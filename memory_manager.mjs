#!/usr/bin/env node
/**
 * memory_manager.mjs
 *
 * A lightweight memory system using Markdown files as source of truth
 * and SQLite FTS5 for full-text search.
 *
 * Inspired by OpenClaw's memory architecture.
 * Requires: Node.js >= 22.5.0 (built-in node:sqlite)
 *
 * Usage:
 *   node memory_manager.mjs init              — Initialize memory.db
 *   node memory_manager.mjs index             — Index all markdown files
 *   node memory_manager.mjs search <query>    — Full-text search
 *   node memory_manager.mjs list              — List indexed files
 *   node memory_manager.mjs stats             — Database statistics
 *   node memory_manager.mjs log <text>        — Append note to today's log
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';

// ─── Configuration ────────────────────────────────────────────────────────────

const ROOT       = resolve('.');
const DB_PATH    = join(ROOT, 'memory.db');
const MEMORY_DIR = join(ROOT, 'memory');

// Files to index at the root level
const ROOT_FILES = ['soul.md', 'user.md', 'memory.md', 'agent.md'];

// Chunking: target ~400 characters per chunk, 80-char overlap
const CHUNK_SIZE    = 400;
const CHUNK_OVERLAP = 80;

// ─── Database Setup ───────────────────────────────────────────────────────────

function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function initDb(db) {
  // Metadata table
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Track indexed files (path → hash + mtime)
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path   TEXT PRIMARY KEY,
      hash   TEXT NOT NULL,
      mtime  INTEGER NOT NULL,
      size   INTEGER NOT NULL
    );
  `);

  // Text chunks from markdown files
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id         TEXT PRIMARY KEY,
      path       TEXT NOT NULL,
      start_char INTEGER NOT NULL,
      end_char   INTEGER NOT NULL,
      text       TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
    );
  `);

  // FTS5 virtual table for full-text search (BM25 ranking)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      id   UNINDEXED,
      path UNINDEXED,
      content     = 'chunks',
      content_rowid = 'rowid'
    );
  `);

  // Triggers to keep FTS5 in sync with chunks table
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text, id, path)
      VALUES (new.rowid, new.text, new.id, new.path);
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text, id, path)
      VALUES ('delete', old.rowid, old.text, old.id, old.path);
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text, id, path)
      VALUES ('delete', old.rowid, old.text, old.id, old.path);
      INSERT INTO chunks_fts(rowid, text, id, path)
      VALUES (new.rowid, new.text, new.id, new.path);
    END;
  `);

  // Store schema version
  const stmt = db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`);
  stmt.run('schema_version', '1');
  stmt.run('created_at', new Date().toISOString());
  stmt.run('chunking_size', String(CHUNK_SIZE));
  stmt.run('chunking_overlap', String(CHUNK_OVERLAP));

  console.log('✓ memory.db initialized');
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks.
 * Tries to break at paragraph boundaries (double newline), then sentence ends.
 */
function chunkText(text) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + CHUNK_SIZE;

    if (end >= text.length) {
      chunks.push({ text: text.slice(start).trim(), start_char: start, end_char: text.length });
      break;
    }

    // Try to break at a paragraph boundary near the end of the chunk
    const searchFrom = Math.max(start + CHUNK_SIZE - 100, start);
    const paraBreak  = text.indexOf('\n\n', searchFrom);

    if (paraBreak !== -1 && paraBreak < start + CHUNK_SIZE + 200) {
      end = paraBreak + 2;
    } else {
      // Fall back: break at last newline or space near chunk size
      const nlBreak = text.lastIndexOf('\n', start + CHUNK_SIZE);
      if (nlBreak > start + CHUNK_SIZE / 2) {
        end = nlBreak + 1;
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push({ text: chunk, start_char: start, end_char: end });
    }

    // Advance with overlap so context carries across chunk boundaries
    start = end - CHUNK_OVERLAP;
    if (start <= 0) start = end; // safety: never go backward
  }

  return chunks;
}

