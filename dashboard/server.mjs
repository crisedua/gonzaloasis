/**
 * dashboard/server.mjs — HTTP server with routing, auth, and static file serving
 *
 * Zero external dependencies — uses only node:http, node:fs, node:path, node:sqlite.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSessionsTable, createSession, validateSession, pruneExpiredSessions } from './auth.mjs';
import { initConfigTable, getAllConfig, setMultiConfig, deleteConfig, deleteConfigByPrefix,
         getConfigStatus, loadConfigIntoEnv } from './config.mjs';
import { handleHome, handleGoals, handleGoalDetail, handleDocuments, handleDocumentView,
         handleMemory, handleHistory, handleCalendar, handleHelp,
         apiGoals, apiMemorySearch, apiDocuments, apiCalendar } from './routes.mjs';
import { loginPage } from './templates/layout.mjs';
import { setupWelcomePage, setupTelegramPage, setupGooglePage,
         setupTodoistPage, setupFreedcampPage, setupProfilePage,
         setupCompletePage } from './templates/setup.mjs';
import { adminPage } from './templates/admin.mjs';

const MIME_TYPES = {
  '.css':  'text/css',
  '.js':   'text/javascript',
  '.html': 'text/html',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
};

/**
 * Start the dashboard HTTP server.
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.rootDir - Project root (where memory.db lives)
 * @param {Function} opts.getUpcomingEvents - From calendar.mjs
 * @param {object} opts.services - External service functions { getTodoistTasks, getFreedcampTasks, getRecentEmails }
 */
