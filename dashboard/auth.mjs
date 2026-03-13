/**
 * dashboard/auth.mjs — Session token management
 *
 * Uses memory.db (shared with bot) to store dashboard session tokens.
 * Tokens are opaque 32-byte hex strings, delivered via Telegram deep links.
 */

import { randomBytes } from 'node:crypto';

const TTL_DAYS = 7;

/** Ensure the sessions table exists. Call once on startup. */
export function initSessionsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
}

/** Generate a new session token for a user. Returns the token string. */
export function createSession(db, userId) {
  const token     = randomBytes(32).toString('hex');
  const now       = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TTL_DAYS * 86400_000).toISOString();

  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, expiresAt);

  return token;
}

/** Validate a token. Returns { userId, expiresAt } or null if invalid/expired. */
export function validateSession(db, token) {
  if (!token) return null;

  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return null;

  if (new Date() > new Date(row.expires_at)) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  return { userId: row.user_id, expiresAt: row.expires_at };
}

/** Remove expired sessions. Returns count deleted. */
export function pruneExpiredSessions(db) {
  const now = new Date().toISOString();
  const result = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return result.changes;
}
