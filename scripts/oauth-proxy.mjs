#!/usr/bin/env node
/**
 * scripts/oauth-proxy.mjs — Central OAuth callback proxy
 *
 * Runs on a single fixed port. All client instances share one Google redirect URI.
 * Each instance encodes its port in the OAuth `state` parameter.
 * After token exchange, tokens are POSTed to the correct instance.
 *
 * Usage:
 *   node scripts/oauth-proxy.mjs
 *
 * Env:
 *   OAUTH_PROXY_PORT  — port to listen on (default: 3400)
 *   GOOGLE_CLIENT_ID  — shared OAuth client ID
 *   GOOGLE_CLIENT_SECRET — shared OAuth client secret
 */

import { createServer } from 'node:http';
import { config } from 'dotenv';
import { resolve } from 'node:path';

// Load .env from project root
config({ path: resolve(import.meta.dirname, '..', '.env') });

const PORT = parseInt(process.env.OAUTH_PROXY_PORT || '3400', 10);
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const stateRaw = url.searchParams.get('state');

  // Parse state to get the instance port
  let instancePort;
  try {
    const state = JSON.parse(stateRaw || '{}');
    instancePort = state.port;
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid state parameter');
    return;
  }

  if (!instancePort) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing instance port in state');
    return;
  }

  // Build the instance's base URL (always localhost since same VPS)
  const instanceBase = `http://localhost:${instancePort}`;

  if (error) {
    res.writeHead(302, { Location: `${instanceBase}/setup/google?error=${encodeURIComponent(error)}` });
    res.end();
    return;
  }

  if (!code) {
    res.writeHead(302, { Location: `${instanceBase}/setup/google?error=No+authorization+code+received` });
    res.end();
    return;
  }

  // Exchange the code for tokens using googleapis
  try {
    const { google } = await import('googleapis');
    // Use env var if set (required when behind HTTPS reverse proxy like Caddy)
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `http://${req.headers.host}/oauth2callback`;
    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri);
    const { tokens } = await oauth2Client.getToken(code);

    // POST tokens to the instance
    const postRes = await fetch(`${instanceBase}/api/oauth-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens),
    });

    if (!postRes.ok) {
      throw new Error(`Instance returned ${postRes.status}`);
    }

    // Redirect client back to their setup page
    const successUrl = `${instanceBase}/setup/google?success=Google+connected+successfully`;
    // Use the public host (not localhost) for the browser redirect
    const publicUrl = successUrl.replace('localhost', req.headers.host.split(':')[0]);
    res.writeHead(302, { Location: publicUrl });
    res.end();
  } catch (err) {
    console.error('[oauth-proxy] Token exchange failed:', err.message);
    const errUrl = `${instanceBase}/setup/google?error=${encodeURIComponent('OAuth failed: ' + err.message)}`;
    const publicErrUrl = errUrl.replace('localhost', req.headers.host.split(':')[0]);
    res.writeHead(302, { Location: publicErrUrl });
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`OAuth proxy running on port ${PORT}`);
  console.log(`Redirect URI: http://YOUR_VPS_IP:${PORT}/oauth2callback`);
});
