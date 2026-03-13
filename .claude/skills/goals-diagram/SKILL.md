---
name: goals-diagram
description: Use when someone asks to visualize goals, create a goal diagram, generate an Excalidraw diagram, or see a visual map of their goals.
---

## Goal Diagram Generator

Generates an Excalidraw diagram from `goals.md` — color-coded cards per goal
showing status, metrics, progress bar, and next actions.

---

## Step 1 — Ensure goals are indexed

```bash
node goals_manager.mjs list
```

If no goals appear, run `node goals_manager.mjs index` first.

---

## Step 2 — Generate the diagram

```bash
node scripts/generate-goals-diagram.mjs
```

---

## Step 3 — Tell the user how to open it

Report the output path and give clear instructions:

> "Diagram saved to `documents/goals-diagram.excalidraw`
>
> To view it:
> 1. Go to https://excalidraw.com
> 2. File → Open → select `documents/goals-diagram.excalidraw`
> Or drag the file directly into the excalidraw.com browser tab.
>
> Each goal appears as a color-coded card:
> - Blue = active
> - Yellow = paused
> - Green = completed
> - Gray = archived
>
> The card shows: status, progress bar (completed/total actions), metrics, and next 4 pending actions."

---

## Notes

- Re-run after every `/goals` session to keep the diagram current.
- Add new goals to `goals.md`, then run `node goals_manager.mjs index` before regenerating.
- The `.excalidraw` file is plain JSON — it can be opened offline in the Excalidraw desktop app too.
