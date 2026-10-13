import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { globalSessionTasksDir, sessionTaskFile } from "../src/task-paths.js";
import type { TaskStoreData } from "../src/types.js";
import { flush, installSubagentsMock, mockPi, mockSessionCtx } from "./helpers/mock-pi.js";

let root: string;
let cwd: string;
let agentDir: string;
let mock: ReturnType<typeof mockPi>;
let rpc: ReturnType<typeof installSubagentsMock>;
let sharedFile: string | undefined;

beforeEach(() => {
  sharedFile = undefined;
  root = mkdtempSync(join(tmpdir(), "pi-tasks-batch-lifecycle-"));
  cwd = join(root, "workspace");
  agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  delete process.env.PI_TASKS;
  writeFileSync(join(agentDir, "tasks-config.json"), JSON.stringify({ taskScope: "session-global" }));
  mock = mockPi();
  rpc = installSubagentsMock(mock.pi);
  initExtension(mock.pi as any);
});

afterEach(async () => {
  await mock.executeTool("TaskUpdate", {
    updates: Array.from({ length: 9 }, (_, index) => ({ taskId: String(index + 1), status: "completed" })),
  });
  rpc.unsub();
  vi.unstubAllEnvs();
  if (sharedFile) rmSync(sharedFile, { force: true });
  rmSync(root, { recursive: true, force: true });
});

function ctxFor(sessionId = "s1") {
  return mockSessionCtx(sessionId, { cwd });
}

function dataFor(sessionId = "s1"): TaskStoreData {
  return JSON.parse(readFileSync(sessionTaskFile(cwd, sessionId, "session-global"), "utf-8"));
}

async function start(sessionId = "s1", reason = "startup") {
  const ctx = ctxFor(sessionId);
  await mock.fireLifecycle("session_start", { reason }, ctx);
  await mock.fireLifecycle("turn_start", {}, ctx);
  return ctx;
}

const family = [
  { key: "parent", subject: "Deliver feature", description: "Container" },
  { key: "build", subject: "Build feature", description: "Build", status: "in_progress", relations: [{ type: "parent", target: "parent" }] },
  { key: "verify", subject: "Verify feature", description: "Verify", blockedBy: ["build"], relations: [{ type: "parent", target: "parent" }] },
];

