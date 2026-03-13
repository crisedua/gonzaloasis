/**
 * dashboard/data.mjs — Data access layer for the dashboard
 *
 * Reads directly from memory.db and the filesystem.
 * All functions accept rootDir so this layer is multi-tenant ready.
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ─── Database ────────────────────────────────────────────────────────────────

function openDb(rootDir) {
  const dbPath = join(rootDir, 'memory.db');
  if (!existsSync(dbPath)) return null;
  return new DatabaseSync(dbPath);
}

// ─── Goals ───────────────────────────────────────────────────────────────────

/** List goals, optionally filtered by status. */
export function getGoals(rootDir, statusFilter) {
  const db = openDb(rootDir);
  if (!db) return [];

  try {
    let rows;
    if (statusFilter) {
      rows = db.prepare(
        'SELECT id, title, status, category, why, metrics, actions, balance, last_reviewed, updated_at FROM goals WHERE status = ? ORDER BY id'
      ).all(statusFilter);
    } else {
      rows = db.prepare(
        'SELECT id, title, status, category, why, metrics, actions, balance, last_reviewed, updated_at FROM goals ORDER BY CASE status WHEN \'active\' THEN 1 WHEN \'paused\' THEN 2 WHEN \'completed\' THEN 3 ELSE 4 END, id'
      ).all();
    }
    return rows;
  } finally {
    db.close();
  }
}

/** Get a single goal by ID. */
export function getGoalById(rootDir, id) {
  const db = openDb(rootDir);
  if (!db) return null;

  try {
    return db.prepare('SELECT * FROM goals WHERE id = ?').get(id) || null;
  } finally {
    db.close();
  }
}

/** Goal stats by status. */
export function getGoalStats(rootDir) {
  const db = openDb(rootDir);
  if (!db) return { active: 0, paused: 0, completed: 0, archived: 0, total: 0 };

  try {
    const rows = db.prepare('SELECT status, COUNT(*) AS n FROM goals GROUP BY status').all();
    const stats = { active: 0, paused: 0, completed: 0, archived: 0, total: 0 };
    for (const r of rows) {
      stats[r.status] = r.n;
      stats.total += r.n;
    }
    return stats;
  } finally {
    db.close();
  }
}

// ─── Memory Search ───────────────────────────────────────────────────────────

/** FTS5 search across indexed memory chunks. */
export function searchMemory(rootDir, query, limit = 8) {
  const db = openDb(rootDir);
  if (!db) return [];

  try {
    return db.prepare(`
      SELECT c.path, c.start_char, c.end_char, c.text, fts.rank
      FROM chunks_fts fts
      JOIN chunks c ON c.id = fts.id
      WHERE chunks_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `).all(query, limit);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Memory DB stats. */
export function getMemoryStats(rootDir) {
  const db = openDb(rootDir);
  if (!db) return { files: 0, chunks: 0 };

  try {
    const files  = db.prepare('SELECT COUNT(*) AS n FROM files').get();
    const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get();
    return { files: files.n, chunks: chunks.n };
  } finally {
    db.close();
  }
}

// ─── Daily Logs ──────────────────────────────────────────────────────────────

/** List daily log files, most recent first. */
export function getDailyLogs(rootDir, limit = 30) {
  const memDir = join(rootDir, 'memory');
  if (!existsSync(memDir)) return [];

  return readdirSync(memDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit)
    .map(f => {
      const st = statSync(join(memDir, f));
      return { date: f.replace('.md', ''), size: st.size };
    });
}

/** Read a specific daily log. */
export function getDailyLogContent(rootDir, date) {
  const logPath = join(rootDir, 'memory', `${date}.md`);
  if (!existsSync(logPath)) return null;
  return readFileSync(logPath, 'utf8');
}

// ─── Documents ───────────────────────────────────────────────────────────────

/** List all documents in the documents/ directory. */
export function getDocuments(rootDir) {
  const docsDir = join(rootDir, 'documents');
  if (!existsSync(docsDir)) return [];

  return readdirSync(docsDir)
    .filter(f => !statSync(join(docsDir, f)).isDirectory())
    .sort((a, b) => b.localeCompare(a))
    .map(f => {
      const st = statSync(join(docsDir, f));
      const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})/);
      return {
        name: f,
        date: dateMatch ? dateMatch[1] : null,
        size: st.size,
      };
    });
}

/** Read a document's content. */
export function getDocumentContent(rootDir, filename) {
  const docPath = join(rootDir, 'documents', filename);
  if (!existsSync(docPath)) return null;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return null;
  return readFileSync(docPath, 'utf8');
}
