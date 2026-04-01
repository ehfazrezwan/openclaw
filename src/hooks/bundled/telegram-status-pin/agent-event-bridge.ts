/**
 * Agent-event bridge for the telegram-status-pin hook.
 *
 * Subscribes to agent tool events (start/end) via `onAgentEvent` and calls
 * `trackTask` / `completeTask` on the status-pin handler so the pinned card
 * reflects which tools K.I.T.T. is currently executing.
 *
 * For persistent tools like `sessions_spawn`, the tool call returns quickly
 * (status: "accepted") while the spawned session runs in the background.
 * The bridge defers `completeTask` until the child run's lifecycle:end event
 * fires, so the pinned card persists for the entire session duration.
 */

import { onAgentEvent, getAgentRunContext } from "../../../infra/agent-events.js";
import {
  trackTask,
  completeTask,
  setCurrentAction,
  clearCurrentAction,
  handleRunEnd,
} from "./handler.js";

/** Tools that create long-running persistent tasks (shown as bullet points). */
const PERSISTENT_TOOLS = new Set(["sessions_spawn"]);

/**
 * Maps toolCallId → { chatId, isPersistent } so that tool:end events can
 * resolve the correct chatId even when the agent run context has already been
 * cleaned up (the root cause of orphaned pinned status cards).
 */
const taskChatIdMap = new Map<string, { chatId: string; isPersistent: boolean }>();

/**
 * Maps child runId → { chatId, taskId } for persistent tools that spawned
 * background sessions. The task is completed when a lifecycle:end/error event
 * arrives for that runId. The 2-hour TASK_TIMEOUT_MS safety net in the handler
 * covers cases where lifecycle events are not received (e.g. remote gateway).
 */
const pendingRunCompletions = new Map<string, { chatId: string; taskId: string }>();

function labelForTool(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "sessions_spawn" && typeof args.task === "string") {
    const preview = args.task.slice(0, 40).replace(/\n/g, " ");
    return `sessions_spawn: ${preview}${args.task.length > 40 ? "\u2026" : ""}`;
  }
  if ((toolName === "exec" || toolName === "bash") && typeof args.command === "string") {
    const preview = args.command.slice(0, 40).replace(/\n/g, " ");
    return `exec: ${preview}${args.command.length > 40 ? "\u2026" : ""}`;
  }
  if (toolName === "web_search" && typeof args.query === "string") {
    const preview = args.query.slice(0, 40);
    return `web_search: ${preview}${args.query.length > 40 ? "\u2026" : ""}`;
  }
  if (toolName === "web_fetch" && typeof args.url === "string") {
    return `web_fetch: ${args.url.slice(0, 50)}`;
  }
  return toolName;
}

/**
 * Extract the Telegram chat ID from a session key.
 *
 * Handles all canonical formats produced by `buildAgentPeerSessionKey`:
 *   - `agent:main:telegram:direct:<chatId>`            (per-channel-peer)
 *   - `agent:main:telegram:<account>:direct:<chatId>`  (per-account-channel-peer)
 *   - `agent:main:telegram:dm:<chatId>`                (legacy alias)
 *   - `agent:main:telegram:group:<chatId>`             (group chat)
 *   - Any of the above with `:thread:<id>` / `:topic:<id>` suffix
 *
 * Returns `null` for non-telegram session keys.
 */
export function extractTelegramChatId(sessionKey: string): string | null {
  const lower = sessionKey.toLowerCase();
  if (!lower.includes(":telegram:")) {
    return null;
  }

  // Strip thread/topic suffix before extracting the peer id
  const base = lower.replace(/:(?:thread|topic):[^:]*$/, "");

  // The chat id is always the segment after direct/dm/group
  const match = base.match(/:(direct|dm|group):([^:]+)$/);
  return match ? match[2] : null;
}

/**
 * Extract the child runId from a persistent tool's result.
 *
 * For sessions_spawn, the tool result has the structure:
 *   { content: [{ type: "text", text: "..." }], details: { status, runId, ... } }
 *
 * After sanitization, the `details` field is preserved. A non-empty `runId`
 * indicates the session was successfully spawned and is running in the background.
 */