export function startDashboard({ port, rootDir, getUpcomingEvents, services = {} }) {
  const dbPath = join(rootDir, 'memory.db');
  let db;
  try {
    db = new DatabaseSync(dbPath);
    initSessionsTable(db);
    initConfigTable(db);
  } catch (err) {
    console.error('Dashboard: could not open memory.db —', err.message);
    return null;
  }

  // Load config from DB into process.env (fills gaps only)
  loadConfigIntoEnv(db);

  // Prune expired sessions every hour
  setInterval(() => { try { pruneExpiredSessions(db); } catch {} }, 3600_000);

  const staticDir = join(import.meta.dirname, 'static');

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const path = url.pathname;

      // ── Static files ──────────────────────────────────────────────────
      if (path.startsWith('/static/')) {
        return serveStatic(res, staticDir, path.slice(7));
      }

      // ── Login page (no auth) ──────────────────────────────────────────
      if (path === '/login') {
        return sendHtml(res, 200, loginPage());
      }

      // ── Setup wizard routes (no auth on first run) ────────────────────
      if (path.startsWith('/setup') || path.startsWith('/api/setup/')) {
        return await handleSetupRoutes(req, res, path, url, db, rootDir, port);
      }

      // ── Google OAuth callback (no auth — Google redirects here) ───────
      if (path === '/oauth2callback') {
        return await handleOAuthCallback(req, res, url, db);
      }

      // ── OAuth token receiver (from central proxy — no auth) ───────────
      if (path === '/api/oauth-tokens' && req.method === 'POST') {
        return await handleOAuthTokens(req, res, db, rootDir);
      }

      // ── Auth middleware for /d/* and /api/* ────────────────────────────
      const token = extractToken(req, url);
      const session = validateSession(db, token);

      if (!session && path.startsWith('/api/')) {
        return sendJson(res, 401, { error: 'Unauthorized' });
      }
      if (!session && path.startsWith('/d')) {
        return sendHtml(res, 302, '', { Location: '/login' });
      }

      // Set cookie on first visit from Telegram link
      if (session && url.searchParams.has('t')) {
        res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; Max-Age=${7 * 86400}; SameSite=Lax`);
        // Redirect to clean URL (remove ?t=)
        return sendHtml(res, 302, '', { Location: path });
      }

      // ── Page routes ───────────────────────────────────────────────────

      // /d — overview
      if (path === '/d' || path === '/d/') {
        return sendHtml(res, 200, handleHome(rootDir));
      }

      // /d/goals
      if (path === '/d/goals') {
        return sendHtml(res, 200, handleGoals(rootDir));
      }

      // /d/goals/:id
      const goalMatch = path.match(/^\/d\/goals\/(\d+)$/);
      if (goalMatch) {
        return sendHtml(res, 200, handleGoalDetail(rootDir, goalMatch[1]));
      }

      // /d/documents
      if (path === '/d/documents') {
        return sendHtml(res, 200, handleDocuments(rootDir));
      }

      // /d/documents/:filename
      const docMatch = path.match(/^\/d\/documents\/(.+)$/);
      if (docMatch) {
        const filename = decodeURIComponent(docMatch[1]);
        return sendHtml(res, 200, handleDocumentView(rootDir, filename));
      }

      // /d/memory
      if (path === '/d/memory') {
        const q = url.searchParams.get('q') || '';
        return sendHtml(res, 200, handleMemory(rootDir, q));
      }

      // /d/history or /d/history/:date
      if (path === '/d/history') {
        return sendHtml(res, 200, handleHistory(rootDir, null));
      }
      const histMatch = path.match(/^\/d\/history\/(\d{4}-\d{2}-\d{2})$/);
      if (histMatch) {
        return sendHtml(res, 200, handleHistory(rootDir, histMatch[1]));
      }

      // /d/calendar (async — Google API)
      if (path === '/d/calendar') {
        const html = await handleCalendar(getUpcomingEvents);
        return sendHtml(res, 200, html);
      }

      // /d/help
      if (path === '/d/help') {
        return sendHtml(res, 200, handleHelp());
      }

      // /d/admin
      if (path === '/d/admin') {
        const status = getConfigStatus(db);
        const config = getAllConfig(db);
        return sendHtml(res, 200, adminPage({ status, config }));
      }

      // ── API routes ────────────────────────────────────────────────────

      if (path === '/api/goals') {
        return sendJson(res, 200, apiGoals(rootDir));
      }

      if (path === '/api/memory/search') {
        const q = url.searchParams.get('q') || '';
        return sendJson(res, 200, apiMemorySearch(rootDir, q));
      }

      if (path === '/api/documents') {
        return sendJson(res, 200, apiDocuments(rootDir));
      }

      if (path === '/api/calendar') {
        const data = await apiCalendar(getUpcomingEvents);
        return sendJson(res, 200, data);
      }

      if (path === '/api/todoist') {
        if (!services.getTodoistTasks) return sendJson(res, 200, { data: [], error: 'Todoist not configured' });
        try {
          const data = await services.getTodoistTasks();
          return sendJson(res, 200, { data, error: null });
        } catch (err) {
          console.error('Dashboard /api/todoist error:', err.message);
          return sendJson(res, 200, { data: [], error: err.message });
        }
      }

      if (path === '/api/freedcamp') {
        if (!services.getFreedcampTasks) return sendJson(res, 200, { data: [], error: 'Freedcamp not configured' });
        try {
          const data = await services.getFreedcampTasks();
          return sendJson(res, 200, { data, error: null });
        } catch (err) {
          console.error('Dashboard /api/freedcamp error:', err.message);
          return sendJson(res, 200, { data: [], error: err.message });
        }
      }

      if (path === '/api/emails') {
        if (!services.getRecentEmails) return sendJson(res, 200, { data: [], error: 'Gmail not configured' });
        try {
          const data = await services.getRecentEmails();
          return sendJson(res, 200, { data, error: null });
        } catch (err) {
          console.error('Dashboard /api/emails error:', err.message);
          return sendJson(res, 200, { data: [], error: err.message });
        }
      }

      // ── Config API routes (auth required) ─────────────────────────────

      if (path === '/api/config/status') {
        return sendJson(res, 200, getConfigStatus(db));
      }

      if (path === '/api/config/save' && req.method === 'POST') {
        return await handleConfigSave(req, res, db);
      }

      if (path.startsWith('/api/config/test/') && req.method === 'POST') {
        const service = path.split('/').pop();
        return await handleConfigTest(res, service);
      }

      if (path.startsWith('/api/config/disconnect/') && req.method === 'POST') {
        const service = path.split('/').pop();
        return handleConfigDisconnect(res, db, service, rootDir);
      }

      // ── Redirect root ────────────────────────────────────────────────
      if (path === '/') {
        // If not configured, redirect to setup
        if (!process.env.TELEGRAM_BOT_TOKEN) {
          return sendHtml(res, 302, '', { Location: '/setup' });
        }
        return sendHtml(res, 302, '', { Location: '/d' });
      }

      // ── 404 ───────────────────────────────────────────────────────────
      sendHtml(res, 404, '<h1>Not Found</h1>');

    } catch (err) {
      console.error('Dashboard error:', err);
      sendHtml(res, 500, '<h1>Internal Server Error</h1>');
    }
  });

  server.listen(port, () => {
    console.log(`Dashboard running at http://localhost:${port}/d`);
  });

  return {
    server,
    db,
    /** Generate a session token for a Telegram user. */
    createTokenForUser(userId) {
      return createSession(db, userId);
    },
  };
}

