import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AutoClearManager } from "./auto-clear.js";
import { buildTaskHierarchy, getReadyParentIds, getSubtaskSummary } from "./hierarchy.js";
import type { TaskStore } from "./task-store.js";
import type { Task, TaskCreateInput, TaskUpdateFields } from "./types.js";
import type { TaskWidget } from "./ui/task-widget.js";

const TaskRelationSchema = Type.Object({
  type: Type.String({ description: "Relationship type, e.g. parent, related, validates, supersedes, or orderAfter" }),
  target: Type.String({ description: "Target task ID, or a create-batch key when used inside TaskCreate" }),
});

const TaskCreateItemSchema = Type.Object({
  key: Type.Optional(Type.String({ description: "Temporary key for references within this TaskCreate call" })),
  subject: Type.String({ description: "A brief title for the task" }),
  description: Type.String({ description: "A detailed description of what needs to be done" }),
  status: Type.Optional(Type.Unsafe<"pending" | "in_progress">({
    type: "string",
    enum: ["pending", "in_progress"],
    description: "Initial task status. Defaults to pending; use in_progress for the task you are starting immediately.",
  })),
  activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in the spinner when in_progress" })),
  agentType: Type.Optional(Type.String({ description: "Agent type for subagent execution" })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
  blocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs or create-batch keys this task blocks" })),
  blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs or create-batch keys that block this task" })),
  relations: Type.Optional(Type.Array(TaskRelationSchema, { description: "Non-blocking task relationships" })),
});

const TaskUpdateItemSchema = Type.Object({
  taskId: Type.String({ description: "The ID of the task to update" }),
  status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
    type: "string",
    enum: ["pending", "in_progress", "completed", "deleted"],
    description: "New status for the task",
  })),
  subject: Type.Optional(Type.String({ description: "New subject for the task" })),
  description: Type.Optional(Type.String({ description: "New description for the task" })),
  activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in the spinner when in_progress" })),
  owner: Type.Optional(Type.String({ description: "New owner for the task" })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge into the task. Set a key to null to delete it." })),
  addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
  addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
  setRelations: Type.Optional(Type.Array(TaskRelationSchema, { description: "Replace non-blocking relationships for this task" })),
  addRelations: Type.Optional(Type.Array(TaskRelationSchema, { description: "Add non-blocking relationships to this task" })),
  removeRelations: Type.Optional(Type.Array(TaskRelationSchema, { description: "Remove matching non-blocking relationships from this task" })),
});

type TaskCreateToolParams = { tasks?: TaskCreateInput[] } & Partial<TaskCreateInput>;
type TaskUpdateToolParams = {
  updates?: Array<TaskUpdateFields & { taskId: string }>;
  taskId?: string;
  includeList?: boolean;
} & TaskUpdateFields;

function normalizeTaskCreateParams(params: TaskCreateToolParams): TaskCreateInput[] {
  if (Array.isArray(params.tasks)) return params.tasks;
  if (typeof params.subject !== "string" || typeof params.description !== "string") return [];
  const { tasks: _tasks, ...task } = params;
  return [task as TaskCreateInput];
}

