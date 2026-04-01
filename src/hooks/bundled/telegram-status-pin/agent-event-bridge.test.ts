import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock handler exports before importing the bridge
vi.mock("./handler.js", () => ({
  trackTask: vi.fn(),
  completeTask: vi.fn(),
}));

// Mock agent-events — capture the listener so we can fire events manually
let capturedListener: ((evt: unknown) => void) | null = null;
const mockUnsubscribe = vi.fn();

vi.mock("../../../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((listener: (evt: unknown) => void) => {
    capturedListener = listener;
    return mockUnsubscribe;
  }),
  getAgentRunContext: vi.fn(),
}));

import { getAgentRunContext } from "../../../infra/agent-events.js";
import { startAgentEventBridge, extractTelegramChatId } from "./agent-event-bridge.js";
import { trackTask, completeTask } from "./handler.js";

const mockGetAgentRunContext = getAgentRunContext as ReturnType<typeof vi.fn>;

function fireToolEvent(overrides: Record<string, unknown> = {}) {
  const { data: dataOverrides, ...topOverrides } = overrides;
  const evt = {
    runId: "run-1",
    seq: 1,
    stream: "tool",
    ts: Date.now(),
    ...topOverrides,
    data: {
      phase: "start",
      name: "web_search",
      toolCallId: "tc-001",
      args: { query: "Tailscale pricing" },
      ...(dataOverrides as Record<string, unknown>),
    },
  };
  capturedListener?.(evt);
}

beforeEach(() => {
  capturedListener = null;
  mockUnsubscribe.mockClear();
  vi.mocked(trackTask).mockClear();
  vi.mocked(completeTask).mockClear();
  mockGetAgentRunContext.mockReset();

  // Default: valid Telegram session with no heartbeat
  mockGetAgentRunContext.mockReturnValue({
    sessionKey: "agent:main:telegram:direct:5225642693",
    isHeartbeat: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent-event-bridge", () => {
  describe("startAgentEventBridge", () => {
    it("returns an unsubscribe function from onAgentEvent", () => {
      const unsub = startAgentEventBridge();
      expect(unsub).toBe(mockUnsubscribe);
    });

    it("registers exactly one listener", () => {
      startAgentEventBridge();
      expect(capturedListener).toBeTypeOf("function");
    });
  });

  describe("tool start events", () => {
    it("calls trackTask with correct chatId and label", () => {
      startAgentEventBridge();
      fireToolEvent();

      expect(trackTask).toHaveBeenCalledOnce();
      expect(trackTask).toHaveBeenCalledWith(
        "5225642693",
        "tool:tc-001",
        "web_search: Tailscale pricing",
      );
    });
  });

  describe("tool end events", () => {
    it("calls completeTask on phase=end", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { phase: "end" } });

      expect(completeTask).toHaveBeenCalledOnce();
      expect(completeTask).toHaveBeenCalledWith("5225642693", "tool:tc-001");
    });

    it("calls completeTask on phase=error", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { phase: "error" } });

      expect(completeTask).toHaveBeenCalledOnce();
      expect(completeTask).toHaveBeenCalledWith("5225642693", "tool:tc-001");
    });
  });

  describe("SKIP_TOOLS filtering", () => {
    it("ignores memory_search", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { name: "memory_search" } });

      expect(trackTask).not.toHaveBeenCalled();
      expect(completeTask).not.toHaveBeenCalled();
    });

    it("ignores memory_get", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { name: "memory_get" } });

      expect(trackTask).not.toHaveBeenCalled();
      expect(completeTask).not.toHaveBeenCalled();
    });
  });

  describe("non-telegram session keys", () => {
    it("ignores whatsapp session keys", () => {
      mockGetAgentRunContext.mockReturnValue({
        sessionKey: "agent:main:whatsapp:direct:+15551234567",
      });
      startAgentEventBridge();
      fireToolEvent();

      expect(trackTask).not.toHaveBeenCalled();
    });

    it("ignores discord session keys", () => {
      mockGetAgentRunContext.mockReturnValue({
        sessionKey: "agent:main:discord:channel:alerts",
      });
      startAgentEventBridge();
      fireToolEvent();

      expect(trackTask).not.toHaveBeenCalled();
    });
  });

  describe("heartbeat runs", () => {
    it("ignores events from heartbeat runs", () => {
      mockGetAgentRunContext.mockReturnValue({
        sessionKey: "agent:main:telegram:direct:5225642693",
        isHeartbeat: true,
      });
      startAgentEventBridge();
      fireToolEvent();

      expect(trackTask).not.toHaveBeenCalled();
    });
  });

  describe("missing sessionKey", () => {
    it("ignores events when sessionKey is undefined", () => {
      mockGetAgentRunContext.mockReturnValue({});
      startAgentEventBridge();
      fireToolEvent();

      expect(trackTask).not.toHaveBeenCalled();
    });

    it("ignores events when run context is undefined", () => {
      mockGetAgentRunContext.mockReturnValue(undefined);
      startAgentEventBridge();
      fireToolEvent();

      expect(trackTask).not.toHaveBeenCalled();
    });
  });

  describe("non-tool event streams", () => {
    it("ignores lifecycle events", () => {
      startAgentEventBridge();
      fireToolEvent({ stream: "lifecycle" });

      expect(trackTask).not.toHaveBeenCalled();
    });

    it("ignores assistant events", () => {
      startAgentEventBridge();
      fireToolEvent({ stream: "assistant" });

      expect(trackTask).not.toHaveBeenCalled();
    });
  });

  describe("label formatting", () => {
    it("sessions_spawn includes task preview", () => {
      startAgentEventBridge();
      fireToolEvent({
        data: {
          name: "sessions_spawn",
          args: { task: "Fix the authentication bug in the login flow" },
        },
      });

      expect(trackTask).toHaveBeenCalledWith(
        "5225642693",
        "tool:tc-001",
        "sessions_spawn: Fix the authentication bug in the login \u2026",
      );
    });

    it("exec includes command preview", () => {
      startAgentEventBridge();
      fireToolEvent({
        data: {
          name: "exec",
          args: { command: "pnpm build && pnpm test --run" },
        },
      });

      expect(trackTask).toHaveBeenCalledWith(
        "5225642693",
        "tool:tc-001",
        "exec: pnpm build && pnpm test --run",
      );
    });

    it("bash includes command preview (same as exec)", () => {
      startAgentEventBridge();
      fireToolEvent({
        data: {
          name: "bash",
          args: { command: "git status" },
        },
      });

      expect(trackTask).toHaveBeenCalledWith("5225642693", "tool:tc-001", "exec: git status");
    });

    it("web_search includes query preview", () => {
      startAgentEventBridge();
      fireToolEvent({
        data: {
          name: "web_search",
          args: { query: "How to configure Tailscale on Ubuntu" },
        },
      });

      expect(trackTask).toHaveBeenCalledWith(
        "5225642693",
        "tool:tc-001",
        "web_search: How to configure Tailscale on Ubuntu",
      );
    });

    it("web_fetch includes URL", () => {
      startAgentEventBridge();
      fireToolEvent({
        data: {
          name: "web_fetch",
          args: { url: "https://docs.tailscale.com/kb/1234/install" },
        },
      });

      expect(trackTask).toHaveBeenCalledWith(
        "5225642693",
        "tool:tc-001",
        "web_fetch: https://docs.tailscale.com/kb/1234/install",
      );
    });

    it("unknown tool uses bare tool name", () => {
      startAgentEventBridge();
      fireToolEvent({
        data: {
          name: "custom_tool",
          args: {},
        },
      });

      expect(trackTask).toHaveBeenCalledWith("5225642693", "tool:tc-001", "custom_tool");
    });

    it("truncates long sessions_spawn task preview at 40 chars", () => {
      const longTask = "A".repeat(50);
      startAgentEventBridge();
      fireToolEvent({
        data: {
          name: "sessions_spawn",
          args: { task: longTask },
        },
      });

      expect(trackTask).toHaveBeenCalledWith(
        "5225642693",
        "tool:tc-001",
        `sessions_spawn: ${"A".repeat(40)}\u2026`,
      );
    });
  });

  describe("missing event data fields", () => {
    it("ignores events with missing phase", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { phase: undefined } });

      expect(trackTask).not.toHaveBeenCalled();
    });

    it("ignores events with missing name", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { name: undefined } });

      expect(trackTask).not.toHaveBeenCalled();
    });

    it("ignores events with missing toolCallId", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { toolCallId: undefined } });

      expect(trackTask).not.toHaveBeenCalled();
    });
  });
});

