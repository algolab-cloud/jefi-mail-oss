# Tasks: turning email into things to do

Epic lume-tsk. Tasks are the fourth app in the rail (⌘4), beside Mail, Calendar and Notes. A task is
a short line with an optional due date and notes, and it can link back to the email it came from.
The storage and link model are the ones notes use (docs/calendar-notes-architecture.md). Where this
doc says "like notes", the code is the same shape.

## Decisions

- **Tasks are local.** Like the calendar and notes: they live in mail.db, belong to no account and
  outlive account removal. Nothing syncs with Reminders, Todoist or anyone else. If sync comes later,
  `uid` is already an iCalendar-style id (VTODO), so a CalDAV or EventKit bridge has something stable
  to match on.
- **An email becomes a task in three ways:**
  1. **By hand.** "Make task" in the reader's toolbar, the message menu, the list's context menu, or
     the `t` key. It opens a small form with the subject as the title and a due date from
     `src/detect` ("by Friday"), and it links the message and its conversation.
  2. **Suggested by AI.** With AI on, "Suggest tasks with Claude" (or OpenAI/ChatGPT) in the Make
     task form asks the person's own model (the existing AI settings) for the action items in the
     conversation. Suggestions are shown, never saved on their own: each one is added by the person.
  3. **From the menu bar.** The panel lists what's overdue or due today, ticks tasks off in place,
     and its quick-add field makes a task when the text starts with "Task:" (or "Todo:"); the colon
     is required, so "Task force sync Friday" is still an event. New task opens the Tasks view.
- **Tasks work like issues in Linear.** Each has a workflow status (Backlog, Todo, In Progress, Done,
  Canceled), a priority (none, urgent, high, medium, low), a number shown as T-12, an optional
  project and any number of labels. Done and canceled are *closed*; the rest are *open*.
- **A due date is a day, or a day and a time.** It is stored like an event's start: a date-only due
  is its UTC midnight with `due_all_day = 1`; a timed one is the instant. "Today" and "overdue" are
  worked out on the person's clock.
- **Closing a task keeps it.** `completed_at` is set when the status becomes done or canceled (and
  kept when it moves between the two); reopening clears it. Delete removes the task, with its links.
- **Tasks are on the calendar without being events.** Every open task with a due date is drawn
  on a built-in, read-only Tasks calendar (`src/tasks/calendar.tsx`): in the all-day row for a
  date-only task, or as a half hour at its time. Nothing is copied into `events`, so changing the
  due moves the task on the calendar. Selecting one opens a task card with Mark done and Open in
  Tasks, and the task sheet has Show in calendar. The Tasks row in the calendar list, or
  Settings → Calendar, hides them.
- **Tasks remind you like events do** (lume-tsk.7, lume-tsk.11). The engine's reminder scheduler
  plans alerts for open tasks with a due date, and `reminders_fired` records them keyed by task id
  and due, so each one is shown once.
  - Settings → Tasks sets the defaults: *Task reminders* for tasks due at a time (at the due time,
    5, 10, 15 or 30 minutes, 1 hour or 1 day before) and *Tasks due on a day* (9:00 on the day, or
    the day before).
  - Each task's Remind property overrides them (`alarms_json`, migration 22: NULL follows the
    default, `[]` is none).
  - Banners read "Due in 30 min", and opening one opens the task. The route carries the task id
    where an event's would be.
  - `remind_at` stays reserved.

## Schema (migrations 20, 21, 22 and 24)

Migration 20 created the tables. Migration 21 rebuilt `tasks` and `task_links` for statuses and
priorities, because SQLite can't change a CHECK constraint. It kept every row, rowid (the search
key) and link, and it added projects and labels. All times are epoch ms UTC.

### `tasks`
| column | notes |
|---|---|
| `n` INTEGER PK | the FTS rowid, as in `notes` |
| `id` TEXT UNIQUE | `task-<uuid>` |
| `uid` TEXT UNIQUE | `<uuid>@jefi`, for sync later |
| `number` INTEGER UNIQUE | shown as T-12; one more than the highest ever given out (`task_numbers`, migration 24), never reused. Undo after a delete gives the same number back |
| `title` | one line; never empty on save |
| `notes` | markdown |
| `status` | `backlog`, `todo` (the default), `in_progress`, `done` or `canceled` |
| `priority` | 0 none, 1 urgent, 2 high, 3 medium, 4 low |
| `project_id` | a `task_projects` row, or NULL; deleting the project sets it NULL |
| `due_at`, `due_all_day` | NULL when there's no due date |
| `remind_at` | reserved |
| `alarms_json` | reminders in minutes before the due (migration 22); NULL follows Settings, `[]` is none |
| `origin` | `manual`, `email`, `ai` or `menubar` |
| `completed_at`, `created_at`, `updated_at` | |

`task_search` is FTS5 over title and notes, kept by triggers. `task_projects` and `task_labels`
hold `id`, `name` (label names are unique, ignoring case) and a `#RRGGBB` `color`.
`task_label_links (task_id, label_id)` ties labels to tasks. `task_numbers` holds one row, the
highest number handed out so far, so deleting the newest task doesn't free its number.

### `task_links`
The same columns as `note_links`: `kind` is `thread`, `message`, `event` or `contact`. Mail links
store the UI id, the Message-ID header and a snapshot, and `linkOf` re-finds them after re-threading.
`detachAccount` also detaches `task_links`.

## Engine API (`MailEngine`)

Reads resolve with data (`[]` or `null` through the worker if it fails). Writes resolve with what
was stored and reject with a message fit to show. Each write emits
`{ type: 'tasksChanged', taskIds? }`.

