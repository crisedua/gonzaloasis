/**
 * dashboard/routes.mjs — Route handlers for dashboard pages + API
 */

import { getGoals, getGoalById, getGoalStats, searchMemory, getMemoryStats,
         getDailyLogs, getDailyLogContent, getDocuments, getDocumentContent } from './data.mjs';
import { homePage } from './templates/home.mjs';
import { goalsPage, goalDetailPage } from './templates/goals.mjs';
import { documentsPage, documentViewPage } from './templates/documents.mjs';
import { memoryPage } from './templates/memory.mjs';
import { historyPage } from './templates/history.mjs';
import { calendarPage } from './templates/calendar.mjs';
import { helpPage } from './templates/help.mjs';

// ─── Page Routes (return HTML) ─────────────────────────────────────────────

export function handleHome(rootDir) {
  const goalStats   = getGoalStats(rootDir);
  const activeGoals = getGoals(rootDir, 'active');
  const recentDocs  = getDocuments(rootDir);
  const memoryStats = getMemoryStats(rootDir);
  return homePage({ goalStats, activeGoals, recentDocs, memoryStats });
}

export function handleGoals(rootDir) {
  const goals = getGoals(rootDir);
  return goalsPage({ goals });
}

export function handleGoalDetail(rootDir, id) {
  const goal = getGoalById(rootDir, parseInt(id, 10));
  return goalDetailPage({ goal });
}

export function handleDocuments(rootDir) {
  const documents = getDocuments(rootDir);
  return documentsPage({ documents });
}

export function handleDocumentView(rootDir, filename) {
  const content = getDocumentContent(rootDir, filename);
  return documentViewPage({ filename, content });
}

export function handleMemory(rootDir, query) {
  const stats   = getMemoryStats(rootDir);
  const results = query ? searchMemory(rootDir, query) : [];
  return memoryPage({ query: query || '', results, stats });
}

export function handleHistory(rootDir, date) {
  const logs    = getDailyLogs(rootDir);
  const sel     = date || (logs.length > 0 ? logs[0].date : null);
  const content = sel ? getDailyLogContent(rootDir, sel) : null;
  return historyPage({ logs, selectedDate: sel, content });
}

export async function handleCalendar(getUpcomingEvents) {
  try {
    const events = await getUpcomingEvents(15);
    return calendarPage({ events, error: null });
  } catch (err) {
    return calendarPage({ events: [], error: `Calendar error: ${err.message}` });
  }
}

export function handleHelp() {
  return helpPage();
}

// ─── API Routes (return JSON) ──────────────────────────────────────────────

export function apiGoals(rootDir) {
  return getGoals(rootDir);
}

export function apiMemorySearch(rootDir, query) {
  if (!query) return [];
  return searchMemory(rootDir, query);
}

export function apiDocuments(rootDir) {
  return getDocuments(rootDir);
}

export async function apiCalendar(getUpcomingEvents) {
  try {
    const events = await getUpcomingEvents(15);
    return { events, error: null };
  } catch (err) {
    return { events: [], error: err.message };
  }
}