// ─── Setup wizard route handler ─────────────────────────────────────────────

async function handleSetupRoutes(req, res, path, url, db, rootDir, port) {
  const config = getAllConfig(db);
  const status = getConfigStatus(db);

  // GET pages
  if (req.method === 'GET') {
    if (path === '/setup' || path === '/setup/') {
      return sendHtml(res, 200, setupWelcomePage());
    }
    if (path === '/setup/telegram') {
      return sendHtml(res, 200, setupTelegramPage({
        token: config.TELEGRAM_BOT_TOKEN || '',
        userId: config.ALLOWED_TELEGRAM_USER_ID || '',
        error: url.searchParams.get('error'),
        success: url.searchParams.get('success'),
      }));
    }
    if (path === '/setup/google') {
      // Auto-compute redirect URI from request host if not set
      const defaultRedirect = `http://${req.headers.host}/oauth2callback`;
      return sendHtml(res, 200, setupGooglePage({
        clientId: config.GOOGLE_CLIENT_ID || '',
        clientSecret: config.GOOGLE_CLIENT_SECRET || '',
        redirectUri: process.env.GOOGLE_REDIRECT_URI || config.GOOGLE_REDIRECT_URI || defaultRedirect,
        authorized: status.google.authorized,
        error: url.searchParams.get('error'),
        success: url.searchParams.get('success'),
      }));
    }
    if (path === '/setup/todoist') {
      return sendHtml(res, 200, setupTodoistPage({
        apiToken: config.TODOIST_API_TOKEN || '',
        error: url.searchParams.get('error'),
        success: url.searchParams.get('success'),
      }));
    }
    if (path === '/setup/freedcamp') {
      return sendHtml(res, 200, setupFreedcampPage({
        apiKey: config.FREEDCAMP_API_KEY || '',
        apiSecret: config.FREEDCAMP_API_SECRET || '',
        error: url.searchParams.get('error'),
        success: url.searchParams.get('success'),
      }));
    }
    if (path === '/setup/profile') {
      return sendHtml(res, 200, setupProfilePage({
        name: config.USER_NAME || '',
        timezone: config.TIMEZONE || process.env.TIMEZONE || 'UTC',
        role: config.USER_ROLE || '',
        error: url.searchParams.get('error'),
        success: url.searchParams.get('success'),
      }));
    }
    if (path === '/setup/complete') {
      return sendHtml(res, 200, setupCompletePage({ status }));
    }
  }

  // POST API handlers
  if (req.method === 'POST') {
    const body = await parseFormBody(req);

    if (path === '/api/setup/telegram') {
      const token = (body.token || '').trim();
      const userId = (body.userId || '').trim();
      if (!token) {
        return sendHtml(res, 302, '', { Location: '/setup/telegram?error=Bot+token+is+required' });
      }
      // Test the token with Telegram API
      try {
        const tgRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
        const tgData = await tgRes.json();
        if (!tgData.ok) throw new Error(tgData.description || 'Invalid token');

        setMultiConfig(db, { TELEGRAM_BOT_TOKEN: token, ALLOWED_TELEGRAM_USER_ID: userId });
        process.env.TELEGRAM_BOT_TOKEN = token;
        if (userId) process.env.ALLOWED_TELEGRAM_USER_ID = userId;

        const botName = tgData.result.first_name || 'Bot';
        return sendHtml(res, 302, '', {
          Location: `/setup/google?success=Connected+to+${encodeURIComponent(botName)}`,
        });
      } catch (err) {
        return sendHtml(res, 302, '', {
          Location: `/setup/telegram?error=${encodeURIComponent(err.message)}`,
        });
      }
    }

    if (path === '/api/setup/google') {
      const clientId = (body.clientId || '').trim();
      const clientSecret = (body.clientSecret || '').trim();
      const redirectUri = (body.redirectUri || '').trim();
      if (clientId && clientSecret) {
        const entries = { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret };
        if (redirectUri) entries.GOOGLE_REDIRECT_URI = redirectUri;
        setMultiConfig(db, entries);
        process.env.GOOGLE_CLIENT_ID = clientId;
        process.env.GOOGLE_CLIENT_SECRET = clientSecret;
        if (redirectUri) process.env.GOOGLE_REDIRECT_URI = redirectUri;
      }
      return sendHtml(res, 302, '', { Location: '/setup/google?success=Credentials+saved' });
    }

    if (path === '/api/setup/todoist') {
      const apiToken = (body.apiToken || '').trim();
      if (apiToken) {
        // Test the token
        try {
          const tdRes = await fetch('https://api.todoist.com/api/v1/projects', {
            headers: { Authorization: `Bearer ${apiToken}` },
          });
          if (!tdRes.ok) throw new Error(`HTTP ${tdRes.status}`);

          setMultiConfig(db, { TODOIST_API_TOKEN: apiToken });
          process.env.TODOIST_API_TOKEN = apiToken;
          return sendHtml(res, 302, '', { Location: '/setup/freedcamp?success=Todoist+connected' });
        } catch (err) {
          return sendHtml(res, 302, '', {
            Location: `/setup/todoist?error=${encodeURIComponent('Test failed: ' + err.message)}`,
          });
        }
      }
      return sendHtml(res, 302, '', { Location: '/setup/freedcamp' });
    }

    if (path === '/api/setup/freedcamp') {
      const apiKey = (body.apiKey || '').trim();
      const apiSecret = (body.apiSecret || '').trim();
      if (apiKey && apiSecret) {
        // Test credentials
        try {
          const { createHmac } = await import('node:crypto');
          const timestamp = Math.floor(Date.now() / 1000);
          const hash = createHmac('sha1', apiSecret).update(apiKey + timestamp).digest('hex');
          const fcUrl = `https://freedcamp.com/api/v1/projects?api_key=${apiKey}&timestamp=${timestamp}&hash=${hash}`;
          const fcRes = await fetch(fcUrl);
          if (!fcRes.ok) throw new Error(`HTTP ${fcRes.status}`);

          setMultiConfig(db, { FREEDCAMP_API_KEY: apiKey, FREEDCAMP_API_SECRET: apiSecret });
          process.env.FREEDCAMP_API_KEY = apiKey;
          process.env.FREEDCAMP_API_SECRET = apiSecret;
          return sendHtml(res, 302, '', { Location: '/setup/profile?success=Freedcamp+connected' });
        } catch (err) {
          return sendHtml(res, 302, '', {
            Location: `/setup/freedcamp?error=${encodeURIComponent('Test failed: ' + err.message)}`,
          });
        }
      }
      return sendHtml(res, 302, '', { Location: '/setup/profile' });
    }

    if (path === '/api/setup/profile') {
      const name = (body.name || '').trim();
      const role = (body.role || '').trim();
      const timezone = (body.timezone || 'UTC').trim();

      if (name) {
        setMultiConfig(db, { USER_NAME: name, USER_ROLE: role, TIMEZONE: timezone });
        process.env.TIMEZONE = timezone;
        process.env.CALENDAR_TIMEZONE = timezone;

        // Generate user.md from template or overwrite placeholder template
        const userMdPath = join(rootDir, 'user.md');
        const templatePath = join(rootDir, 'templates', 'user.md.template');
        let userMd;
        if (existsSync(templatePath)) {
          userMd = readFileSync(templatePath, 'utf8')
            .replace(/\{\{NAME\}\}/g, name)
            .replace(/\{\{LOCATION\}\}/g, timezone.split('/')[1]?.replace(/_/g, ' ') || '')
            .replace(/\{\{PLATFORM\}\}/g, process.platform === 'win32' ? 'Windows' : 'Linux')
            .replace(/\{\{ROLE\}\}/g, role)
            .replace(/\{\{DESCRIPTION\}\}/g, role);
        } else {
          userMd = [
            `# User`,
            ``,
            `## Identity`,
            `- **Name:** ${name}`,
            role ? `- **Role:** ${role}` : null,
            `- **Timezone:** ${timezone}`,
            ``,
            `## Communication Preferences`,
            `- Concise responses preferred`,
            `- No emojis unless asked`,
          ].filter(Boolean).join('\n');
        }
        writeFileSync(userMdPath, userMd, 'utf8');
      }
      return sendHtml(res, 302, '', { Location: '/setup/complete' });
    }
  }

  // Google test from setup page (no auth needed)
  if (path === '/api/setup/test/google' && req.method === 'POST') {
    return await handleConfigTest(res, 'google');
  }

  // Google OAuth connect redirect
  if (path === '/api/setup/google-connect') {
    const from = req.headers.referer?.includes('/d/admin') ? '/d/admin' : '/setup/google';

    // ── Vercel OAuth handler (recommended — provides HTTPS automatically) ──
    const oauthHandlerUrl = process.env.OAUTH_HANDLER_URL;
    if (oauthHandlerUrl) {
      const callbackBase = process.env.DASHBOARD_URL || `http://${req.headers.host}`;
      const vercelUrl = `${oauthHandlerUrl}?callback=${encodeURIComponent(callbackBase)}&from=${encodeURIComponent(from)}`;
      return sendHtml(res, 302, '', { Location: vercelUrl });
    }

    // ── Direct mode (localhost development or custom HTTPS) ──
    try {
      const { google } = await import('googleapis');
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
      }

      const redirectUri = process.env.GOOGLE_REDIRECT_URI || `http://${req.headers.host}/oauth2callback`;
      process.env.GOOGLE_REDIRECT_URI = redirectUri;

      const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.send',
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/drive.readonly',
          'https://www.googleapis.com/auth/drive.file',
          'https://www.googleapis.com/auth/calendar.readonly',
          'https://www.googleapis.com/auth/calendar.events',
          'https://www.googleapis.com/auth/presentations',
        ],
        prompt: 'consent',
        state: JSON.stringify({ port }),
      });

      return sendHtml(res, 302, '', { Location: authUrl });
    } catch (err) {
      return sendHtml(res, 302, '', {
        Location: `${from}?error=${encodeURIComponent(err.message)}`,
      });
    }
  }

  sendHtml(res, 404, '<h1>Not Found</h1>');
}

