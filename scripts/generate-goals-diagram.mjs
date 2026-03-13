#!/usr/bin/env node
/**
 * generate-goals-diagram.mjs
 *
 * Reads goals.md and generates an Excalidraw diagram file.
 * Output: documents/goals-diagram.excalidraw
 *
 * Usage:
 *   node scripts/generate-goals-diagram.mjs
 *
 * To view:
 *   1. Go to https://excalidraw.com
 *   2. File → Open → select documents/goals-diagram.excalidraw
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT      = resolve('.');
const GOALS_FILE = join(ROOT, 'goals.md');
const DOCS_DIR  = join(ROOT, 'documents');
const OUTPUT    = join(DOCS_DIR, 'goals-diagram.excalidraw');

// ─── Status colors ────────────────────────────────────────────────────────────

const COLORS = {
  active:    { card: '#dbe4ff', header: '#4263eb', text: '#ffffff', border: '#3b5bdb' },
  paused:    { card: '#fff3bf', header: '#f08c00', text: '#ffffff', border: '#e67700' },
  completed: { card: '#d3f9d8', header: '#2f9e44', text: '#ffffff', border: '#2b8a3e' },
  archived:  { card: '#f1f3f5', header: '#868e96', text: '#ffffff', border: '#868e96' },
};
const FALLBACK = COLORS.active;

// ─── Parser ───────────────────────────────────────────────────────────────────

function parseGoals(content) {
  const goals = [];
  const sections = content.split(/\n---\n/).filter(s => s.trim());

  for (const section of sections) {
    const titleLine = section.trim().split('\n').find(l => l.startsWith('## '));
    if (!titleLine) continue;

    const title  = titleLine.replace(/^## /, '').trim();
    const status = (extractField(section, 'Status') || 'active').replace(/`/g, '').trim();

    const metricsBlock  = extractBlock(section, 'Metrics') || '';
    const actionsBlock  = extractBlock(section, 'Actions') || '';
    const balanceBlock  = extractBlock(section, 'Balance check') || '';
    const lastReviewed  = extractField(section, 'Last reviewed') || '';

    const metrics = metricsBlock.split('\n')
      .filter(l => l.trim().match(/^[-•*]/))
      .map(l => l.replace(/^[-•*\s]+/, '').trim())
      .slice(0, 4);

    const pendingActions = actionsBlock.split('\n')
      .filter(l => l.trim().startsWith('- [ ]'))
      .map(l => l.replace(/^[*\s]*-\s*\[\s*\]\s*/, '').trim())
      .slice(0, 4);

    const completedCount = (actionsBlock.match(/- \[x\]/gi) || []).length;
    const totalCount     = (actionsBlock.match(/- \[[ x]\]/gi) || []).length;

    goals.push({ title, status, metrics, pendingActions, completedCount, totalCount, lastReviewed, balance: balanceBlock });
  }

  return goals;
}

function extractField(text, field) {
  const m = text.match(new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, 'i'));
  return m ? m[1].trim() : null;
}

function extractBlock(text, field) {
  const m = text.match(new RegExp(`\\*\\*${field}:\\*\\*([\\s\\S]*?)(?=\\n\\*\\*|$)`, 'i'));
  return m ? m[1].trim() : null;
}

// ─── Excalidraw element builders ─────────────────────────────────────────────

let _seq = 1;
const eid  = ()  => `g${_seq++}_${Math.random().toString(36).slice(2, 7)}`;
const rng  = ()  => Math.floor(Math.random() * 2_000_000_000);
const trunc = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

function makeRect({ x, y, w, h, bg = 'transparent', stroke = '#1e1e1e', sw = 2, rnd = 3 }) {
  return {
    id: eid(), type: 'rectangle',
    x, y, width: w, height: h,
    angle: 0,
    strokeColor: stroke, backgroundColor: bg,
    fillStyle: 'solid', strokeWidth: sw, strokeStyle: 'solid',
    roughness: 0, opacity: 100,
    groupIds: [], frameId: null,
    roundness: { type: rnd },
    seed: rng(), version: 1, versionNonce: rng(),
    isDeleted: false, boundElements: null,
    updated: Date.now(), link: null, locked: false,
  };
}

function makeText({ x, y, t, size = 14, color = '#1e1e1e', align = 'left', family = 2, w = 300 }) {
  return {
    id: eid(), type: 'text',
    x, y, width: w, height: size * 1.5,
    angle: 0,
    strokeColor: color, backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
    roughness: 0, opacity: 100,
    groupIds: [], frameId: null, roundness: null,
    seed: rng(), version: 1, versionNonce: rng(),
    isDeleted: false, boundElements: null,
    updated: Date.now(), link: null, locked: false,
    text: t, fontSize: size, fontFamily: family,
    textAlign: align, verticalAlign: 'top',
    baseline: size, containerId: null, originalText: t, lineHeight: 1.25,
  };
}

// ─── Card layout ──────────────────────────────────────────────────────────────

const CARD_W = 400;
const PAD    = 16;

