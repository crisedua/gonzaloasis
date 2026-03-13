#!/usr/bin/env node
/**
 * goals_manager.mjs
 *
 * Goal state tracking system. Parses goals.md (source of truth)
 * and indexes goals into SQLite for querying and status tracking.
 *
 * Requires: Node.js >= 22.5.0 (built-in node:sqlite)
 *
 * Usage:
 *   node goals_manager.mjs index                    — Parse goals.md → upsert to SQLite
 *   node goals_manager.mjs list [--status=active]   — List goals with status
 *   node goals_manager.mjs update <id> <status>     — Change goal status
 *   node goals_manager.mjs metric <id> <text>       — Log a metric update
 *   node goals_manager.mjs stats                    — Summary counts by status
 *   node goals_manager.mjs search <query>           — FTS5 search over goals
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ─── Configuration ────────────────────────────────────────────────────────────

const ROOT       = resolve('.');
const DB_PATH    = join(ROOT, 'memory.db');
const GOALS_FILE = join(ROOT, 'goals.md');

const VALID_STATUSES = ['active', 'paused', 'completed', 'archived'];

// ─── Database ─────────────────────────────────────────────────────────────────

function openDb() {
  const db = new DatabaseSync(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT    NOT NULL UNIQUE,
      status       TEXT    NOT NULL DEFAULT 'active',
      category     TEXT,
      why          TEXT,
      metrics      TEXT,
      actions      TEXT,
      balance      TEXT,
      created_at   TEXT,
      last_reviewed TEXT,
      updated_at   TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS goals_fts USING fts5(
      title, why, metrics, content=goals, content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS goals_ai AFTER INSERT ON goals BEGIN
      INSERT INTO goals_fts(rowid, title, why, metrics)
        VALUES (new.id, new.title, new.why, new.metrics);
    END;

    CREATE TRIGGER IF NOT EXISTS goals_ad AFTER DELETE ON goals BEGIN
      INSERT INTO goals_fts(goals_fts, rowid, title, why, metrics)
        VALUES ('delete', old.id, old.title, old.why, old.metrics);
    END;

    CREATE TRIGGER IF NOT EXISTS goals_au AFTER UPDATE ON goals BEGIN
      INSERT INTO goals_fts(goals_fts, rowid, title, why, metrics)
        VALUES ('delete', old.id, old.title, old.why, old.metrics);
      INSERT INTO goals_fts(rowid, title, why, metrics)
        VALUES (new.id, new.title, new.why, new.metrics);
    END;
  `);

  return db;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse goals.md into an array of goal objects.
 * Goals are separated by `---` lines.
 * Each goal starts with `## Title`.
 */