// ─── OAuth token receiver (from central proxy) ─────────────────────────────

async function handleOAuthTokens(req, res, db, rootDir) {
  try {
    const body = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
      req.on('error', reject);
    });

    // Save tokens to file (same as exchangeCode does)
    const tokensPath = join(rootDir, '.google-tokens.json');
    writeFileSync(tokensPath, JSON.stringify(body, null, 2), 'utf8');

    // Also save to DB for backup
    setMultiConfig(db, { google_tokens: JSON.stringify(body) });

    return sendJson(res, 200, { ok: true });
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }
}

// ─── Google OAuth callback ──────────────────────────────────────────────────

async function handleOAuthCallback(req, res, url, db) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return sendHtml(res, 302, '', {
      Location: `/setup/google?error=${encodeURIComponent(error)}`,
    });
  }

  if (!code) {
    return sendHtml(res, 302, '', {
      Location: '/setup/google?error=No+authorization+code+received',
    });
  }

  try {
    const { exchangeCode } = await import('../google-auth.mjs');
    const tokens = await exchangeCode(code);
    // Also save tokens to DB config for backup
    setMultiConfig(db, { google_tokens: JSON.stringify(tokens) });

    // Determine redirect target (admin or setup)
    const redirectTo = process.env.TELEGRAM_BOT_TOKEN
      ? '/d/admin?success=Google+connected+successfully'
      : '/setup/todoist?success=Google+connected+successfully';
    return sendHtml(res, 302, '', { Location: redirectTo });
  } catch (err) {
    return sendHtml(res, 302, '', {
      Location: `/setup/google?error=${encodeURIComponent('OAuth failed: ' + err.message)}`,
    });
  }
}

