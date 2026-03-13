/**
 * dashboard/config.mjs — Config table CRUD for SQLite-based configuration
 *
 * Stores all configurable values (API tokens, credentials, settings) in a
 * `config` table inside memory.db. Values set in .env take precedence.
 */

// ─── Table init ──────────────────────────────────────────────────────────────

export function initConfigTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/** Get a single config value. Returns null if not found. */
export function getConfig(db, key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

/** Get all config values as a { key: value } object. */
export function getAllConfig(db) {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const result = {};
  for (const r of rows) result[r.key] = r.value;
  return result;
}

/** Upsert a single config value. */
export function setConfig(db, key, value) {
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

/** Batch upsert multiple config values. entries = { key: value, ... } */
export function setMultiConfig(db, entries) {
  const stmt = db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== null && value !== '') {
      stmt.run(key, String(value));
    }
  }
}

/** Delete a config entry. */
export function deleteConfig(db, key) {
  db.prepare('DELETE FROM config WHERE key = ?').run(key);
}

/** Delete multiple config entries by prefix (e.g. all GOOGLE_* keys). */
export function deleteConfigByPrefix(db, prefix) {
  db.prepare('DELETE FROM config WHERE key LIKE ?').run(`${prefix}%`);
}

// ─── Environment merge ───────────────────────────────────────────────────────

/**
 * Load all config from DB into process.env.
 * .env values take precedence — DB only fills gaps.
 *
 * Stores the original .env keys so we know which came from file vs DB.
 */
const ENV_FILE_KEYS = new Set(Object.keys(process.env));

export function loadConfigIntoEnv(db) {
  const config = getAllConfig(db);
  for (const [key, value] of Object.entries(config)) {
    // Skip internal keys that shouldn't go to process.env
    if (key === 'google_tokens') continue;
    // .env values take precedence
    if (!ENV_FILE_KEYS.has(key) || !process.env[key]) {
      process.env[key] = value;
    }
  }
}

// ─── Status helpers ──────────────────────────────────────────────────────────

/** Returns integration status flags for the admin panel. */
export function getConfigStatus(db) {
  const c = getAllConfig(db);
  const env = process.env;

  // Helper: check if a key has a value in either env or config
  const has = (key) => !!(env[key] || c[key]);

  return {
    telegram: {
      configured: has('TELEGRAM_BOT_TOKEN'),
      userId: env.ALLOWED_TELEGRAM_USER_ID || c.ALLOWED_TELEGRAM_USER_ID || null,
    },
    google: {
      configured: has('GOOGLE_CLIENT_ID') && has('GOOGLE_CLIENT_SECRET'),
      authorized: !!c.google_tokens,
    },
    todoist: {
      configured: has('TODOIST_API_TOKEN'),
    },
    freedcamp: {
      configured: has('FREEDCAMP_API_KEY') && has('FREEDCAMP_API_SECRET'),
    },
    bot: {
      model: env.CLAUDE_MODEL || c.CLAUDE_MODEL || 'opus',
      timezone: env.TIMEZONE || env.CALENDAR_TIMEZONE || c.TIMEZONE || 'UTC',
      dashboardUrl: env.DASHBOARD_URL || c.DASHBOARD_URL || '',
      driveFolder: env.DRIVE_FOLDER || c.DRIVE_FOLDER || 'AI Assistant',
    },
  };
}

/** Mask a token/secret for display (show last 6 chars). */
export function maskSecret(value) {
  if (!value || value.length < 10) return value ? '••••••' : '';
  return '••••••' + value.slice(-6);
}
