#!/usr/bin/env node
/**
 * pull-todoist-goals.mjs
 *
 * Pulls completed Todoist tasks back into goals.md:
 *   - For each active goal with a **Todoist Project ID:** field
 *   - Fetches completed tasks from that Todoist project
 *   - Marks matching `- [ ] action` lines as `- [x] action` in goals.md
 *   - Re-indexes via goals_manager.mjs
 *
 * Usage:
 *   node scripts/pull-todoist-goals.mjs
 *
 * Requires: TODOIST_API_TOKEN in .env
 * Run `node scripts/sync-goals-todoist.mjs` first if goals don't have a Todoist Project ID yet.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getCompletedTasksForProject } from '../todoist.mjs';

const execFileAsync = promisify(execFile);

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

    const actionsBlock = section.match(/\*\*Actions:\*\*([\s\S]*?)(?=\n\*\*|$)/i)?.[1] ?? '';
    const pending = actionsBlock.split('\n')
      .filter(l => l.trim().startsWith('- [ ]'))
      .map(l => l.replace(/^[\s*]*-\s*\[\s*\]\s*/, '').trim());

    goals.push({ title, status, todoistProjectId, pending });
  }

  return goals;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

if (!existsSync(GOALS_FILE)) {
  console.error('goals.md not found.');
  process.exit(1);
}

const goals  = parseGoals(readFileSync(GOALS_FILE, 'utf8'));
const linked = goals.filter(g => g.todoistProjectId && g.status === 'active');

if (linked.length === 0) {
  console.log('No active goals with a Todoist Project ID found.');
  console.log('Run `node scripts/sync-goals-todoist.mjs` first to link goals to Todoist projects.');
  process.exit(0);
}

let content     = readFileSync(GOALS_FILE, 'utf8');
let totalMarked = 0;

for (const goal of linked) {
  console.log(`\nGoal: ${goal.title} [Todoist: ${goal.todoistProjectId}]`);

  if (goal.pending.length === 0) {
    console.log('  No pending actions to check.');
    continue;
  }

  let completed;
  try {
    completed = await getCompletedTasksForProject(goal.todoistProjectId);
  } catch (err) {
    console.warn(`  Could not fetch completed tasks: ${err.message}`);
    continue;
  }

  if (completed.length === 0) {
    console.log('  No completed tasks found in Todoist.');
    continue;
  }

  const completedTitles = new Set(completed.map(t => t.content.trim()));

  for (const action of goal.pending) {
    if (completedTitles.has(action)) {
      const before = `- [ ] ${action}`;
      const after  = `- [x] ${action}`;

      if (content.includes(before)) {
        content = content.replace(before, after);
        console.log(`  [x] ${action}`);
        totalMarked++;
      } else {
        console.log(`  (line not found in goals.md) ${action}`);
      }
    }
  }
}

if (totalMarked > 0) {
  writeFileSync(GOALS_FILE, content, 'utf8');
  console.log(`\nUpdated goals.md — ${totalMarked} action(s) marked complete.`);

  // Re-index so SQLite reflects the changes
  try {
    await execFileAsync('node', ['goals_manager.mjs', 'index'], { cwd: ROOT });
    console.log('Re-indexed goals in SQLite.');
  } catch (err) {
    console.warn(`Re-index failed: ${err.message}`);
  }
} else {
  console.log('\nNo changes — no pending actions matched completed Todoist tasks.');
}