- `listTasks(query?: TaskQuery): Promise<Task[]>`, where `TaskQuery` is
  `{ status?: 'open' | 'closed' | 'all' | TaskStatus[], projectId?, labelId?, search?, limit? }`.
  - Open tasks are sorted by due date (no date last), then priority (urgent first), then newest.
  - Closed tasks are sorted by `completed_at`, newest first.
  - `search` is FTS prefix matching, as in `listNotes`.
- `getTask(id)`
- `saveTask(input: TaskInput)`: creates (no `id`) or updates. Fields left `undefined` keep their
  value, and `null` clears `dueAt`, `remindAt` and `projectId`. `labelIds` replaces the task's
  labels. `links` are added, like notes.
- `setTaskDone(id, done)`: done, or back to todo.
- `listTaskProjects`, `saveTaskProject({ id?, name, color })`, `deleteTaskProject(id)`, and the same
  three for labels. Deleting a project or label keeps its tasks.
- `deleteTask(id)`
- `linkTask(taskId, target)`, `unlinkTask(linkId)`
- `tasksForThread(accountId, threadId)`: tasks linked to a conversation or any of its messages.

## Store (UI)

`src/local-data.ts` gets `tasksRev`, bumped by `tasksChanged`. The hooks are `useTasks(query)`,
`useThreadTasks(accountId, threadId)` and `useTasksRevision()`. The writes are store actions:
`saveTask`, `setTaskDone`, `deleteTask`, `linkTask` and `unlinkTask`. They toast and return `null`
or `false` when they fail.

## UI

- **Rail:** "Tasks" (⌘4, `circleCheck`), with a count of open tasks that are overdue or due today.
- **Sidebar (`src/tasks/sidebar.tsx`):** Tasks has a context column, like Linear:
  - the views, with counts: Active (todo and in progress), Today, Upcoming, Backlog, All tasks and
    Completed;
  - Projects and Labels, each with a + to add one and a right-click to delete it.

  `state.ts` holds the view, layout, grouping, ordering, filter and open sheet, shared with the pane.
- **Pane (`src/tasks/tasks-pane.tsx`):**
  - A header with the view's name, search (⌘F) and **New task**.
  - A toolbar with **Filter** (priority, labels, projects; the active filters show as removable
    chips) and **Display** (List or Board; group by status, priority, project, due date or nothing;
    order by priority, due date, created or updated).
  - **List:** a full-width table. An always-there "Add a task…" line on top reads a due date out of
    the text (`parseTaskText`; Enter arrives as the input's `onSubmit` in GPUIX, never as a keydown).
    Then come the group headers, each with a +, and one row per task: a priority icon, the T-number,
    a status icon, the title, then label, project and mail pills and the due date. The priority and
    status icons open their pickers in place. The status groups lead with In Progress.
  - **Board:** a column per group, in workflow order and kept even when empty, with cards showing
    the same properties.
  - **Keys:** C or N for a new task, J/K or the arrows to move, Enter to open, X to complete.
- **Sheet (`src/tasks/sheet.tsx`):** clicking a task slides a wide sheet over the list or board from
  the right. The title, notes, links and activity sit on the left; Properties on the right has the
  Status, Priority, Labels, Project and Due pickers (`pickers.tsx`). J/K step through the list and
  Esc closes it.
- **Composer (`src/tasks/composer.tsx`):** Linear's new-issue sheet, mounted at the shell. It has a
  title (a date typed into it sets the due), notes, and pills for status, priority, labels, project
  and due, plus Create more. It opens from New task, a group's +, C, the palette and the menu bar,
  and group + and project views prefill it.
- **Reader:**
  - A "Make task" toolbar button (and `T`) opens `MakeTaskPopover`, which is prefilled by
    `taskDraftFromMessage`: the cleaned subject, and the first date in the email that's still ahead
    as the due date. The due is picked from chips (the found date, Today, Tomorrow, Next week, No
    date), so there's no picker nested in the popover. The message menu and the list's context menu
    have "Make task" too; those save the draft straight away.
  - `ThreadLinks` shows linked tasks as chips with a checkbox, next to events and notes.
- **AI:** `suggestTasks(connection, thread, me, { today, timeZone })` in `src/ai.ts` asks for a JSON
  array of `{ title, due, quote }`, with `due` as a local ISO date or date-time (or null).
  `parseTaskSuggestions` in `src/tasks/suggest.ts` reads the answer as untrusted text: anything
  malformed is dropped, at most five, and titles are capped. The suggestions appear at the bottom of
  the Make task form, each with an Add button. An added task has `origin: 'ai'` and links to the
  message its quote came from.
- **Menu bar:** the model gets `tasks` (open ones, overdue then due today; four shown, `tasksMore`
  counts the rest). Its messages are `toggle-task`, `open-task`, `open-tasks` and `new-task` (which
  opens the composer). Ticking a task off and adding one with "Task:" in quick add happen with the
  panel open.

## Beads

1. lume-tsk.1: storage, engine API, worker, events, and tests
2. lume-tsk.2: store hooks and actions
3. lume-tsk.3: the Tasks pane, the rail item, ⌘4 and palette commands
4. lume-tsk.4: "Make task" from email (reader, message menu, list menu, `t`) and task chips in the
   reader
5. lume-tsk.5: AI action-item suggestions
6. lume-tsk.6: menu bar tasks and quick add
7. lume-tsk.7: due reminders (scheduler, notifications)
8. lume-tsk.8: tasks in the headless CLI and MCP
9. lume-tsk.9: website and What's New
10. lume-tsk.10: Linear-style statuses, priorities, T-numbers, labels, projects, sidebar views, table
    and board, Filter and Display, the composer and the detail sheet
