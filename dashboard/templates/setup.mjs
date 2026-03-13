/**
 * dashboard/templates/setup.mjs — First-run setup wizard pages
 */

import { esc } from './layout.mjs';

const COMMON_HEAD = `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/static/dashboard.css?v=4">
`;

function setupShell({ title, step, totalSteps, content, prevHref }) {
  const progress = totalSteps ? Math.round((step / totalSteps) * 100) : 0;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${COMMON_HEAD}
  <title>${esc(title)} — Setup</title>
</head>
<body>
  <div class="setup-page">
    <div class="setup-box">
      <div class="setup-header">
        <h1>AI Assistant Setup</h1>
        ${totalSteps ? `
        <div class="setup-progress">
          <div class="setup-progress-bar" style="width:${progress}%"></div>
        </div>
        <p class="setup-step">Step ${step} of ${totalSteps}</p>
        ` : ''}
      </div>
      ${content}
      ${prevHref ? `<div class="setup-back"><a href="${prevHref}">&larr; Back</a></div>` : ''}
    </div>
  </div>
  <script src="/static/dashboard.js?v=4"></script>
</body>
</html>`;
}

// ─── Welcome ─────────────────────────────────────────────────────────────────

export function setupWelcomePage() {
  return setupShell({
    title: 'Welcome',
    content: `
      <h2>Welcome</h2>
      <p>This wizard will configure your AI Assistant. You'll connect your Telegram bot and optionally set up integrations like Gmail, Todoist, and Freedcamp.</p>
      <p>You'll need:</p>
      <ul class="setup-list">
        <li>A Telegram Bot Token (from <strong>@BotFather</strong>)</li>
        <li>Your Telegram user ID (from <strong>@userinfobot</strong>)</li>
        <li>Optionally: Google, Todoist, or Freedcamp credentials</li>
      </ul>
      <div class="setup-actions">
        <a href="/setup/telegram" class="btn btn-primary">Get Started</a>
      </div>
    `,
  });
}

// ─── Telegram ────────────────────────────────────────────────────────────────

export function setupTelegramPage({ token, userId, error, success }) {
  return setupShell({
    title: 'Telegram',
    step: 1,
    totalSteps: 5,
    prevHref: '/setup',
    content: `
      <h2>Telegram Bot</h2>
      <p>Create a bot with <strong>@BotFather</strong> on Telegram, then paste the token here.</p>
      ${error ? `<div class="alert alert-error">${esc(error)}</div>` : ''}
      ${success ? `<div class="alert alert-success">${esc(success)}</div>` : ''}
      <form method="POST" action="/api/setup/telegram" class="setup-form">
        <label>Bot Token <span class="required">*</span></label>
        <input type="text" name="token" value="${esc(token || '')}" placeholder="8624599957:AAFxX..." required>
        <label>Your Telegram User ID <span class="required">*</span></label>
        <input type="text" name="userId" value="${esc(userId || '')}" placeholder="7545369609" required>
        <p class="form-hint">Send a message to <strong>@userinfobot</strong> on Telegram to get your numeric ID.</p>
        <div class="setup-actions">
          <button type="submit" class="btn btn-primary">Save &amp; Test</button>
          <a href="/setup/google" class="btn btn-secondary">Skip for now</a>
        </div>
      </form>
    `,
  });
}

// ─── Google ──────────────────────────────────────────────────────────────────

export function setupGooglePage({ clientId, clientSecret, redirectUri, authorized, error, success }) {
  const preConfigured = !!(clientId || process.env.GOOGLE_CLIENT_ID);
  const vercelMode = !!process.env.OAUTH_HANDLER_URL;

  // Simple view: credentials are pre-configured, client just clicks to connect
  const simpleView = `
      <h2>Google Integration</h2>
      <p>Connect your Gmail, Google Drive, and Calendar with one click.${vercelMode ? '' : ' Requires HTTPS redirect URI — see admin for details.'}</p>
      ${error ? `<div class="alert alert-error">${esc(error)}</div>` : ''}
      ${success ? `<div class="alert alert-success">${esc(success)}</div>` : ''}
      ${authorized
        ? '<div class="alert alert-success">Google is connected and authorized.</div>'
        : '<p>Click the button below to sign in with your Google account. You\'ll be asked to grant access to Gmail, Drive, and Calendar.</p>'}
      <div id="google-test-result" style="margin-bottom:12px"></div>
      <div class="setup-actions">
        ${!authorized ? '<a href="/api/setup/google-connect" class="btn btn-accent">Connect to Google</a>' : ''}
        <button class="btn ${authorized ? 'btn-accent' : 'btn-secondary'}" onclick="testGoogle(this)">Test Connection</button>
        <a href="/setup/todoist" class="btn btn-secondary">${authorized ? 'Next' : 'Skip / Next'}</a>
      </div>
      ${authorized ? '' : '<p class="form-hint" style="margin-top:16px"><a href="#" onclick="document.getElementById(\'google-advanced\').style.display=\'block\';this.style.display=\'none\';return false;">Advanced: enter credentials manually</a></p>'}
      <script>
      async function testGoogle(btn) {
        const result = document.getElementById('google-test-result');
        btn.disabled = true;
        btn.textContent = 'Testing...';
        result.innerHTML = '';
        try {
          const res = await fetch('/api/setup/test/google', { method: 'POST' });
          const data = await res.json();
          if (data.ok) {
            result.innerHTML = '<div class="alert alert-success">' + data.info + '</div>';
          } else {
            result.innerHTML = '<div class="alert alert-error">Test failed: ' + (data.error || 'Unknown error') + '</div>';
          }
        } catch (err) {
          result.innerHTML = '<div class="alert alert-error">Test failed: ' + err.message + '</div>';
        }
        btn.disabled = false;
        btn.textContent = 'Test Connection';
      }
      </script>
      <div id="google-advanced" style="display:none">
  `;

  // Manual credential form (shown by default when no credentials, or via "Advanced" toggle)
  const credentialForm = `
      <form method="POST" action="/api/setup/google" class="setup-form">
        <p style="margin-bottom:12px">Enter your own Google OAuth credentials:</p>
        <ol class="setup-list">
          <li>Create a project in <a href="https://console.cloud.google.com" target="_blank">Google Cloud Console</a></li>
          <li>Enable: Gmail API, Google Drive API, Google Docs API, Google Calendar API</li>
          <li>Create OAuth 2.0 credentials (Web Application type)</li>
          <li>Add the Redirect URI below as an authorized redirect URI</li>
        </ol>
        <label>Client ID</label>
        <input type="text" name="clientId" value="${esc(clientId || '')}" placeholder="1028688238923-...apps.googleusercontent.com">
        <label>Client Secret</label>
        <input type="text" name="clientSecret" value="${esc(clientSecret || '')}" placeholder="GOCSPX-...">
        ${vercelMode ? '' : `
        <label>Redirect URI</label>
        <input type="text" name="redirectUri" value="${esc(redirectUri || '')}" placeholder="http://YOUR_IP:3456/oauth2callback">
        <p class="form-hint">Must match exactly what you entered in Google Cloud Console.</p>
        `}
        <div class="setup-actions">
          <button type="submit" class="btn btn-primary">Save Credentials</button>
        </div>
      </form>
  `;

  // If pre-configured: show simple view with hidden advanced form
  // If not configured: show manual form directly
  const content = preConfigured
    ? simpleView + credentialForm + '</div>'
    : `
      <h2>Google Integration</h2>
      <p>Connect Gmail, Google Drive, and Calendar.</p>
      ${error ? `<div class="alert alert-error">${esc(error)}</div>` : ''}
      ${success ? `<div class="alert alert-success">${esc(success)}</div>` : ''}
      ${authorized ? '<div class="alert alert-success">Google is connected and authorized.</div>' : ''}
      ${credentialForm}
      <div class="setup-actions" style="margin-top:12px">
        ${!authorized && clientId
          ? '<a href="/api/setup/google-connect" class="btn btn-accent">Connect to Google</a>'
          : ''}
        <a href="/setup/todoist" class="btn btn-secondary">Skip / Next</a>
      </div>
    `;

  return setupShell({
    title: 'Google',
    step: 2,
    totalSteps: 5,
    prevHref: '/setup/telegram',
    content,
  });
}

// ─── Todoist ─────────────────────────────────────────────────────────────────

export function setupTodoistPage({ apiToken, error, success }) {
  return setupShell({
    title: 'Todoist',
    step: 3,
    totalSteps: 5,
    prevHref: '/setup/google',
    content: `
      <h2>Todoist</h2>
      <p>Connect to sync goals with Todoist. Get your API token from <strong>todoist.com &rarr; Settings &rarr; Integrations &rarr; Developer</strong>.</p>
      ${error ? `<div class="alert alert-error">${esc(error)}</div>` : ''}
      ${success ? `<div class="alert alert-success">${esc(success)}</div>` : ''}
      <form method="POST" action="/api/setup/todoist" class="setup-form">
        <label>API Token</label>
        <input type="text" name="apiToken" value="${esc(apiToken || '')}" placeholder="e5f8a2b1c3d4...">
        <div class="setup-actions">
          <button type="submit" class="btn btn-primary">Save &amp; Test</button>
          <a href="/setup/freedcamp" class="btn btn-secondary">Skip / Next</a>
        </div>
      </form>
    `,
  });
}

// ─── Freedcamp ───────────────────────────────────────────────────────────────

export function setupFreedcampPage({ apiKey, apiSecret, error, success }) {
  return setupShell({
    title: 'Freedcamp',
    step: 4,
    totalSteps: 5,
    prevHref: '/setup/todoist',
    content: `
      <h2>Freedcamp</h2>
      <p>Connect for task management integration. Get your API credentials from Freedcamp settings.</p>
      ${error ? `<div class="alert alert-error">${esc(error)}</div>` : ''}
      ${success ? `<div class="alert alert-success">${esc(success)}</div>` : ''}
      <form method="POST" action="/api/setup/freedcamp" class="setup-form">
        <label>API Key</label>
        <input type="text" name="apiKey" value="${esc(apiKey || '')}" placeholder="ad42c2e34be921e...">
        <label>API Secret</label>
        <input type="text" name="apiSecret" value="${esc(apiSecret || '')}" placeholder="a1ad52e489b0d7...">
        <div class="setup-actions">
          <button type="submit" class="btn btn-primary">Save &amp; Test</button>
          <a href="/setup/profile" class="btn btn-secondary">Skip / Next</a>
        </div>
      </form>
    `,
  });
}

// ─── Profile ─────────────────────────────────────────────────────────────────

export function setupProfilePage({ name, timezone, role, error, success }) {
  const timezones = [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Santiago', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
    'America/Mexico_City', 'America/Bogota', 'America/Lima',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
    'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Asia/Dubai',
    'Australia/Sydney', 'Pacific/Auckland', 'UTC',
  ];

  const tzOptions = timezones.map(tz =>
    `<option value="${tz}" ${tz === timezone ? 'selected' : ''}>${tz}</option>`
  ).join('');

  return setupShell({
    title: 'Profile',
    step: 5,
    totalSteps: 5,
    prevHref: '/setup/freedcamp',
    content: `
      <h2>Your Profile</h2>
      <p>Tell the assistant about you so it can personalize responses.</p>
      ${error ? `<div class="alert alert-error">${esc(error)}</div>` : ''}
      ${success ? `<div class="alert alert-success">${esc(success)}</div>` : ''}
      <form method="POST" action="/api/setup/profile" class="setup-form">
        <label>Your Name <span class="required">*</span></label>
        <input type="text" name="name" value="${esc(name || '')}" placeholder="John Smith" required>
        <label>Your Role / Title</label>
        <input type="text" name="role" value="${esc(role || '')}" placeholder="CEO, Manager, Consultant...">
        <label>Timezone</label>
        <select name="timezone">${tzOptions}</select>
        <div class="setup-actions">
          <button type="submit" class="btn btn-primary">Save Profile</button>
        </div>
      </form>
    `,
  });
}

// ─── Complete ────────────────────────────────────────────────────────────────

export function setupCompletePage({ status }) {
  const items = [
    { label: 'Telegram Bot', ok: status.telegram.configured, href: '/setup/telegram' },
    { label: 'Google (Gmail/Drive/Calendar)', ok: status.google.configured && status.google.authorized, href: '/setup/google' },
    { label: 'Todoist', ok: status.todoist.configured, href: '/setup/todoist' },
    { label: 'Freedcamp', ok: status.freedcamp.configured, href: '/setup/freedcamp' },
  ];

  const statusHtml = items.map(i => `
    <div class="setup-status-item">
      <span class="setup-status-icon ${i.ok ? 'ok' : 'skip'}">${i.ok ? '&#10003;' : '&#8211;'}</span>
      <span>${i.label}</span>
      <span style="margin-left:auto; display:flex; align-items:center; gap:8px;">
        <span class="setup-status-badge ${i.ok ? 'badge-active' : 'badge-paused'}">${i.ok ? 'Connected' : 'Skipped'}</span>
        <a href="${i.href}" style="font-size:0.85em">${i.ok ? 'Edit' : 'Configure'}</a>
      </span>
    </div>
  `).join('');

  return setupShell({
    title: 'Complete',
    content: `
      <h2>Setup Complete</h2>
      <div class="setup-status-list">${statusHtml}</div>
      <p>Your AI Assistant is configured. ${status.telegram.configured
        ? 'Restart the bot to start Telegram polling: <code>npm start</code>'
        : 'Configure Telegram to start using the bot.'}</p>
      ${status.telegram.configured
        ? '<p>After restart, send <strong>/start</strong> in Telegram to begin.</p>'
        : ''}
      <div class="setup-actions">
        ${status.telegram.configured
          ? '<a href="/d" class="btn btn-primary">Open Dashboard</a>'
          : '<a href="/setup/telegram" class="btn btn-primary">Configure Telegram</a>'}
      </div>
    `,
  });
}
