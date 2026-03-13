#!/usr/bin/env node
/**
 * sync-goals-todoist.mjs
 *
 * Syncs goals.md → Todoist:
 *   - Each active goal → a Todoist project (created if missing)
 *   - Each pending action (- [ ]) → a task in that project (skipped if already exists by title)
 *   - Completed actions (- [x]) are ignored
 *   - Stores the Todoist project ID back into goals.md as **Todoist Project ID:** <id>
 *     for stable cross-referencing by pull-todoist-goals.mjs
 *
 * Usage:
 *   node scripts/sync-goals-todoist.mjs
 *
 * Requires: TODOIST_API_TOKEN in .env
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findOrCreateProject, getTasksForProject, createTask } from '../todoist.mjs';

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

// ─── Write Todoist project ID back into goals.md ───────────────────────────────

function storeProjectId(goalTitle, projectId) {
  let content = readFileSync(GOALS_FILE, 'utf8');

  // Already stored — nothing to do
  if (content.includes(`**Todoist Project ID:** ${projectId}`)) return false;

  // Insert after the **Status:** line in this goal's section
  const titleEsc = goalTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(## ${titleEsc}[\\s\\S]*?\\*\\*Status:\\*\\*\\s*\`[^\`]+\`)`,
    'm'
  );

  if (!re.test(content)) {
    console.warn(`  Could not locate section for "${goalTitle}" to store project ID`);
    return false;
  }

  content = content.replace(re, `$1\n**Todoist Project ID:** ${projectId}`);
  writeFileSync(GOALS_FILE, content, 'utf8');
  return true;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

if (!existsSync(GOALS_FILE)) {
  console.error('goals.md not found.');
  process.exit(1);
}

const goals  = parseGoals(readFileSync(GOALS_FILE, 'utf8'));
const active = goals.filter(g => g.status === 'active');

if (active.length === 0) {
  console.log('No active goals to sync.');
  process.exit(0);
}

let totalCreated = 0;
let totalSkipped = 0;

for (const goal of active) {
  console.log(`\nGoal: ${goal.title}`);

  const project = await findOrCreateProject(goal.title);
  console.log(`  Project: ${project.name} [${project.id}]`);

  // Store the Todoist project ID in goals.md for stable cross-referencing
  if (!goal.todoistProjectId) {
    const stored = storeProjectId(goal.title, project.id);
    if (stored) console.log(`  Stored Todoist Project ID: ${project.id}`);
  }

  if (goal.pending.length === 0) {
    console.log('  No pending actions.');
    continue;
  }

  // Fetch existing task titles to avoid duplicates
  const existing       = await getTasksForProject(project.id);
  const existingTitles = new Set(existing.map(t => t.content.trim()));

  for (const action of goal.pending) {
    if (existingTitles.has(action)) {
      console.log(`  skip  ${action}`);
      totalSkipped++;
    } else {
      await createTask(action, project.id);
      console.log(`  +     ${action}`);
      totalCreated++;
    }
  }
}

console.log(`\nDone. Created: ${totalCreated}  Skipped (already existed): ${totalSkipped}`);
