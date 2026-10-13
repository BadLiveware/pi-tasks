# @tintinweb/pi-tasks

A [pi](https://pi.dev) extension that brings **Claude Code-style task tracking and coordination** to pi. Track multi-step work with batch task creation, hierarchical subtasks, dependency management, and a persistent visual widget.

> **Status:** Early release.

<img width="600" alt="pi-tasks screenshot" src="https://github.com/tintinweb/pi-tasks/raw/master/media/screenshot.png" />

https://github.com/user-attachments/assets/1d0ee87a-e0a5-4bfa-a9b9-2f9144cb905b



## Features

- **7 LLM (large language model)-callable tools** — `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskOutput`, `TaskStop`, `TaskExecute` — for task creation, updates, execution, and inspection
- **Batch task mutations** — create whole task sets in one `TaskCreate` call and update/complete/delete multiple tasks in one `TaskUpdate` call
- **Hierarchical task trees** — model parent/subtask relationships, nested trees, aggregate subtask progress, parallel-capable siblings, and ready-to-complete parent hints
- **Persistent widget** — live task list above the editor with tree connectors, `✔`/`◼`/`◻` status icons, task numbers (`#1`, `#2`, …), strikethrough for completed tasks, a Pi-style braille spinner (`⠋⠙⠹⠸`) for active tasks, and a smart viewport that keeps active/actionable work visible in larger lists
- **System-reminder injection** — periodic `<system-reminder>` nudges injected into the upcoming model request through the `context` hook, never persisted or added to unrelated tool output; also detects stale in-progress tasks
- **Stop-hook cleanup prompt**: when an agent stops with open tasks, pi-tasks injects one follow-up decision: clean up finished/obsolete tasks, keep working actionable tasks, or explicitly quiesce when human input or another real blocker is required
- **Configurable widget** — [custom glyphs](CUSTOMIZING.md#task-glyphs), sort presets and sort specs, completed-task collapse, and explicit top/bottom visible limits
- **Prompt guidelines** — workflow contract encoded in tool descriptions, nudging the LLM at the point of tool use
- **Dependency and relationship management** — hard `blocks`/`blockedBy` dependencies plus non-blocking relationships such as `parent`, `related`, `validates`, `supersedes`, and `orderAfter`
- **Shared task lists** — multiple pi sessions can share a file-backed task list for agent team coordination
- **File locking** — concurrent access is safe when multiple sessions share a task list
- **Background process tracking** — track spawned processes with output buffering, blocking wait, and graceful stop
- **Subagent integration** — tasks with `agentType` can be executed as subagents via `TaskExecute` (requires [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)). Auto-cascade mode flows through the task DAG automatically when enabled.

## Install

```bash
pi install npm:@tintinweb/pi-tasks
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

## Widget

The extension renders a persistent widget above the editor:

```
● 4 tasks (1 done, 1 in progress, 2 open)
  ✔ #1 Design the flux capacitor
  ⠙ #2 Acquiring plutonium… (2m 49s · ↑ 4.1k ↓ 1.2k)
  ◻ #3 Install flux capacitor in DeLorean › blocked by #1
  ◻ #4 Test time travel at 88 mph › blocked by #2, #3
```

| Glyph | Meaning |
|------|---------|
| `✔` | Completed (strikethrough + dim) |
| `◼` | In-progress (not actively executing) |
| `◻` | Pending |
| `⠋`/`⠙`/`⠹`/`⠸` | Animated braille spinner — actively executing task (shows `activeForm` text, elapsed time, token counts) |

The widget shows a larger default viewport than earlier releases and switches to a smart selection when the list is longer: active or in-progress rows stay visible with parent context, ready parent tasks and unblocked pending work are favored, and hidden ranges are summarized as `… N hidden tasks`. `TaskList` still returns the full task tree on demand.

Long task trees stay focused on current work:

```
● 26 tasks (1 in progress, 25 open)
  ◻ #57 Build observatory › 0/25 subtasks
  … 3 hidden tasks
  ├─ ◻ #61 Grind primary lens
  ├─ ◻ #62 Polish mirror
  ├─ ⠙ #69 Calibrating the first-light target… (44m 50s · ↑ 670.3k ↓ 1.6k)
  ├─ ◻ #70 Open observation notebook
  ├─ ◻ #71 Take first-light photo › blocked by #69
  … 5 hidden tasks
```

### Widget display settings

How tasks are sorted and how many are shown can be configured via `/tasks` → Settings (saved as project overrides in `.pi/tasks-config.json`), except `glyphs`, which is set in the config file directly.
With no explicit `sortOrder`, `maxVisible`, or `hiddenAt`, the widget keeps the fork's pending-first flat order and smart viewport (14 task rows, or 10–18 based on terminal height).
Explicit `sortOrder` sorts roots and siblings while keeping subtasks under their parents.
Explicit `maxVisible` or `hiddenAt` selects top/bottom truncation and ID order unless `sortOrder` is set.
`showAll` bypasses either limit; `collapseCompleted` works with both modes.

> **[→ Customizing the task widget](CUSTOMIZING.md)** — the full guide: global vs. project config, sort presets, writing your own sort order, and recipes.

| Setting | Values | Default | Behaviour |
|---------|--------|---------|-----------|
| `sortOrder` | `id` / `status` / `active` / `recent` / `oldest`, or a [sort spec](CUSTOMIZING.md#writing-your-own-sort-order) | fork order when unset | `id` = creation order; `status` groups completed → in-progress → pending; `active` is the reverse grouping (in-progress → pending → completed); `recent`/`oldest` = by last-updated time |
| `collapseCompleted` | `true` / `false` | `false` | When `true`, completed tasks are replaced by a single `✔ N completed` line at the bottom |
| `maxVisible` | `5`–`100` | smart viewport when unset | Caps how many task lines the widget shows (ignored when `showAll` is on) |
| `showAll` | `true` / `false` | `false` | When `true`, every listed task is shown regardless of `maxVisible` |
| `hiddenAt` | `bottom` / `top` | smart viewport when unset | When the list overflows `maxVisible`, where the `… and N more` collapse happens. `top` pairs well with `sortOrder: status` to keep active work visible and fold completed tasks away |
| `glyphs` | a [glyph set](CUSTOMIZING.md#task-glyphs) | `✔` / `◼` / `◻` + braille spinner | Every character the widget is drawn with — status marks, spinner frames, header bullet, overflow and truncation markers, token arrows. Config file only |

> Note: the widget's `status` order is completed-first (so finished work collapses at the top with `hiddenAt: top`), which is the reverse of the `TaskList` tool's pending-first order. Use `active` for pending-first.

`collapseCompleted` and the visible limit are independent: collapsing decides what goes in the list, and `maxVisible` / `showAll` / `hiddenAt` then apply to whatever remains.

For an order the presets don't cover, `sortOrder` also accepts a **sort spec** — an ordered list of comparison keys, written into `tasks-config.json`:

```json
{
  "sortOrder": [
    { "field": "status", "rank": ["in_progress", "pending", "completed"] },
    { "field": "id" }
  ]
}
```

See [Writing your own sort order](CUSTOMIZING.md#writing-your-own-sort-order) for the full key reference and recipes.

> Configuration is data, never code. There is deliberately no executable config file, so nothing in a cloned repository's `.pi/` can run on your machine.

## Tools

### `TaskCreate`

Create one or more structured tasks. Pass `tasks`, an array of task objects; use one element for a single task.

| Task field | Type | Required | Description |
|------------|------|----------|-------------|
| `key` | string | no | Temporary key for references inside this create call |
| `subject` | string | yes | Brief imperative title |
| `description` | string | yes | Detailed context and acceptance criteria |
| `status` | `pending` / `in_progress` | no | Initial status; defaults to `pending`. Use `in_progress` for the task you are starting immediately |
| `activeForm` | string | no | Present continuous form for spinner (e.g., "Running tests") |
| `agentType` | string | no | Agent type for subagent execution (e.g., `"general-purpose"`, `"Explore"`) |
| `metadata` | object | no | Arbitrary key-value pairs |
| `blocks` | string[] | no | Task IDs or keys this task blocks |
| `blockedBy` | string[] | no | Task IDs or keys that block this task |
| `relations` | object[] | no | Non-blocking relationships with `type` and `target` |

```json
{
  "tasks": [
    { "key": "design", "subject": "Design API", "description": "Decide the shape", "status": "in_progress" },
    {
      "key": "docs",
      "subject": "Document API",
      "description": "Write usage notes",
      "blockedBy": ["design"],
      "relations": [{ "type": "validates", "target": "design" }]
    }
  ]
}
```

```
→ Created 2 tasks:
#1 Design API
#2 Document API
```

### `TaskList`

List all tasks with status, owner, blocked-by info, and hierarchy summaries.

```
#1 [pending] Deliver feature [container 1/3 done] [parallel #3, #4]
├─ #2 [completed] Design API
├─ #3 [pending] Implement API
└─ #4 [pending] Write docs
#5 [pending] Validate feature [blocked by #3, #4]
```

Flat lists sort pending first, then in-progress, then completed (each group by ID). Hierarchical lists render parent tasks with tree connectors so container context stays visible.

### `TaskGet`

Get full details for a specific task.

```
Task #2: Write unit tests
Status: in_progress
Owner: agent-1
Description: Add tests for the auth module
Parent: #1
Parallel siblings: #4
Blocked by: #1
Blocks: #3
Relations: parent #1, validates #1
```

For parent tasks, `TaskGet` also shows direct subtasks, aggregate subtask progress, available parallel subtasks, and ready-to-complete hints. Shows owner (if set), open dependency edges, and non-blocking relationships. Non-empty metadata is displayed as JSON.

### `TaskUpdate`

Update one or more tasks. Pass `updates`, an array of update objects; use one element for a single task. Set top-level `includeList: true` when you want the post-update task summary in the same response instead of making a separate `TaskList` call.

| Update field | Type | Description |
|--------------|------|-------------|
| `taskId` | string | Task ID (required) |
| `status` | `pending` / `in_progress` / `completed` / `deleted` | New status |
| `subject` | string | New title |
| `description` | string | New description |
| `activeForm` | string | Spinner text |
| `owner` | string | Agent name |
| `metadata` | object | Shallow merge (null values delete keys) |
| `addBlocks` | string[] | Hard dependencies this task blocks |
| `addBlockedBy` | string[] | Hard dependencies that block this task |
| `setRelations` | object[] | Replace non-blocking relationships |
| `addRelations` | object[] | Add non-blocking relationships |
| `removeRelations` | object[] | Remove matching non-blocking relationships |

```json
{
  "updates": [
    { "taskId": "1", "status": "completed" },
    { "taskId": "2", "status": "deleted" }
  ]
}
```

```
→ Updated task #1 status
→ Updated task #2 deleted
```

To complete a task and immediately see the updated list:

```json
{
  "updates": [{ "taskId": "1", "status": "completed" }],
  "includeList": true
}
```

```
→ Updated task #1 status

Task list:
#2 [pending] Next work
#1 [completed] Finish me
```

When a batch completes all subtasks for a parent, the response includes a ready-to-complete hint:

```
→ Ready to complete: #10 (4/4 subtasks done)
```

Setting `status: "deleted"` permanently removes the task.

Dependencies are bidirectional: `addBlocks: ["3"]` on task 1 also adds `blockedBy: ["1"]` to task 3. Non-blocking `relations` are directional structure only and do not affect whether a task can start.

### `TaskOutput`

Retrieve output from a background task process.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task_id` | string | — | Task ID or agent ID (required) |
| `block` | boolean | `true` | Wait for completion |
| `timeout` | number | `30000` | Max wait time in ms (max 600000) |

Both task IDs and agent IDs (including partial prefixes) are accepted — agent IDs are resolved via the internal `agentTaskMap`.

For a subagent task that has finished, the tool returns the agent's stored result (or its error) under the status line, so joining a task and reading what it produced is one call. Doing so also [consumes the result](#joining-a-subagent).

### `TaskStop`

Stop a running background task process. Sends SIGTERM, waits 5 seconds, then SIGKILL. For subagent tasks, sends a stop RPC.

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_id` | string | Task ID or agent ID to stop |

### `TaskExecute`

Execute one or more tasks as background subagents. Requires [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents).

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_ids` | string[] | Task IDs to execute (required) |
| `additional_context` | string | Extra context appended to each agent's prompt |
| `model` | string | Model override (e.g., `"sonnet"`, `"haiku"`) |
| `max_turns` | number | Max turns per agent |

Tasks must be `pending`, have `agentType` set, and all `blockedBy` dependencies `completed`. Each task spawns as an independent background subagent.

With **auto-cascade** enabled (via `/tasks` → Settings), completed tasks automatically trigger execution of their unblocked dependents — flowing through the DAG like a build system. Each cascaded agent receives its prerequisites' stored results in the prompt, so it can build directly on what came before without re-fetching.

## Task Lifecycle

```
pending → in_progress → completed
                      → deleted (permanently removed)
```

Tasks default to `pending`; `TaskCreate` also accepts initial `in_progress` status.
Mark `in_progress` before starting work and `completed` when done.
`deleted` removes the task entirely; IDs never reset.

## Dependency, Hierarchy, and Relationship Management

- **Batch creation:** `TaskCreate` can create tasks and resolve temporary `key` references in one atomic mutation
- **Bidirectional hard edges:** `blocks`/`blockedBy` and `addBlocks`/`addBlockedBy` maintain both sides automatically
- **Hierarchy:** `relations: [{ "type": "parent", "target": "..." }]` nests a subtask under a parent/container task
- **Parallel subtasks:** Siblings under the same parent with no hard dependency edge between them are shown as parallel-capable; multiple currently unblocked children are shown as `parallel #...`
- **Non-blocking relations:** `relations`, `setRelations`, `addRelations`, and `removeRelations` record structure without blocking execution
- **Completion hints:** Parent tasks show aggregate subtask progress and are reported as ready to complete once all subtasks are completed
- **Dependency warnings:** cycles, self-dependencies, and references to non-existent tasks are stored but produce warnings in the tool response
- **Display-time filtering:** `TaskList` only shows non-completed blockers in `[blocked by ...]`
- **Raw data preserved:** `TaskGet` shows all hard edges and non-blocking relations
- **Cleanup on deletion:** removing a task cleans up hard edges and relations pointing to it

Example nested task set:

```json
{
  "tasks": [
    { "key": "feature", "subject": "Deliver feature", "description": "Container task" },
    {
      "key": "api",
      "subject": "Implement API",
      "description": "Build the endpoint",
      "relations": [{ "type": "parent", "target": "feature" }]
    },
    {
      "key": "docs",
      "subject": "Write docs",
      "description": "Document the endpoint",
      "relations": [{ "type": "parent", "target": "feature" }]
    },
    {
      "key": "validate",
      "subject": "Validate feature",
      "description": "Run checks after implementation and docs",
      "blockedBy": ["api", "docs"],
      "relations": [
        { "type": "parent", "target": "feature" },
        { "type": "validates", "target": "feature" }
      ]
    }
  ]
}
```

## Task Storage

Task storage is controlled by the `taskScope` setting (`/tasks` → Settings → Task storage):

| Mode | File | Behaviour |
|------|------|-----------|
| `memory` | *(none)* | In-memory only — tasks lost when session ends |
| `session` **(default)** | `<workspace>/.pi/tasks/tasks-<sessionId>.json` | Per-session file — isolated between sessions, survives resume |
| `session-global` | `<agent-dir>/tasks/sessions/<project-key>/tasks-<sessionId>.json` | The same, kept outside the workspace so repositories stay clean |
| `project` | `<workspace>/.pi/tasks/tasks.json` | Shared across all sessions in the project |

`<workspace>` is the directory pi reports for the session — the same one its file tools operate in. That is normally where you started pi; it differs only when a session is opened by an explicit path from another project, or when a host serves sessions from elsewhere.

`session-global` exists because a per-session file keyed by a session ID is runtime state, not project content: it means nothing to anyone else who clones the repository, and it costs a `.gitignore` rule per project. `<agent-dir>` is `~/.pi/agent` unless pi is configured otherwise, the same directory the [global settings](#global-defaults) live in. `<project-key>` encodes the workspace path the way pi encodes it for its own session logs (`/Users/me/work/repo` → `--Users-me-work-repo--`), so a project's task files sit under the same name as its transcripts and same-ID sessions in different workspaces cannot collide.

Under either session scope, tasks stay in memory whenever pi is not persisting the session (`pi --no-session`) — there is no session for the file to belong to, so none is written. `project` scope still writes its shared list, since that belongs to the project rather than the session.

Switching to `session-global` never moves or deletes anything. It changes where *new* session files are created; a session that already has a file in `<workspace>/.pi/tasks/` keeps using it, so resuming that session still finds its tasks and switching back to `session` strands nothing. To empty an existing `.pi/tasks/`, clear those sessions' tasks as usual — the file is removed once its list is empty.

Picking `session-global` from `/tasks` → Settings saves it as a *project* override in `<workspace>/.pi/tasks-config.json`, so that repository still gets a `.pi/` — holding config rather than task data. To apply it everywhere and leave repositories alone, set it once as a [global default](#global-defaults) instead:

```json
{
  "taskScope": "session-global"
}
```

On new session start, if all persisted tasks are completed they are auto-cleared for a clean slate. On session resume, all tasks (including completed) are shown so the user can review progress. Empty session files are automatically deleted when all tasks are cleared.

### Auto-clear completed tasks

The `autoClearCompleted` setting controls automatic cleanup of completed tasks:

| Mode | Behaviour |
|------|-----------|
| `never` | Completed tasks stay visible until manually cleared via `/tasks` → Clear completed |
| `on_list_complete` **(default)** | Cleared once all tasks are done and a few idle turns pass |
| `on_task_complete` | Each completed task cleared individually after a few turns |

Both auto-clear modes use a turn-based delay for non-jarring UX — tasks linger briefly so you see the completion before they disappear.

### Stop-hook open task cleanup

On `agent_end`, if pending or in-progress tasks remain and no other extension follow-up is pending, pi-tasks triggers one extra turn with hidden transport and injects the decision instructions into the provider's native system/instructions field for that continuation. The trigger marker is removed from model context, so it cannot appear as a user message. The agent must explicitly choose to mark finished tasks completed, delete obsolete tasks, continue actionable work, or quiesce because progress genuinely needs human input, permission, unavailable information, or another blocker. When quiescing, it may ask the user for exactly what is needed without mentioning the hook itself. The hook fingerprints the open-task snapshot, so the continuation's own `agent_end` does not create a `stopHook → model → stopHook` loop; it checks again only after the task snapshot changes or new user input arrives. Session switches also reset the prompt gate.


In either mode, a list with nothing left to do is also retired when a *later* batch of work begins, however long it has been sitting there. The turn delay only runs while the conversation does, so a list completed just before the agent stopped would otherwise still be on screen when the next task arrived, and that task would join it. The finished list stays visible while you read it and through any follow-up question, and goes when the agent starts new work. Tasks the agent adds to a list it is still working through are unaffected, and task IDs stay monotonic and are never reused.

Settings (`taskScope`, `autoCascade`, `autoClearCompleted`, plus the [widget display settings](#widget-display-settings) `sortOrder` / `collapseCompleted` / `maxVisible` / `showAll` / `hiddenAt`) changed through `/tasks` are saved as project overrides in `<workspace>/.pi/tasks-config.json`. `glyphs` is config-file only — see [CUSTOMIZING.md](CUSTOMIZING.md#task-glyphs).

### Global defaults

Put settings that should apply across projects in `<agent-dir>/tasks-config.json` (`~/.pi/agent/tasks-config.json` by default). The agent directory follows pi's configured agent path. Project settings in `<workspace>/.pi/tasks-config.json` take precedence key by key.

For example, enable auto-cascade by default for every project:

```json
{
  "autoCascade": true
}
```

The `/tasks` settings menu writes only project overrides. Changing another setting in a project does not copy global defaults into that project's config.

See [Customizing the task widget](CUSTOMIZING.md#where-config-lives) for worked examples of how the two files merge.

### Override via environment variables

| Variable | Value | Behaviour |
|----------|-------|-----------|
| `PI_TASKS` | `off` | In-memory only (CI/automation) |
| `PI_TASKS` | `sprint-1` | Named shared list at `~/.pi/tasks/sprint-1.json` |
| `PI_TASKS` | `/abs/path/tasks.json` | Explicit absolute file path |
| `PI_TASKS` | `./tasks.json` | Relative path resolved from the session workspace |
| *(unset)* | | Uses `taskScope` setting (default: `session`) |
| `PI_TASKS_DEBUG` | `1` | Trace RPC communication (request/reply/timeout) and spawn errors to stderr |

Named and explicit paths use a file-locked store with stale-lock detection — safe for multiple pi sessions coordinating on the same task list.

**CI example** (`.envrc`):
```bash
export PI_TASKS=off
```

**Shared team list** (`.envrc`):
```bash
export PI_TASKS=my-project
```

## `/tasks` Command

Interactive menu:

```
Tasks
├─ View all tasks (4)
├─ Create task
├─ Clear completed (1)
├─ Clear all (4)
└─ Settings
```

- **View all tasks** — select a task to see details and take actions (start, complete, delete)
- **Create task** — input prompts for subject and description
- **Clear completed** — remove all completed tasks
- **Clear all** — remove all tasks regardless of status
- **Settings** — configure project overrides for task storage, auto-cascade, auto-clear completed tasks, and [widget display](#widget-display-settings) (sort order, max visible, show all, hidden position)

## Cross-extension Communication with [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)

[`pi-tasks`](https://github.com/tintinweb/pi-tasks) communicates with [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) via pi's eventbus using a scoped request/reply RPC protocol. No shared global state — just events.

### Presence Detection

Load order doesn't matter. Two handshake paths ensure detection regardless of which extension loads first:

1. **Ping on init** — [`pi-tasks`](https://github.com/tintinweb/pi-tasks) emits `subagents:rpc:ping` with a unique `requestId` and listens for `subagents:rpc:ping:reply:{requestId}`. If [`pi-subagents`](https://github.com/tintinweb/pi-subagents) is already loaded, it replies immediately.
2. **Ready broadcast** — [`pi-subagents`](https://github.com/tintinweb/pi-subagents) emits `subagents:ready` when it initializes. If [`pi-tasks`](https://github.com/tintinweb/pi-tasks) loaded first, it picks this up.

```
┌─────────────┐                    ┌──────────────────┐
│  pi-tasks   │                    │  pi-subagents    │
└──────┬──────┘                    └────────┬─────────┘
       │                                    │
       │──── subagents:rpc:ping ───────────▶│
       │◀─── subagents:rpc:ping:reply ──────│
       │                                    │
       │◀─── subagents:ready ───────────────│  (broadcast on init)
       │                                    │
```

### Spawning Subagents

When `TaskExecute` runs, it sends a spawn RPC with a scoped reply channel:

```
pi-tasks                                pi-subagents
   │                                         │
   │── subagents:rpc:spawn ─────────────────▶│  { requestId, type, prompt, options }
   │◀─ subagents:rpc:spawn:reply:{reqId} ───│  { id }  (or { error })
   │                                         │
```

The returned `id` is stored in an in-memory `agentTaskMap` (agentId → taskId) for O(1) completion lookup. A 30-second timeout rejects the Promise if no reply arrives.

### Lifecycle Events

[`pi-subagents`](https://github.com/tintinweb/pi-subagents) emits lifecycle events that [`pi-tasks`](https://github.com/tintinweb/pi-tasks) listens to:

| Event | Payload | Action |
|-------|---------|--------|
| `subagents:completed` | `{ id, result? }` | Mark task `completed`, trigger auto-cascade if enabled |
| `subagents:failed` | `{ id, error?, status }` | Revert task to `pending`, store error in metadata |

### Joining a Subagent

`TaskOutput` waits on those same lifecycle events and then returns the stored result. Handing it to the model *consumes* it: pi-tasks says so over the bus, and pi-subagents drops the completion notification it was holding for that agent, which would otherwise arrive after the model had already answered and cost a turn to dismiss.

```
pi-tasks                                pi-subagents
   │                                         │
   │◀─ subagents:completed ─────────────────│  { id, result }
   │── subagents:rpc:consume ───────────────▶│  { requestId, agentId }
   │                                         │
```

Fire-and-forget, and deliberately outside the version handshake — a [`pi-subagents`](https://github.com/tintinweb/pi-subagents) without the handler keeps notifying, exactly as before. An agent that is still running is never consumed: nothing has been read from it yet, and its notification is the only thing that will announce it.

### Standalone Mode

If [`pi-subagents`](https://github.com/tintinweb/pi-subagents) is not installed, everything works except `TaskExecute`, which returns a friendly message explaining the agent can fall back to plain Agent-tool spawns — with the caveat that pi-tasks won't track those (status stays `pending`, auto-cascade won't fire, `TaskOutput` stays empty). All core task tools (create, list, get, update, dependencies, widget, system-reminder injection) function independently.

## Architecture

```
src/
├── index.ts            # Extension entry: 7 tools + /tasks command + widget + subagent integration
├── types.ts            # Task, TaskStatus, BackgroundProcess types
├── task-store.ts       # File-backed store with CRUD, dependencies, locking
├── auto-clear.ts       # Turn-based auto-clearing of completed tasks (AutoClearManager)
├── task-mutation-tools.ts # Batch creation/update registration and workflows
├── hierarchy.ts        # Parent/subtask trees and progress summaries
├── stop-hook.ts        # agent_end system guidance for unresolved task cleanup
├── tasks-config.ts     # Global defaults and project override persistence
├── task-paths.ts       # Where session task files live, per taskScope
├── task-glyphs.ts      # Glyph defaults and config validation
├── task-sort.ts        # Widget ordering: sort presets and sort specs
├── reminder-cadence.ts # Pure cadence logic for system-reminder injection
├── process-tracker.ts  # Background process output buffering and stop
└── ui/
    ├── task-widget.ts  # Persistent widget with status glyphs and spinner
    └── settings-menu.ts  # /tasks → Settings panel (SettingsList TUI component)
```

## Future Work

- **Background Bash auto-task creation** — Claude Code auto-creates tasks when `Bash` runs with `run_in_background: true`. Pi's bash tool currently lacks a `run_in_background` parameter (only `command` + `timeout`), so there's nothing to hook into. Once pi adds background execution support to its bash tool, we can use the `tool_call` event to detect it and auto-create tasks via `TaskStore`/`ProcessTracker`.

## Development

```bash
npm install
npm run typecheck   # TypeScript validation
npm test            # Run unit tests
```

## License

MIT — [tintinweb](https://github.com/tintinweb)
