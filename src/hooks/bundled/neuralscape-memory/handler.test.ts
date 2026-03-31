import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookEvent } from "../../hooks.js";

let handler: typeof import("./handler.js").default;

beforeEach(async () => {
  ({ default: handler } = await import("./handler.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function sentEvent(content: string, overrides: Record<string, unknown> = {}) {
  return createHookEvent("message", "sent", "agent:main:main", {
    to: "+1234567890",
    content,
    success: true,
    channelId: "telegram",
    conversationId: "chat-1",
    ...overrides,
  });
}

function receivedEvent(content: string, overrides: Record<string, unknown> = {}) {
  return createHookEvent("message", "received", "agent:main:main", {
    from: "+1234567890",
    content,
    channelId: "telegram",
    conversationId: "chat-1",
    ...overrides,
  });
}

describe("neuralscape-memory hook", () => {
  it("skips non-message events", async () => {
    const spy = vi.spyOn(http, "request");
    const event = createHookEvent("command", "new", "agent:main:main", {});
    await handler(event);
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips non-sent message actions (e.g. transcribed)", async () => {
    const spy = vi.spyOn(http, "request");
    const event = createHookEvent("message", "transcribed", "agent:main:main", {
      content: "Some transcription",
      channelId: "telegram",
    });
    await handler(event);
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips heartbeat messages (exact match)", async () => {
    const spy = vi.spyOn(http, "request");
    await handler(sentEvent("HEARTBEAT_OK"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips heartbeat messages (prefix match)", async () => {
    const spy = vi.spyOn(http, "request");
    await handler(sentEvent("HEARTBEAT_OK some extra data"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips failed sends", async () => {
    const spy = vi.spyOn(http, "request");
    await handler(sentEvent("Hello", { success: false }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips empty content", async () => {
    const spy = vi.spyOn(http, "request");
    await handler(sentEvent(""));
    expect(spy).not.toHaveBeenCalled();
  });

  it("fires HTTP request on valid message:sent", async () => {
    let capturedBody = "";
    const mockReq = {
      on: vi.fn(),
      write: vi.fn((data: string) => {
        capturedBody = data;
      }),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    vi.spyOn(http, "request").mockReturnValue(mockReq as unknown as http.ClientRequest);

    await handler(sentEvent("Hello, how can I help?"));

    expect(http.request).toHaveBeenCalledOnce();
    const parsed = JSON.parse(capturedBody);
    expect(parsed.user_id).toBe("ehfaz");
    expect(parsed.project_id).toBeNull();
    expect(parsed.messages).toEqual([{ role: "assistant", content: "Hello, how can I help?" }]);
  });

  it("pairs cached user message with assistant reply", async () => {
    let capturedBody = "";
    const mockReq = {
      on: vi.fn(),
      write: vi.fn((data: string) => {
        capturedBody = data;
      }),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    vi.spyOn(http, "request").mockReturnValue(mockReq as unknown as http.ClientRequest);

    // Simulate message:received first
    await handler(receivedEvent("What is 2+2?"));

    // Then message:sent
    await handler(sentEvent("2+2 equals 4"));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.messages).toEqual([
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "2+2 equals 4" },
    ]);
  });

  it("does not block when handler completes (fire and forget)", async () => {
    const mockReq = {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    vi.spyOn(http, "request").mockReturnValue(mockReq as unknown as http.ClientRequest);

    const start = Date.now();
    await handler(sentEvent("Quick reply"));
    const elapsed = Date.now() - start;

    // Should complete nearly instantly (not waiting for HTTP response)
    expect(elapsed).toBeLessThan(100);
  });

  it("handles NeuralScape being down (no throw)", async () => {
    const mockReq = {
      on: vi.fn((event: string, cb: (err: Error) => void) => {
        if (event === "error") {
          // Simulate connection refused
          setTimeout(() => cb(new Error("connect ECONNREFUSED")), 0);
        }
      }),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    vi.spyOn(http, "request").mockReturnValue(mockReq as unknown as http.ClientRequest);

    // Should not throw
    await expect(handler(sentEvent("Hello"))).resolves.toBeUndefined();
  });

  it("caches user message per conversation and clears after use", async () => {
    let capturedBody = "";
    const mockReq = {
      on: vi.fn(),
      write: vi.fn((data: string) => {
        capturedBody = data;
      }),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    vi.spyOn(http, "request").mockReturnValue(mockReq as unknown as http.ClientRequest);

    // Cache a user message
    await handler(receivedEvent("First question"));
    // Consume it
    await handler(sentEvent("First answer"));

    let parsed = JSON.parse(capturedBody);
    expect(parsed.messages[0]).toEqual({ role: "user", content: "First question" });

    // Send another reply without a preceding user message
    capturedBody = "";
    await handler(sentEvent("Follow up unprompted"));
    parsed = JSON.parse(capturedBody);
    // Should only have assistant message (cache was cleared)
    expect(parsed.messages).toEqual([{ role: "assistant", content: "Follow up unprompted" }]);
  });
});