function normalizeTaskUpdateParams(params: TaskUpdateToolParams): Array<TaskUpdateFields & { taskId: string }> {
  if (Array.isArray(params.updates)) return params.updates;
  if (typeof params.taskId !== "string") return [];
  const { updates: _updates, includeList: _includeList, ...update } = params;
  return [update as TaskUpdateFields & { taskId: string }];
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

interface TaskMutationContext {
  getStore(): TaskStore;
  widget: TaskWidget;
  autoClear: AutoClearManager;
  getCurrentTurn(): number;
  formatTaskList(tasks: Task[]): string;
}

export function registerTaskMutationTools(pi: ExtensionAPI, context: TaskMutationContext): void {
  const { widget, autoClear, getCurrentTurn, formatTaskList } = context;

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Use this tool to create one or more structured tasks for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - Create the visible task set in one call
- After receiving new instructions - Immediately capture user requirements as tasks
- After completing a task - Add any newly discovered follow-up tasks

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Parameters

Pass \`tasks\`, an array of task objects. Use one element for a single task.

Each task supports:
- **key**: Temporary key for references inside this create call
- **subject**: A brief, actionable title in imperative form
- **description**: Detailed context and acceptance criteria
- **status**: Optional initial status, \`pending\` or \`in_progress\`; use \`in_progress\` for the task you are starting immediately
- **activeForm**: Present continuous form shown in the spinner when in_progress
- **agentType**: Agent type for subagent execution via TaskExecute
- **metadata**: Arbitrary metadata
- **blocks** / **blockedBy**: Hard dependencies using task IDs or keys from this call
- **relations**: Non-blocking relationships, e.g. \`parent\`, \`related\`, \`validates\`, \`supersedes\`, or \`orderAfter\`

Tasks default to status \`pending\`. Set \`status: "in_progress"\` on the task you are starting immediately to avoid a follow-up TaskUpdate call.

## Tips

- Create small, scan-friendly task sets instead of many separate tool calls
- Use \`key\` plus \`blockedBy\` to create tasks and their hard dependencies atomically
- Use \`relations\` for structure that should not block execution
- Check TaskList first to avoid creating duplicate tasks`,
    promptGuidelines: [
      "When working on complex multi-step tasks, use TaskCreate to track progress and TaskUpdate to update status.",
      "Mark tasks as in_progress before starting work and completed when done.",
      "Use TaskList to check for available work after completing a task.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(TaskCreateItemSchema, { description: "Tasks to create. Use one element for a single task.", minItems: 1 }),
    }),

    execute(_toolCallId, params: TaskCreateToolParams) {
      const inputs = normalizeTaskCreateParams(params);
      if (inputs.length === 0) return Promise.resolve(textResult("No tasks provided"));

      autoClear.startNewBatch();
      const { tasks, warnings } = context.getStore().createMany(inputs);
      for (const task of tasks) {
        if (task.status === "in_progress") widget.setActiveTask(task.id);
      }
      widget.update();

      let lines: string[];
      if (tasks.length === 1) {
        lines = [`Task #${tasks[0].id} created successfully: ${tasks[0].subject}`];
      } else {
        lines = [`Created ${tasks.length} tasks:`, ...tasks.map(task => `#${task.id} ${task.subject}`)];
      }
      if (warnings.length > 0) lines.push(`Warnings: ${warnings.join("; ")}`);
      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Use this tool to update one or more tasks in the task list.

## When to Use This Tool

**Before starting work on a task:**
- Mark it in_progress BEFORE beginning — do not start work without updating status first
- Set top-level \`includeList: true\` when you need the updated task summary immediately after the mutation

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, use \`includeList: true\` when you need the updated list or next available task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep it as in_progress
- Never mark a task as completed if tests are failing, implementation is partial, or unresolved errors remain

**Delete tasks:**
- Include an update with \`status: "deleted"\` to permanently remove that task
- Deleting a task cleans hard dependency edges and non-blocking relationships pointing to it

**Update task details and relationships:**
- Use \`updates\`, an array of update objects. Use one element for a single task.
- Set top-level \`includeList: true\` to append the post-update TaskList summary when you would otherwise call TaskList immediately afterward.
- \`addBlocks\` and \`addBlockedBy\` are hard blocking dependencies and affect availability.
- \`setRelations\`, \`addRelations\`, and \`removeRelations\` manage non-blocking structure such as \`parent\`, \`related\`, \`validates\`, \`supersedes\`, and \`orderAfter\`.

## Fields You Can Update

- **taskId**: Task to update
- **status**: \`pending\`, \`in_progress\`, \`completed\`, or \`deleted\`
- **subject**, **description**, **activeForm**, **owner**
- **metadata**: Shallow merge; set a key to null to delete it
- **addBlocks** / **addBlockedBy**: Hard dependencies
- **setRelations** / **addRelations** / **removeRelations**: Non-blocking relationships

## Additional Options

- **includeList**: Optional top-level boolean. When true, append the post-mutation task list summary to avoid a separate TaskList call.

## Examples

Mark one task as in progress:
\`\`\`json
{"updates": [{"taskId": "1", "status": "in_progress"}]}
\`\`\`

Complete and delete tasks together:
\`\`\`json
{"updates": [{"taskId": "1", "status": "completed"}, {"taskId": "2", "status": "deleted"}]}
\`\`\`

Add a soft ordering relationship:
\`\`\`json
{"updates": [{"taskId": "3", "addRelations": [{"type": "orderAfter", "target": "1"}]}]}
\`\`\`

Complete a task and include the updated list:
\`\`\`json
{"updates": [{"taskId": "1", "status": "completed"}], "includeList": true}
\`\`\``,
    parameters: Type.Object({
      updates: Type.Array(TaskUpdateItemSchema, { description: "Task updates to apply. Use one element for a single task.", minItems: 1 }),
      includeList: Type.Optional(Type.Boolean({ description: "Append the post-update TaskList summary to avoid a separate TaskList call" })),
    }),

    execute(_toolCallId, params: TaskUpdateToolParams) {
      const updates = normalizeTaskUpdateParams(params);
      if (updates.length === 0) return Promise.resolve(textResult("No task updates provided"));

      const store = context.getStore();
      const { results, warnings } = store.updateMany(updates);
      const lines: string[] = [];

      for (let i = 0; i < updates.length; i++) {
        const update = updates[i];
        const result = results[i];
        if (!result || (result.changedFields.length === 0 && !result.task)) {
          lines.push(`Task #${update.taskId} not found`);
          continue;
        }

        if (update.status === "in_progress") {
          widget.setActiveTask(update.taskId);
          autoClear.resetBatchCountdown();
        } else if (update.status === "pending") {
          autoClear.resetBatchCountdown();
        } else if (update.status === "completed" || update.status === "deleted") {
          widget.setActiveTask(update.taskId, false);
          if (update.status === "completed") autoClear.trackCompletion(update.taskId, getCurrentTurn());
        }

        lines.push(`Updated task #${update.taskId} ${result.changedFields.join(", ")}`);
      }

      if (warnings.length > 0) lines.push(`Warnings: ${warnings.join("; ")}`);
      if (updates.some(update => update.status === "completed" || update.status === "deleted")) {
        const hierarchy = buildTaskHierarchy(store.list());
        const readyParents = getReadyParentIds(hierarchy);
        if (readyParents.length > 0) {
          lines.push(`Ready to complete: ${readyParents.map(id => {
            const summary = getSubtaskSummary(id, hierarchy);
            return `#${id} (${summary.completed}/${summary.total} subtasks done)`;
          }).join(", ")}`);
        }
      }
      if (params.includeList) {
        lines.push("", "Task list:", formatTaskList(store.list()));
      }
      widget.update();
      return Promise.resolve(textResult(lines.join("\n")));
    },
  });
}
