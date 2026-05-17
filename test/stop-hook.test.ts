import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import {
  buildStopHookPrompt,
  consumeStopHookSystemPrompt,
  createStopHookState,
  maybePromptForOpenTasks,
  TASK_STOP_HOOK_MESSAGE_TYPE,
} from "../src/stop-hook.js";
import type { Task } from "../src/types.js";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

function task(id: string, status: Task["status"], subject: string): Task {
  return {
    id,
    status,
    subject,
    description: "Desc",
    metadata: {},
    blocks: [],
    blockedBy: [],
    relations: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function mockPi() {
  const tools = new Map<string, any>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand: vi.fn(),
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const h of eventHandlers.get(channel) ?? []) h(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {
          const arr = eventHandlers.get(channel);
          if (arr) eventHandlers.set(channel, arr.filter(h => h !== handler));
        };
      },
    },
    sendMessage: vi.fn(),
  };

  return {
    pi,
    tools,
    async executeTool(name: string, params: any, ctx = mockCtx()) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx);
    },
    async fireLifecycle(event: string, ...args: any[]) {
      const results: any[] = [];
      for (const h of lifecycleHandlers.get(event) ?? []) results.push(await h(...args));
      return results;
    },
  };
}

function mockCtx(overrides: Record<string, unknown> = {}) {
  return {
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
    ...overrides,
  };
}

describe("stop hook prompt helpers", () => {
  it("builds a task cleanup prompt with open tasks", () => {
    const prompt = buildStopHookPrompt([
      task("2", "pending", "Queued cleanup"),
      task("1", "in_progress", "Current cleanup"),
    ]);

    expect(prompt).toContain("[PI-TASKS STOP HOOK]");
    expect(prompt).toContain("This is a system instruction from pi-tasks, not a user request");
    expect(prompt).toContain("Task cleanup needed before stopping");
    expect(prompt).toContain("#1 [in_progress] Current cleanup");
    expect(prompt).toContain("#2 [pending] Queued cleanup");
    expect(prompt).toContain("Use TaskUpdate now");
    expect(prompt).toContain("mark tasks completed only when");
    expect(prompt).toContain("delete tasks that are obsolete");
  });

  it("sends one prompt per unchanged open-task snapshot", () => {
    const state = createStopHookState();
    const pi = { sendMessage: vi.fn() };
    const ctx = { hasPendingMessages: () => false };
    const tasks = [task("1", "pending", "Unresolved")];

    expect(maybePromptForOpenTasks(pi, ctx, tasks, state)).toBe(true);
    expect(maybePromptForOpenTasks(pi, ctx, tasks, state)).toBe(false);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    expect(pi.sendMessage.mock.calls[0][0]).toMatchObject({
      customType: TASK_STOP_HOOK_MESSAGE_TYPE,
      content: "pi-tasks queued a system cleanup check for 1 open task.",
      display: true,
      details: { openTaskIds: ["1"], source: "agent_end", promptDelivery: "before_agent_start.systemPrompt" },
    });
    expect(pi.sendMessage.mock.calls[0][0].content).not.toContain("Use TaskUpdate now");
    expect(consumeStopHookSystemPrompt(state)).toContain("Use TaskUpdate now");
    expect(pi.sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: true });
  });

  it("does not send while another message is already pending", () => {
    const state = createStopHookState();
    const pi = { sendMessage: vi.fn() };
    const ctx = { hasPendingMessages: () => true };

    expect(maybePromptForOpenTasks(pi, ctx, [task("1", "pending", "Unresolved")], state)).toBe(false);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("stop hook integration", () => {
  it("prompts after agent_end when tasks remain open", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Finish cleanup",
      description: "Resolve task list",
      status: "in_progress",
    });

    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());

    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = mock.pi.sendMessage.mock.calls[0];
    expect(message.customType).toBe(TASK_STOP_HOOK_MESSAGE_TYPE);
    expect(message.content).toBe("pi-tasks queued a system cleanup check for 1 open task.");
    expect(message.content).not.toContain("#1 [in_progress] Finish cleanup");
    expect(options).toEqual({ triggerTurn: true });

    const results = await mock.fireLifecycle("before_agent_start", { systemPrompt: "base system" }, mockCtx());
    const systemPatch = results.find(Boolean);
    expect(systemPatch.systemPrompt).toContain("base system");
    expect(systemPatch.systemPrompt).toContain("This is a system instruction from pi-tasks, not a user request");
    expect(systemPatch.systemPrompt).toContain("#1 [in_progress] Finish cleanup");
  });

  it("does not repeatedly prompt for the same open tasks unless user input resets it", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Unresolved",
      description: "Still open",
    });

    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    await mock.fireLifecycle("before_agent_start", { systemPrompt: "base system" }, mockCtx());
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(1);

    await mock.fireLifecycle("input", { source: "interactive" }, mockCtx());
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not prompt once tasks are completed", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Done",
      description: "Finished",
      status: "in_progress",
    });
    await mock.executeTool("TaskUpdate", { updates: [{ taskId: "1", status: "completed" }] });

    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());

    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  });
});