function parseGoalsFile(content) {
  const goals = [];

  // Split on horizontal rules, filter empty sections
  const sections = content.split(/\n---\n/).filter(s => s.trim());

  for (const section of sections) {
    const lines = section.trim().split('\n');

    // Must start with ## to be a goal
    const titleLine = lines.find(l => l.startsWith('## '));
    if (!titleLine) continue;

    const title = titleLine.replace(/^## /, '').trim();

    const goal = {
      title,
      status: extractField(section, 'Status') || 'active',
      category: extractField(section, 'Category') || null,
      why: extractBlock(section, 'Why this matters') || null,
      metrics: extractBlock(section, 'Metrics') || null,
      actions: extractBlock(section, 'Actions') || null,
      balance: extractBlock(section, 'Balance check') || null,
      created_at: extractField(section, 'Created') || null,
      last_reviewed: extractField(section, 'Last reviewed') || null,
    };

    // Strip backticks from status (stored as `active`)
    if (goal.status) goal.status = goal.status.replace(/`/g, '').trim();

    goals.push(goal);
  }

  return goals;
}

/** Extract a single-line bold field value: `**Field:** value` */
function extractField(text, field) {
  const re = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, 'i');
  const m  = text.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Extract a multi-line block that starts after `**Field:**`
 * and ends at the next `**Bold:**` header or end of section.
 */
function extractBlock(text, field) {
  const re = new RegExp(`\\*\\*${field}:\\*\\*([\\s\\S]*?)(?=\\n\\*\\*|$)`, 'i');
  const m  = text.match(re);
  if (!m) return null;
  return m[1].trim() || null;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function cmdIndex() {
  if (!existsSync(GOALS_FILE)) {
    console.error('goals.md not found. Create it first.');
    process.exit(1);
  }

  const content = readFileSync(GOALS_FILE, 'utf8');
  const goals   = parseGoalsFile(content);
  const db      = openDb();
  const now     = new Date().toISOString();

  const upsert = db.prepare(`
    INSERT INTO goals (title, status, category, why, metrics, actions, balance, created_at, last_reviewed, updated_at)
    VALUES (@title, @status, @category, @why, @metrics, @actions, @balance, @created_at, @last_reviewed, @updated_at)
    ON CONFLICT(title) DO UPDATE SET
      status        = excluded.status,
      category      = excluded.category,
      why           = excluded.why,
      metrics       = excluded.metrics,
      actions       = excluded.actions,
      balance       = excluded.balance,
      last_reviewed = excluded.last_reviewed,
      updated_at    = excluded.updated_at
  `);

  let count = 0;
  for (const goal of goals) {
    upsert.run({ ...goal, updated_at: now });
    count++;
  }

  db.close();
  console.log(`Indexed ${count} goal${count !== 1 ? 's' : ''} from goals.md`);
}

function cmdList(args) {
  const statusFilter = args.find(a => a.startsWith('--status='))?.split('=')[1];
  const db = openDb();

  let rows;
  if (statusFilter) {
    rows = db.prepare('SELECT id, title, status, category, last_reviewed FROM goals WHERE status = ? ORDER BY id')
      .all(statusFilter);
  } else {
    rows = db.prepare('SELECT id, title, status, category, last_reviewed FROM goals ORDER BY status, id')
      .all();
  }

  db.close();

  if (rows.length === 0) {
    console.log(statusFilter ? `No ${statusFilter} goals.` : 'No goals indexed. Run: node goals_manager.mjs index');
    return;
  }

  const statusEmoji = { active: '[ACTIVE]', paused: '[PAUSED]', completed: '[DONE]', archived: '[ARCHIVED]' };

  for (const row of rows) {
    const tag      = statusEmoji[row.status] || `[${row.status.toUpperCase()}]`;
    const category = row.category ? ` (${row.category})` : '';
    const reviewed = row.last_reviewed ? ` — last reviewed ${row.last_reviewed}` : '';
    console.log(`${row.id}. ${tag} ${row.title}${category}${reviewed}`);
  }
}

function cmdUpdate(args) {
  const [idStr, newStatus] = args;

  if (!idStr || !newStatus) {
    console.error('Usage: node goals_manager.mjs update <id> <status>');
    console.error('Status values:', VALID_STATUSES.join(', '));
    process.exit(1);
  }

  if (!VALID_STATUSES.includes(newStatus)) {
    console.error(`Invalid status "${newStatus}". Must be one of: ${VALID_STATUSES.join(', ')}`);
    process.exit(1);
  }

  const db   = openDb();
  const goal = db.prepare('SELECT id, title, status FROM goals WHERE id = ?').get(parseInt(idStr, 10));

  if (!goal) {
    console.error(`Goal #${idStr} not found.`);
    db.close();
    process.exit(1);
  }

  const now = new Date().toISOString().slice(0, 10);

  // Update SQLite
  db.prepare('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?')
    .run(newStatus, now, goal.id);
  db.close();

  // Update goals.md
  if (existsSync(GOALS_FILE)) {
    let content = readFileSync(GOALS_FILE, 'utf8');
    // Replace **Status:** `old` with new status
    const oldStatusRe = new RegExp(
      '(## ' + escapeRegex(goal.title) + '[\\s\\S]*?\\*\\*Status:\\*\\* )' + '`[^`]*`',
      'i'
    );
    content = content.replace(oldStatusRe, '$1' + '`' + newStatus + '`');
    writeFileSync(GOALS_FILE, content, 'utf8');
  }

  console.log(`Goal #${goal.id} "${goal.title}": ${goal.status} → ${newStatus}`);
}

function cmdMetric(args) {
  const [idStr, ...rest] = args;
  const metricText = rest.join(' ');

  if (!idStr || !metricText) {
    console.error('Usage: node goals_manager.mjs metric <id> <text>');
    process.exit(1);
  }

  const db   = openDb();
  const goal = db.prepare('SELECT id, title FROM goals WHERE id = ?').get(parseInt(idStr, 10));

  if (!goal) {
    console.error(`Goal #${idStr} not found.`);
    db.close();
    process.exit(1);
  }

  const now = new Date().toISOString().slice(0, 10);

  if (existsSync(GOALS_FILE)) {
    let content = readFileSync(GOALS_FILE, 'utf8');
    // Append metric update as a new bullet under **Metrics:**
    const metricsRe = new RegExp(
      '(## ' + escapeRegex(goal.title) + '[\\s\\S]*?\\*\\*Metrics:\\*\\*[\\s\\S]*?)(\\n\\*\\*|\\n---)',
      'i'
    );
    content = content.replace(metricsRe, `$1\n- [${now}] ${metricText}$2`);
    writeFileSync(GOALS_FILE, content, 'utf8');
  }

  // Re-read and re-index just this goal
  db.close();
  cmdIndex();
  console.log(`Metric logged for goal #${goal.id} "${goal.title}": ${metricText}`);
}

function cmdAddAction(args) {
  const [idStr, ...rest] = args;
  const actionText = rest.join(' ');

  if (!idStr || !actionText) {
    console.error('Usage: node goals_manager.mjs add-action <id> <text>');
    process.exit(1);
  }

  const db   = openDb();
  const goal = db.prepare('SELECT id, title FROM goals WHERE id = ?').get(parseInt(idStr, 10));

  if (!goal) {
    console.error(`Goal #${idStr} not found.`);
    db.close();
    process.exit(1);
  }

  db.close();

  if (existsSync(GOALS_FILE)) {
    let content = readFileSync(GOALS_FILE, 'utf8');
    // Append new action before the next ** section or --- following **Actions:**
    const actionsRe = new RegExp(
      '(## ' + escapeRegex(goal.title) + '[\\s\\S]*?\\*\\*Actions:\\*\\*[\\s\\S]*?)(\\n\\*\\*|\\n---)',
      'i'
    );
    content = content.replace(actionsRe, `$1\n- [ ] ${actionText}$2`);
    writeFileSync(GOALS_FILE, content, 'utf8');
  }

  cmdIndex();
  console.log(`Action added to goal #${goal.id} "${goal.title}": ${actionText}`);
}

function cmdDelete(args) {
  const [idStr] = args;

  if (!idStr) {
    console.error('Usage: node goals_manager.mjs delete <id>');
    process.exit(1);
  }

  const db   = openDb();
  const goal = db.prepare('SELECT id, title FROM goals WHERE id = ?').get(parseInt(idStr, 10));

  if (!goal) {
    console.error(`Goal #${idStr} not found.`);
    db.close();
    process.exit(1);
  }

  // Remove from goals.md by filtering out the section with this title
  if (existsSync(GOALS_FILE)) {
    const content  = readFileSync(GOALS_FILE, 'utf8');
    const sections = content.split(/\n---\n/);
    const filtered = sections.filter(s => {
      const titleLine = s.trim().split('\n').find(l => l.startsWith('## '));
      if (!titleLine) return true; // keep header/non-goal sections
      return titleLine.replace(/^## /, '').trim() !== goal.title;
    });
    writeFileSync(GOALS_FILE, filtered.join('\n---\n'), 'utf8');
  }

  // Remove from SQLite
  db.prepare('DELETE FROM goals WHERE id = ?').run(goal.id);
  db.close();

  console.log(`Deleted goal #${goal.id}: "${goal.title}"`);
}

function cmdStats() {
  const db = openDb();

  const counts = db.prepare(`
    SELECT status, COUNT(*) as count FROM goals GROUP BY status ORDER BY status
  `).all();

  const total = db.prepare('SELECT COUNT(*) as count FROM goals').get();
  db.close();

  if (total.count === 0) {
    console.log('No goals indexed. Run: node goals_manager.mjs index');
    return;
  }

  console.log(`Goals — ${total.count} total`);
  for (const row of counts) {
    console.log(`  ${row.status.padEnd(10)} ${row.count}`);
  }
}

function cmdSearch(args) {
  const query = args.join(' ');
  if (!query) {
    console.error('Usage: node goals_manager.mjs search <query>');
    process.exit(1);
  }

  const db = openDb();

  const rows = db.prepare(`
    SELECT g.id, g.title, g.status, g.category,
           snippet(goals_fts, 1, '>>>', '<<<', '...', 8) AS excerpt
    FROM goals_fts
    JOIN goals g ON goals_fts.rowid = g.id
    WHERE goals_fts MATCH ?
    ORDER BY rank
    LIMIT 5
  `).all(query);

  db.close();

  if (rows.length === 0) {
    console.log(`No goals found for: "${query}"`);
    return;
  }

  for (const row of rows) {
    const category = row.category ? ` (${row.category})` : '';
    console.log(`\n#${row.id} [${row.status}] ${row.title}${category}`);
    if (row.excerpt) console.log(`  ${row.excerpt}`);
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

const [,, cmd, ...rest] = process.argv;

switch (cmd) {
  case 'index':  cmdIndex();        break;
  case 'list':   cmdList(rest);     break;
  case 'update': cmdUpdate(rest);   break;
  case 'metric': cmdMetric(rest);   break;
  case 'stats':  cmdStats();        break;
  case 'add-action': cmdAddAction(rest); break;
  case 'delete': cmdDelete(rest);   break;
  case 'search': cmdSearch(rest);   break;
  default:
    console.log(`goals_manager.mjs — goal state tracking

Commands:
  index                    Parse goals.md → upsert to SQLite
  list [--status=active]   List goals with status
  update <id> <status>     Change status (active/paused/completed/archived)
  metric <id> <text>       Log a metric update to goals.md
  add-action <id> <text>   Add a new pending action to a goal
  stats                    Summary counts by status
  search <query>           FTS5 search over goal titles and justifications`);
}
