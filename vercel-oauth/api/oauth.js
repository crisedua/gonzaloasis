/**
 * Vercel serverless function — Central Google OAuth handler
 *
 * Provides HTTPS callback for Google OAuth on behalf of VPS bot instances.
 * Zero npm dependencies — uses only Node.js built-ins + fetch.
 *
 * Flow:
 *   1. VPS redirects user to: GET /api/oauth?callback=http://VPS:PORT&from=/setup/google
 *   2. This function generates Google auth URL and redirects to Google
 *   3. Google redirects back to: GET /api/oauth?code=xxx&state=xxx
 *   4. This function exchanges code for tokens
 *   5. POSTs tokens to VPS: POST http://VPS:PORT/api/oauth-tokens
 *   6. Redirects user's browser back to VPS setup/admin page
 *
 * Env vars (set in Vercel dashboard):
 *   GOOGLE_CLIENT_ID     — OAuth client ID
 *   GOOGLE_CLIENT_SECRET — OAuth client secret
 *   STATE_SECRET         — Random string for signing state parameter
 */

import crypto from 'node:crypto';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/presentations',
].join(' ');

/** Sign state data with HMAC to prevent tampering. */
function signState(data, secret) {
  const payload = JSON.stringify(data);
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
}

/** Verify and decode signed state. Throws on invalid signature. */
function verifyState(encoded, secret) {
  const { p, s } = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  const expected = crypto.createHmac('sha256', secret).update(p).digest('hex');
  if (s.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) {
    throw new Error('Invalid state signature');
  }
  return JSON.parse(p);
}

export default async function handler(req, res) {
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const STATE_SECRET = process.env.STATE_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET || !STATE_SECRET) {
    return res.status(500).json({ error: 'Server not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, STATE_SECRET.' });
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = new URL(req.url, `${proto}://${host}`);

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const callback = url.searchParams.get('callback');
  const from = url.searchParams.get('from') || '/setup/google';
  const stateRaw = url.searchParams.get('state');

  // This function's own URL = the Google redirect URI
  // Use explicit env var to guarantee it matches Google Console exactly
  const redirectUri = process.env.REDIRECT_URI || `${proto}://${host}/api/oauth`;

  // ── Mode 1: Start OAuth flow ──────────────────────────────────────────────
  // Triggered by: GET /api/oauth?callback=http://VPS:PORT&from=/setup/google
  if (callback && !code && !stateRaw) {
    const state = signState({ callback, from }, STATE_SECRET);

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);

    return res.redirect(302, authUrl.toString());
  }

  // ── Mode 2: Handle Google callback ────────────────────────────────────────
  // Google redirects here with ?code=xxx&state=xxx (or ?error=xxx&state=xxx)

  if (error) {
    try {
      const { callback: cb, from: f } = verifyState(stateRaw, STATE_SECRET);
      return res.redirect(302, `${cb}${f}?error=${encodeURIComponent(error)}`);
    } catch {
      return res.status(400).json({ error });
    }
  }

  if (!code && !stateRaw && !callback) {
    // Landing page with usage instructions and debug info
    return res.status(200).json({
      service: 'AI Assistant OAuth Handler',
      usage: 'GET /api/oauth?callback=http://YOUR_VPS:PORT&from=/setup/google',
      redirect_uri: redirectUri,
      host,
      proto,
    });
  }

  let callbackUrl, fromPath;
  try {
    const state = verifyState(stateRaw, STATE_SECRET);
    callbackUrl = state.callback;
    fromPath = state.from || '/setup/google';
  } catch (err) {
    return res.status(400).json({ error: 'Invalid state: ' + err.message });
  }

  // Exchange authorization code for tokens
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      throw new Error(tokenData.error_description || tokenData.error);
    }

    // POST tokens to the VPS instance
    const postRes = await fetch(`${callbackUrl}/api/oauth-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenData),
    });

    if (!postRes.ok) {
      throw new Error(`Instance returned HTTP ${postRes.status}`);
    }

    // Redirect user's browser back to VPS
    return res.redirect(302, `${callbackUrl}${fromPath}?success=Google+connected+successfully`);
  } catch (err) {
    console.error('OAuth token exchange failed:', err.message);
    return res.redirect(302, `${callbackUrl}${fromPath}?error=${encodeURIComponent('OAuth failed: ' + err.message)}`);
  }
}
