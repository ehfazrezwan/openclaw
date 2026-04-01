import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookEvent } from "../../hooks.js";
import { statusByChatId, WORK_DELAY_MS } from "./handler.js";

let handler: typeof import("./handler.js").default;

beforeEach(async () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token-123");
  statusByChatId.clear();
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

describe("telegram-status-pin hook", () => {
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
    const calls = (https.request as ReturnType<typeof vi.fn>).mock.calls;
    const methods = calls.map((c: unknown[]) => (c[0] as { path: string }).path);
    expect(methods.some((m: string) => m.includes("sendMessage"))).toBe(true);
    expect(methods.some((m: string) => m.includes("pinChatMessage"))).toBe(true);
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
    await vi.advanceTimersByTimeAsync(5_100);

    // Should have called editMessageText to update elapsed time
    const calls = (https.request as ReturnType<typeof vi.fn>).mock.calls;
    const methods = calls.map((c: unknown[]) => (c[0] as { path: string }).path);
    expect(methods.some((m: string) => m.includes("editMessageText"))).toBe(true);
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
      startedAt: new Date(Date.now() - 20_000),
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
      startedAt: new Date(),
    });

    // Should not throw
    await expect(handler(sentEvent("Hello"))).resolves.toBeUndefined();
  });
});
