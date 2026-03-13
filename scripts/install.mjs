#!/usr/bin/env node
/**
 * scripts/install.mjs — First-run installation script
 *
 * Creates directories, initializes the database, and copies template files.
 * Run once on a fresh VPS: node scripts/install.mjs
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve('.');
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim   = (s) => `\x1b[2m${s}\x1b[0m`;
const bold  = (s) => `\x1b[1m${s}\x1b[0m`;

console.log(bold('\nAI Assistant — Installation\n'));

// ─── 1. Check Node.js version ────────────────────────────────────────────────

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`Node.js v22+ is required (found v${process.versions.node}).`);
  console.error('Install from: https://nodejs.org/');
  process.exit(1);
}
console.log(green('✓') + ` Node.js v${process.versions.node}`);

// ─── 2. Create directories ──────────────────────────────────────────────────

const dirs = ['memory', 'documents', 'documents/clipped'];
for (const dir of dirs) {
  const p = join(ROOT, dir);
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
    console.log(green('✓') + ` Created ${dir}/`);
  } else {
    console.log(dim(`  ${dir}/ already exists`));
  }
}

// ─── 3. Initialize memory.db ────────────────────────────────────────────────

const dbPath = join(ROOT, 'memory.db');
if (!existsSync(dbPath)) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);

    // Config table (admin panel settings)
    db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Sessions table (dashboard auth)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      )
    `);

    // Memory FTS tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        hash TEXT NOT NULL,
        indexed_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        start_char INTEGER NOT NULL,
        end_char INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id')
    `);

    // Goals table
    db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'active',
        category TEXT,
        why TEXT,
        metrics TEXT,
        actions TEXT,
        balance TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        last_reviewed TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.close();
    console.log(green('✓') + ' Initialized memory.db');
  } catch (err) {
    console.error('Failed to initialize memory.db:', err.message);
    process.exit(1);
  }
} else {
  console.log(dim('  memory.db already exists'));
}

// ─── 4. Copy template files ─────────────────────────────────────────────────

const templates = [
  { src: 'templates/soul.md.template', dst: 'soul.md' },
  { src: 'templates/agent.md.template', dst: 'agent.md' },
  { src: 'templates/user.md.template', dst: 'user.md' },
];

for (const { src, dst } of templates) {
  const srcPath = join(ROOT, src);
  const dstPath = join(ROOT, dst);
  if (!existsSync(dstPath) && existsSync(srcPath)) {
    copyFileSync(srcPath, dstPath);
    console.log(green('✓') + ` Created ${dst} from template`);
  } else if (existsSync(dstPath)) {
    console.log(dim(`  ${dst} already exists (not overwritten)`));
  } else {
    console.log(dim(`  ${src} not found, skipping`));
  }
}

// Create empty goals.md if missing
const goalsPath = join(ROOT, 'goals.md');
if (!existsSync(goalsPath)) {
  writeFileSync(goalsPath, '# Goals\n\n(Add your goals here. Run `node goals_manager.mjs index` after editing.)\n', 'utf8');
  console.log(green('✓') + ' Created goals.md');
}

// Create empty memory.md if missing
const memoryPath = join(ROOT, 'memory.md');
if (!existsSync(memoryPath)) {
  writeFileSync(memoryPath, '# Memory\n\n(Curated long-term facts. Append-only — never overwrite existing entries.)\n', 'utf8');
  console.log(green('✓') + ' Created memory.md');
}

// Create .env from .env.example if missing, with unique port
const envPath = join(ROOT, '.env');
const envExamplePath = join(ROOT, '.env.example');
let assignedPort = '3456';

if (!existsSync(envPath) && existsSync(envExamplePath)) {
  let envContent = readFileSync(envExamplePath, 'utf8');

  // Find next available port starting from 3456
  assignedPort = await findAvailablePort(3456);
  envContent = envContent.replace(/DASHBOARD_PORT=\d+/, `DASHBOARD_PORT=${assignedPort}`);

  writeFileSync(envPath, envContent, 'utf8');
  console.log(green('✓') + ` Created .env (port ${assignedPort})`);
} else if (existsSync(envPath)) {
  // Read existing port
  const existing = readFileSync(envPath, 'utf8');
  const match = existing.match(/DASHBOARD_PORT=(\d+)/);
  if (match) assignedPort = match[1];
  console.log(dim(`  .env already exists (port ${assignedPort})`));
}

async function findAvailablePort(startPort) {
  const { createServer } = await import('node:net');
  for (let port = startPort; port < startPort + 100; port++) {
    const available = await new Promise(resolve => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => { srv.close(); resolve(true); });
      srv.listen(port);
    });
    if (available) return String(port);
  }
  return String(startPort); // fallback
}

// ─── Done ────────────────────────────────────────────────────────────────────

console.log(bold('\nInstallation complete.\n'));
console.log('Next steps:');
console.log(`  1. ${bold('npm install')}              Install dependencies`);
console.log(`  2. ${bold('npm start')}                Start the bot + dashboard`);
console.log(`  3. Visit ${bold(`http://YOUR_IP:${assignedPort}/setup`)}  Configure via browser`);
console.log('');
console.log('For Google OAuth (one-time, if not already deployed):');
console.log(`  cd vercel-oauth && npx vercel --prod`);
console.log(`  Set env vars in Vercel dashboard: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, STATE_SECRET`);
console.log(`  Register redirect URI in Google Console: https://YOUR_APP.vercel.app/api/oauth`);
console.log(`  Then set OAUTH_HANDLER_URL in .env to your Vercel URL\n`);