// ─── Config save (admin panel) ──────────────────────────────────────────────

async function handleConfigSave(req, res, db) {
  const body = await parseFormBody(req);
  const section = body.section;
  delete body.section;

  // Filter out empty values (don't overwrite with blank)
  const entries = {};
  for (const [key, value] of Object.entries(body)) {
    const v = (value || '').trim();
    if (v) entries[key] = v;
  }

  if (Object.keys(entries).length > 0) {
    setMultiConfig(db, entries);
    // Update process.env live
    for (const [key, value] of Object.entries(entries)) {
      if (key !== 'google_tokens') process.env[key] = value;
    }
    // Sync TIMEZONE to CALENDAR_TIMEZONE
    if (entries.TIMEZONE) process.env.CALENDAR_TIMEZONE = entries.TIMEZONE;
  }

  return sendHtml(res, 302, '', { Location: '/d/admin?saved=1' });
}

// ─── Config test ────────────────────────────────────────────────────────────

async function handleConfigTest(res, service) {
  try {
    if (service === 'telegram') {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) return sendJson(res, 200, { ok: false, error: 'No token configured' });
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const d = await r.json();
      if (!d.ok) return sendJson(res, 200, { ok: false, error: d.description });
      return sendJson(res, 200, { ok: true, info: `Bot: ${d.result.first_name} (@${d.result.username})` });
    }

    if (service === 'google') {
      const { getAuthClient } = await import('../google-auth.mjs');
      const auth = await getAuthClient();
      // Try a simple calendar list to verify
      const { google } = await import('googleapis');
      const cal = google.calendar({ version: 'v3', auth });
      const r = await cal.calendarList.list({ maxResults: 1 });
      return sendJson(res, 200, { ok: true, info: `Connected (${r.data.items?.length || 0} calendars found)` });
    }

    if (service === 'todoist') {
      const token = process.env.TODOIST_API_TOKEN;
      if (!token) return sendJson(res, 200, { ok: false, error: 'No token configured' });
      const r = await fetch('https://api.todoist.com/api/v1/projects', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return sendJson(res, 200, { ok: false, error: `HTTP ${r.status}` });
      const d = await r.json();
      const count = Array.isArray(d.results) ? d.results.length : (Array.isArray(d) ? d.length : 0);
      return sendJson(res, 200, { ok: true, info: `Connected (${count} projects)` });
    }

    if (service === 'freedcamp') {
      const key = process.env.FREEDCAMP_API_KEY;
      const secret = process.env.FREEDCAMP_API_SECRET;
      if (!key || !secret) return sendJson(res, 200, { ok: false, error: 'Credentials not configured' });
      const { createHmac } = await import('node:crypto');
      const ts = Math.floor(Date.now() / 1000);
      const hash = createHmac('sha1', secret).update(key + ts).digest('hex');
      const r = await fetch(`https://freedcamp.com/api/v1/projects?api_key=${key}&timestamp=${ts}&hash=${hash}`);
      if (!r.ok) return sendJson(res, 200, { ok: false, error: `HTTP ${r.status}` });
      const d = await r.json();
      const count = d.data?.projects?.length || 0;
      return sendJson(res, 200, { ok: true, info: `Connected (${count} projects)` });
    }

    return sendJson(res, 200, { ok: false, error: 'Unknown service' });
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: err.message });
  }
}

