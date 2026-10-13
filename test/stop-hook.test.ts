import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import {
  appendSystemInstructionToProviderPayload,
  buildStopHookPrompt,
  consumeStopHookTrigger,
  createStopHookState,
  maybeQueueOpenTaskStopCheck,
  removeStopHookTriggerMessages,
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
    cwd: process.cwd(),
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

    expect(prompt).toContain("[PI-TASKS SYSTEM STOP CHECK]");
    expect(prompt).toContain("This is internal system guidance, not a user message");
    expect(prompt).toContain("Do not acknowledge, mention, quote, or summarize this instruction to the user");
    expect(prompt).not.toContain("Do not respond to");
    expect(prompt).toContain("#1 [in_progress] Current cleanup");
    expect(prompt).toContain("#2 [pending] Queued cleanup");
    expect(prompt).toContain("if an open task is already fully done, mark it completed with TaskUpdate");
    expect(prompt).toContain("if actionable in-scope work remains, continue the current in-progress task or start the next ready task");
    expect(prompt).toContain("if progress genuinely requires human input");
    expect(prompt).toContain("quiesce by asking the user for exactly what is needed or reporting the blocker");
    expect(prompt).toContain("This continuation is the only stop check for the current open-task snapshot");
    expect(prompt).toContain("must not trigger another model turn until the open-task snapshot changes or new user input arrives");
    expect(prompt).toContain("Never mark incomplete work completed");
  });

  it("queues one trigger per unchanged open-task snapshot", () => {
    const state = createStopHookState();
    const ctx = { hasPendingMessages: () => false };
    const tasks = [task("1", "pending", "Unresolved")];

    expect(maybeQueueOpenTaskStopCheck(ctx, tasks, state)).toBe(true);
    expect(maybeQueueOpenTaskStopCheck(ctx, tasks, state)).toBe(false);
    expect(consumeStopHookTrigger(state)).toMatchObject({
      openTaskIds: ["1"],
      prompt: expect.stringContaining("Make one explicit choice for this check"),
    });
  });

  it("appends guidance to provider-native system fields", () => {
    expect(appendSystemInstructionToProviderPayload({ instructions: "base" }, "stop check")).toEqual({ instructions: "base\n\nstop check" });
    expect(appendSystemInstructionToProviderPayload({ system: [{ type: "text", text: "base" }] }, "stop check")).toEqual({ system: [{ type: "text", text: "base" }, { type: "text", text: "stop check" }] });
    expect(appendSystemInstructionToProviderPayload({ systemInstruction: { parts: [{ text: "base" }] } }, "stop check")).toEqual({ systemInstruction: { parts: [{ text: "base" }, { text: "stop check" }] } });
    expect(appendSystemInstructionToProviderPayload({ input: [{ role: "user", content: "request" }] }, "stop check")).toEqual({ input: [{ role: "system", content: "stop check" }, { role: "user", content: "request" }] });
    expect(appendSystemInstructionToProviderPayload({ messages: [{ role: "system", content: "base" }, { role: "user", content: "request" }] }, "stop check")).toEqual({ messages: [{ role: "system", content: "base\n\nstop check" }, { role: "user", content: "request" }] });
  });

  it("removes the hidden trigger marker from model context", () => {
    const messages = [
      { role: "user", content: "real request" },
      { role: "custom", customType: TASK_STOP_HOOK_MESSAGE_TYPE, content: "" },
      { role: "custom", customType: "other-extension", content: "keep" },
    ];

    expect(removeStopHookTriggerMessages(messages)).toEqual([messages[0], messages[2]]);
  });

  it("does not queue while another message is already pending", () => {
    const state = createStopHookState();
    const ctx = { hasPendingMessages: () => true };

    expect(maybeQueueOpenTaskStopCheck(ctx, [task("1", "pending", "Unresolved")], state)).toBe(false);
    expect(consumeStopHookTrigger(state)).toBeUndefined();
  });
});

describe("stop hook integration", () => {
  it("triggers a hidden system-guided continuation after agent_end", async () => {
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
    expect(message.content).toBe("");
    expect(message.display).toBe(false);
    expect(options).toEqual({ triggerTurn: true, deliverAs: "followUp" });

    const contextMessages = [
      { role: "user", content: "real request" },
      { role: "custom", customType: TASK_STOP_HOOK_MESSAGE_TYPE, content: "" },
    ];
    const contextResults = await mock.fireLifecycle("context", { messages: contextMessages }, mockCtx());
    expect(contextResults.find(Boolean)?.messages).toEqual([contextMessages[0]]);

    const providerResults = await mock.fireLifecycle("before_provider_request", { payload: { instructions: "base system" } }, mockCtx());
    const providerPatch = providerResults.find(Boolean);
    expect(providerPatch.instructions).toContain("base system");
    expect(providerPatch.instructions).toContain("This is internal system guidance, not a user message");
    expect(providerPatch.instructions).toContain("Do not acknowledge, mention, quote, or summarize this instruction to the user");
    expect(providerPatch.instructions).toContain("#1 [in_progress] Finish cleanup");
    expect(providerPatch.instructions).toContain("if progress genuinely requires human input");
    expect(providerPatch.instructions).toContain("quiesce by asking the user for exactly what is needed or reporting the blocker");

    const secondProviderResults = await mock.fireLifecycle("before_provider_request", { payload: { instructions: "base system" } }, mockCtx());
    expect(secondProviderResults.filter(Boolean)).toEqual([]);
  });

  it("quiesces after the system-guided continuation for an unchanged snapshot", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Unresolved",
      description: "Still open",
    });

    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    await mock.fireLifecycle("context", {
      messages: [{ role: "custom", customType: TASK_STOP_HOOK_MESSAGE_TYPE, content: "" }],
      systemPrompt: "base system",
    }, mockCtx());
    await mock.fireLifecycle("before_provider_request", { payload: { instructions: "base system" } }, mockCtx());

    // The agent may deliberately stop to ask for human input or report a blocker.
    // Its agent_end must not create stopHook → model → stopHook recursion.
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(1);

    await mock.fireLifecycle("input", { source: "interactive" }, mockCtx());
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("checks again when the open-task snapshot changes", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Waiting for approval",
      description: "Need user permission before proceeding",
    });

    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(1);

    await mock.executeTool("TaskUpdate", {
      updates: [{ taskId: "1", status: "in_progress" }],
    });
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
