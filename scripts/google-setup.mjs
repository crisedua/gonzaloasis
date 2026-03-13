#!/usr/bin/env node
/**
 * scripts/google-setup.mjs
 *
 * One-time OAuth 2.0 setup for Gmail + Drive.
 * Spins up a temporary localhost server to catch the OAuth callback —
 * no manual copy-pasting of codes required.
 *
 * Usage (run locally, NOT on VPS):
 *   node scripts/google-setup.mjs
 *
 * Steps before running:
 *   1. Google Cloud Console → create/select a project
 *   2. Enable Gmail API + Google Drive API + Google Docs API
 *   3. OAuth consent screen → External → add your own email as test user
 *   4. Credentials → OAuth 2.0 Client ID → Application type: Web application
 *      Authorized redirect URI: http://localhost:3456/oauth2callback
 *   5. Copy Client ID + Client Secret into .env
 *   6. Run this script — your browser will open automatically
 *   7. .google-tokens.json is written — copy it to your VPS
 *
 * Requires: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in .env
 */

import 'dotenv/config';
import { createServer } from 'node:http';
import { getAuthUrl, exchangeCode, isAuthorised } from '../google-auth.mjs';

const PORT = 3456;

if (isAuthorised()) {
  console.log('.google-tokens.json already exists — you are authorised.');
  console.log('Delete .google-tokens.json and re-run to re-authorise.');
  process.exit(0);
}

console.log('\n=== Google OAuth Setup ===\n');

const url = getAuthUrl();
console.log('Opening browser...\n');
console.log('If the browser does not open, visit this URL manually:\n');
console.log(url, '\n');

// Try to open the browser automatically
const { exec } = await import('node:child_process');
const open = process.platform === 'win32'
  ? `start "" "${url}"`
  : process.platform === 'darwin'
    ? `open "${url}"`
    : `xdg-open "${url}"`;
exec(open);

// Spin up a temporary HTTP server to catch the callback
await new Promise((resolve, reject) => {
  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

    if (reqUrl.pathname !== '/oauth2callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const code  = reqUrl.searchParams.get('code');
    const error = reqUrl.searchParams.get('error');

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h2>Authorisation denied: ${error}</h2><p>You can close this tab.</p>`);
      server.close();
      reject(new Error(`OAuth denied: ${error}`));
      return;
    }

    if (!code) {
      res.writeHead(400);
      res.end('No code received.');
      return;
    }

    try {
      await exchangeCode(code);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Google authorised.</h2><p>You can close this tab and return to the terminal.</p>');
      console.log('\nSuccess! .google-tokens.json saved.');
      console.log('Copy this file to your VPS alongside the project.\n');
      server.close();
      resolve();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error: ${err.message}`);
      server.close();
      reject(err);
    }
  });

  server.listen(PORT, () => {
    console.log(`Waiting for Google callback on http://localhost:${PORT}/oauth2callback ...\n`);
  });

  server.on('error', err => {
    reject(new Error(`Could not start server on port ${PORT}: ${err.message}`));
  });
});
