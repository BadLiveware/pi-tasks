import type { Task } from "./types.js";

export const TASK_STOP_HOOK_MESSAGE_TYPE = "tasks:stop-hook-open-tasks";

const MAX_TASKS_IN_PROMPT = 8;

type StopHookPi = {
  sendMessage: (message: {
    customType: string;
    content: string;
    display: boolean;
    details?: Record<string, unknown>;
  }, options: { triggerTurn: boolean }) => void;
};

type StopHookContext = {
  hasPendingMessages?: () => boolean;
};

export interface StopHookState {
  lastPromptedFingerprint?: string;
  pendingSystemPrompt?: string;
}

export function createStopHookState(): StopHookState {
  return {};
}

export function resetStopHookPrompt(state: StopHookState): void {
  state.lastPromptedFingerprint = undefined;
  state.pendingSystemPrompt = undefined;
}

export function consumeStopHookSystemPrompt(state: StopHookState): string | undefined {
  const prompt = state.pendingSystemPrompt;
  state.pendingSystemPrompt = undefined;
  return prompt;
}

export function openTasksForStopHook(tasks: Task[]): Task[] {
  return tasks
    .filter(task => task.status !== "completed")
    .sort((left, right) => {
      const statusRank = (task: Task) => task.status === "in_progress" ? 0 : 1;
      return statusRank(left) - statusRank(right) || Number(left.id) - Number(right.id);
    });
}

export function fingerprintOpenTasks(tasks: Task[]): string {
  return openTasksForStopHook(tasks).map(task => [
    task.id,
    task.status,
    task.owner ?? "",
    task.subject,
    [...task.blockedBy].sort().join(","),
    [...task.blocks].sort().join(","),
  ].join("\u001f")).join("\u001e");
}

function formatTaskLine(task: Task): string {
  const parts = [`#${task.id}`, `[${task.status}]`, task.subject];
  if (task.owner) parts.push(`owner=${task.owner}`);
  if (task.blockedBy.length > 0) parts.push(`blockedBy=${task.blockedBy.map(id => `#${id}`).join(",")}`);
  return `- ${parts.join(" ")}`;
}

export function buildStopHookPrompt(openTasks: Task[]): string {
  const shown = openTasks.slice(0, MAX_TASKS_IN_PROMPT);
  const omitted = openTasks.length - shown.length;
  const lines = shown.map(formatTaskLine);
  if (omitted > 0) lines.push(`- … ${omitted} more open task${omitted === 1 ? "" : "s"}`);

  return [
    "[PI-TASKS STOP HOOK]",
    "This is a system instruction from pi-tasks, not a user request. Do not present it as user input.",
    "Task cleanup needed before stopping.",
    "",
    "Open tasks remain:",
    ...lines,
    "",
    "Do not leave abandoned tasks behind. Use TaskUpdate now to resolve the list:",
    "- mark tasks completed only when their described work is fully done;",
    "- delete tasks that are obsolete, accidental, superseded, or no longer needed;",
    "- if a task is still real in-scope work, continue working it instead of stopping.",
    "",
    "Prefer one TaskUpdate call with includeList:true when possible. Do not summarize final completion to the user until the task list is resolved or the remaining open work is explicitly justified by continued execution.",
  ].join("\n");
}

function hasPendingMessages(ctx: StopHookContext): boolean {
  try {
    return typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages();
  } catch {
    return false;
  }
}

export function maybePromptForOpenTasks(
  pi: StopHookPi,
  ctx: StopHookContext,
  tasks: Task[],
  state: StopHookState,
): boolean {
  const openTasks = openTasksForStopHook(tasks);
  if (openTasks.length === 0) {
    resetStopHookPrompt(state);
    return false;
  }
  if (hasPendingMessages(ctx)) return false;

  const fingerprint = fingerprintOpenTasks(openTasks);
  if (state.lastPromptedFingerprint === fingerprint) return false;

  const prompt = buildStopHookPrompt(openTasks);
  state.lastPromptedFingerprint = fingerprint;
  state.pendingSystemPrompt = prompt;
  pi.sendMessage({
    customType: TASK_STOP_HOOK_MESSAGE_TYPE,
    content: `pi-tasks queued a system cleanup check for ${openTasks.length} open task${openTasks.length === 1 ? "" : "s"}.`,
    display: true,
    details: {
      openTaskIds: openTasks.map(task => task.id),
      source: "agent_end",
      promptDelivery: "before_agent_start.systemPrompt",
    },
  }, { triggerTurn: true });
  return true;
}
