/**
 * task-widget.ts — Persistent widget showing task list with status icons and progress.
 *
 * Display style matches Claude Code's task list:
 *   ✔ completed tasks (strikethrough + dim)
 *   ◼ in_progress tasks
 *   ◻ pending tasks
 *   ⠋/⠙/⠹/⠸ actively executing task (spinner with activeForm text)
 */

import { truncateToWidth } from "@mariozechner/pi-tui";
import type { TaskHierarchy, TaskHierarchyRow } from "../hierarchy.js";
import {
  buildTaskHierarchy,
  flattenTaskHierarchy,
  formatTaskRefs,
  getOpenBlockerIds,
} from "../hierarchy.js";
import type { TaskStore } from "../task-store.js";

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Pi-style braille spinner frames for animated active task indicators. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 180;

const DEFAULT_VISIBLE_TASK_ROWS = 14;
const MIN_VISIBLE_TASK_ROWS = 10;
const MAX_VISIBLE_TASK_ROWS = 18;

/** Per-task runtime metrics (elapsed time, token usage). */
export interface TaskMetrics {
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
}

/** Format milliseconds as a human-readable duration (e.g., "2m 49s", "1h 3m"). */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** Format token count with k suffix (e.g., "4.1k", "850"). */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function visibleTaskRowBudget(tui: any): number {
  const terminalRows = tui?.terminal?.rows;
  if (typeof terminalRows !== "number" || !Number.isFinite(terminalRows)) return DEFAULT_VISIBLE_TASK_ROWS;
  return clamp(Math.floor(terminalRows * 0.35), MIN_VISIBLE_TASK_ROWS, MAX_VISIBLE_TASK_ROWS);
}

type WidgetViewportItem =
  | { kind: "row"; row: TaskHierarchyRow }
  | { kind: "marker"; hiddenCount: number };

function isActionable(row: TaskHierarchyRow, hierarchy: TaskHierarchy): boolean {
  return row.task.status === "pending" && getOpenBlockerIds(row.task, hierarchy).length === 0;
}

function findFocusIndex(rows: TaskHierarchyRow[], hierarchy: TaskHierarchy, activeTaskIds: Set<string>): number {
  const activeIndex = rows.findIndex(row => activeTaskIds.has(row.task.id) && row.task.status === "in_progress");
  if (activeIndex !== -1) return activeIndex;

  const inProgressIndex = rows.findIndex(row => row.task.status === "in_progress");
  if (inProgressIndex !== -1) return inProgressIndex;

  const readyParentIndex = rows.findIndex(row => row.readyToComplete);
  if (readyParentIndex !== -1) return readyParentIndex;

  const actionableIndex = rows.findIndex(row => isActionable(row, hierarchy));
  if (actionableIndex !== -1) return actionableIndex;

  const pendingIndex = rows.findIndex(row => row.task.status === "pending");
  return pendingIndex !== -1 ? pendingIndex : 0;
}

