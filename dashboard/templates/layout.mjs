/**
 * dashboard/templates/layout.mjs — Base HTML shell for all dashboard pages
 */

const TABS = [
  { href: '/d',           label: 'Overview',   key: 'home' },
  { href: '/d/goals',     label: 'Goals',      key: 'goals' },
  { href: '/d/documents', label: 'Documents',  key: 'documents' },
  { href: '/d/memory',    label: 'Memory',     key: 'memory' },
  { href: '/d/history',   label: 'History',    key: 'history' },
  { href: '/d/calendar',  label: 'Calendar',   key: 'calendar' },
  { href: '/d/admin',     label: 'Admin',      key: 'admin' },
  { href: '/d/help',      label: 'Help',       key: 'help' },
];

export function layout({ title, activeTab, content }) {
  const nav = TABS.map(t =>
    `<a href="${t.href}" class="${t.key === activeTab ? 'active' : ''}">${t.label}</a>`
  ).join('\n        ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/static/dashboard.css?v=4">
</head>
<body>
  <nav class="dash-nav">
    <div class="container">
      <span class="dash-logo">AI Assistant</span>
      <div class="dash-links">
        ${nav}
      </div>
    </div>
  </nav>
  <main class="dash-content container">
    ${content}
  </main>
  <footer class="footer"><p>AI Assistant Dashboard</p></footer>
  <script src="/static/dashboard.js?v=4"></script>
</body>
</html>`;
}

/** Login / unauthorized page — no nav */
export function loginPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard — Login Required</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/static/dashboard.css?v=4">
</head>
<body>
  <div class="login-page">
    <div class="login-box">
      <h1>Dashboard Access</h1>
      <p>Send <strong>/dashboard</strong> in Telegram to get your access link.</p>
    </div>
  </div>
</body>
</html>`;
}

/** Escape HTML entities */
export function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format file size in bytes to human-readable */
export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Render a status badge */
export function badge(status) {
  return `<span class="badge badge-${esc(status)}">${esc(status)}</span>`;
}

/** Simple markdown to HTML (headers, bold, italic, code, lists, hr) */
export function md(text) {
  if (!text) return '';
  return esc(text)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- \[x\] (.+)$/gm, '<div>&#9745; $1</div>')
    .replace(/^- \[ \] (.+)$/gm, '<div>&#9744; $1</div>')
    .replace(/^- (.+)$/gm, '<div>&bull; $1</div>')
    .replace(/^---$/gm, '<hr>')
    .replace(/\n{2,}/g, '<br><br>')
    .replace(/\n/g, '<br>');
}
