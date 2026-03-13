#!/usr/bin/env node
/**
 * clear-todoist-tasks.mjs
 *
 * Deletes all open tasks from a goal's Todoist project.
 * The goal itself (in goals.md) is left completely unchanged.
 *
 * Usage:
 *   node scripts/clear-todoist-tasks.mjs <goal-number>
 *
 * <goal-number> is the 1-based position of the goal in goals.md,
 * matching the ID shown by `node goals_manager.mjs list`.
 *
 * Requires: TODOIST_API_TOKEN in .env
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getTasksForProject, deleteTask } from '../todoist.mjs';

const ROOT       = resolve('.');
const GOALS_FILE = join(ROOT, 'goals.md');

// ─── Parser ────────────────────────────────────────────────────────────────────

function parseGoals(content) {
  const goals = [];
  const sections = content.split(/\n---\n/).filter(s => s.trim());

  for (const section of sections) {
    const titleLine = section.trim().split('\n').find(l => l.startsWith('## '));
    if (!titleLine) continue;

    const title            = titleLine.replace(/^## /, '').trim();
    const status           = (section.match(/\*\*Status:\*\*\s*`([^`]+)`/i)?.[1] ?? 'active').trim();
    const todoistProjectId = section.match(/\*\*Todoist Project ID:\*\*\s*(\S+)/i)?.[1] ?? null;

    goals.push({ title, status, todoistProjectId });
  }

  return goals;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

if (!existsSync(GOALS_FILE)) {
  console.error('goals.md not found.');
  process.exit(1);
}

const goals = parseGoals(readFileSync(GOALS_FILE, 'utf8'));

// No argument — list goals and exit
if (process.argv.length < 3) {
  console.log('Usage: node scripts/clear-todoist-tasks.mjs <goal-number>\n');
  console.log('Goals:');
  goals.forEach((g, i) => {
    const pid = g.todoistProjectId ? `[Todoist: ${g.todoistProjectId}]` : '[no Todoist link — run /tsync first]';
    console.log(`  ${i + 1}. ${g.title} (${g.status}) ${pid}`);
  });
  process.exit(0);
}

const goalNumber = parseInt(process.argv[2], 10);
if (isNaN(goalNumber) || goalNumber < 1 || goalNumber > goals.length) {
  console.error(`Invalid goal number. Valid range: 1–${goals.length}`);
  process.exit(1);
}

const goal = goals[goalNumber - 1];
console.log(`Goal: ${goal.title}`);

if (!goal.todoistProjectId) {
  console.error('This goal has no Todoist Project ID. Run `/tsync` first to link it.');
  process.exit(1);
}

console.log(`Fetching open tasks from Todoist project [${goal.todoistProjectId}]...`);

let tasks;
try {
  tasks = await getTasksForProject(goal.todoistProjectId);
} catch (err) {
  console.error(`Failed to fetch tasks: ${err.message}`);
  process.exit(1);
}

if (tasks.length === 0) {
  console.log('No open tasks to delete.');
  process.exit(0);
}

console.log(`Deleting ${tasks.length} task(s)...`);
let deleted = 0;
let failed  = 0;

for (const task of tasks) {
  try {
    await deleteTask(task.id);
    console.log(`  deleted  ${task.content}`);
    deleted++;
  } catch (err) {
    console.warn(`  failed   ${task.content}: ${err.message}`);
    failed++;
  }
}

console.log(`\nDone. Deleted: ${deleted}  Failed: ${failed}`);
console.log('goals.md is unchanged.');
