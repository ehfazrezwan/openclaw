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
  // Clear all timers and state
  for (const state of statusByChatId.values()) {
    if (state.pendingTimer) {
      clearTimeout(state.pendingTimer);
    }
    if (state.completionTimer) {
      clearTimeout(state.completionTimer);
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
    // Simulate an async response
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

  it("skips heartbeat messages on received", async () => {
    vi.useFakeTimers();
    mockHttpsRequest();
    await handler(receivedEvent("HEARTBEAT_OK"));
    vi.advanceTimersByTime(WORK_DELAY_MS + 100);
    expect(https.request).not.toHaveBeenCalled();
  });

  it("skips heartbeat messages (prefix match)", async () => {
    vi.useFakeTimers();
    mockHttpsRequest();
    await handler(receivedEvent("HEARTBEAT_OK extra data"));
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

  it("on message:received, sets a pending timer", async () => {
    vi.useFakeTimers();
    mockHttpsRequest();
    await handler(receivedEvent("Hello"));

    const state = statusByChatId.get("5225642693");
    expect(state).toBeDefined();
    expect(state!.pendingTimer).toBeDefined();
    expect(state!.startedAt).toBeInstanceOf(Date);

    // Timer should not have fired yet
    expect(https.request).not.toHaveBeenCalled();
  });

  it("on message:received, fires API call after delay", async () => {
    vi.useFakeTimers();
    mockHttpsRequest();
    await handler(receivedEvent("Hello"));

    // Advance past the delay
    vi.advanceTimersByTime(WORK_DELAY_MS + 100);

    // Should have called Telegram API (sendMessage since no existing messageId)
    expect(https.request).toHaveBeenCalled();
  });

  it("on message:sent within delay, cancels pending timer", async () => {
    vi.useFakeTimers();
    mockHttpsRequest();

    await handler(receivedEvent("Hello"));
    const state = statusByChatId.get("5225642693");
    expect(state!.pendingTimer).toBeDefined();

    // Agent replies quickly (within 3s)
    await handler(sentEvent("Here's the answer"));

    // Timer should be cancelled
    expect(state!.pendingTimer).toBeUndefined();

    // Advance time — no API call should happen
    vi.advanceTimersByTime(WORK_DELAY_MS + 100);
    expect(https.request).not.toHaveBeenCalled();
  });

  it("on message:sent, does not call API if no status message was shown", async () => {
    const spy = vi.spyOn(https, "request");

    // Send a received then immediately sent (within delay)
    await handler(receivedEvent("Hello"));
    await handler(sentEvent("Quick reply"));

    expect(spy).not.toHaveBeenCalled();
  });

  it("on message:sent with existing status message, edits to Done", async () => {
    mockHttpsRequest();

    // Simulate existing state with a pinned message
    statusByChatId.set("5225642693", {
      chatId: "5225642693",
      messageId: 42,
      startedAt: new Date(Date.now() - 5000),
    });

    await handler(sentEvent("Here's your answer"));

    // Should have called editMessageText
    expect(https.request).toHaveBeenCalled();
    const callArgs = (https.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0].path).toContain("editMessageText");
  });

  it("handles Telegram API errors silently (no throw)", async () => {
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

    // Set up state with existing message
    statusByChatId.set("5225642693", {
      chatId: "5225642693",
      messageId: 42,
      startedAt: new Date(),
    });

    // Should not throw
    await expect(handler(sentEvent("Hello"))).resolves.toBeUndefined();
  });
});