function buildWidgetViewport(
  rows: TaskHierarchyRow[],
  hierarchy: TaskHierarchy,
  activeTaskIds: Set<string>,
  rowBudget: number,
): WidgetViewportItem[] {
  if (rows.length <= rowBudget) return rows.map(row => ({ kind: "row", row }));

  const rowIndexByTaskId = new Map(rows.map((row, index) => [row.task.id, index]));
  const selected = new Set<number>();
  const focusIndex = findFocusIndex(rows, hierarchy, activeTaskIds);
  const addIndex = (index: number) => {
    if (index >= 0 && index < rows.length && selected.size < rowBudget) selected.add(index);
  };
  const addWithAncestors = (index: number) => {
    const chain: number[] = [];
    let current: TaskHierarchyRow | undefined = rows[index];
    while (current) {
      const currentIndex = rowIndexByTaskId.get(current.task.id);
      if (currentIndex === undefined || chain.includes(currentIndex)) break;
      chain.unshift(currentIndex);
      current = current.parentId ? rows[rowIndexByTaskId.get(current.parentId) ?? -1] : undefined;
    }
    for (const chainIndex of chain.slice(-rowBudget)) addIndex(chainIndex);
  };

  addWithAncestors(focusIndex);

  for (let index = 0; index < rows.length && selected.size < rowBudget; index++) {
    const row = rows[index];
    if (activeTaskIds.has(row.task.id) || row.task.status === "in_progress" || row.readyToComplete) {
      addWithAncestors(index);
    }
  }

  for (let distance = 1; selected.size < rowBudget && distance < rows.length; distance++) {
    addIndex(focusIndex - distance);
    addIndex(focusIndex + distance);
  }

  for (let index = 0; index < rows.length && selected.size < rowBudget; index++) {
    addIndex(index);
  }

  const selectedIndexes = [...selected].sort((a, b) => a - b);
  const items: WidgetViewportItem[] = [];
  let previousIndex = -1;
  for (const index of selectedIndexes) {
    if (index > previousIndex + 1) items.push({ kind: "marker", hiddenCount: index - previousIndex - 1 });
    items.push({ kind: "row", row: rows[index] });
    previousIndex = index;
  }
  if (previousIndex < rows.length - 1) items.push({ kind: "marker", hiddenCount: rows.length - previousIndex - 1 });
  return items;
}

function formatHiddenTasks(hiddenCount: number): string {
  return hiddenCount === 1 ? "… 1 hidden task" : `… ${hiddenCount} hidden tasks`;
}

// ---- Widget ----

