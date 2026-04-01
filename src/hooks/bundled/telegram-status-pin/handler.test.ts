import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookEvent } from "../../hooks.js";
import {
  statusByChatId,
  WORK_DELAY_MS,
  ELAPSED_INTERVAL_MS,
  renderCard,
  rerenderLocks,
  trackTask,
  completeTask,
  setCurrentAction,
  clearCurrentAction,
} from "./handler.js";

let handler: typeof import("./handler.js").default;

beforeEach(async () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token-123");
  statusByChatId.clear();
  rerenderLocks.clear();
  ({ default: handler } = await import("./handler.js"));
});

afterEach(() => {
  for (const state of statusByChatId.values()) {
    if (state.pendingTimer) {
      clearTimeout(state.pendingTimer);
    }
    if (state.elapsedTimer) {
      clearInterval(state.elapsedTimer);
    }
  }
  statusByChatId.clear();
  rerenderLocks.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function receivedEvent(content: string, overrides: Record<string, unknown> = {}) {
  return createHookEvent("message", "received", "agent:main:main", {
    from: "12345",
    content,
    channelId: "telegram",
    conversationId: "5225642693",
    ...overrides,
  });
}

function sentEvent(content: string, overrides: Record<string, unknown> = {}) {
  return createHookEvent("message", "sent", "agent:main:main", {
    to: "5225642693",
    content,
    success: true,
    channelId: "telegram",
    conversationId: "5225642693",
    ...overrides,
  });
}

function mockHttpsRequest(responseBody: object = { ok: true, result: { message_id: 99 } }) {
  const responseJson = JSON.stringify(responseBody);
  vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
    if (callback) {
      const cb = callback as (res: { on: (e: string, h: (d?: Buffer) => void) => void }) => void;
      process.nextTick(() => {
        cb({
          on(event: string, handler: (data?: Buffer) => void) {
            if (event === "data") {
              process.nextTick(() => handler(Buffer.from(responseJson)));
            } else if (event === "end") {
              process.nextTick(() => handler());
            }
          },
        });
      });
    }
    const mockReq = {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    return mockReq as unknown as ReturnType<typeof https.request>;
  });
}

/** Extract the Telegram API method names from mock call history */
function getCalledMethods(): string[] {
  const calls = (https.request as ReturnType<typeof vi.fn>).mock.calls;
  return calls.map((c: unknown[]) => (c[0] as { path: string }).path);
}

describe("telegram-status-pin hook", () => {
  // -------------------------------------------------------------------
  // Existing behaviour tests
  // -------------------------------------------------------------------

  it("skips non-message events", async () => {
    const spy = vi.spyOn(https, "request");
    const event = createHookEvent("command", "new", "agent:main:main", {});
    await handler(event);
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips non-telegram channels", async () => {
    const spy = vi.spyOn(https, "request");
    await handler(receivedEvent("Hello", { channelId: "whatsapp" }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips heartbeat messages", async () => {
    vi.useFakeTimers();
    mockHttpsRequest();
    await handler(receivedEvent("HEARTBEAT_OK"));
    vi.advanceTimersByTime(WORK_DELAY_MS + 100);
    expect(https.request).not.toHaveBeenCalled();
  });

  it("handles missing bot token silently", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.useFakeTimers();
    const spy = vi.spyOn(https, "request");
    await handler(receivedEvent("Hello"));
    vi.advanceTimersByTime(WORK_DELAY_MS + 100);
    expect(spy).not.toHaveBeenCalled();
  });

  it("handles missing conversationId silently", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(https, "request");
    await handler(receivedEvent("Hello", { conversationId: undefined }));
    vi.advanceTimersByTime(WORK_DELAY_MS + 100);
    expect(spy).not.toHaveBeenCalled();
  });

  it("strips telegram: prefix from conversationId", async () => {
    vi.useFakeTimers();
    mockHttpsRequest();
    await handler(receivedEvent("Hello", { conversationId: "telegram:5225642693" }));

    const state = statusByChatId.get("5225642693");
    expect(state).toBeDefined();
    expect(state!.chatId).toBe("5225642693");
  });

  it("does not call API before 15s threshold", async () => {
    vi.useFakeTimers();
    mockHttpsRequest();
    await handler(receivedEvent("Hello"));

    // Advance to 14s — still under threshold
    vi.advanceTimersByTime(14_000);
    expect(https.request).not.toHaveBeenCalled();
  });

  it("after 15s: sends message and pins it", async () => {
    vi.useFakeTimers();
    mockHttpsRequest();
    await handler(receivedEvent("Hello"));

    // Advance past 15s threshold
    vi.advanceTimersByTime(WORK_DELAY_MS + 100);

    // Allow microtasks (nextTick callbacks in mock) to flush
    await vi.advanceTimersByTimeAsync(100);

    // Should have called sendMessage + pinChatMessage
    const methods = getCalledMethods();
    expect(methods.some((m) => m.includes("sendMessage"))).toBe(true);
    expect(methods.some((m) => m.includes("pinChatMessage"))).toBe(true);
  });

  it("elapsed timer updates message text after initial send", async () => {
    vi.useFakeTimers();
    mockHttpsRequest();
    await handler(receivedEvent("Hello"));

    // Fire pending timer (15s) + flush microtasks
    await vi.advanceTimersByTimeAsync(WORK_DELAY_MS + 100);

    // Clear call history after initial send+pin
    (https.request as ReturnType<typeof vi.fn>).mockClear();
    mockHttpsRequest();

    // Advance by elapsed interval (5s) + flush microtasks
    await vi.advanceTimersByTimeAsync(ELAPSED_INTERVAL_MS + 100);

    // Should have called editMessageText to update elapsed time
    const methods = getCalledMethods();
    expect(methods.some((m) => m.includes("editMessageText"))).toBe(true);
  });

  it("handleSent cancels pending timer (no API call if reply is fast)", async () => {
    vi.useFakeTimers();
    mockHttpsRequest();

    await handler(receivedEvent("Hello"));
    const state = statusByChatId.get("5225642693");
    expect(state!.pendingTimer).toBeDefined();

    // Agent replies quickly (within 15s)
    await handler(sentEvent("Here's the answer"));

    // State should be cleared entirely
    expect(statusByChatId.has("5225642693")).toBe(false);

    // Advance time — no API call should happen
    vi.advanceTimersByTime(WORK_DELAY_MS + 100);
    expect(https.request).not.toHaveBeenCalled();
  });

  it("handleSent calls deleteMessage if messageId exists", async () => {
    mockHttpsRequest();

    // Simulate existing state with a pinned message
    statusByChatId.set("5225642693", {
      chatId: "5225642693",
      messageId: 42,
      workingStartedAt: new Date(Date.now() - 20_000),
      tasks: new Map(),
    });

    await handler(sentEvent("Here's your answer"));

    // Should have called deleteMessage
    expect(https.request).toHaveBeenCalled();
    const callArgs = (https.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0].path).toContain("deleteMessage");

    // State should be cleared
    expect(statusByChatId.has("5225642693")).toBe(false);
  });

  it("deleteMessage failure is swallowed silently", async () => {
    vi.spyOn(https, "request").mockImplementation((_opts, _callback) => {
      const mockReq = {
        on: vi.fn((event: string, cb: (err: Error) => void) => {
          if (event === "error") {
            process.nextTick(() => cb(new Error("connect ECONNREFUSED")));
          }
        }),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      };
      return mockReq as unknown as ReturnType<typeof https.request>;
    });

    statusByChatId.set("5225642693", {
      chatId: "5225642693",
      messageId: 42,
      workingStartedAt: new Date(),
      tasks: new Map(),
    });

    // Should not throw
    await expect(handler(sentEvent("Hello"))).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------
  // Persistent task tracking (trackTask / completeTask)
  // -------------------------------------------------------------------

  describe("trackTask", () => {
    it("adds an entry and re-renders the card", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      trackTask("5225642693", "cc-1", "Claude Code: fix telegram hook");

      // Flush microtasks for the async rerender
      await vi.advanceTimersByTimeAsync(100);

      // Should have a state with the task
      const state = statusByChatId.get("5225642693");
      expect(state).toBeDefined();
      expect(state!.tasks.has("cc-1")).toBe(true);
      expect(state!.tasks.get("cc-1")!.label).toBe("Claude Code: fix telegram hook");

      // Should have sent a message (sendMessage + pinChatMessage)
      const methods = getCalledMethods();
      expect(methods.some((m) => m.includes("sendMessage"))).toBe(true);
    });

    it("does nothing when bot token is missing", () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
      const spy = vi.spyOn(https, "request");

      trackTask("5225642693", "cc-1", "Claude Code: test");

      expect(spy).not.toHaveBeenCalled();
      expect(statusByChatId.has("5225642693")).toBe(false);
    });
  });

  describe("completeTask", () => {
    it("removes an entry; if no tasks remain and no working state, deletes message", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      // Set up state with one task and a message
      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 99,
        tasks: new Map([["cc-1", { label: "Claude Code: fix hook", startedAt: new Date() }]]),
      });

      completeTask("5225642693", "cc-1");

      // Flush microtasks
      await vi.advanceTimersByTimeAsync(100);

      // Should have called deleteMessage
      const methods = getCalledMethods();
      expect(methods.some((m) => m.includes("deleteMessage"))).toBe(true);

      // State should be cleaned up
      expect(statusByChatId.has("5225642693")).toBe(false);
    });

    it("keeps card alive when other tasks remain", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 99,
        tasks: new Map([
          ["cc-1", { label: "Claude Code: fix hook", startedAt: new Date() }],
          ["cc-2", { label: "sessions_spawn: Build feature", startedAt: new Date() }],
        ]),
      });

      completeTask("5225642693", "cc-1");

      // Flush microtasks
      await vi.advanceTimersByTimeAsync(100);

      // State should still exist with remaining task
      const state = statusByChatId.get("5225642693");
      expect(state).toBeDefined();
      expect(state!.tasks.size).toBe(1);
      expect(state!.tasks.has("cc-2")).toBe(true);

      // Should have re-rendered (editMessageText), not deleted
      const methods = getCalledMethods();
      expect(methods.some((m) => m.includes("editMessageText"))).toBe(true);
      expect(methods.some((m) => m.includes("deleteMessage"))).toBe(false);
    });

    it("keeps card alive when currentAction is active even with no tasks", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 99,
        currentAction: { taskId: "tool:tc-1", label: "web_search: test", startedAt: new Date() },
        tasks: new Map([["cc-1", { label: "Claude Code: test", startedAt: new Date() }]]),
      });

      completeTask("5225642693", "cc-1");

      // Flush microtasks
      await vi.advanceTimersByTimeAsync(100);

      // State should still exist (currentAction active)
      const state = statusByChatId.get("5225642693");
      expect(state).toBeDefined();
      expect(state!.tasks.size).toBe(0);
      expect(state!.currentAction).toBeDefined();

      // Should have re-rendered, not deleted
      const methods = getCalledMethods();
      expect(methods.some((m) => m.includes("deleteMessage"))).toBe(false);
    });

    it("is a no-op for unknown chatId", () => {
      const spy = vi.spyOn(https, "request");
      completeTask("nonexistent", "cc-1");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Ephemeral action tracking (setCurrentAction / clearCurrentAction)
  // -------------------------------------------------------------------

  describe("setCurrentAction", () => {
    it("sets the current action and re-renders", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      setCurrentAction("5225642693", "tool:tc-1", "web_search: OpenClaw pricing");

      await vi.advanceTimersByTimeAsync(100);

      const state = statusByChatId.get("5225642693");
      expect(state).toBeDefined();
      expect(state!.currentAction).toBeDefined();
      expect(state!.currentAction!.taskId).toBe("tool:tc-1");
      expect(state!.currentAction!.label).toBe("web_search: OpenClaw pricing");

      const methods = getCalledMethods();
      expect(methods.some((m) => m.includes("sendMessage"))).toBe(true);
    });

    it("replaces the previous ephemeral action", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      setCurrentAction("5225642693", "tool:tc-1", "web_search: first");
      await vi.advanceTimersByTimeAsync(100);

      setCurrentAction("5225642693", "tool:tc-2", "exec: grep foo");
      await vi.advanceTimersByTimeAsync(100);

      const state = statusByChatId.get("5225642693");
      expect(state!.currentAction!.taskId).toBe("tool:tc-2");
      expect(state!.currentAction!.label).toBe("exec: grep foo");
    });

    it("does nothing when bot token is missing", () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
      const spy = vi.spyOn(https, "request");

      setCurrentAction("5225642693", "tool:tc-1", "web_search: test");

      expect(spy).not.toHaveBeenCalled();
      expect(statusByChatId.has("5225642693")).toBe(false);
    });
  });

  describe("clearCurrentAction", () => {
    it("clears the action when taskId matches", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      // Set up state with a currentAction and a persistent task
      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 99,
        currentAction: { taskId: "tool:tc-1", label: "web_search: test", startedAt: new Date() },
        tasks: new Map([["cc-1", { label: "sessions_spawn: Fix bug", startedAt: new Date() }]]),
      });

      clearCurrentAction("5225642693", "tool:tc-1");
      await vi.advanceTimersByTimeAsync(100);

      const state = statusByChatId.get("5225642693");
      expect(state).toBeDefined();
      expect(state!.currentAction).toBeUndefined();
      // Persistent task should remain
      expect(state!.tasks.size).toBe(1);
    });

    it("does not clear when taskId does not match (newer action replaced it)", () => {
      mockHttpsRequest();

      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 99,
        currentAction: { taskId: "tool:tc-2", label: "exec: grep bar", startedAt: new Date() },
        tasks: new Map(),
      });

      // Try to clear with the OLD taskId — should be a no-op
      clearCurrentAction("5225642693", "tool:tc-1");

      const state = statusByChatId.get("5225642693");
      expect(state!.currentAction).toBeDefined();
      expect(state!.currentAction!.taskId).toBe("tool:tc-2");
    });

    it("auto-deletes card when clearing the last action with no persistent tasks", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 99,
        currentAction: { taskId: "tool:tc-1", label: "web_search: test", startedAt: new Date() },
        tasks: new Map(),
      });

      clearCurrentAction("5225642693", "tool:tc-1");
      await vi.advanceTimersByTimeAsync(100);

      // Should have deleted the message
      const methods = getCalledMethods();
      expect(methods.some((m) => m.includes("deleteMessage"))).toBe(true);

      // State should be cleaned up
      expect(statusByChatId.has("5225642693")).toBe(false);
    });

    it("is a no-op for unknown chatId", () => {
      const spy = vi.spyOn(https, "request");
      clearCurrentAction("nonexistent", "tool:tc-1");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // renderCard
  // -------------------------------------------------------------------

  describe("renderCard", () => {
    it("renders persistent tasks as bullet points", () => {
      vi.useFakeTimers({ now: new Date("2026-04-01T12:00:45Z") });

      const state: typeof statusByChatId extends Map<string, infer V> ? V : never = {
        chatId: "123",
        tasks: new Map([
          [
            "cc-1",
            {
              label: "Claude Code: fix telegram hook",
              startedAt: new Date("2026-04-01T12:00:00Z"),
            },
          ],
        ]),
      };

      const text = renderCard(state);

      expect(text).toContain("\u2699\uFE0F K.I.T.T. is working...");
      expect(text).toContain("\u2022 Claude Code: fix telegram hook (45s)");
    });

    it("renders both persistent tasks and ephemeral action", () => {
      vi.useFakeTimers({ now: new Date("2026-04-01T12:02:15Z") });

      const state: typeof statusByChatId extends Map<string, infer V> ? V : never = {
        chatId: "123",
        tasks: new Map([
          [
            "cc-1",
            {
              label: "Claude Code: Fix the auth bug",
              startedAt: new Date("2026-04-01T12:00:00Z"),
            },
          ],
        ]),
        currentAction: {
          taskId: "tool:tc-1",
          label: "web_search: OpenClaw pricing",
          startedAt: new Date("2026-04-01T12:02:12Z"),
        },
      };

      const text = renderCard(state);

      expect(text).toContain("\u2699\uFE0F K.I.T.T. is working...");
      expect(text).toContain("\u2022 Claude Code: Fix the auth bug (2m 15s)");
      expect(text).toContain("\uD83D\uDD27 web_search: OpenClaw pricing (3s)");
    });

    it("renders only ephemeral action without blank line", () => {
      vi.useFakeTimers({ now: new Date("2026-04-01T12:00:12Z") });

      const state: typeof statusByChatId extends Map<string, infer V> ? V : never = {
        chatId: "123",
        tasks: new Map(),
        currentAction: {
          taskId: "tool:tc-1",
          label: 'exec: grep -n -i "sharepoint"',
          startedAt: new Date("2026-04-01T12:00:00Z"),
        },
      };

      const text = renderCard(state);

      expect(text).toBe(
        '\u2699\uFE0F K.I.T.T. is working...\n\uD83D\uDD27 exec: grep -n -i "sharepoint" (12s)',
      );
    });

    it("renders general working state when no named tasks or actions", () => {
      vi.useFakeTimers({ now: new Date("2026-04-01T12:00:23Z") });

      const state: typeof statusByChatId extends Map<string, infer V> ? V : never = {
        chatId: "123",
        workingStartedAt: new Date("2026-04-01T12:00:00Z"),
        tasks: new Map(),
      };

      const text = renderCard(state);
      expect(text).toBe("\u2699\uFE0F Working... (23s)");
    });

    it("omits elapsed for first few seconds of general working", () => {
      vi.useFakeTimers({ now: new Date("2026-04-01T12:00:02Z") });

      const state: typeof statusByChatId extends Map<string, infer V> ? V : never = {
        chatId: "123",
        workingStartedAt: new Date("2026-04-01T12:00:00Z"),
        tasks: new Map(),
      };

      const text = renderCard(state);
      expect(text).toBe("\u2699\uFE0F Working...");
    });

    it("formats elapsed time with minutes for longer durations", () => {
      vi.useFakeTimers({ now: new Date("2026-04-01T12:02:15Z") });

      const state: typeof statusByChatId extends Map<string, infer V> ? V : never = {
        chatId: "123",
        tasks: new Map([
          [
            "cc-1",
            { label: "Claude Code: big refactor", startedAt: new Date("2026-04-01T12:00:00Z") },
          ],
        ]),
      };

      const text = renderCard(state);
      expect(text).toContain("\u2022 Claude Code: big refactor (2m 15s)");
    });
  });

  // -------------------------------------------------------------------
  // handleSent with active tasks
  // -------------------------------------------------------------------

  describe("handleSent with active named tasks", () => {
    it("clears ephemeral state but preserves persistent tasks", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      // State has both general working, an ephemeral action, and a persistent task
      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 99,
        workingStartedAt: new Date(),
        currentAction: { taskId: "tool:tc-1", label: "web_search: test", startedAt: new Date() },
        tasks: new Map([["cc-1", { label: "Claude Code: build feature", startedAt: new Date() }]]),
      });

      await handler(sentEvent("Here's the answer"));

      // Flush microtasks for the rerender
      await vi.advanceTimersByTimeAsync(100);

      // State should still exist — persistent task is still active
      const state = statusByChatId.get("5225642693");
      expect(state).toBeDefined();
      expect(state!.workingStartedAt).toBeUndefined();
      expect(state!.currentAction).toBeUndefined();
      expect(state!.tasks.size).toBe(1);
    });

    it("deletes card when handleSent fires with no persistent tasks", async () => {
      mockHttpsRequest();

      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 99,
        currentAction: { taskId: "tool:tc-1", label: "web_search: test", startedAt: new Date() },
        tasks: new Map(),
      });

      await handler(sentEvent("Here's your answer"));

      // State should be cleared entirely
      expect(statusByChatId.has("5225642693")).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Auto-deletion when last persistent task completes
  // -------------------------------------------------------------------

  describe("card auto-deletion", () => {
    it("auto-deletes when last persistent task completes and no currentAction", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 99,
        tasks: new Map([["cc-1", { label: "Claude Code: fix hook", startedAt: new Date() }]]),
      });

      completeTask("5225642693", "cc-1");
      await vi.advanceTimersByTimeAsync(100);

      expect(statusByChatId.has("5225642693")).toBe(false);
      const methods = getCalledMethods();
      expect(methods.some((m) => m.includes("deleteMessage"))).toBe(true);
    });

    it("auto-deletes when clearCurrentAction empties all state", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 99,
        currentAction: { taskId: "tool:tc-1", label: "exec: test", startedAt: new Date() },
        tasks: new Map(),
      });

      clearCurrentAction("5225642693", "tool:tc-1");
      await vi.advanceTimersByTimeAsync(100);

      expect(statusByChatId.has("5225642693")).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Mutex prevents concurrent sendMessage calls
  // -------------------------------------------------------------------

  describe("rerender mutex", () => {
    it("serializes concurrent rerenders to prevent duplicate sendMessage calls", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      // Fire two trackTask calls rapidly — without mutex both would see
      // messageId=undefined and both call sendMessage
      trackTask("5225642693", "cc-1", "Task 1");
      trackTask("5225642693", "cc-2", "Task 2");

      // Flush all microtasks
      await vi.advanceTimersByTimeAsync(200);

      // Count sendMessage calls — should be exactly 1 (second rerender
      // should use editMessageText since mutex ensures first completes first)
      const methods = getCalledMethods();
      const sendMessageCalls = methods.filter((m) => m.includes("/sendMessage"));
      expect(sendMessageCalls.length).toBe(1);
    });
  });
});
