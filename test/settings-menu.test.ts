import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";
import { loadTasksConfig, type TasksConfig } from "../src/tasks-config.js";
import { openSettingsMenu, type SettingsUI } from "../src/ui/settings-menu.js";
import { TaskWidget, type Theme } from "../src/ui/task-widget.js";

let root: string;
let cwd: string;
const theme: Theme = { fg: (_color, text) => text, bold: text => text, strikethrough: text => text };
const stripAnsi = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-tasks-settings-"));
  cwd = join(root, "workspace");
  mkdirSync(cwd);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.useFakeTimers();
  initTheme("dark", false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function open(cfg: TasksConfig, interact: (list: SettingsList) => void = () => {}) {
  let before: string[] = [];
  let after: string[] = [];
  const ui: SettingsUI = {
    custom(factory) {
      return new Promise(resolve => {
        const panel = factory({}, theme, {}, resolve);
        const list = panel.children.find((child: unknown) => child instanceof SettingsList) as SettingsList;
        before = panel.render(180).map(stripAnsi);
        interact(list);
        after = panel.render(180).map(stripAnsi);
        list.handleInput("\u001b");
      });
    },
  };
  await openSettingsMenu(ui, cfg, async () => {}, 4, cwd);
  return { before, after };
}

function renderTasks(cfg: TasksConfig) {
  const store = new TaskStore();
  store.createMany([
    ...Array.from({ length: 19 }, (_, index) => ({ subject: `Task ${index + 1}`, description: "d" })),
    { subject: "Active work", description: "d", status: "in_progress" },
  ]);
  const widget = new TaskWidget(store, cfg);
  let component: { render(): string[] } | undefined;
  widget.setUICtx({
    setStatus() {},
    setWidget(_key, content) {
      if (typeof content === "function") component = content({ terminal: { columns: 180 }, requestRender() {} }, theme);
      else component = undefined;
    },
  });
  widget.setActiveTask("20");
  try {
    return component!.render();
  } finally {
    widget.dispose();
  }
}

describe("Settings display defaults", () => {
  it("shows smart/fork labels and preserves adaptive behavior after an unrelated settings edit", async () => {
    const { before, after } = await open({}, list => {
      list.selectItem("autoCascade");
      list.handleInput(" ");
    });
    for (const lines of [before, after]) {
      expect(lines.find(line => line.includes("Max visible tasks"))).toContain("smart");
      expect(lines.find(line => line.includes("Widget sort order"))).toContain("fork default");
      expect(lines.find(line => line.includes("Hidden tasks position"))).toContain("smart");
    }
    const lines = renderTasks(loadTasksConfig(cwd));
    expect(lines.filter(line => /#\d+/.test(line))).toHaveLength(14);
    expect(lines.some(line => line.includes("#20 Active work"))).toBe(true);
  });

  it("keeps selectable limit presets and applies explicit truncation when chosen", async () => {
    const { after } = await open({}, list => {
      list.selectItem("maxVisible");
      list.handleInput(" ");
      list.handleInput(" ");
    });
    expect(after.find(line => line.includes("Max visible tasks"))).toContain("10");
    expect(after.find(line => line.includes("Widget sort order"))).toContain("id");
    expect(after.find(line => line.includes("Hidden tasks position"))).toContain("bottom");
    const lines = renderTasks(loadTasksConfig(cwd));
    expect(lines.filter(line => /#\d+/.test(line))).toHaveLength(10);
    expect(lines.some(line => line.includes("Active work"))).toBe(false);
    expect(lines.some(line => line.includes("10 more"))).toBe(true);
  });

  it("shows effective fallback labels for an explicit visible limit", async () => {
    const { before } = await open({ maxVisible: 5 });
    expect(before.find(line => line.includes("Max visible tasks"))).toContain("5");
    expect(before.find(line => line.includes("Widget sort order"))).toContain("id");
    expect(before.find(line => line.includes("Hidden tasks position"))).toContain("bottom");
  });
});
