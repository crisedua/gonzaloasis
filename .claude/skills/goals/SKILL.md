---
name: goals
description: Use when someone asks to review their goals, create goals, plan their goals, set goals, or work on their goal system.
---

## Goal Review System

A recurring session that loads the current state of your goals from `goals.md`,
reviews what moved and what stalled, updates statuses and metrics, and produces
a dated session summary. The whiteboard philosophy and Hormozi frameworks guide
the conversation.

**Source of truth:** `goals.md` (all goal state lives here, indexed to SQLite)
**Reference:** `.claude/skills/goals/hormozi.md`

---

## Step 1 — Load Current Goal State

Run this to show all goals with their current status:

```bash
node goals_manager.mjs list
```

If the output is empty (no goals indexed), run:
```bash
node goals_manager.mjs index
```

Then read `goals.md` to have the full context (actions, metrics, balance checks).

Present the goals to the user in a brief summary:
- Title and status for each goal
- How many actions are pending vs. completed
- Last reviewed date

---

## Step 2 — Present the Lens (briefly)

Share the operating philosophy before diving in — conversational, not a lecture:

> "Before we go through each one — the lens: goals flow from intrinsic motivation,
> approached playfully with non-attachment. The path is Actions → Goals → Balance →
> Success. Enjoyment is the signal. Sincere, not serious."

Then begin the review.

---

## Step 3 — Review Each Active Goal

For each goal with status `active`, work through it one at a time.

**a) State what you see**

Summarize the goal's current state: what's checked off, what's still open,
last reviewed date, current metrics.

**b) Ask two questions**

> "Since the last review — what actually happened with [goal]?
> And is there anything that's stalled or needs to change?"

Wait for their answer before moving to the next goal.

**c) Based on their answer, do one or more of:**

- Check off completed actions in `goals.md`
- Add new actions the user mentions
- Update metrics with new numbers
- If the goal is blocked or deprioritized, ask: "Do you want to pause this or keep it active?"
- If status should change, use:
  ```bash
  node goals_manager.mjs update <id> <status>
  ```
  Status values: `active` | `paused` | `completed` | `archived`

- To log a metric update:
  ```bash
  node goals_manager.mjs metric <id> "MRR: $500 / $5,000 — first client signed"
  ```

---

## Step 4 — New Goals (only if raised)

Ask only if the user mentions something new or if fewer than 2 active goals remain:

> "Anything new you want to add as a goal?"

If yes, add it to `goals.md` in this format:

```markdown
## [Goal Title]

**Status:** `active`
**Category:** [business | health | learning | personal]
**Created:** YYYY-MM-DD
**Last reviewed:** YYYY-MM-DD

**Why this matters:**
[2–3 sentences: why this goal makes sense given who they are and what they're building]

**Metrics:**
- [metric name]: [current] / [target]

**Actions:**
- [ ] [first action]

**Balance check:**
[Any overcommitment or enjoyment risks]

---
```

For business/revenue goals, apply Hormozi frameworks from `hormozi.md`:
- Sharpen the offer using the Value Equation
- Identify the lead gen channel and funnel path
- Draft the outreach message

---

## Step 5 — Re-index and Update Last Reviewed

After editing `goals.md`, run:

```bash
node goals_manager.mjs index
```

Then update the `**Last reviewed:**` date for each goal you touched.
Use today's date in YYYY-MM-DD format.

---

## Step 6 — Generate Session Summary

Write a dated session summary to `documents/goals-YYYY-MM-DD.md`.
This is NOT a full state dump — it records only what changed this session.

```markdown
# Goal Session — YYYY-MM-DD

## What Changed

### [Goal Title]
- [Action checked off or added]
- [Metric updated: old → new]
- [Status change if any]

## New Goals Added
[List or "None"]

## Key Decisions
[Any significant choices made this session]

## Commitments This Cycle
1. [Top action — most important thing to do before next review]
2. [Second action]
3. [Third action]
```

---

## Step 7 — Log to Memory

```bash
node memory_manager.mjs log "Goal review completed. Active goals: [N]. Key commitment: [top action]."
```

---

## Notes

- Never assume or invent goal status — always load from `goals_manager.mjs list` first.
- If a goal sounds externally driven (hustle for approval, money for status), name it gently.
- The session summary is the record of change; `goals.md` is the record of current state.
- `offer.md` and `outreach-tracker.md` are updated only when the user explicitly works on them.
- Run `node goals_manager.mjs stats` at the start of any session for a quick overview.
