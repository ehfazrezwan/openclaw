/**
 * Telegram Status Pin hook handler
 *
 * Maintains a single pinned "status" message in Telegram chats that shows
 * real-time progress when the agent is doing long-running work. On
 * message:received (after a 3s delay) the status updates to "Working...".
 * On message:sent it switches to "Done" and then "Standby" after 10s.
 */

import https from "node:https";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("hooks/telegram-status-pin");

const TELEGRAM_API_BASE = "https://api.telegram.org";
const WORK_DELAY_MS = 3_000;
const STANDBY_DELAY_MS = 10_000;
const AGENT_NAME = "K.I.T.T.";

interface StatusState {
  chatId: string;
  messageId?: number;
  pendingTimer?: ReturnType<typeof setTimeout>;
  completionTimer?: ReturnType<typeof setTimeout>;
  startedAt?: Date;
}

const statusByChatId = new Map<string, StatusState>();

function getBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
}

function isHeartbeat(content: string): boolean {
  return content === "HEARTBEAT_OK" || content.startsWith("HEARTBEAT_OK");
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function workingText(startedAt: Date): string {
  return [
    `⚙️ ${AGENT_NAME} — Working`,
    "──────────────────────",
    "⏳ Processing your request...",
    `Started: ${formatTime(startedAt)}`,
  ].join("\n");
}

function doneText(durationSeconds: number): string {
  return [
    `⚙️ ${AGENT_NAME} — Ready`,
    "──────────────────────",
    `✅ Last response: ${durationSeconds}s ago`,
  ].join("\n");
}

function standbyText(): string {
  return [`⚙️ ${AGENT_NAME} — Standby`, "──────────────────────", "💤 Waiting for input"].join(
    "\n",
  );
}

// ---------------------------------------------------------------------------
// Telegram Bot API helpers (direct HTTPS, no external dependencies)
// ---------------------------------------------------------------------------

type TelegramApiResult = { ok: boolean; result?: { message_id?: number } };

function callTelegramApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramApiResult> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const url = new URL(`/bot${token}/${method}`, TELEGRAM_API_BASE);

    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString()) as TelegramApiResult;
            resolve(json);
          } catch {
            resolve({ ok: false });
          }
        });
      },
    );

    req.on("error", (err) => {
      log.debug("Telegram API error", { method, error: err.message });
      resolve({ ok: false });
    });

    req.on("timeout", () => {
      req.destroy();
      log.debug("Telegram API timeout", { method });
      resolve({ ok: false });
    });

    req.write(payload);
    req.end();
  });
}

async function sendOrEditStatus(
  token: string,
  chatId: string,
  text: string,
  existingMessageId?: number,
): Promise<number | undefined> {
  if (existingMessageId) {
    const res = await callTelegramApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: existingMessageId,
      text,
    });
    if (res.ok) {
      return existingMessageId;
    }
    // If edit fails (message deleted etc.), fall through to send a new one
    log.debug("editMessageText failed, sending new message", { chatId });
  }

  const res = await callTelegramApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    disable_notification: true,
  });

  const messageId = res.result?.message_id;
  if (res.ok && messageId) {
    // Pin the message silently
    await callTelegramApi(token, "pinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true,
    });
    return messageId;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Hook handler
// ---------------------------------------------------------------------------

const telegramStatusPinHandler: HookHandler = async (event) => {
  if (event.type !== "message") {
    return;
  }

  const context = event.context || {};
  const channelId = context.channelId as string | undefined;

  // Only handle Telegram channels
  if (channelId !== "telegram") {
    return;
  }

  const content = context.content as string | undefined;

  // Skip heartbeat messages
  if (content && isHeartbeat(content)) {
    return;
  }

  const token = getBotToken();
  if (!token) {
    return;
  }

  const chatId = context.conversationId as string | undefined;
  if (!chatId) {
    return;
  }

  if (event.action === "received") {
    handleReceived(token, chatId);
    return;
  }

  if (event.action === "sent") {
    await handleSent(token, chatId);
    return;
  }
};

function handleReceived(token: string, chatId: string): void {
  let state = statusByChatId.get(chatId);
  if (!state) {
    state = { chatId };
    statusByChatId.set(chatId, state);
  }

  // Clear any existing completion timer (we got a new message while in "Done" state)
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = undefined;
  }

  // Clear any existing pending timer
  if (state.pendingTimer) {
    clearTimeout(state.pendingTimer);
  }

  state.startedAt = new Date();

  // Set a 3s delay — if the agent hasn't replied by then, show "Working..."
  state.pendingTimer = setTimeout(() => {
    state.pendingTimer = undefined;
    const startedAt = state.startedAt ?? new Date();
    sendOrEditStatus(token, chatId, workingText(startedAt), state.messageId).then(
      (msgId) => {
        if (msgId !== undefined) {
          state.messageId = msgId;
        }
      },
      (err) => {
        log.debug("Failed to send working status", {
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }, WORK_DELAY_MS);
}

async function handleSent(token: string, chatId: string): Promise<void> {
  const state = statusByChatId.get(chatId);
  if (!state) {
    return;
  }

  // Cancel pending "Working..." timer if agent replied quickly
  if (state.pendingTimer) {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = undefined;
  }

  // Clear any existing completion timer
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = undefined;
  }

  // If we never showed a status message, no need to update
  if (!state.messageId) {
    state.startedAt = undefined;
    return;
  }

  // Calculate duration
  const durationSeconds = state.startedAt
    ? Math.round((Date.now() - state.startedAt.getTime()) / 1000)
    : 0;
  state.startedAt = undefined;

  // Edit to "Done"
  const msgId = await sendOrEditStatus(token, chatId, doneText(durationSeconds), state.messageId);
  if (msgId !== undefined) {
    state.messageId = msgId;
  }

  // After 10s, switch to "Standby"
  state.completionTimer = setTimeout(() => {
    state.completionTimer = undefined;
    sendOrEditStatus(token, chatId, standbyText(), state.messageId).then(
      (msgId) => {
        if (msgId !== undefined) {
          state.messageId = msgId;
        }
      },
      (err) => {
        log.debug("Failed to send standby status", {
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }, STANDBY_DELAY_MS);
}

export default telegramStatusPinHandler;

// Exported for testing
export { statusByChatId, WORK_DELAY_MS, STANDBY_DELAY_MS };
