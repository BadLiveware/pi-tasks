/**
 * task-widget.ts — Persistent widget showing task list with status glyphs and progress.
 *
 * Display style matches Claude Code's task list:
 *   ✔ completed tasks (strikethrough + dim)
 *   ◼ in_progress tasks
 *   ◻ pending tasks
 *   ⠋/⠙/⠹/⠸ actively executing task (spinner with activeForm text)
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TaskHierarchy, TaskHierarchyRow } from "../hierarchy.js";
import {
  buildTaskHierarchy,
  flattenTaskHierarchy,
  formatTaskRefs,
  getOpenBlockerIds,
} from "../hierarchy.js";
import { resolveTaskGlyphs } from "../task-glyphs.js";
import type { TaskStore } from "../task-store.js";
import type { TasksConfig } from "../tasks-config.js";

// ---- Truncation ----

function truncateFromTop<T>(tasks: T[], limit: number): T[] {
  return tasks.slice(-limit);
}

function truncateFromBottom<T>(tasks: T[], limit: number): T[] {
  return tasks.slice(0, limit);
}

const TRUNCATE_FNS = { top: truncateFromTop, bottom: truncateFromBottom };

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

const SPINNER_INTERVAL_MS = 180;

const DEFAULT_VISIBLE_TASK_ROWS = 14;
const MIN_VISIBLE_TASK_ROWS = 10;
const MAX_VISIBLE_TASK_ROWS = 18;
const DEFAULT_MAX_VISIBLE_TASKS = 10;

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

function formatHiddenTasks(hiddenCount: number, overflow: string): string {
  if (hiddenCount === 1) return `${overflow} 1 hidden task`;
  return `${overflow} ${hiddenCount} hidden tasks`;
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

  constructor(
    private store: TaskStore,
    private config: TasksConfig = {},
  ) {}

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

  /** Ensure the widget update timer is running. The spinner advances here and
   *  nowhere else: `update()` also runs on every task mutation and tool execution,
   *  so incrementing there tied the animation speed to how busy the agent was. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => {
        this.widgetFrame++;
        this.update();
      }, SPINNER_INTERVAL_MS);
    }
  }

  /** Render callback entry point. Guarded so a render error can never escape to
   *  the TUI timer and crash the whole host process — worst case the widget is
   *  empty for one frame. */
  private renderWidget(tui: any, theme: Theme): string[] {
    try {
      return this.buildWidgetLines(tui, theme);
    } catch {
      return [];
    }
  }

  /** Build widget lines from current live state. */
  private buildWidgetLines(tui: any, theme: Theme): string[] {
    const sortOrder = this.config.sortOrder ?? "id";
    // Resolved per render, not cached: the extension swaps this config object's
    // contents when the host moves to a session in another workspace.
    const glyphs = resolveTaskGlyphs(this.config.glyphs);
    const tasks = this.store.list(sortOrder);
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w, glyphs.truncation);

    if (tasks.length === 0) return [];

    const completed = tasks.filter(t => t.status === "completed");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const pending = tasks.filter(t => t.status === "pending");

    const parts: string[] = [];
    if (completed.length > 0) parts.push(`${completed.length} done`);
    if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
    if (pending.length > 0) parts.push(`${pending.length} open`);
    const statusText = `${tasks.length} tasks (${parts.join(", ")})`;

    const spinnerFrame = glyphs.spinner[this.widgetFrame % glyphs.spinner.length];
    const lines: string[] = [truncate(theme.fg("accent", glyphs.header) + " " + theme.fg("accent", statusText))];

    const hierarchy = buildTaskHierarchy(tasks);
    const preserveOrder = this.config.sortOrder !== undefined ||
      this.config.maxVisible !== undefined || this.config.hiddenAt !== undefined;
    const rows = flattenTaskHierarchy(hierarchy, preserveOrder);
    const collapseCompleted = this.config.collapseCompleted ?? false;
    let listed = rows;
    if (collapseCompleted) listed = rows.filter(row => row.task.status !== "completed");

    let viewport: WidgetViewportItem[];
    if (this.config.showAll) {
      viewport = listed.map(row => ({ kind: "row", row }));
    } else if (this.config.maxVisible !== undefined || this.config.hiddenAt !== undefined) {
      const limit = this.config.maxVisible ?? DEFAULT_MAX_VISIBLE_TASKS;
      const hiddenAt = this.config.hiddenAt === "top" ? "top" : "bottom";
      const visible = TRUNCATE_FNS[hiddenAt](listed, limit);
      viewport = visible.map(row => ({ kind: "row", row }));
      const hiddenCount = listed.length - visible.length;
      if (hiddenCount > 0) {
        const marker: WidgetViewportItem = { kind: "marker", hiddenCount };
        if (hiddenAt === "top") viewport.unshift(marker);
        else viewport.push(marker);
      }
    } else {
      viewport = buildWidgetViewport(listed, hierarchy, this.activeTaskIds, visibleTaskRowBudget(tui));
    }

    for (const item of viewport) {
      if (item.kind === "marker") {
        let text = formatHiddenTasks(item.hiddenCount, glyphs.overflow);
        if (this.config.maxVisible !== undefined || this.config.hiddenAt !== undefined) {
          text = `${glyphs.overflow} and ${item.hiddenCount} more`;
        }
        lines.push(truncate(theme.fg("dim", `  ${text}`)));
        continue;
      }

      const row = item.row;
      const task = row.task;
      const isActive = this.activeTaskIds.has(task.id) && task.status === "in_progress";

      let statusGlyph: string;
      if (isActive) {
        statusGlyph = theme.fg("accent", spinnerFrame);
      } else if (task.status === "completed") {
        statusGlyph = theme.fg("success", glyphs.completed);
      } else if (task.status === "in_progress") {
        statusGlyph = theme.fg("accent", glyphs.inProgress);
      } else {
        statusGlyph = glyphs.pending;
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
      let suffix = "";
      if (suffixParts.length > 0) suffix = theme.fg("dim", ` ${glyphs.blocked} ${suffixParts.join(" · ")}`);

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
          if (m.inputTokens > 0) tokenParts.push(`${glyphs.inputTokens} ${formatTokens(m.inputTokens)}`);
          if (m.outputTokens > 0) tokenParts.push(`${glyphs.outputTokens} ${formatTokens(m.outputTokens)}`);
          stats = tokenParts.length > 0
            ? ` ${theme.fg("dim", `(${elapsed} ${glyphs.statsSeparator} ${tokenParts.join(" ")})`)}`
            : ` ${theme.fg("dim", `(${elapsed})`)}`;
        }
        text = `  ${row.connectorPrefix}${statusGlyph} ${theme.fg("dim", "#" + task.id)} ${
          theme.fg("accent", form + agentLabel + glyphs.trailingEllipsis)
        }${stats}`;
      } else if (task.status === "completed") {
        text = `  ${row.connectorPrefix}${statusGlyph} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}`;
      } else {
        const agentSuffix = task.status === "in_progress" && task.metadata?.agentId
          ? theme.fg("dim", ` (agent ${task.metadata.agentId.slice(0, 5)})`)
          : "";
        text = `  ${row.connectorPrefix}${statusGlyph} ${theme.fg("dim", "#" + task.id)} ${task.subject}${agentSuffix}`;
      }

      lines.push(truncate(text + suffix));
    }

    if (collapseCompleted && completed.length > 0) {
      lines.push(truncate(`  ${theme.fg("success", glyphs.completedSummary)} ${theme.fg("dim", `${completed.length} completed`)}`));
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
      if (t?.status !== "in_progress") {
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
