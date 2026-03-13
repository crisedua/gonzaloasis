/**
 * calendar.mjs — Google Calendar API helpers
 *
 * All functions auto-obtain an authenticated client via google-auth.mjs.
 *
 * Exports:
 *   getUpcomingEvents(maxResults)          → array of event summaries
 *   getTodayEvents()                       → array of today's events
 *   searchEvents(query, maxResults)        → array of matching events
 *   getEvent(eventId)                      → full event details
 *   createEvent(title, start, end, desc?, loc?) → { id, link }
 *   deleteEvent(eventId)                   → void
 *   getCalendarContext(maxResults)          → formatted string for Claude context
 */

import { google } from 'googleapis';
import { getAuthClient } from './google-auth.mjs';

// ─── Internal helpers ──────────────────────────────────────────────────────────

function getCalendar(auth) {
  return google.calendar({ version: 'v3', auth });
}

/**
 * Formats a Calendar event dateTime or date object into a display string.
 * Handles both all-day events (date only) and timed events (dateTime).
 */
function formatEventTime(eventDateTime) {
  if (!eventDateTime) return '';
  const tz = process.env.CALENDAR_TIMEZONE || 'America/Santiago';
  if (eventDateTime.dateTime) {
    return new Date(eventDateTime.dateTime).toLocaleString('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  }
  if (eventDateTime.date) {
    return new Date(eventDateTime.date + 'T00:00:00').toLocaleDateString('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    }) + ' (all day)';
  }
  return '';
}

/** Converts a Calendar event resource into a clean summary object. */
function toSummary(event) {
  return {
    id:          event.id,
    title:       event.summary ?? '(no title)',
    start:       formatEventTime(event.start),
    end:         formatEventTime(event.end),
    location:    event.location ?? '',
    description: (event.description ?? '').slice(0, 500),
    link:        event.htmlLink ?? '',
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/** Returns up to maxResults upcoming events, sorted by start time. */
export async function getUpcomingEvents(maxResults = 10) {
  const auth     = await getAuthClient();
  const calendar = getCalendar(auth);

  const { data } = await calendar.events.list({
    calendarId: 'primary',
    timeMin: new Date().toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (data.items ?? []).map(toSummary);
}

/** Returns events for today only (midnight → end of day). */
export async function getTodayEvents() {
  const auth     = await getAuthClient();
  const calendar = getCalendar(auth);

  const tz = process.env.CALENDAR_TIMEZONE || 'America/Santiago';
  // Get today's boundaries in the configured timezone
  const nowStr = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const start  = new Date(`${nowStr}T00:00:00`);
  const end    = new Date(`${nowStr}T23:59:59`);

  const { data } = await calendar.events.list({
    calendarId: 'primary',
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: tz,
  });

  return (data.items ?? []).map(toSummary);
}

/** Searches calendar events by text query (past year forward). */
export async function searchEvents(query, maxResults = 10) {
  const auth     = await getAuthClient();
  const calendar = getCalendar(auth);

  const { data } = await calendar.events.list({
    calendarId: 'primary',
    q: query,
    timeMin: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (data.items ?? []).map(toSummary);
}

/** Returns full details for a single event. */
export async function getEvent(eventId) {
  const auth     = await getAuthClient();
  const calendar = getCalendar(auth);

  const { data } = await calendar.events.get({
    calendarId: 'primary',
    eventId,
  });

  return {
    id:          data.id,
    title:       data.summary ?? '(no title)',
    start:       formatEventTime(data.start),
    end:         formatEventTime(data.end),
    location:    data.location ?? '',
    description: data.description ?? '',
    link:        data.htmlLink ?? '',
    attendees:   (data.attendees ?? []).map(a => a.email),
    status:      data.status ?? '',
    creator:     data.creator?.email ?? '',
  };
}

/**
 * Creates a new calendar event.
 * @param {string} title       Event title
 * @param {string} start       ISO 8601 datetime (e.g. "2026-03-05T15:00:00")
 * @param {string} end         ISO 8601 datetime
 * @param {string} [description]
 * @param {string} [location]
 * @returns {{ id: string, link: string }}
 */
export async function createEvent(title, start, end, description = '', location = '', attendees = []) {
  const auth     = await getAuthClient();
  const calendar = getCalendar(auth);

  const eventBody = {
    summary: title,
    start:   { dateTime: start },
    end:     { dateTime: end },
  };

  if (description) eventBody.description = description;
  if (location)    eventBody.location    = location;
  if (attendees.length > 0) {
    eventBody.attendees = attendees.map(email => ({ email }));
  }

  const { data } = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: eventBody,
    sendUpdates: attendees.length > 0 ? 'all' : 'none',
  });

  return { id: data.id, link: data.htmlLink ?? '' };
}

/** Deletes a calendar event by ID. */
export async function deleteEvent(eventId) {
  const auth     = await getAuthClient();
  const calendar = getCalendar(auth);

  await calendar.events.delete({
    calendarId: 'primary',
    eventId,
  });
}

/** Returns a formatted string of upcoming events for Claude context injection. */
export async function getCalendarContext(maxResults = 5) {
  const events = await getUpcomingEvents(maxResults);
  if (events.length === 0) return '*Calendar — no upcoming events*';

  const lines = [`*Calendar — ${events.length} upcoming events*`, ''];
  for (const e of events) {
    lines.push(`*${e.title}*`);
    lines.push(`${e.start}${e.location ? ' | ' + e.location : ''}`);
    lines.push('');
  }

  return lines.join('\n');
}
