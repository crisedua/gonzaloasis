/**
 * todoist.mjs — Todoist REST API v2 client
 *
 * Simple Bearer-token auth. Credentials read from process.env.
 *
 * Exports:
 *   getProjects()                        → array of project objects
 *   findOrCreateProject(name)            → project object
 *   getTasksForProject(projectId)        → array of open task objects
 *   createTask(content, projectId)       → task object
 *   closeTask(taskId)                    → void
 *   getTodoistContext()                  → formatted string for Claude context
 */

const BASE = 'https://api.todoist.com/api/v1';

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function token() {
  const t = process.env.TODOIST_API_TOKEN;
  if (!t) throw new Error('TODOIST_API_TOKEN is not set in .env');
  return t;
}

async function apiGet(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token()}` },
  });

  if (!res.ok) throw new Error(`Todoist GET ${path} failed: ${res.status} ${res.statusText}`);
  const body = await res.json();
  // API v1 returns { results: [...] } for list endpoints
  return Array.isArray(body.results) ? body.results : body;
}

async function apiPost(path, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Todoist POST ${path} failed: ${res.status} ${text.slice(0, 120)}`);
  }

  // close endpoint returns 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

// ─── Projects ─────────────────────────────────────────────────────────────────

/** Returns all Todoist projects. */
export async function getProjects() {
  return apiGet('/projects');
}

/**
 * Finds a project by exact name, or creates it if it doesn't exist.
 * Returns the project object.
 */
export async function findOrCreateProject(name) {
  const projects = await getProjects();
  const existing = projects.find(p => p.name === name);
  if (existing) return existing;
  return apiPost('/projects', { name });
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

/** Returns all open tasks in a project. */
export async function getTasksForProject(projectId) {
  return apiGet('/tasks', { project_id: projectId });
}

/**
 * Creates a task in a project.
 * @param {string} content  Task title
 * @param {string} projectId
 * @param {object} opts     Optional: description, priority (1–4), due_string
 */
export async function createTask(content, projectId, opts = {}) {
  return apiPost('/tasks', { content, project_id: projectId, ...opts });
}

/** Marks a task as complete. */
export async function closeTask(taskId) {
  return apiPost(`/tasks/${taskId}/close`);
}

/** Returns completed tasks in a project. */
export async function getCompletedTasksForProject(projectId) {
  return apiGet('/tasks', { project_id: projectId, is_completed: 'true' });
}

/** Permanently deletes a task. */
export async function deleteTask(taskId) {
  const res = await fetch(`${BASE}/tasks/${taskId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Todoist DELETE /tasks/${taskId} failed: ${res.status} ${text.slice(0, 120)}`);
  }
  return null; // 204 No Content
}

// ─── Context formatter ────────────────────────────────────────────────────────

/**
 * Returns a formatted string of all Todoist tasks grouped by project,
 * suitable for injection into Claude's context.
 *
 * @param {number} days  Only include tasks due within this many days (0 = all tasks)
 */
export async function getTodoistContext(days = 0) {
  const today = new Date().toISOString().slice(0, 10);
  const projects = await getProjects();

  // Calculate cutoff date for filtering
  let cutoff = null;
  if (days > 0) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    cutoff = d.toISOString().slice(0, 10);
  }

  const lines = [`*Todoist — ${today}${cutoff ? ` (next ${days} days)` : ''}*`, ''];

  for (const project of projects) {
    const allTasks = await getTasksForProject(project.id);
    // Filter by due date if cutoff is set: include tasks due <= cutoff OR tasks with no due date
    const tasks = cutoff
      ? allTasks.filter(t => !t.due || t.due.date <= cutoff)
      : allTasks;
    if (tasks.length === 0) continue; // skip empty projects

    lines.push(`*${project.name}* (${tasks.length})`);
    for (const t of tasks) {
      const due   = t.due ? ` _${t.due.date}_` : '';
      // priority: 4=P1 urgent, 3=P2, 2=P3, 1=normal (no badge)
      const badge = t.priority > 1 ? ` [P${5 - t.priority}]` : '';
      lines.push(`• ${t.content}${badge}${due}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