describe("extractTelegramChatId", () => {
  it("extracts chatId from per-channel-peer format", () => {
    expect(extractTelegramChatId("agent:main:telegram:direct:5225642693")).toBe("5225642693");
  });

  it("extracts chatId from per-account-channel-peer format", () => {
    expect(extractTelegramChatId("agent:main:telegram:atlas:direct:123")).toBe("123");
  });

  it("extracts chatId from default account format", () => {
    expect(extractTelegramChatId("agent:main:telegram:default:direct:7550356539")).toBe(
      "7550356539",
    );
  });

  it("extracts chatId from dm alias", () => {
    expect(extractTelegramChatId("agent:main:telegram:dm:123456")).toBe("123456");
  });

  it("extracts chatId from group format", () => {
    expect(extractTelegramChatId("agent:main:telegram:group:-1001")).toBe("-1001");
  });

  it("strips :thread: suffix before extracting", () => {
    expect(extractTelegramChatId("agent:main:telegram:direct:123:thread:99")).toBe("123");
  });

  it("strips :topic: suffix before extracting", () => {
    expect(extractTelegramChatId("agent:main:telegram:group:-1001:topic:42")).toBe("-1001");
  });

  it("returns null for non-telegram keys", () => {
    expect(extractTelegramChatId("agent:main:whatsapp:direct:+15551234567")).toBeNull();
    expect(extractTelegramChatId("agent:main:discord:channel:alerts")).toBeNull();
    expect(extractTelegramChatId("agent:main:main")).toBeNull();
  });

  it("returns null for malformed keys without direct/dm/group", () => {
    expect(extractTelegramChatId("agent:main:telegram:unknown")).toBeNull();
  });
});
