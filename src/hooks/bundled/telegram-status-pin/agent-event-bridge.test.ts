import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock handler exports before importing the bridge
vi.mock("./handler.js", () => ({
  trackTask: vi.fn(),
  completeTask: vi.fn(),
  setCurrentAction: vi.fn(),
  clearCurrentAction: vi.fn(),
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
import {
  startAgentEventBridge,
  extractTelegramChatId,
  extractChildRunId,
  taskChatIdMap,
  pendingRunCompletions,
} from "./agent-event-bridge.js";
import { trackTask, completeTask, setCurrentAction, clearCurrentAction } from "./handler.js";

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
  vi.mocked(setCurrentAction).mockClear();
  vi.mocked(clearCurrentAction).mockClear();
  mockGetAgentRunContext.mockReset();
  taskChatIdMap.clear();
  pendingRunCompletions.clear();

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

  // -------------------------------------------------------------------
  // Ephemeral tool routing
  // -------------------------------------------------------------------

  describe("ephemeral tool start events", () => {
    it("calls setCurrentAction for ephemeral tools", () => {
      startAgentEventBridge();
      fireToolEvent();

      expect(setCurrentAction).toHaveBeenCalledOnce();
      expect(setCurrentAction).toHaveBeenCalledWith(
        "5225642693",
        "tool:tc-001",
        "web_search: Tailscale pricing",
      );
      expect(trackTask).not.toHaveBeenCalled();
    });
  });

  describe("ephemeral tool end events", () => {
    it("calls clearCurrentAction on phase=end", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { phase: "end" } });

      expect(clearCurrentAction).toHaveBeenCalledOnce();
      expect(clearCurrentAction).toHaveBeenCalledWith("5225642693", "tool:tc-001");
      expect(completeTask).not.toHaveBeenCalled();
    });

    it("calls clearCurrentAction on phase=error", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { phase: "error" } });

      expect(clearCurrentAction).toHaveBeenCalledOnce();
      expect(clearCurrentAction).toHaveBeenCalledWith("5225642693", "tool:tc-001");
      expect(completeTask).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Persistent tool routing (sessions_spawn)
  // -------------------------------------------------------------------

  describe("persistent tool start events", () => {
    it("calls trackTask for sessions_spawn", () => {
      startAgentEventBridge();
      fireToolEvent({
        data: {
          name: "sessions_spawn",
          args: { task: "Fix the authentication bug in the login flow" },
        },
      });

      expect(trackTask).toHaveBeenCalledOnce();
      expect(trackTask).toHaveBeenCalledWith(
        "5225642693",
        "tool:tc-001",
        "sessions_spawn: Fix the authentication bug in the login \u2026",
      );
      expect(setCurrentAction).not.toHaveBeenCalled();
    });
  });

  describe("persistent tool end events", () => {
    it("calls completeTask for sessions_spawn on phase=end", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { phase: "end", name: "sessions_spawn" } });

      expect(completeTask).toHaveBeenCalledOnce();
      expect(completeTask).toHaveBeenCalledWith("5225642693", "tool:tc-001");
      expect(clearCurrentAction).not.toHaveBeenCalled();
    });

    it("calls completeTask for sessions_spawn on phase=error", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { phase: "error", name: "sessions_spawn" } });

      expect(completeTask).toHaveBeenCalledOnce();
      expect(completeTask).toHaveBeenCalledWith("5225642693", "tool:tc-001");
      expect(clearCurrentAction).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Previously-skipped tools are now ephemeral
  // -------------------------------------------------------------------

  describe("memory tools are now ephemeral (no longer skipped)", () => {
    it("routes memory_search as ephemeral", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { name: "memory_search" } });

      expect(setCurrentAction).toHaveBeenCalledOnce();
      expect(setCurrentAction).toHaveBeenCalledWith("5225642693", "tool:tc-001", "memory_search");
      expect(trackTask).not.toHaveBeenCalled();
    });

    it("routes memory_get as ephemeral", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { name: "memory_get" } });

      expect(setCurrentAction).toHaveBeenCalledOnce();
      expect(setCurrentAction).toHaveBeenCalledWith("5225642693", "tool:tc-001", "memory_get");
      expect(trackTask).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Filtering (non-telegram, heartbeat, missing data)
  // -------------------------------------------------------------------

  describe("non-telegram session keys", () => {
    it("ignores whatsapp session keys", () => {
      mockGetAgentRunContext.mockReturnValue({
        sessionKey: "agent:main:whatsapp:direct:+15551234567",
      });
      startAgentEventBridge();
      fireToolEvent();

      expect(setCurrentAction).not.toHaveBeenCalled();
      expect(trackTask).not.toHaveBeenCalled();
    });

    it("ignores discord session keys", () => {
      mockGetAgentRunContext.mockReturnValue({
        sessionKey: "agent:main:discord:channel:alerts",
      });
      startAgentEventBridge();
      fireToolEvent();

      expect(setCurrentAction).not.toHaveBeenCalled();
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

      expect(setCurrentAction).not.toHaveBeenCalled();
      expect(trackTask).not.toHaveBeenCalled();
    });
  });

  describe("missing sessionKey", () => {
    it("ignores events when sessionKey is undefined", () => {
      mockGetAgentRunContext.mockReturnValue({});
      startAgentEventBridge();
      fireToolEvent();

      expect(setCurrentAction).not.toHaveBeenCalled();
      expect(trackTask).not.toHaveBeenCalled();
    });

    it("ignores events when run context is undefined", () => {
      mockGetAgentRunContext.mockReturnValue(undefined);
      startAgentEventBridge();
      fireToolEvent();

      expect(setCurrentAction).not.toHaveBeenCalled();
      expect(trackTask).not.toHaveBeenCalled();
    });
  });

  describe("non-tool event streams", () => {
    it("ignores lifecycle events", () => {
      startAgentEventBridge();
      fireToolEvent({ stream: "lifecycle" });

      expect(setCurrentAction).not.toHaveBeenCalled();
      expect(trackTask).not.toHaveBeenCalled();
    });

    it("ignores assistant events", () => {
      startAgentEventBridge();
      fireToolEvent({ stream: "assistant" });

      expect(setCurrentAction).not.toHaveBeenCalled();
      expect(trackTask).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Label formatting
  // -------------------------------------------------------------------

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

      expect(setCurrentAction).toHaveBeenCalledWith(
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

      expect(setCurrentAction).toHaveBeenCalledWith(
        "5225642693",
        "tool:tc-001",
        "exec: git status",
      );
    });

    it("web_search includes query preview", () => {
      startAgentEventBridge();
      fireToolEvent({
        data: {
          name: "web_search",
          args: { query: "How to configure Tailscale on Ubuntu" },
        },
      });

      expect(setCurrentAction).toHaveBeenCalledWith(
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

      expect(setCurrentAction).toHaveBeenCalledWith(
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

      expect(setCurrentAction).toHaveBeenCalledWith("5225642693", "tool:tc-001", "custom_tool");
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

  // -------------------------------------------------------------------
  // Missing event data fields
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------
  // chatId mapping for reliable tool:end resolution
  // -------------------------------------------------------------------

  describe("taskChatIdMap for reliable tool:end", () => {
    it("stores chatId on tool:start and uses it on tool:end even when run context is gone", () => {
      startAgentEventBridge();

      // tool:start — run context is available
      fireToolEvent({
        data: { phase: "start", name: "sessions_spawn", args: { task: "Fix bug" } },
      });
      expect(trackTask).toHaveBeenCalledOnce();
      expect(taskChatIdMap.has("tc-001")).toBe(true);

      // Simulate run context being cleaned up
      mockGetAgentRunContext.mockReturnValue(undefined);

      // tool:end — run context is gone, but chatId is in the map
      fireToolEvent({ data: { phase: "end", name: "sessions_spawn" } });
      expect(completeTask).toHaveBeenCalledOnce();
      expect(completeTask).toHaveBeenCalledWith("5225642693", "tool:tc-001");

      // Mapping should be cleaned up after use
      expect(taskChatIdMap.has("tc-001")).toBe(false);
    });

    it("uses stored isPersistent flag from mapping on tool:end", () => {
      startAgentEventBridge();

      // tool:start as persistent tool
      fireToolEvent({
        data: { phase: "start", name: "sessions_spawn", args: { task: "Task" } },
      });
      expect(trackTask).toHaveBeenCalledOnce();

      // tool:end — even if the name is different due to some wrapper, isPersistent
      // is resolved from the stored mapping
      mockGetAgentRunContext.mockReturnValue(undefined);
      fireToolEvent({
        data: { phase: "end", name: "sessions_spawn", toolCallId: "tc-001" },
      });

      expect(completeTask).toHaveBeenCalledOnce();
      expect(clearCurrentAction).not.toHaveBeenCalled();
    });

    it("stores chatId for ephemeral tools and clears on tool:end", () => {
      startAgentEventBridge();

      // tool:start — ephemeral
      fireToolEvent({
        data: { phase: "start", name: "web_search", args: { query: "test" } },
      });
      expect(setCurrentAction).toHaveBeenCalledOnce();
      expect(taskChatIdMap.has("tc-001")).toBe(true);

      // Run context gone
      mockGetAgentRunContext.mockReturnValue(undefined);

      // tool:end — resolved from mapping
      fireToolEvent({ data: { phase: "end", name: "web_search" } });
      expect(clearCurrentAction).toHaveBeenCalledOnce();
      expect(clearCurrentAction).toHaveBeenCalledWith("5225642693", "tool:tc-001");
      expect(taskChatIdMap.has("tc-001")).toBe(false);
    });

    it("falls back to getAgentRunContext when mapping is missing on tool:end", () => {
      startAgentEventBridge();

      // Directly fire tool:end without a prior tool:start (edge case)
      fireToolEvent({ data: { phase: "end", name: "web_search" } });

      // Should still work via getAgentRunContext fallback
      expect(clearCurrentAction).toHaveBeenCalledOnce();
      expect(clearCurrentAction).toHaveBeenCalledWith("5225642693", "tool:tc-001");
    });

    it("drops tool:end when both mapping and run context are missing", () => {
      startAgentEventBridge();

      mockGetAgentRunContext.mockReturnValue(undefined);

      // No prior tool:start, no run context — should be silently dropped
      fireToolEvent({ data: { phase: "end", name: "web_search" } });

      expect(clearCurrentAction).not.toHaveBeenCalled();
      expect(completeTask).not.toHaveBeenCalled();
    });

    it("handles tool:error the same as tool:end", () => {
      startAgentEventBridge();

      fireToolEvent({
        data: { phase: "start", name: "sessions_spawn", args: { task: "Fail" } },
      });
      expect(trackTask).toHaveBeenCalledOnce();

      mockGetAgentRunContext.mockReturnValue(undefined);

      fireToolEvent({ data: { phase: "error", name: "sessions_spawn" } });
      expect(completeTask).toHaveBeenCalledOnce();
      expect(taskChatIdMap.has("tc-001")).toBe(false);
    });

    it("does not store mapping for non-telegram sessions", () => {
      mockGetAgentRunContext.mockReturnValue({
        sessionKey: "agent:main:whatsapp:direct:+15551234567",
        isHeartbeat: false,
      });

      startAgentEventBridge();
      fireToolEvent();

      expect(taskChatIdMap.has("tc-001")).toBe(false);
      expect(setCurrentAction).not.toHaveBeenCalled();
    });

    it("does not store mapping for heartbeat runs", () => {
      mockGetAgentRunContext.mockReturnValue({
        sessionKey: "agent:main:telegram:direct:5225642693",
        isHeartbeat: true,
      });

      startAgentEventBridge();
      fireToolEvent();

      expect(taskChatIdMap.has("tc-001")).toBe(false);
      expect(setCurrentAction).not.toHaveBeenCalled();
    });
  });

  describe("missing event data fields", () => {
    it("ignores events with missing phase", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { phase: undefined } });

      expect(setCurrentAction).not.toHaveBeenCalled();
      expect(trackTask).not.toHaveBeenCalled();
    });

    it("ignores events with missing name", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { name: undefined } });

      expect(setCurrentAction).not.toHaveBeenCalled();
      expect(trackTask).not.toHaveBeenCalled();
    });

    it("ignores events with missing toolCallId", () => {
      startAgentEventBridge();
      fireToolEvent({ data: { toolCallId: undefined } });

      expect(setCurrentAction).not.toHaveBeenCalled();
      expect(trackTask).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Deferred completion for persistent tools (sessions_spawn)
  // -------------------------------------------------------------------

  describe("deferred completion for persistent tools", () => {
    const spawnResult = {
      content: [{ type: "text", text: '{"status":"accepted","runId":"child-run-1"}' }],
      details: {
        status: "accepted",
        runId: "child-run-1",
        childSessionKey: "agent:main:subagent:uuid",
      },
    };

    it("does NOT call completeTask when sessions_spawn returns accepted with a runId", () => {
      startAgentEventBridge();

      // tool:start
      fireToolEvent({
        data: { phase: "start", name: "sessions_spawn", args: { task: "Fix bug" } },
      });
      expect(trackTask).toHaveBeenCalledOnce();

      // tool:result with accepted status and runId
      fireToolEvent({
        data: {
          phase: "result",
          name: "sessions_spawn",
          isError: false,
          result: spawnResult,
        },
      });

      // completeTask should NOT have been called — task should persist
      expect(completeTask).not.toHaveBeenCalled();

      // Should have stored the pending run completion
      expect(pendingRunCompletions.has("child-run-1")).toBe(true);
      expect(pendingRunCompletions.get("child-run-1")).toEqual({
        chatId: "5225642693",
        taskId: "tool:tc-001",
      });
    });

    it("calls completeTask immediately when sessions_spawn errors (isError=true)", () => {
      startAgentEventBridge();

      fireToolEvent({
        data: { phase: "start", name: "sessions_spawn", args: { task: "Fail" } },
      });

      fireToolEvent({
        data: {
          phase: "result",
          name: "sessions_spawn",
          isError: true,
          result: {
            content: [{ type: "text", text: '{"status":"error"}' }],
            details: { status: "error" },
          },
        },
      });

      expect(completeTask).toHaveBeenCalledOnce();
      expect(completeTask).toHaveBeenCalledWith("5225642693", "tool:tc-001");
      expect(pendingRunCompletions.size).toBe(0);
    });

    it("calls completeTask immediately when sessions_spawn result has no runId", () => {
      startAgentEventBridge();

      fireToolEvent({
        data: { phase: "start", name: "sessions_spawn", args: { task: "Fail" } },
      });

      fireToolEvent({
        data: {
          phase: "result",
          name: "sessions_spawn",
          isError: false,
          result: {
            content: [{ type: "text", text: '{"status":"forbidden"}' }],
            details: { status: "forbidden", error: "max depth reached" },
          },
        },
      });

      expect(completeTask).toHaveBeenCalledOnce();
      expect(pendingRunCompletions.size).toBe(0);
    });

    it("calls completeTask immediately when persistent tool:result has no result data at all", () => {
      startAgentEventBridge();

      fireToolEvent({
        data: { phase: "start", name: "sessions_spawn", args: { task: "Task" } },
      });

      // tool:end with no result (e.g. phase="end" fallback)
      fireToolEvent({
        data: { phase: "end", name: "sessions_spawn" },
      });

      expect(completeTask).toHaveBeenCalledOnce();
      expect(pendingRunCompletions.size).toBe(0);
    });

    it("completes the task when child run lifecycle:end event fires", () => {
      startAgentEventBridge();

      // tool:start
      fireToolEvent({
        data: { phase: "start", name: "sessions_spawn", args: { task: "Fix bug" } },
      });

      // tool:result with accepted status
      fireToolEvent({
        data: {
          phase: "result",
          name: "sessions_spawn",
          isError: false,
          result: spawnResult,
        },
      });
      expect(completeTask).not.toHaveBeenCalled();

      // Child run lifecycle:end event
      capturedListener?.({
        runId: "child-run-1",
        seq: 99,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "end", endedAt: Date.now() },
      });

      expect(completeTask).toHaveBeenCalledOnce();
      expect(completeTask).toHaveBeenCalledWith("5225642693", "tool:tc-001");
      expect(pendingRunCompletions.has("child-run-1")).toBe(false);
    });

    it("completes the task when child run lifecycle:error event fires", () => {
      startAgentEventBridge();

      fireToolEvent({
        data: { phase: "start", name: "sessions_spawn", args: { task: "Fix bug" } },
      });
      fireToolEvent({
        data: {
          phase: "result",
          name: "sessions_spawn",
          isError: false,
          result: spawnResult,
        },
      });

      // Child run lifecycle:error event
      capturedListener?.({
        runId: "child-run-1",
        seq: 99,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "error", error: "LLM request failed" },
      });

      expect(completeTask).toHaveBeenCalledOnce();
      expect(completeTask).toHaveBeenCalledWith("5225642693", "tool:tc-001");
      expect(pendingRunCompletions.has("child-run-1")).toBe(false);
    });

    it("ignores lifecycle:end events that don't match any pending run", () => {
      startAgentEventBridge();

      capturedListener?.({
        runId: "unrelated-run",
        seq: 1,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "end" },
      });

      expect(completeTask).not.toHaveBeenCalled();
      expect(trackTask).not.toHaveBeenCalled();
    });

    it("ignores lifecycle:start events (only end/error trigger completion)", () => {
      startAgentEventBridge();

      // Set up a pending completion
      pendingRunCompletions.set("child-run-1", { chatId: "5225642693", taskId: "tool:tc-001" });

      capturedListener?.({
        runId: "child-run-1",
        seq: 1,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "start" },
      });

      // Should NOT complete — phase is "start", not "end"
      expect(completeTask).not.toHaveBeenCalled();
      expect(pendingRunCompletions.has("child-run-1")).toBe(true);
    });

    it("cleans up taskChatIdMap even when deferring completion", () => {
      startAgentEventBridge();

      fireToolEvent({
        data: { phase: "start", name: "sessions_spawn", args: { task: "Task" } },
      });
      expect(taskChatIdMap.has("tc-001")).toBe(true);

      fireToolEvent({
        data: {
          phase: "result",
          name: "sessions_spawn",
          isError: false,
          result: spawnResult,
        },
      });

      // taskChatIdMap should be cleaned up
      expect(taskChatIdMap.has("tc-001")).toBe(false);
      // But pendingRunCompletions should have the entry
      expect(pendingRunCompletions.has("child-run-1")).toBe(true);
    });

    it("full lifecycle: start → accepted result → lifecycle:end completes task", () => {
      startAgentEventBridge();

      // 1. Tool starts
      fireToolEvent({
        data: { phase: "start", name: "sessions_spawn", args: { task: "Build feature" } },
      });
      expect(trackTask).toHaveBeenCalledOnce();

      // 2. Tool returns accepted (session spawned in background)
      fireToolEvent({
        data: {
          phase: "result",
          name: "sessions_spawn",
          isError: false,
          result: {
            content: [{ type: "text", text: '{"status":"accepted","runId":"child-42"}' }],
            details: { status: "accepted", runId: "child-42" },
          },
        },
      });
      expect(completeTask).not.toHaveBeenCalled();

      // 3. Child session runs for a while... then ends
      capturedListener?.({
        runId: "child-42",
        seq: 50,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "end", endedAt: Date.now() },
      });

      expect(completeTask).toHaveBeenCalledOnce();
      expect(completeTask).toHaveBeenCalledWith("5225642693", "tool:tc-001");
      expect(pendingRunCompletions.size).toBe(0);
      expect(taskChatIdMap.size).toBe(0);
    });
  });
});

describe("extractChildRunId", () => {
  it("extracts runId from a successful spawn result", () => {
    expect(
      extractChildRunId({
        content: [{ type: "text", text: '{"status":"accepted","runId":"child-1"}' }],
        details: { status: "accepted", runId: "child-1" },
      }),
    ).toBe("child-1");
  });

  it("returns null when details has no runId", () => {
    expect(
      extractChildRunId({
        content: [{ type: "text", text: '{"status":"error"}' }],
        details: { status: "error", error: "forbidden" },
      }),
    ).toBeNull();
  });

  it("returns null when result is null/undefined", () => {
    expect(extractChildRunId(null)).toBeNull();
    expect(extractChildRunId(undefined)).toBeNull();
  });

  it("returns null when result has no details", () => {
    expect(extractChildRunId({ content: [] })).toBeNull();
  });

  it("returns null for empty runId string", () => {
    expect(extractChildRunId({ details: { runId: "" } })).toBeNull();
    expect(extractChildRunId({ details: { runId: "  " } })).toBeNull();
  });

  it("trims whitespace from runId", () => {
    expect(extractChildRunId({ details: { runId: "  child-1  " } })).toBe("child-1");
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