describe("batch tools with persisted session lifecycle", () => {
  it("validates the registered batch schema and initial status through host TypeBox", async () => {
    const ctx = await start();
    const create = mock.tools.get("TaskCreate");
    expect(Value.Check(create.parameters, { tasks: family })).toBe(true);
    expect(Value.Check(create.parameters, { tasks: [] })).toBe(false);
    expect(Value.Check(create.parameters, { tasks: [{ subject: "Invalid", description: "d", status: "completed" }] })).toBe(false);
    await mock.executeTool("TaskCreate", { tasks: family }, ctx);
    expect(dataFor().tasks[1].status).toBe("in_progress");
  });

  it("persists forward key references, hard edges, and parent relations outside the workspace", async () => {
    const ctx = await start();
    const file = sessionTaskFile(cwd, "s1", "session-global");
    expect(existsSync(dirname(file))).toBe(false);
    const created = await mock.executeTool("TaskCreate", { tasks: [family[2], family[0], family[1]] }, ctx);
    expect(created.content[0].text).toContain("Created 3 tasks");
    expect(dataFor().tasks[0]).toMatchObject({ blockedBy: ["3"], relations: [{ type: "parent", target: "2" }] });
    expect(dataFor().tasks[2]).toMatchObject({ blocks: ["1"], status: "in_progress" });
    expect(existsSync(join(cwd, ".pi", "tasks"))).toBe(false);
    const list = (await mock.executeTool("TaskList", {}, ctx)).content[0].text;
    expect(list).toContain("#2 [pending] Deliver feature [container 0/2 done]");
    expect(list).toContain("├─ #1 [pending] Verify feature [blocked by #3]");
  });

  it("returns the post-batch tree and cleans references on deletion after reload", async () => {
    const ctx = await start();
    await mock.executeTool("TaskCreate", { tasks: family }, ctx);
    await mock.fireLifecycle("session_start", { reason: "reload" }, ctx);
    const updates = [{ taskId: "2", status: "completed" }, { taskId: "3", status: "completed" }];
    const updateTool = mock.tools.get("TaskUpdate");
    expect(Value.Check(updateTool.parameters, { updates, includeList: true })).toBe(true);
    const updated = await mock.executeTool("TaskUpdate", { updates, includeList: true }, ctx);
    const list = (await mock.executeTool("TaskList", {}, ctx)).content[0].text;
    expect(updated.content[0].text).toContain(`Task list:\n${list}`);
    expect(updated.content[0].text).toContain("Ready to complete: #1 (2/2 subtasks done)");
    await mock.executeTool("TaskUpdate", { updates: [{ taskId: "1", status: "deleted" }, { taskId: "2", status: "deleted" }] }, ctx);
    expect(dataFor().tasks).toHaveLength(1);
    expect(dataFor().tasks[0]).toMatchObject({ id: "3", relations: [], blockedBy: [] });
  });

  it("retires the completed batch only at the settled boundary and resolves fresh keys", async () => {
    const ctx = await start();
    await mock.executeTool("TaskCreate", { tasks: family }, ctx);
    await mock.executeTool("TaskUpdate", { updates: ["1", "2", "3"].map(taskId => ({ taskId, status: "completed" })) }, ctx);
    await mock.fireLifecycle("agent_end", {}, ctx);
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
    expect(dataFor().tasks).toHaveLength(3);
    await mock.fireLifecycle("agent_settled", {}, ctx);
    await mock.executeTool("TaskCreate", { tasks: [
      { key: "next", subject: "Next batch", description: "d", status: "in_progress" },
      { subject: "Next validation", description: "d", blockedBy: ["next"], relations: [{ type: "parent", target: "next" }] },
    ] }, ctx);
    expect(dataFor().tasks.map(task => task.id)).toEqual(["4", "5"]);
    expect(dataFor().tasks[1]).toMatchObject({ blockedBy: ["4"], relations: [{ type: "parent", target: "4" }] });
  });

  it("expires a completed update batch and reclaims the empty global session directory", async () => {
    const ctx = await start();
    await mock.executeTool("TaskCreate", { tasks: family }, ctx);
    await mock.executeTool("TaskUpdate", { updates: ["1", "2", "3"].map(taskId => ({ taskId, status: "completed" })) }, ctx);
    for (let turn = 0; turn < 4; turn++) await mock.fireLifecycle("turn_start", {}, ctx);
    expect(existsSync(globalSessionTasksDir(cwd))).toBe(false);
    expect((await mock.executeTool("TaskList", {}, ctx)).content[0].text).toBe("No tasks found");
  });

  it.each(["named", "absolute", "relative", "project"])("keeps the %s shared file and ID counter through lifecycle clear and reopen", async kind => {
    let file = join(cwd, ".pi", "tasks", "tasks.json");
    if (kind === "project") {
      writeFileSync(join(agentDir, "tasks-config.json"), JSON.stringify({ taskScope: "project" }));
    } else if (kind === "named") {
      const name = `shared-${basename(root)}`;
      vi.stubEnv("PI_TASKS", name);
      file = join(homedir(), ".pi", "tasks", `${name}.json`);
      sharedFile = file;
    } else if (kind === "absolute") {
      file = join(root, "absolute-tasks.json");
      vi.stubEnv("PI_TASKS", file);
    } else {
      file = join(cwd, "relative-tasks.json");
      vi.stubEnv("PI_TASKS", "./relative-tasks.json");
    }
    rpc.unsub();
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    const ctx = await start();
    await mock.executeTool("TaskCreate", { tasks: [
      { subject: "First", description: "d" }, { subject: "Second", description: "d" },
    ] }, ctx);
    await mock.executeTool("TaskUpdate", { updates: [
      { taskId: "1", status: "completed" }, { taskId: "2", status: "completed" },
    ] }, ctx);
    for (let turn = 0; turn < 4; turn++) await mock.fireLifecycle("turn_start", {}, ctx);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf-8")).tasks).toEqual([]);

    rpc.unsub();
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    const reopened = await start("s2");
    const result = await mock.executeTool("TaskCreate", { tasks: [{ subject: "After reopening", description: "d" }] }, reopened);
    expect(result.content[0].text).toContain("Task #3 created successfully");
    expect(JSON.parse(readFileSync(file, "utf-8")).nextId).toBe(4);
  });

  it("keeps smart defaults through merged config and applies explicit project display overrides", async () => {
    writeFileSync(join(agentDir, "tasks-config.json"), JSON.stringify({
      taskScope: "session-global", glyphs: { pending: "[ ]" },
    }));
    mkdirSync(join(cwd, ".pi"));
    const configFile = join(cwd, ".pi", "tasks-config.json");
    writeFileSync(configFile, JSON.stringify({ collapseCompleted: true }));
    const ctx = await start();
    await mock.executeTool("TaskCreate", { tasks: [
      ...Array.from({ length: 17 }, (_, index) => ({ subject: `Task ${index + 1}`, description: "d" })),
      { subject: "Active work", description: "d", status: "in_progress" },
    ] }, ctx);
    const factory = ctx.ui.setWidget.mock.calls.find(call => typeof call[1] === "function")![1];
    const component = factory({ terminal: { columns: 200 }, requestRender() {} }, {
      fg: (_color: string, text: string) => text, bold: (text: string) => text, strikethrough: (text: string) => text,
    });
    const smart = component.render();
    expect(smart.filter((line: string) => /#\d+/.test(line))).toHaveLength(14);
    expect(smart.some((line: string) => line.includes("#18 Active work"))).toBe(true);
    expect(smart.some((line: string) => line.includes("[ ]"))).toBe(true);
    writeFileSync(configFile, JSON.stringify({ maxVisible: 5, hiddenAt: "bottom", sortOrder: "id" }));
    await mock.fireLifecycle("session_start", { reason: "reload" }, ctx);
    const limited = component.render();
    expect(limited.filter((line: string) => /#\d+/.test(line))).toHaveLength(5);
    expect(limited.some((line: string) => line.includes("Active work"))).toBe(false);
    expect(limited.some((line: string) => line.includes("13 more"))).toBe(true);
    await mock.executeTool("TaskUpdate", { updates: [{ taskId: "18", status: "completed" }] }, ctx);
  });

  it("uses project auto-clear overrides", async () => {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "tasks-config.json"), JSON.stringify({ autoClearCompleted: "never" }));
    const ctx = await start();
    await mock.executeTool("TaskCreate", { tasks: family }, ctx);
    await mock.executeTool("TaskUpdate", { updates: ["1", "2", "3"].map(taskId => ({ taskId, status: "completed" })) }, ctx);
    await mock.fireLifecycle("agent_settled", {}, ctx);
    await mock.executeTool("TaskCreate", { tasks: [{ subject: "More", description: "d" }] }, ctx);
    expect(dataFor().tasks).toHaveLength(4);
  });

  it("routes batch tools to the new store on session switch and discards the old cleanup prompt", async () => {
    const ctx = await start();
    await mock.executeTool("TaskCreate", { tasks: family }, ctx);
    await mock.fireLifecycle("agent_end", {}, ctx);
    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(1);
    const next = await start("s2", "new");
    const hooks = await mock.fireLifecycle("before_agent_start", { systemPrompt: "Base" }, next);
    expect(hooks.some(result => result?.systemPrompt)).toBe(false);
    await mock.executeTool("TaskCreate", { tasks: [{ subject: "New session", description: "d", status: "in_progress" }] }, next);
    await mock.executeTool("TaskUpdate", { updates: [{ taskId: "1", subject: "Changed new session" }], includeList: true }, next);
    expect(dataFor("s1").tasks[0].subject).toBe("Deliver feature");
    expect(dataFor("s2").tasks[0].subject).toBe("Changed new session");
    await mock.fireLifecycle("agent_end", {}, next);
    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("updates normalized legacy records and repairs the ID envelope without losing valid relations", async () => {
    const file = sessionTaskFile(cwd, "s1", "session-global");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ tasks: [
      { id: "7", subject: "Legacy", description: "d", status: "pending", relations: [{ type: "related", target: "8" }, null, { type: "parent" }] },
      { id: "8", subject: "Other", description: "d", status: "pending", relations: "bad" },
    ] }));
    const ctx = await start();
    await mock.executeTool("TaskUpdate", { updates: [{ taskId: "7", addBlockedBy: ["8"] }], includeList: true }, ctx);
    await mock.executeTool("TaskCreate", { tasks: [{ subject: "New", description: "d", relations: [{ type: "parent", target: "7" }] }] }, ctx);
    expect(dataFor().tasks.map(task => task.id)).toEqual(["7", "8", "9"]);
    expect(dataFor().tasks[0]).toMatchObject({ metadata: {}, blockedBy: ["8"], relations: [{ type: "related", target: "8" }] });
    expect(dataFor().tasks[1]).toMatchObject({ relations: [], blocks: ["7"] });
  });

  it("returns and consumes batch-created subagent results while preserving dependency and hierarchy data", async () => {
    writeFileSync(join(agentDir, "tasks-config.json"), JSON.stringify({ taskScope: "session-global", autoCascade: true }));
    const ctx = await start();
    await mock.executeTool("TaskCreate", { tasks: [
      { key: "parent", subject: "Delivery", description: "d" },
      { key: "prep", subject: "Prepare", description: "d", agentType: "general-purpose", relations: [{ type: "parent", target: "parent" }] },
      { subject: "Follow up", description: "d", agentType: "general-purpose", blockedBy: ["prep"], relations: [{ type: "parent", target: "parent" }] },
    ] }, ctx);
    await mock.executeTool("TaskExecute", { task_ids: ["2"] }, ctx);
    const pending = mock.executeTool("TaskOutput", { task_id: "2", block: true, timeout: 5000 }, ctx);
    await flush();
    rpc.complete("agent-1", "Preparation result");
    expect((await pending).content[0].text).toContain("Preparation result");
    await flush();
    expect(rpc.spawned[1].prompt).toContain("Preparation result");
    rpc.complete("agent-2", "Final result");
    await flush();
    expect((await mock.executeTool("TaskOutput", { task_id: "3", block: false, timeout: 0 }, ctx)).content[0].text).toContain("Final result");
    await rpc.afterNudgeHold();
    expect(rpc.consumed).toEqual(["agent-1", "agent-2"]);
    expect(rpc.notified).toEqual([]);
    expect(dataFor().tasks[2]).toMatchObject({ blockedBy: ["2"], relations: [{ type: "parent", target: "1" }], status: "completed" });
    const updated = await mock.executeTool("TaskUpdate", { updates: [{ taskId: "1", status: "completed" }], includeList: true }, ctx);
    expect(updated.content[0].text).toContain("[container 2/2 done]");
  });
});
