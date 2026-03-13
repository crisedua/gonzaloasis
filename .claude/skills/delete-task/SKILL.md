# Skill: delete-task

Delete one or more Freedcamp tasks by ID.

## Invoke

`/delete-task` or natural language: "delete task", "remove task", "delete freedcamp task"

## Steps

### Step 1 — Fetch current tasks

Run this script to show all open tasks with their IDs:

```bash
node -e "
import('./freedcamp.mjs').then(async ({ getAllTasks }) => {
  const groups = await getAllTasks();
  for (const { project, tasks } of groups) {
    if (!tasks.length) continue;
    console.log('\n## ' + project.project_name);
    for (const t of tasks) {
      console.log('  [' + t.id + '] ' + t.title);
    }
  }
});
"
```

Show the user the full list grouped by project with IDs visible.

### Step 2 — Confirm which task(s) to delete

Ask the user: "Which task ID(s) do you want to delete? (You can list multiple, e.g. 123 456)"

Wait for their answer. Repeat back the task title(s) and ask: "Confirm deletion of: [titles]? (yes/no)"

Do not proceed without explicit confirmation.

### Step 3 — Delete

For each confirmed task ID, run:

```bash
node -e "
import('./freedcamp.mjs').then(async ({ deleteTask }) => {
  await deleteTask(TASK_ID);
  console.log('Deleted task TASK_ID');
}).catch(e => { console.error(e.message); process.exit(1); });
"
```

Replace `TASK_ID` with the actual numeric ID.

### Step 4 — Confirm result

Report which tasks were deleted and which (if any) failed. If a deletion failed, show the error message.
