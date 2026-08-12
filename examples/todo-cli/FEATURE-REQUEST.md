# Feature request

Add due dates and recurring todos.

- `todo add "pay rent" --due 2026-09-01`
- `todo add "standup" --repeat weekdays`
- `todo list` should show what is overdue.

Open questions nobody has answered yet:

- Are due dates local time or UTC?
- When a recurring todo is completed, does the next instance appear immediately?
- Does `list` sort by due date or by id?

The store is a flat JSON file with `{ id, title, done }`. Anything new has to
migrate the existing file without losing todos.
