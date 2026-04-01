import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookEvent } from "../../hooks.js";
import {
  statusByChatId,
  WORK_DELAY_MS,
  ELAPSED_INTERVAL_MS,
  TASK_TIMEOUT_MS,
  renderCard,
  rerenderLocks,
  trackTask,
  completeTask,
  setCurrentAction,
  clearCurrentAction,
  handleRunEnd,
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
    for (const task of state.tasks.values()) {
      if (task.timeoutTimer) {
        clearTimeout(task.timeoutTimer);
      }
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

  // -------------------------------------------------------------------
  // Race condition regression tests
  // -------------------------------------------------------------------

  describe("elapsed timer race conditions", () => {
    it("elapsed timer goes through rerender mutex, not direct sendStatusMessage", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      // Trigger the pending timer to start working state + elapsed timer
      await handler(receivedEvent("Hello"));
      await vi.advanceTimersByTimeAsync(WORK_DELAY_MS + 100);

      // Now the elapsed timer is running. Clear mock history.
      (https.request as ReturnType<typeof vi.fn>).mockClear();
      mockHttpsRequest();

      // Fire elapsed timer interval
      await vi.advanceTimersByTimeAsync(ELAPSED_INTERVAL_MS + 100);

      // The elapsed timer should have called editMessageText (via rerender
      // mutex), not sendMessage. Since messageId is already set, it should
      // use editMessageText.
      const methods = getCalledMethods();
      const sendCalls = methods.filter((m) => m.includes("/sendMessage"));
      expect(sendCalls.length).toBe(0);
      expect(methods.some((m) => m.includes("editMessageText"))).toBe(true);
    });

    it("elapsed timer does NOT create orphaned messages after handleSent deletes state", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      // Start working state + elapsed timer
      await handler(receivedEvent("Hello"));
      await vi.advanceTimersByTimeAsync(WORK_DELAY_MS + 100);

      // Verify elapsed timer is running
      const state = statusByChatId.get("5225642693");
      expect(state).toBeDefined();
      expect(state!.elapsedTimer).toBeDefined();

      // handleSent cleans up everything
      await handler(sentEvent("Done"));
      expect(statusByChatId.has("5225642693")).toBe(false);

      // Clear mock history
      (https.request as ReturnType<typeof vi.fn>).mockClear();
      mockHttpsRequest();

      // Advance past several elapsed intervals — the timer was cleared
      // by handleSent, so no API calls should happen
      await vi.advanceTimersByTimeAsync(ELAPSED_INTERVAL_MS * 3);

      const methods = getCalledMethods();
      expect(methods.length).toBe(0);
    });

    it("clearTimers is called before Map deletion in handleSent", async () => {
      mockHttpsRequest();

      const elapsedTimer = setInterval(() => {}, 999_999);
      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 42,
        workingStartedAt: new Date(Date.now() - 20_000),
        elapsedTimer,
        tasks: new Map(),
      });

      await handler(sentEvent("Done"));

      // State is deleted from Map
      expect(statusByChatId.has("5225642693")).toBe(false);

      // The interval should have been cleared (we verify by checking it
      // doesn't fire — clearInterval was called on the handle)
      // If clearTimers wasn't called, this interval would leak
    });
  });

  describe("sendInFlight guard", () => {
    it("prevents duplicate sendMessage when two calls race past the mutex", async () => {
      vi.useFakeTimers();

      // Use a slow mock that resolves after a delay to simulate in-flight race
      let resolveFirst: ((v: object) => void) | undefined;
      let callCount = 0;

      vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
        callCount++;
        const currentCall = callCount;

        if (callback) {
          const cb = callback as (res: {
            on: (e: string, h: (d?: Buffer) => void) => void;
          }) => void;

          if (currentCall === 1) {
            // First sendMessage call — delay resolution
            void new Promise<object>((resolve) => {
              resolveFirst = resolve;
            }).then(() => {
              cb({
                on(event: string, handler: (data?: Buffer) => void) {
                  if (event === "data") {
                    process.nextTick(() =>
                      handler(
                        Buffer.from(JSON.stringify({ ok: true, result: { message_id: 99 } })),
                      ),
                    );
                  } else if (event === "end") {
                    process.nextTick(() => handler());
                  }
                },
              });
            });
          } else {
            // Subsequent calls resolve immediately
            process.nextTick(() => {
              cb({
                on(event: string, handler: (data?: Buffer) => void) {
                  if (event === "data") {
                    process.nextTick(() =>
                      handler(
                        Buffer.from(JSON.stringify({ ok: true, result: { message_id: 100 } })),
                      ),
                    );
                  } else if (event === "end") {
                    process.nextTick(() => handler());
                  }
                },
              });
            });
          }
        }

        return {
          on: vi.fn(),
          write: vi.fn(),
          end: vi.fn(),
          destroy: vi.fn(),
        } as unknown as ReturnType<typeof https.request>;
      });

      // Create state with no messageId
      const state = { chatId: "5225642693", tasks: new Map() } as typeof statusByChatId extends Map<
        string,
        infer V
      >
        ? V
        : never;
      statusByChatId.set("5225642693", state);
      state.workingStartedAt = new Date();

      // First trackTask triggers a rerender → sendStatusMessage → sendMessage
      trackTask("5225642693", "cc-1", "Task 1");
      await vi.advanceTimersByTimeAsync(50);

      // sendInFlight should be true while first call is pending
      expect(state.sendInFlight).toBe(true);

      // Now resolve the first call
      resolveFirst!({});
      await vi.advanceTimersByTimeAsync(200);

      // sendInFlight should be false after completion
      expect(state.sendInFlight).toBe(false);
      // messageId should be set from the first call
      expect(state.messageId).toBe(99);
    });

    it("clearTimers is called before Map deletion in completeTask", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      const elapsedTimer = setInterval(() => {}, 999_999);
      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 99,
        elapsedTimer,
        tasks: new Map([["cc-1", { label: "Test task", startedAt: new Date() }]]),
      });

      completeTask("5225642693", "cc-1");
      await vi.advanceTimersByTimeAsync(100);

      // State should be cleaned up
      expect(statusByChatId.has("5225642693")).toBe(false);
    });

    it("clearTimers is called before Map deletion in clearCurrentAction", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      const elapsedTimer = setInterval(() => {}, 999_999);
      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 99,
        elapsedTimer,
        currentAction: { taskId: "tool:tc-1", label: "test", startedAt: new Date() },
        tasks: new Map(),
      });

      clearCurrentAction("5225642693", "tool:tc-1");
      await vi.advanceTimersByTimeAsync(100);

      // State should be cleaned up
      expect(statusByChatId.has("5225642693")).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Task timeout safety net
  // -------------------------------------------------------------------

  describe("task timeout safety net", () => {
    it("auto-completes a task after TASK_TIMEOUT_MS", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      trackTask("5225642693", "cc-1", "sessions_spawn: Long task");
      await vi.advanceTimersByTimeAsync(100);

      // Task should exist
      const state = statusByChatId.get("5225642693");
      expect(state).toBeDefined();
      expect(state!.tasks.has("cc-1")).toBe(true);

      // Clear call history
      (https.request as ReturnType<typeof vi.fn>).mockClear();
      mockHttpsRequest();

      // Advance past the timeout
      await vi.advanceTimersByTimeAsync(TASK_TIMEOUT_MS + 100);

      // Task should be auto-completed and state cleaned up
      expect(statusByChatId.has("5225642693")).toBe(false);

      // Should have called deleteMessage
      const methods = getCalledMethods();
      expect(methods.some((m) => m.includes("deleteMessage"))).toBe(true);
    });

    it("timeout timer is cleared when completeTask is called normally", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      trackTask("5225642693", "cc-1", "sessions_spawn: Quick task");
      await vi.advanceTimersByTimeAsync(100);

      // Complete the task normally
      completeTask("5225642693", "cc-1");
      await vi.advanceTimersByTimeAsync(100);

      expect(statusByChatId.has("5225642693")).toBe(false);

      // Clear call history
      (https.request as ReturnType<typeof vi.fn>).mockClear();
      mockHttpsRequest();

      // Advance past timeout — should NOT fire since it was cleared
      await vi.advanceTimersByTimeAsync(TASK_TIMEOUT_MS + 100);

      // No additional API calls from the timeout
      expect(https.request).not.toHaveBeenCalled();
    });

    it("task persists after handleSent and timeout still fires as safety net", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      trackTask("5225642693", "cc-1", "sessions_spawn: Test");
      await vi.advanceTimersByTimeAsync(100);

      // handleSent re-renders but keeps the task alive
      await handler(sentEvent("Done"));
      await vi.advanceTimersByTimeAsync(100);

      // Task should still be present after handleSent
      const state = statusByChatId.get("5225642693");
      expect(state).toBeDefined();
      expect(state!.tasks.has("cc-1")).toBe(true);

      // Clear call history
      (https.request as ReturnType<typeof vi.fn>).mockClear();
      mockHttpsRequest();

      // Advance past timeout — safety net should auto-complete the task
      await vi.advanceTimersByTimeAsync(TASK_TIMEOUT_MS + 100);

      expect(statusByChatId.has("5225642693")).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Run-end cleanup (handleRunEnd — secondary path for NO_REPLY)
  // -------------------------------------------------------------------

  describe("handleRunEnd", () => {
    it("cleans up Working card when message:sent never fires (NO_REPLY scenario)", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      // 1. message:received starts the pending timer
      await handler(receivedEvent("Hello"));

      // 2. pending timer fires — shows "Working..." card
      await vi.advanceTimersByTimeAsync(WORK_DELAY_MS + 100);

      const state = statusByChatId.get("5225642693");
      expect(state).toBeDefined();
      expect(state!.workingStartedAt).toBeDefined();
      expect(state!.messageId).toBe(99);

      // Clear call history
      (https.request as ReturnType<typeof vi.fn>).mockClear();
      mockHttpsRequest();

      // 3. run-end fires WITHOUT message:sent — should clean up
      handleRunEnd("5225642693");

      // Flush microtasks for the async deleteStatusMessage
      await vi.advanceTimersByTimeAsync(100);

      // Card should be cleaned up
      expect(statusByChatId.has("5225642693")).toBe(false);

      // Should have called deleteMessage
      const methods = getCalledMethods();
      expect(methods.some((m) => m.includes("deleteMessage"))).toBe(true);
    });

    it("keeps card alive when persistent tasks are still active", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      // State has both working state and a persistent task
      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 99,
        workingStartedAt: new Date(),
        tasks: new Map([
          ["cc-1", { label: "sessions_spawn: Build feature", startedAt: new Date() }],
        ]),
      });

      handleRunEnd("5225642693");

      // Flush microtasks
      await vi.advanceTimersByTimeAsync(100);

      // State should still exist — persistent task is active
      const state = statusByChatId.get("5225642693");
      expect(state).toBeDefined();
      expect(state!.workingStartedAt).toBeUndefined();
      expect(state!.currentAction).toBeUndefined();
      expect(state!.tasks.size).toBe(1);
      expect(state!.tasks.has("cc-1")).toBe(true);

      // Should have re-rendered (editMessageText), not deleted
      const methods = getCalledMethods();
      expect(methods.some((m) => m.includes("editMessageText"))).toBe(true);
      expect(methods.some((m) => m.includes("deleteMessage"))).toBe(false);
    });

    it("is idempotent — no error when both message:sent and handleRunEnd fire", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      // Set up working state with a pinned message
      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 99,
        workingStartedAt: new Date(),
        tasks: new Map(),
      });

      // message:sent fires first — cleans up
      await handler(sentEvent("Here's the answer"));
      expect(statusByChatId.has("5225642693")).toBe(false);

      // handleRunEnd fires second — should be a no-op (state already gone)
      handleRunEnd("5225642693");

      // Flush microtasks
      await vi.advanceTimersByTimeAsync(100);

      // Still cleaned up, no errors
      expect(statusByChatId.has("5225642693")).toBe(false);
    });

    it("is a no-op for unknown chatId", () => {
      const spy = vi.spyOn(https, "request");
      handleRunEnd("nonexistent");
      expect(spy).not.toHaveBeenCalled();
    });

    it("is a no-op when bot token is missing", () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
      const spy = vi.spyOn(https, "request");

      statusByChatId.set("5225642693", {
        chatId: "5225642693",
        messageId: 99,
        workingStartedAt: new Date(),
        tasks: new Map(),
      });

      handleRunEnd("5225642693");

      expect(spy).not.toHaveBeenCalled();
      // State is untouched — no cleanup without token
      expect(statusByChatId.has("5225642693")).toBe(true);
    });

    it("clears pending timer even when card has not appeared yet", async () => {
      vi.useFakeTimers();
      mockHttpsRequest();

      // message:received starts the pending timer (card not yet shown)
      await handler(receivedEvent("Hello"));
      const state = statusByChatId.get("5225642693");
      expect(state).toBeDefined();
      expect(state!.pendingTimer).toBeDefined();
      expect(state!.workingStartedAt).toBeUndefined(); // card not shown yet

      // run-end fires before 15s — should cancel the pending timer
      handleRunEnd("5225642693");

      // Flush microtasks
      await vi.advanceTimersByTimeAsync(100);

      // State should be cleaned up (no tasks, no working state)
      expect(statusByChatId.has("5225642693")).toBe(false);

      // Advance past the pending timer — should NOT fire
      await vi.advanceTimersByTimeAsync(WORK_DELAY_MS + 100);
      expect(https.request).not.toHaveBeenCalled();
    });
  });
});
