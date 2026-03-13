/**
 * freedcamp.mjs — Freedcamp API client
 *
 * Handles HMAC-SHA1 authentication and data fetching.
 * All credentials read from process.env (loaded by dotenv in bot.mjs).
 *
 * Exports:
 *   getProjects()          → array of project objects
 *   getTasks(projectId)    → array of task objects (open only by default)
 *   getAllTasks()           → tasks across all projects
 *   getFreedcampContext()  → formatted string for Claude context injection
 */

import { createHmac } from 'node:crypto';

const BASE = 'https://freedcamp.com/api/v1';

// ─── Auth ─────────────────────────────────────────────────────────────────────

function buildAuthParams() {
  const key    = process.env.FREEDCAMP_API_KEY;
  const secret = process.env.FREEDCAMP_API_SECRET;

  if (!key)    throw new Error('FREEDCAMP_API_KEY is not set');
  if (!secret) throw new Error('FREEDCAMP_API_SECRET is not set');

  const timestamp = Math.floor(Date.now() / 1000);
  const hash      = createHmac('sha1', secret).update(key + timestamp).digest('hex');

  return { api_key: key, timestamp, hash };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function apiFetch(endpoint, params = {}) {
  const auth  = buildAuthParams();
  const query = new URLSearchParams({ ...auth, ...params }).toString();
  const url   = `${BASE}/${endpoint}?${query}`;

  const res  = await fetch(url);
  const body = await res.json();

  if (body.http_code !== 200) {
    throw new Error(`Freedcamp API error: ${body.msg} (${body.http_code})`);
  }

  return body.data;
}

async function apiPut(endpoint, params = {}) {
  const auth  = buildAuthParams();
  const query = new URLSearchParams({ ...auth }).toString();
  const url   = `${BASE}/${endpoint}?${query}`;
  const body  = new URLSearchParams(params);

  const res  = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json();

  if (json.http_code !== 200) {
    throw new Error(`Freedcamp API error: ${json.msg} (${json.http_code})`);
  }

  return json.data;
}

async function apiDelete(endpoint, params = {}) {
  const auth  = buildAuthParams();
  const query = new URLSearchParams({ ...auth, ...params }).toString();
  const url   = `${BASE}/${endpoint}?${query}`;

  const res  = await fetch(url, { method: 'DELETE' });
  const body = await res.json();

  if (body.http_code !== 200) {
    throw new Error(`Freedcamp API error: ${body.msg} (${body.http_code})`);
  }

  return body.data;
}

// ─── Pagination helper ────────────────────────────────────────────────────────

async function fetchAll(endpoint, key, extraParams = {}) {
  const results = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const data = await apiFetch(endpoint, { ...extraParams, limit, offset });
    const page = data[key] ?? [];
    results.push(...page);

    if (!data.meta?.has_more || page.length < limit) break;
    offset += limit;
  }

  return results;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Deletes a task by its numeric ID.
 * @param {string|number} taskId
 */
export async function deleteTask(taskId) {
  return apiDelete(`tasks/${taskId}`);
}

/** Marks a task as completed by ID. */
export async function completeTask(taskId) {
  return apiPut(`tasks/${taskId}`, { f_completed: 1 });
}

/** Returns all active projects the user has access to. */
export async function getProjects() {
  const data = await apiFetch('projects');
  return (data.projects ?? []).filter(p => p.f_active);
}

/**
 * Returns tasks for a given project.
 * @param {string} projectId
 * @param {object} opts
 * @param {boolean} opts.includeCompleted  default false
 */
export async function getTasks(projectId, { includeCompleted = false } = {}) {
  const params = { project_id: projectId };
  if (!includeCompleted) params.f_completed = 0;

  return fetchAll('tasks', 'tasks', params);
}

/** Returns open tasks across all projects, keyed by project. */
export async function getAllTasks({ includeCompleted = false } = {}) {
  const projects = await getProjects();
  const result   = [];

  for (const project of projects) {
    const tasks = await getTasks(project.id, { includeCompleted });
    result.push({ project, tasks });
  }

  return result;
}

// ─── Context formatter ────────────────────────────────────────────────────────

/**
 * Fetches projects + open tasks and returns a formatted string
 * suitable for injection into Claude's context.
 */
export async function getFreedcampContext() {
  const now = new Date();

  let groups;
  try {
    groups = await getAllTasks();
  } catch (err) {
    return `(Freedcamp data unavailable: ${err.message})`;
  }

  const totalTasks = groups.reduce((n, g) => n + g.tasks.length, 0);

  const lines = [
    `# Freedcamp — Live Data (as of ${now.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })})`,
    ``,
    `**Projects:** ${groups.length}   **Open tasks:** ${totalTasks}`,
    ``,
  ];

  for (const { project, tasks } of groups) {
    lines.push(`## ${project.project_name} (${tasks.length} open tasks)`);

    if (tasks.length === 0) {
      lines.push(`_No open tasks._`);
    } else {
      for (const t of tasks) {
        const due     = t.due_date ? ` — due ${formatDate(t.due_date)}` : '';
        const assign  = t.assigned_to_usernames?.length
          ? ` [@${t.assigned_to_usernames.join(', @')}]`
          : '';
        const priority = t.priority ? ` [P${t.priority}]` : '';
        lines.push(`- ${t.title}${priority}${due}${assign}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
