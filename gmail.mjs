/**
 * gmail.mjs — Gmail API helpers
 *
 * All functions auto-obtain an authenticated client via google-auth.mjs.
 *
 * Exports:
 *   getUnread(maxResults)              → array of message summaries
 *   searchEmails(query, maxResults)    → array of message summaries
 *   getEmail(messageId)                → full message object { subject, from, date, body }
 *   sendEmail(to, subject, body)       → sent message id
 *   replyEmail(messageId, body)        → sent message id
 *   getEmailContext(maxResults)        → formatted string for Claude context
 */

import { google } from 'googleapis';
import { getAuthClient } from './google-auth.mjs';

// ─── Internal helpers ──────────────────────────────────────────────────────────

function getGmail(auth) {
  return google.gmail({ version: 'v1', auth });
}

/** Decodes base64url-encoded Gmail body parts. */
function decodeBody(data) {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** Extracts plain-text body from a Gmail message payload. */
function extractBody(payload) {
  if (!payload) return '';

  // Single-part plain text
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBody(payload.body.data);
  }

  // Multipart — prefer text/plain part
  if (payload.parts) {
    const plain = payload.parts.find(p => p.mimeType === 'text/plain');
    if (plain?.body?.data) return decodeBody(plain.body.data);

    // Fall back to text/html part (strip tags roughly)
    const html = payload.parts.find(p => p.mimeType === 'text/html');
    if (html?.body?.data) {
      return decodeBody(html.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  return '';
}

/** Gets a header value by name from a Gmail message. */
function header(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/** Converts a Gmail message resource into a clean summary object. */
function toSummary(msg) {
  const h = msg.payload?.headers ?? [];
  return {
    id:      msg.id,
    subject: header(h, 'Subject') || '(no subject)',
    from:    header(h, 'From'),
    date:    header(h, 'Date'),
    snippet: msg.snippet ?? '',
  };
}

/** Fetches full message details and returns a structured object. */
async function fetchFull(gmail, messageId) {
  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const h = data.payload?.headers ?? [];
  return {
    id:        data.id,
    threadId:  data.threadId,
    subject:   header(h, 'Subject') || '(no subject)',
    from:      header(h, 'From'),
    to:        header(h, 'To'),
    date:      header(h, 'Date'),
    body:      extractBody(data.payload).slice(0, 4000), // cap for context injection
    snippet:   data.snippet ?? '',
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/** Returns up to maxResults unread email summaries. */
export async function getUnread(maxResults = 10) {
  const auth  = await getAuthClient();
  const gmail = getGmail(auth);

  const { data } = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread',
    maxResults,
  });

  if (!data.messages?.length) return [];

  const details = await Promise.all(
    data.messages.map(m =>
      gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'] })
        .then(r => toSummary(r.data))
    )
  );

  return details;
}

/** Searches Gmail and returns up to maxResults summaries. */
export async function searchEmails(query, maxResults = 10) {
  const auth  = await getAuthClient();
  const gmail = getGmail(auth);

  const { data } = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
  });

  if (!data.messages?.length) return [];

  const details = await Promise.all(
    data.messages.map(m =>
      gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'] })
        .then(r => toSummary(r.data))
    )
  );

  return details;
}

/** Returns full message details including body. */
export async function getEmail(messageId) {
  const auth  = await getAuthClient();
  const gmail = getGmail(auth);
  return fetchFull(gmail, messageId);
}

/**
 * Sends a new email.
 * @param {string} to        Recipient address
 * @param {string} subject   Subject line
 * @param {string} body      Plain-text body
 */
export async function sendEmail(to, subject, body) {
  const auth  = await getAuthClient();
  const gmail = getGmail(auth);

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString('base64url');

  const { data } = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return data.id;
}

/**
 * Replies to an existing email thread.
 * @param {string} messageId  The message to reply to
 * @param {string} body       Plain-text reply body
 */
export async function replyEmail(messageId, body) {
  const auth  = await getAuthClient();
  const gmail = getGmail(auth);

  const original = await fetchFull(gmail, messageId);

  const replyTo  = original.from;
  const subject  = original.subject.startsWith('Re:') ? original.subject : `Re: ${original.subject}`;
  const threadId = original.threadId;

  const raw = Buffer.from(
    `To: ${replyTo}\r\nSubject: ${subject}\r\nIn-Reply-To: ${messageId}\r\nReferences: ${messageId}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString('base64url');

  const { data } = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId },
  });

  return data.id;
}

/**
 * Returns a formatted string of unread emails for Claude context injection.
 */
export async function getEmailContext(maxResults = 5) {
  const emails = await getUnread(maxResults);
  if (emails.length === 0) return '*Gmail — no unread emails*';

  const lines = [`*Gmail — ${emails.length} unread*`, ''];
  for (const e of emails) {
    lines.push(`*${e.subject}*`);
    lines.push(`From: ${e.from}  |  ${e.date}`);
    lines.push(e.snippet.slice(0, 200));
    lines.push('');
  }

  return lines.join('\n');
}