function extractChildRunId(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== "object") {
    return null;
  }
  const runId = (details as Record<string, unknown>).runId;
  return typeof runId === "string" && runId.trim() ? runId.trim() : null;
}

export function startAgentEventBridge(): () => void {
  return onAgentEvent((evt) => {
    // Handle lifecycle events for child run completion detection AND
    // parent run-end cleanup (secondary path for NO_REPLY / silent replies).
    if (evt.stream === "lifecycle") {
      const { phase } = evt.data as { phase?: string };
      if (phase === "end" || phase === "error") {
        // 1. Child run completion — completes a persistent task (sessions_spawn)
        const pending = pendingRunCompletions.get(evt.runId);
        if (pending) {
          pendingRunCompletions.delete(evt.runId);
          completeTask(pending.chatId, pending.taskId);
        }

        // 2. Parent run-end cleanup — clears the "Working..." card when
        //    message:sent never fires (e.g. NO_REPLY / silent reply).
        //    handleRunEnd is idempotent: if handleSent already cleaned up,
        //    this is a no-op.
        const context = getAgentRunContext(evt.runId);
        if (context?.sessionKey && !context.isHeartbeat) {
          const chatId = extractTelegramChatId(context.sessionKey);
          if (chatId) {
            handleRunEnd(chatId);
          }
        }
      }
      return;
    }

    if (evt.stream !== "tool") {
      return;
    }

    const { phase, name, toolCallId, args } = evt.data as {
      phase?: string;
      name?: string;
      toolCallId?: string;
      args?: Record<string, unknown>;
    };

    if (!phase || !name || !toolCallId) {
      return;
    }

    const toolName = String(name);
    const taskId = `tool:${toolCallId}`;
    const isPersistent = PERSISTENT_TOOLS.has(toolName);

    if (phase === "start") {
      // Resolve chatId from agent run context (available at start time)
      const context = getAgentRunContext(evt.runId);
      if (!context?.sessionKey) {
        return;
      }
      if (context.isHeartbeat) {
        return;
      }

      const chatId = extractTelegramChatId(context.sessionKey);
      if (!chatId) {
        return;
      }

      // Store the mapping so tool:end can find the chatId even if the
      // agent run context has been cleaned up by then.
      taskChatIdMap.set(toolCallId, { chatId, isPersistent });

      const label = labelForTool(toolName, args ?? {});
      if (isPersistent) {
        trackTask(chatId, taskId, label);
      } else {
        setCurrentAction(chatId, taskId, label);
      }
    } else if (phase === "end" || phase === "result" || phase === "error") {
      // First try the stored mapping (reliable even after run context cleanup).
      // Fall back to getAgentRunContext for backward compatibility.
      const stored = taskChatIdMap.get(toolCallId);
      let chatId: string | null = null;
      let resolvedPersistent = isPersistent;

      if (stored) {
        chatId = stored.chatId;
        resolvedPersistent = stored.isPersistent;
        taskChatIdMap.delete(toolCallId);
      } else {
        const context = getAgentRunContext(evt.runId);
        if (!context?.sessionKey) {
          return;
        }
        if (context.isHeartbeat) {
          return;
        }
        chatId = extractTelegramChatId(context.sessionKey);
      }

      if (!chatId) {
        return;
      }

      if (resolvedPersistent) {
        // For persistent tools, check if a background session was spawned.
        // If so, defer completeTask until the child run's lifecycle event.
        const eventData = evt.data;
        const isError = eventData.isError === true;
        const childRunId = isError ? null : extractChildRunId(eventData.result);

        if (childRunId) {
          // Session spawned successfully — keep the task on the card.
          // It will be completed when the child run emits lifecycle:end.
          pendingRunCompletions.set(childRunId, { chatId, taskId });
        } else {
          // Spawn failed, errored, or no child runId — complete immediately.
          completeTask(chatId, taskId);
        }
      } else {
        clearCurrentAction(chatId, taskId);
      }
    }
  });
}

// Exported for testing
export { taskChatIdMap, pendingRunCompletions, extractChildRunId };