function buildCard(goal, x, y) {
  const elems = [];
  const c = COLORS[goal.status] || FALLBACK;

  // ── Header bar ──
  const headerH = 64;
  elems.push(makeRect({ x, y, w: CARD_W, h: headerH, bg: c.header, stroke: c.border, rnd: 3 }));

  // Status pill
  const pill = goal.status.toUpperCase();
  const pillW = pill.length * 7 + 16;
  elems.push(makeRect({ x: x + PAD, y: y + PAD, w: pillW, h: 20, bg: 'rgba(255,255,255,0.25)', stroke: 'transparent', rnd: 2, sw: 0 }));
  elems.push(makeText({ x: x + PAD + 4, y: y + PAD + 2, t: pill, size: 11, color: c.text, w: pillW }));

  // Title
  const titleX = x + PAD + pillW + 8;
  elems.push(makeText({ x: titleX, y: y + PAD, t: trunc(goal.title, 38), size: 15, color: c.text, w: CARD_W - pillW - PAD * 3, family: 1 }));

  // Progress bar
  if (goal.totalCount > 0) {
    const pct  = goal.completedCount / goal.totalCount;
    const barW = CARD_W - PAD * 2;
    const barY = y + headerH - 10;
    elems.push(makeRect({ x: x + PAD, y: barY, w: barW, h: 4, bg: 'rgba(255,255,255,0.3)', stroke: 'transparent', rnd: 1, sw: 0 }));
    if (pct > 0) {
      elems.push(makeRect({ x: x + PAD, y: barY, w: Math.round(barW * pct), h: 4, bg: '#ffffff', stroke: 'transparent', rnd: 1, sw: 0 }));
    }
  }

  // ── Body ──
  let cy = y + headerH;
  const bodyStartY = cy;

  // Completed/total badge
  if (goal.totalCount > 0) {
    const badge = `${goal.completedCount} / ${goal.totalCount} done`;
    elems.push(makeText({ x: x + PAD, y: cy + PAD, t: badge, size: 11, color: '#868e96', w: 150 }));
  }
  if (goal.lastReviewed) {
    elems.push(makeText({ x: x + CARD_W - 160, y: cy + PAD, t: `reviewed ${goal.lastReviewed}`, size: 11, color: '#adb5bd', align: 'right', w: 140 }));
  }
  cy += goal.totalCount > 0 ? PAD + 22 : PAD;

  // Metrics
  if (goal.metrics.length > 0) {
    elems.push(makeText({ x: x + PAD, y: cy, t: 'METRICS', size: 11, color: c.border, w: 100 }));
    cy += 18;
    for (const m of goal.metrics) {
      elems.push(makeText({ x: x + PAD, y: cy, t: '▸ ' + trunc(m, 50), size: 13, w: CARD_W - PAD * 2 }));
      cy += 20;
    }
    cy += 8;
  }

  // Next actions
  if (goal.pendingActions.length > 0) {
    elems.push(makeText({ x: x + PAD, y: cy, t: 'NEXT ACTIONS', size: 11, color: c.border, w: 150 }));
    cy += 18;
    for (const a of goal.pendingActions) {
      elems.push(makeText({ x: x + PAD, y: cy, t: '☐ ' + trunc(a, 46), size: 13, w: CARD_W - PAD * 2 }));
      cy += 20;
    }
    cy += 8;
  }

  cy += PAD;
  const bodyH = cy - bodyStartY;

  // Insert body background (behind other body elements)
  elems.splice(5, 0, makeRect({ x, y: bodyStartY, w: CARD_W, h: bodyH, bg: '#ffffff', stroke: c.border, sw: 2, rnd: 3 }));

  return { elems, totalH: cy - y };
}

// ─── Full diagram ─────────────────────────────────────────────────────────────

function buildDiagram(goals) {
  const elements = [];
  const today    = new Date().toISOString().slice(0, 10);

  // Page title
  elements.push(makeText({ x: 40, y: 20, t: 'GOAL MAP', size: 36, color: '#1e1e1e', family: 1, w: 400 }));
  elements.push(makeText({ x: 44, y: 66, t: today, size: 14, color: '#868e96', w: 200 }));

  // Legend
  let lx = 300;
  for (const [status, c] of Object.entries(COLORS)) {
    elements.push(makeRect({ x: lx, y: 34, w: 12, h: 12, bg: c.header, stroke: c.border, rnd: 2, sw: 1 }));
    elements.push(makeText({ x: lx + 16, y: 34, t: status, size: 12, color: '#868e96', w: 80 }));
    lx += 90;
  }

  // Cards — 2 columns
  const COLS   = goals.length === 1 ? 1 : 2;
  const GAP    = 32;
  const START_Y = 100;
  let rowMaxH  = 0;
  let startY   = START_Y;

  for (let i = 0; i < goals.length; i++) {
    const col = i % COLS;
    const x   = 40 + col * (CARD_W + GAP);

    if (col === 0 && i > 0) {
      startY  += rowMaxH + GAP;
      rowMaxH  = 0;
    }

    const { elems, totalH } = buildCard(goals[i], x, startY);
    elements.push(...elems);
    rowMaxH = Math.max(rowMaxH, totalH);
  }

  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements,
    appState: { viewBackgroundColor: '#f8f9fa', gridSize: null },
    files: {},
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

if (!existsSync(GOALS_FILE)) {
  console.error('goals.md not found. Run: node goals_manager.mjs index');
  process.exit(1);
}

if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });

const goals = parseGoals(readFileSync(GOALS_FILE, 'utf8'));

if (goals.length === 0) {
  console.error('No goals found in goals.md');
  process.exit(1);
}

const diagram = buildDiagram(goals);
writeFileSync(OUTPUT, JSON.stringify(diagram, null, 2), 'utf8');

console.log(`Generated: documents/goals-diagram.excalidraw`);
console.log(`Goals:     ${goals.map(g => `${g.title.slice(0, 30)} [${g.status}]`).join(', ')}`);
console.log('');
console.log('To view:');
console.log('  1. Go to https://excalidraw.com');
console.log('  2. File → Open → select documents/goals-diagram.excalidraw');
console.log('  Or: drag the file into the excalidraw.com browser tab');
