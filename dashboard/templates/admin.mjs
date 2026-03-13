/**
 * dashboard/templates/admin.mjs — Admin panel page
 */

import { layout, esc } from './layout.mjs';
import { maskSecret } from '../config.mjs';

export function adminPage({ status, config }) {
  // Mask sensitive values for display
  const tgToken = maskSecret(process.env.TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN);
  const tgUser  = process.env.ALLOWED_TELEGRAM_USER_ID || config.ALLOWED_TELEGRAM_USER_ID || '';
  const gClientId = maskSecret(process.env.GOOGLE_CLIENT_ID || config.GOOGLE_CLIENT_ID);
  const gClientSecret = maskSecret(process.env.GOOGLE_CLIENT_SECRET || config.GOOGLE_CLIENT_SECRET);
  const tdToken = maskSecret(process.env.TODOIST_API_TOKEN || config.TODOIST_API_TOKEN);
  const fcKey   = maskSecret(process.env.FREEDCAMP_API_KEY || config.FREEDCAMP_API_KEY);
  const fcSecret = maskSecret(process.env.FREEDCAMP_API_SECRET || config.FREEDCAMP_API_SECRET);

  return layout({
    title: 'Admin',
    activeTab: 'admin',
    content: `
      <h1 class="page-title">Admin Panel</h1>

      <!-- Connection Status Cards -->
      <div class="stats-row" style="margin-bottom:32px">
        <div class="stat-card">
          <div class="stat-number">${statusDot(status.telegram.configured)}</div>
          <div class="stat-label">Telegram</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${statusDot(status.google.configured && status.google.authorized)}</div>
          <div class="stat-label">Google</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${statusDot(status.todoist.configured)}</div>
          <div class="stat-label">Todoist</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${statusDot(status.freedcamp.configured)}</div>
          <div class="stat-label">Freedcamp</div>
        </div>
      </div>

      <!-- Telegram -->
      <div class="admin-section" id="section-telegram">
        <h2 class="admin-section-title">Telegram Bot</h2>
        <div class="admin-card">
          <div class="admin-field">
            <label>Bot Token</label>
            <div class="admin-value">${tgToken || '<span class="text-dim">Not configured</span>'}</div>
          </div>
          <div class="admin-field">
            <label>Allowed User ID</label>
            <div class="admin-value">${esc(tgUser) || '<span class="text-dim">Not set (open to all)</span>'}</div>
          </div>
          <div class="admin-actions">
            <button class="btn btn-sm btn-secondary" onclick="testService('telegram')">Test Connection</button>
            <button class="btn btn-sm btn-secondary" onclick="showEditForm('telegram')">Edit</button>
          </div>
          <div id="test-telegram" class="admin-test-result"></div>
          <form id="edit-telegram" class="admin-edit-form" style="display:none" method="POST" action="/api/config/save">
            <input type="hidden" name="section" value="telegram">
            <label>Bot Token</label>
            <input type="text" name="TELEGRAM_BOT_TOKEN" placeholder="Paste new token...">
            <label>Allowed User ID</label>
            <input type="text" name="ALLOWED_TELEGRAM_USER_ID" placeholder="Numeric user ID" value="${esc(tgUser)}">
            <div class="admin-actions">
              <button type="submit" class="btn btn-sm btn-primary">Save</button>
              <button type="button" class="btn btn-sm btn-secondary" onclick="hideEditForm('telegram')">Cancel</button>
            </div>
            <p class="form-hint">Note: Changing the bot token requires a restart to take effect.</p>
          </form>
        </div>
      </div>

      <!-- Google -->
      <div class="admin-section" id="section-google">
        <h2 class="admin-section-title">Google (Gmail / Drive / Calendar)</h2>
        <div class="admin-card">
          <div class="admin-field">
            <label>Client ID</label>
            <div class="admin-value">${gClientId || '<span class="text-dim">Not configured</span>'}</div>
          </div>
          <div class="admin-field">
            <label>Client Secret</label>
            <div class="admin-value">${gClientSecret || '<span class="text-dim">Not configured</span>'}</div>
          </div>
          <div class="admin-field">
            <label>Authorization</label>
            <div class="admin-value">
              ${status.google.authorized
                ? '<span class="badge badge-active">Authorized</span>'
                : '<span class="badge badge-paused">Not authorized</span>'}
            </div>
          </div>
          <div class="admin-actions">
            ${status.google.configured && !status.google.authorized
              ? '<a href="/api/setup/google-connect" class="btn btn-sm btn-accent">Connect to Google</a>'
              : ''}
            ${status.google.authorized
              ? '<button class="btn btn-sm btn-secondary" onclick="testService(\'google\')">Test Connection</button>'
              : ''}
            <button class="btn btn-sm btn-secondary" onclick="showEditForm('google')">Edit Credentials</button>
            ${status.google.authorized
              ? '<button class="btn btn-sm btn-danger" onclick="disconnectService(\'google\')">Disconnect</button>'
              : ''}
          </div>
          <div id="test-google" class="admin-test-result"></div>
          <form id="edit-google" class="admin-edit-form" style="display:none" method="POST" action="/api/config/save">
            <input type="hidden" name="section" value="google">
            <label>Client ID</label>
            <input type="text" name="GOOGLE_CLIENT_ID" placeholder="1028688...apps.googleusercontent.com">
            <label>Client Secret</label>
            <input type="text" name="GOOGLE_CLIENT_SECRET" placeholder="GOCSPX-...">
            <label>Redirect URI</label>
            <input type="text" name="GOOGLE_REDIRECT_URI" placeholder="http://YOUR_IP:3456/oauth2callback" value="${esc(process.env.GOOGLE_REDIRECT_URI || config.GOOGLE_REDIRECT_URI || '')}">
            <div class="admin-actions">
              <button type="submit" class="btn btn-sm btn-primary">Save</button>
              <button type="button" class="btn btn-sm btn-secondary" onclick="hideEditForm('google')">Cancel</button>
            </div>
          </form>
        </div>
      </div>

      <!-- Todoist -->
      <div class="admin-section" id="section-todoist">
        <h2 class="admin-section-title">Todoist</h2>
        <div class="admin-card">
          <div class="admin-field">
            <label>API Token</label>
            <div class="admin-value">${tdToken || '<span class="text-dim">Not configured</span>'}</div>
          </div>
          <div class="admin-actions">
            <button class="btn btn-sm btn-secondary" onclick="testService('todoist')">Test Connection</button>
            <button class="btn btn-sm btn-secondary" onclick="showEditForm('todoist')">Edit</button>
            ${status.todoist.configured
              ? '<button class="btn btn-sm btn-danger" onclick="disconnectService(\'todoist\')">Disconnect</button>'
              : ''}
          </div>
          <div id="test-todoist" class="admin-test-result"></div>
          <form id="edit-todoist" class="admin-edit-form" style="display:none" method="POST" action="/api/config/save">
            <input type="hidden" name="section" value="todoist">
            <label>API Token</label>
            <input type="text" name="TODOIST_API_TOKEN" placeholder="Paste Todoist API token...">
            <div class="admin-actions">
              <button type="submit" class="btn btn-sm btn-primary">Save</button>
              <button type="button" class="btn btn-sm btn-secondary" onclick="hideEditForm('todoist')">Cancel</button>
            </div>
          </form>
        </div>
      </div>

      <!-- Freedcamp -->
      <div class="admin-section" id="section-freedcamp">
        <h2 class="admin-section-title">Freedcamp</h2>
        <div class="admin-card">
          <div class="admin-field">
            <label>API Key</label>
            <div class="admin-value">${fcKey || '<span class="text-dim">Not configured</span>'}</div>
          </div>
          <div class="admin-field">
            <label>API Secret</label>
            <div class="admin-value">${fcSecret || '<span class="text-dim">Not configured</span>'}</div>
          </div>
          <div class="admin-actions">
            <button class="btn btn-sm btn-secondary" onclick="testService('freedcamp')">Test Connection</button>
            <button class="btn btn-sm btn-secondary" onclick="showEditForm('freedcamp')">Edit</button>
            ${status.freedcamp.configured
              ? '<button class="btn btn-sm btn-danger" onclick="disconnectService(\'freedcamp\')">Disconnect</button>'
              : ''}
          </div>
          <div id="test-freedcamp" class="admin-test-result"></div>
          <form id="edit-freedcamp" class="admin-edit-form" style="display:none" method="POST" action="/api/config/save">
            <input type="hidden" name="section" value="freedcamp">
            <label>API Key</label>
            <input type="text" name="FREEDCAMP_API_KEY" placeholder="ad42c2e34be921e...">
            <label>API Secret</label>
            <input type="text" name="FREEDCAMP_API_SECRET" placeholder="a1ad52e489b0d7...">
            <div class="admin-actions">
              <button type="submit" class="btn btn-sm btn-primary">Save</button>
              <button type="button" class="btn btn-sm btn-secondary" onclick="hideEditForm('freedcamp')">Cancel</button>
            </div>
          </form>
        </div>
      </div>

      <!-- Bot Settings -->
      <div class="admin-section" id="section-bot">
        <h2 class="admin-section-title">Bot Settings</h2>
        <div class="admin-card">
          <form method="POST" action="/api/config/save" class="admin-edit-form" style="display:block">
            <input type="hidden" name="section" value="bot">
            <label>Claude Model</label>
            <select name="CLAUDE_MODEL">
              ${['opus', 'sonnet', 'haiku'].map(m =>
                `<option value="${m}" ${status.bot.model === m ? 'selected' : ''}>${m}</option>`
              ).join('')}
            </select>
            <label>Timezone</label>
            <input type="text" name="TIMEZONE" value="${esc(status.bot.timezone)}" placeholder="America/New_York">
            <label>Dashboard URL</label>
            <input type="text" name="DASHBOARD_URL" value="${esc(status.bot.dashboardUrl)}" placeholder="http://YOUR_IP:3456">
            <label>Google Drive Folder</label>
            <input type="text" name="DRIVE_FOLDER" value="${esc(status.bot.driveFolder)}" placeholder="AI Assistant">
            <div class="admin-actions">
              <button type="submit" class="btn btn-sm btn-primary">Save Settings</button>
            </div>
          </form>
        </div>
      </div>
    `,
  });
}

function statusDot(ok) {
  return ok
    ? '<span class="status-dot status-ok"></span>'
    : '<span class="status-dot status-off"></span>';
}
