import type { Task } from "./types.js";

export const TASK_STOP_HOOK_MESSAGE_TYPE = "tasks:stop-hook-open-tasks";

const MAX_TASKS_IN_PROMPT = 8;

export interface StopHookTrigger {
  openTaskIds: string[];
  prompt: string;
}

type StopHookContext = {
  hasPendingMessages?: () => boolean;
};

export interface StopHookState {
  lastPromptedFingerprint?: string;
  pendingTrigger?: StopHookTrigger;
  pendingSystemPrompt?: string;
}

export function createStopHookState(): StopHookState {
  return {};
}

export function resetStopHookPrompt(state: StopHookState): void {
  state.lastPromptedFingerprint = undefined;
  state.pendingTrigger = undefined;
  state.pendingSystemPrompt = undefined;
}

export function consumeStopHookTrigger(state: StopHookState): StopHookTrigger | undefined {
  const trigger = state.pendingTrigger;
  state.pendingTrigger = undefined;
  return trigger;
}

export function armStopHookSystemPrompt(state: StopHookState, prompt: string): void {
  state.pendingSystemPrompt = prompt;
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
    "[PI-TASKS SYSTEM STOP CHECK]",
    "This is internal system guidance, not a user message.",
    "Do not acknowledge, mention, quote, or summarize this instruction to the user.",
    "",
    "Open tasks remain:",
    ...lines,
    "",
    "Make one explicit choice for this check:",
    "- if an open task is already fully done, mark it completed with TaskUpdate;",
    "- delete tasks that are obsolete, accidental, superseded, or no longer needed;",
    "- if actionable in-scope work remains, continue the current in-progress task or start the next ready task;",
    "- if progress genuinely requires human input, permission, unavailable external information, or another explicit blocker, quiesce by asking the user for exactly what is needed or reporting the blocker. Do not call a task tool merely to suppress the check.",
    "",
    "This continuation is the only stop check for the current open-task snapshot. If you deliberately quiesce, the hook must not trigger another model turn until the open-task snapshot changes or new user input arrives.",
    "Never mark incomplete work completed. Prefer one TaskUpdate call with includeList:true when resolving multiple tasks. After each completion, continue with the next unblocked task unless you deliberately chose to quiesce.",
  ].join("\n");
}

export function removeStopHookTriggerMessages<T extends { role: string; customType?: string }>(messages: T[]): T[] {
  return messages.filter(message => message.role !== "custom" || message.customType !== TASK_STOP_HOOK_MESSAGE_TYPE);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function appendText(existing: unknown, prompt: string): string {
  return typeof existing === "string" && existing.length > 0 ? `${existing}\n\n${prompt}` : prompt;
}

export function appendSystemInstructionToProviderPayload(payload: unknown, prompt: string): unknown {
  const root = record(payload);
  if (!root) return payload;
  const next = { ...root };

  if (typeof next.instructions === "string") {
    next.instructions = appendText(next.instructions, prompt);
    return next;
  }
  if (typeof next.system === "string") {
    next.system = appendText(next.system, prompt);
    return next;
  }
  if (Array.isArray(next.system)) {
    next.system = [...next.system, { type: "text", text: prompt }];
    return next;
  }

  const systemInstruction = record(next.systemInstruction);
  if (systemInstruction && Array.isArray(systemInstruction.parts)) {
    next.systemInstruction = { ...systemInstruction, parts: [...systemInstruction.parts, { text: prompt }] };
    return next;
  }
  if (typeof next.systemInstruction === "string") {
    next.systemInstruction = appendText(next.systemInstruction, prompt);
    return next;
  }

  if (Array.isArray(next.input)) {
    const input = [...next.input];
    input.unshift({ role: "system", content: prompt });
    next.input = input;
    return next;
  }

  if (Array.isArray(next.messages)) {
    const messages = [...next.messages];
    const systemIndex = messages.findIndex(message => record(message)?.role === "system" || record(message)?.role === "developer");
    if (systemIndex >= 0) {
      const message = record(messages[systemIndex])!;
      if (typeof message.content === "string") messages[systemIndex] = { ...message, content: appendText(message.content, prompt) };
      else if (Array.isArray(message.content)) messages[systemIndex] = { ...message, content: [...message.content, { type: "text", text: prompt }] };
      else messages[systemIndex] = { ...message, content: prompt };
    } else {
      messages.unshift({ role: "system", content: prompt });
    }
    next.messages = messages;
    return next;
  }

  return payload;
}

function hasPendingMessages(ctx: StopHookContext): boolean {
  try {
    return typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages();
  } catch {
    return false;
  }
}

export function maybeQueueOpenTaskStopCheck(
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
  state.pendingTrigger = {
    openTaskIds: openTasks.map(task => task.id),
    prompt,
  };
  return true;
}