function chunkId(filePath, startChar) {
  return createHash('sha1')
    .update(`${filePath}:${startChar}`)
    .digest('hex')
    .slice(0, 16);
}

function fileHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

// ─── Indexing ─────────────────────────────────────────────────────────────────

function collectMarkdownFiles() {
  const files = [];

  // Root-level identity files
  for (const name of ROOT_FILES) {
    const p = join(ROOT, name);
    if (existsSync(p)) files.push(p);
  }

  // Daily logs in memory/
  if (existsSync(MEMORY_DIR)) {
    for (const entry of readdirSync(MEMORY_DIR)) {
      if (extname(entry) === '.md') {
        files.push(join(MEMORY_DIR, entry));
      }
    }
  }

  return files;
}

function indexFile(db, filePath) {
  const content = readFileSync(filePath, 'utf8');
  const hash    = fileHash(content);
  const stat    = statSync(filePath);
  const mtime   = Math.floor(stat.mtimeMs);
  const relPath = relative(ROOT, filePath).replace(/\\/g, '/');

  // Check if file changed since last index
  const existing = db.prepare('SELECT hash FROM files WHERE path = ?').get(relPath);
  if (existing && existing.hash === hash) {
    return { path: relPath, status: 'unchanged', chunks: 0 };
  }

  // Delete old chunks for this file (triggers handle FTS5 cleanup)
  db.prepare('DELETE FROM chunks WHERE path = ?').run(relPath);
  db.prepare('DELETE FROM files WHERE path = ?').run(relPath);

  // Upsert file record
  db.prepare(`
    INSERT INTO files (path, hash, mtime, size)
    VALUES (?, ?, ?, ?)
  `).run(relPath, hash, mtime, stat.size);

  // Insert chunks
  const rawChunks = chunkText(content);
  const now       = Date.now();
  const insertChunk = db.prepare(`
    INSERT INTO chunks (id, path, start_char, end_char, text, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const chunk of rawChunks) {
    const id = chunkId(relPath, chunk.start_char);
    insertChunk.run(id, relPath, chunk.start_char, chunk.end_char, chunk.text, now);
  }

  return { path: relPath, status: existing ? 'updated' : 'added', chunks: rawChunks.length };
}

function cmdIndex() {
  const db = openDb();
  initDb(db);

  const files   = collectMarkdownFiles();
  const results = [];

  for (const f of files) {
    try {
      results.push(indexFile(db, f));
    } catch (err) {
      results.push({ path: f, status: 'error', error: err.message, chunks: 0 });
    }
  }

  // Summarize
  let added = 0, updated = 0, unchanged = 0, errors = 0;
  for (const r of results) {
    if (r.status === 'added')     { added++;     console.log(`  + ${r.path} (${r.chunks} chunks)`); }
    if (r.status === 'updated')   { updated++;   console.log(`  ~ ${r.path} (${r.chunks} chunks)`); }
    if (r.status === 'unchanged') { unchanged++;                                                     }
    if (r.status === 'error')     { errors++;    console.error(`  ✗ ${r.path}: ${r.error}`);         }
  }

  console.log(`\nIndex complete: ${added} added, ${updated} updated, ${unchanged} unchanged, ${errors} errors`);
  db.close();
}

// ─── Search ───────────────────────────────────────────────────────────────────

function cmdSearch(query) {
  if (!query) {
    console.error('Usage: node memory_manager.mjs search <query>');
    process.exit(1);
  }

  if (!existsSync(DB_PATH)) {
    console.error('memory.db not found. Run: node memory_manager.mjs init');
    process.exit(1);
  }

  const db = openDb();

  // FTS5 BM25 search — higher rank = better match (rank is negative in SQLite FTS5)
  const rows = db.prepare(`
    SELECT
      c.path,
      c.start_char,
      c.end_char,
      c.text,
      fts.rank
    FROM chunks_fts fts
    JOIN chunks c ON c.id = fts.id
    WHERE chunks_fts MATCH ?
    ORDER BY fts.rank
    LIMIT 8
  `).all(query);

  if (rows.length === 0) {
    console.log(`No results for: "${query}"`);
    db.close();
    return;
  }

  console.log(`\nResults for: "${query}"\n${'─'.repeat(60)}`);
  for (const row of rows) {
    const snippet = row.text.length > 500
      ? row.text.slice(0, 497) + '...'
      : row.text;
    console.log(`\n📄 ${row.path} (chars ${row.start_char}–${row.end_char})`);
    console.log(`${snippet}`);
  }
  console.log(`\n${'─'.repeat(60)}\n${rows.length} result(s) found`);

  db.close();
}

// ─── List ─────────────────────────────────────────────────────────────────────

function cmdList() {
  if (!existsSync(DB_PATH)) {
    console.error('memory.db not found. Run: node memory_manager.mjs init');
    process.exit(1);
  }

  const db   = openDb();
  const rows = db.prepare(`
    SELECT f.path, f.size, COUNT(c.id) AS chunk_count
    FROM files f
    LEFT JOIN chunks c ON c.path = f.path
    GROUP BY f.path
    ORDER BY f.path
  `).all();

  if (rows.length === 0) {
    console.log('No files indexed yet. Run: node memory_manager.mjs index');
  } else {
    console.log('\nIndexed files:\n');
    for (const row of rows) {
      console.log(`  ${row.path.padEnd(40)} ${row.chunk_count} chunks  (${row.size} bytes)`);
    }
    console.log(`\n${rows.length} file(s) indexed`);
  }

  db.close();
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function cmdStats() {
  if (!existsSync(DB_PATH)) {
    console.error('memory.db not found. Run: node memory_manager.mjs init');
    process.exit(1);
  }

  const db      = openDb();
  const files   = db.prepare('SELECT COUNT(*) AS n FROM files').get();
  const chunks  = db.prepare('SELECT COUNT(*) AS n FROM chunks').get();
  const meta    = db.prepare('SELECT key, value FROM meta').all();

  console.log('\n── memory.db stats ──────────────────────────────');
  console.log(`  Files indexed : ${files.n}`);
  console.log(`  Total chunks  : ${chunks.n}`);
  console.log('\n── meta ─────────────────────────────────────────');
  for (const row of meta) {
    console.log(`  ${row.key.padEnd(20)} ${row.value}`);
  }
  console.log('');

  db.close();
}

// ─── Log (quick append to today's daily log) ──────────────────────────────────

function cmdLog(text) {
  if (!text) {
    console.error('Usage: node memory_manager.mjs log <text>');
    process.exit(1);
  }

  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }

  const today   = new Date().toISOString().slice(0, 10);
  const logPath = join(MEMORY_DIR, `${today}.md`);
  const now     = new Date().toLocaleTimeString('en-US', { hour12: false });

  if (!existsSync(logPath)) {
    writeFileSync(logPath, `# Daily Log — ${today}\n\n`, 'utf8');
  }

  const entry = `\n- **${now}** ${text}\n`;
  writeFileSync(logPath, readFileSync(logPath, 'utf8') + entry, 'utf8');
  console.log(`✓ Logged to memory/${today}.md`);
}

// ─── Init (explicit) ──────────────────────────────────────────────────────────

function cmdInit() {
  const db = openDb();
  initDb(db);
  db.close();
}

// ─── CLI dispatch ─────────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'init':   cmdInit();               break;
  case 'index':  cmdIndex();              break;
  case 'search': cmdSearch(args.join(' ')); break;
  case 'list':   cmdList();               break;
  case 'stats':  cmdStats();              break;
  case 'log':    cmdLog(args.join(' '));   break;
  default:
    console.log(`
memory_manager.mjs — Markdown + SQLite memory system

Usage:
  node memory_manager.mjs <command>

Commands:
  init              Initialize memory.db (safe to re-run)
  index             Index all markdown files into memory.db
  search <query>    Full-text search across indexed chunks
  list              List indexed files with chunk counts
  stats             Show database statistics
  log <text>        Append a quick note to today's daily log
    `);
}
