/**
 * Agent-event bridge for the telegram-status-pin hook.
 *
 * Subscribes to agent tool events (start/end) via `onAgentEvent` and calls
 * `trackTask` / `completeTask` on the status-pin handler so the pinned card
 * reflects which tools K.I.T.T. is currently executing.
 */

import { onAgentEvent, getAgentRunContext } from "../../../infra/agent-events.js";
import { trackTask, completeTask } from "./handler.js";

// Tool names that are too noisy or internal to surface in the status card.
const SKIP_TOOLS = new Set(["memory_search", "memory_get"]);

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

export function startAgentEventBridge(): () => void {
  return onAgentEvent((evt) => {
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
    if (SKIP_TOOLS.has(toolName)) {
      return;
    }

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

    const taskId = `tool:${toolCallId}`;

    if (phase === "start") {
      const label = labelForTool(toolName, args ?? {});
      trackTask(chatId, taskId, label);
    } else if (phase === "end" || phase === "error") {
      completeTask(chatId, taskId);
    }
  });
}
