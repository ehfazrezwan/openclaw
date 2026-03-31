/**
 * NeuralScape memory hook handler
 *
 * Sends conversation exchanges to NeuralScape for meaningful memory extraction.
 * Fires on message:sent — pairs the assistant reply with the cached user message
 * and POSTs to NeuralScape's /v1/memories endpoint. Fire-and-forget.
 */

import http from "node:http";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("hooks/neuralscape-memory");

const NEURALSCAPE_URL = "http://localhost:8199/v1/memories";
const USER_ID = "ehfaz";

/** Cache of last user message per conversation, keyed by channelId:conversationId */
const lastUserMessage = new Map<string, string>();

function conversationKey(channelId: string, conversationId?: string): string {
  return `${channelId}:${conversationId ?? "default"}`;
}

function isHeartbeat(content: string): boolean {
  return content === "HEARTBEAT_OK" || content.startsWith("HEARTBEAT_OK");
}

function postToNeuralScape(userMessage: string | undefined, assistantMessage: string): void {
  const messages: Array<{ role: string; content: string }> = [];
  if (userMessage) {
    messages.push({ role: "user", content: userMessage });
  }
  messages.push({ role: "assistant", content: assistantMessage });

  const body = JSON.stringify({
    messages,
    user_id: USER_ID,
    project_id: null,
  });

  const url = new URL(NEURALSCAPE_URL);
  const req = http.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 5000,
    },
    (res) => {
      // Drain the response to free the socket
      res.resume();
      log.debug("NeuralScape response", { status: res.statusCode });
    },
  );

  req.on("error", (err) => {
    log.debug("NeuralScape unavailable", { error: err.message });
  });

  req.on("timeout", () => {
    req.destroy();
    log.debug("NeuralScape request timed out");
  });

  req.write(body);
  req.end();
}

const neuralscapeMemoryHandler: HookHandler = async (event) => {
  if (event.type !== "message") {
    return;
  }

  const context = event.context || {};
  const channelId = context.channelId as string | undefined;

  // Cache user messages from message:received events
  if (event.action === "received") {
    const content = context.content as string | undefined;
    if (channelId && content) {
      const key = conversationKey(channelId, context.conversationId as string | undefined);
      lastUserMessage.set(key, content);
    }
    return;
  }

  // Only process message:sent events from here
  if (event.action !== "sent") {
    return;
  }

  const content = context.content as string | undefined;
  const success = context.success as boolean | undefined;

  // Skip failed sends
  if (success === false) {
    return;
  }

  // Skip empty content
  if (!content || content.trim().length === 0) {
    return;
  }

  // Skip heartbeat messages
  if (isHeartbeat(content)) {
    return;
  }

  // Look up the cached user message for this conversation
  const key = channelId
    ? conversationKey(channelId, context.conversationId as string | undefined)
    : undefined;
  const userMessage = key ? lastUserMessage.get(key) : undefined;

  // Clear the cache entry
  if (key) {
    lastUserMessage.delete(key);
  }

  // Fire and forget — do not await
  try {
    postToNeuralScape(userMessage, content);
  } catch (err) {
    log.debug("Failed to post to NeuralScape", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default neuralscapeMemoryHandler;
