/**
 * google-auth.mjs — OAuth 2.0 client for Gmail + Drive + Calendar
 *
 * Reads credentials from process.env.
 * Tokens are stored in .google-tokens.json at the project root.
 *
 * Exports:
 *   getAuthClient()   → authenticated OAuth2Client (throws if not authorised)
 *   getAuthUrl()      → URL the user must visit to authorise
 *   exchangeCode(code) → exchanges auth code → saves tokens
 *   isAuthorised()    → boolean
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = resolve(__dirname, '.google-tokens.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/presentations',
];

function makeClient() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/** Returns true if tokens are saved on disk. */
export function isAuthorised() {
  return existsSync(TOKENS_FILE);
}

/** Returns the URL the user must visit to grant access. */
export function getAuthUrl() {
  const client = makeClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

/**
 * Exchanges a one-time authorisation code for tokens.
 * Saves tokens to .google-tokens.json.
 */
export async function exchangeCode(code) {
  const client = makeClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  return tokens;
}

/**
 * Returns an authenticated OAuth2Client, refreshing tokens if needed.
 * Throws if the user has not completed the OAuth flow.
 */
export async function getAuthClient() {
  if (!isAuthorised()) {
    throw new Error('Google not authorised. Run /gauth in the bot or node scripts/google-setup.mjs');
  }

  const client = makeClient();
  const tokens = JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
  client.setCredentials(tokens);

  // Auto-refresh and persist updated tokens
  client.on('tokens', updated => {
    const merged = { ...tokens, ...updated };
    writeFileSync(TOKENS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  });

  return client;
}