// ─── Config disconnect ──────────────────────────────────────────────────────

function handleConfigDisconnect(res, db, service, rootDir) {
  if (service === 'google') {
    deleteConfig(db, 'google_tokens');
    deleteConfig(db, 'GOOGLE_CLIENT_ID');
    deleteConfig(db, 'GOOGLE_CLIENT_SECRET');
    deleteConfig(db, 'GOOGLE_REDIRECT_URI');
    // Remove tokens file
    const tokensFile = join(rootDir, '.google-tokens.json');
    try { if (existsSync(tokensFile)) writeFileSync(tokensFile, '', 'utf8'); } catch {}
  } else if (service === 'todoist') {
    deleteConfig(db, 'TODOIST_API_TOKEN');
    delete process.env.TODOIST_API_TOKEN;
  } else if (service === 'freedcamp') {
    deleteConfig(db, 'FREEDCAMP_API_KEY');
    deleteConfig(db, 'FREEDCAMP_API_SECRET');
    delete process.env.FREEDCAMP_API_KEY;
    delete process.env.FREEDCAMP_API_SECRET;
  }
  return sendJson(res, 200, { ok: true });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractToken(req, url) {
  // Check query param first
  const qToken = url.searchParams.get('t');
  if (qToken) return qToken;

  // Check cookie
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

function serveStatic(res, baseDir, relPath) {
  // Prevent path traversal
  if (relPath.includes('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const filePath = join(baseDir, relPath);
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext  = extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const data = readFileSync(filePath);

  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-cache',
  });
  res.end(data);
}

function sendHtml(res, status, html, extraHeaders = {}) {
  const headers = { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders };
  res.writeHead(status, headers);
  res.end(html);
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(data));
}

/** Parse URL-encoded form body from POST request. */
function parseFormBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const params = new URLSearchParams(raw);
      const result = {};
      for (const [key, value] of params) result[key] = value;
      resolve(result);
    });
    req.on('error', reject);
  });
}