export class TaskWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** IDs of tasks currently being actively executed (show spinner). */
  private activeTaskIds = new Set<string>();
  /** Per-task runtime metrics keyed by task ID. */
  private metrics = new Map<string, TaskMetrics>();
  /** Cached TUI instance for requestRender() calls. */
  private tui: any | undefined;
  /** Whether the widget callback is currently registered. */
  private widgetRegistered = false;

  constructor(private store: TaskStore) {}

  setStore(store: TaskStore) {
    this.store = store;
  }

  setUICtx(ctx: UICtx) {
    this.uiCtx = ctx;
  }

  /** Add or remove a task from the active spinner set. */
  setActiveTask(taskId: string | undefined, active = true) {
    if (taskId && active) {
      this.activeTaskIds.add(taskId);
      if (!this.metrics.has(taskId)) {
        this.metrics.set(taskId, { startedAt: Date.now(), inputTokens: 0, outputTokens: 0 });
      }
      this.ensureTimer();
    } else if (taskId) {
      this.activeTaskIds.delete(taskId);
    }
    this.update();
  }

  /** Record token usage for the currently active task(s). */
  addTokenUsage(inputTokens: number, outputTokens: number) {
    // Distribute to all currently active tasks
    for (const id of this.activeTaskIds) {
      const m = this.metrics.get(id);
      if (m) {
        m.inputTokens += inputTokens;
        m.outputTokens += outputTokens;
      }
    }
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), SPINNER_INTERVAL_MS);
    }
  }

  /** Build widget lines from current live state. Called from the render callback. */
  private renderWidget(tui: any, theme: Theme): string[] {
    const tasks = this.store.list();
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);

    if (tasks.length === 0) return [];

    const completed = tasks.filter(t => t.status === "completed");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const pending = tasks.filter(t => t.status === "pending");

    const parts: string[] = [];
    if (completed.length > 0) parts.push(`${completed.length} done`);
    if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
    if (pending.length > 0) parts.push(`${pending.length} open`);
    const statusText = `${tasks.length} tasks (${parts.join(", ")})`;

    const spinnerChar = SPINNER[this.widgetFrame % SPINNER.length];
    const lines: string[] = [truncate(theme.fg("accent", "●") + " " + theme.fg("accent", statusText))];

    const hierarchy = buildTaskHierarchy(tasks);
    const rows = flattenTaskHierarchy(hierarchy);
    const viewport = buildWidgetViewport(rows, hierarchy, this.activeTaskIds, visibleTaskRowBudget(tui));
    for (const item of viewport) {
      if (item.kind === "marker") {
        lines.push(truncate(theme.fg("dim", `  ${formatHiddenTasks(item.hiddenCount)}`)));
        continue;
      }

      const row = item.row;
      const task = row.task;
      const isActive = this.activeTaskIds.has(task.id) && task.status === "in_progress";

      let icon: string;
      if (isActive) {
        icon = theme.fg("accent", spinnerChar);
      } else if (task.status === "completed") {
        icon = theme.fg("success", "✔");
      } else if (task.status === "in_progress") {
        icon = theme.fg("accent", "◼");
      } else {
        icon = "◻";
      }

      const suffixParts: string[] = [];
      if (row.summary.total > 0) {
        suffixParts.push(`${row.summary.completed}/${row.summary.total} subtasks`);
        if (row.readyToComplete) suffixParts.push("ready to complete");
        if (row.availableChildIds.length > 1) suffixParts.push(`parallel ${formatTaskRefs(row.availableChildIds)}`);
      }
      const openBlockers = getOpenBlockerIds(task, hierarchy);
      if (task.status === "pending" && openBlockers.length > 0) {
        suffixParts.push(`blocked by ${formatTaskRefs(openBlockers)}`);
      }
      const suffix = suffixParts.length > 0 ? theme.fg("dim", ` › ${suffixParts.join(" · ")}`) : "";

      let text: string;
      if (isActive) {
        const form = task.activeForm || task.subject;
        const agentId = task.metadata?.agentId;
        const agentLabel = agentId ? ` (agent ${agentId.slice(0, 5)})` : "";
        const m = this.metrics.get(task.id);
        let stats = "";
        if (m) {
          const elapsed = formatDuration(Date.now() - m.startedAt);
          const tokenParts: string[] = [];
          if (m.inputTokens > 0) tokenParts.push(`↑ ${formatTokens(m.inputTokens)}`);
          if (m.outputTokens > 0) tokenParts.push(`↓ ${formatTokens(m.outputTokens)}`);
          stats = tokenParts.length > 0
            ? ` ${theme.fg("dim", `(${elapsed} · ${tokenParts.join(" ")})`)}`
            : ` ${theme.fg("dim", `(${elapsed})`)}`;
        }
        text = `  ${row.connectorPrefix}${icon} ${theme.fg("dim", "#" + task.id)} ${theme.fg("accent", form + agentLabel + "…")}${stats}`;
      } else if (task.status === "completed") {
        text = `  ${row.connectorPrefix}${icon} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}`;
      } else {
        const agentSuffix = task.status === "in_progress" && task.metadata?.agentId
          ? theme.fg("dim", ` (agent ${task.metadata.agentId.slice(0, 5)})`)
          : "";
        text = `  ${row.connectorPrefix}${icon} ${theme.fg("dim", "#" + task.id)} ${task.subject}${agentSuffix}`;
      }

      lines.push(truncate(text + suffix));
    }

    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const tasks = this.store.list();

    // Transition: visible → hidden
    if (tasks.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("tasks", undefined);
        this.widgetRegistered = false;
      }
      if (this.widgetInterval) {
        clearInterval(this.widgetInterval);
        this.widgetInterval = undefined;
      }
      return;
    }

    // Prune stale active IDs (deleted or no longer in_progress)
    for (const id of this.activeTaskIds) {
      const t = this.store.get(id);
      if (!t || t.status !== "in_progress") {
        this.activeTaskIds.delete(id);
        this.metrics.delete(id);
      }
    }

    // Check if any task needs animation
    const hasActiveSpinner = tasks.some(t => this.activeTaskIds.has(t.id) && t.status === "in_progress");
    if (hasActiveSpinner) {
      this.ensureTimer();
    } else if (!hasActiveSpinner && this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }

    this.widgetFrame++;

    // Transition: hidden → visible — register widget callback once
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("tasks", (tui, theme) => {
        this.tui = tui;
        return { render: () => this.renderWidget(tui, theme), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (this.tui) {
      // Widget already registered — just request a re-render
      this.tui.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("tasks", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}
