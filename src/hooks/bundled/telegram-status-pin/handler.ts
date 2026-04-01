/**
 * Telegram Status Pin hook handler
 *
 * Maintains a single pinned "status" message in Telegram chats that shows
 * real-time progress when the agent is doing long-running work. Only shows
 * a status card if no reply arrives within 15 seconds. Deletes the status
 * message on completion.
 */

import https from "node:https";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("hooks/telegram-status-pin");

const TELEGRAM_API_BASE = "https://api.telegram.org";
const WORK_DELAY_MS = 15_000;
const ELAPSED_INTERVAL_MS = 5_000;

interface StatusState {
  chatId: string;
  messageId?: number;
  pendingTimer?: ReturnType<typeof setTimeout>;
  elapsedTimer?: ReturnType<typeof setInterval>;
  startedAt?: Date;
}

const statusByChatId = new Map<string, StatusState>();

function getBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
}

function isHeartbeat(content: string): boolean {
  return content === "HEARTBEAT_OK" || content.startsWith("HEARTBEAT_OK");
}

function workingText(startedAt: Date): string {
  const elapsedSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
  if (elapsedSeconds < 5) {
    return "\u2699\uFE0F Working...";
  }
  return `\u2699\uFE0F Working... (${elapsedSeconds}s)`;
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

async function sendStatusMessage(
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

  if (channelId !== "telegram") {
    return;
  }

  const content = context.content as string | undefined;

  if (content && isHeartbeat(content)) {
    return;
  }

  const token = getBotToken();
  if (!token) {
    return;
  }

  const rawId = context.conversationId as string | undefined;
  const chatId = rawId?.startsWith("telegram:") ? rawId.slice("telegram:".length) : rawId;
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

function clearTimers(state: StatusState): void {
  if (state.pendingTimer) {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = undefined;
  }
  if (state.elapsedTimer) {
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = undefined;
  }
}

function handleReceived(token: string, chatId: string): void {
  let state = statusByChatId.get(chatId);
  if (!state) {
    state = { chatId };
    statusByChatId.set(chatId, state);
  }

  clearTimers(state);

  state.startedAt = new Date();

  // Only show status if no reply arrives within 15s
  state.pendingTimer = setTimeout(() => {
    state.pendingTimer = undefined;
    const startedAt = state.startedAt ?? new Date();

    sendStatusMessage(token, chatId, workingText(startedAt), state.messageId).then(
      (msgId) => {
        if (msgId !== undefined) {
          state.messageId = msgId;
        }

        // Start updating elapsed time every 5s
        state.elapsedTimer = setInterval(() => {
          sendStatusMessage(token, chatId, workingText(startedAt), state.messageId).then(
            (updatedId) => {
              if (updatedId !== undefined) {
                state.messageId = updatedId;
              }
            },
            (err) => {
              log.debug("Failed to update elapsed time", {
                error: err instanceof Error ? err.message : String(err),
              });
            },
          );
        }, ELAPSED_INTERVAL_MS);
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

  clearTimers(state);

  if (state.messageId) {
    await callTelegramApi(token, "deleteMessage", {
      chat_id: chatId,
      message_id: state.messageId,
    }).catch(() => {
      // Swallow delete failures silently
    });
  }

  statusByChatId.delete(chatId);
}

export default telegramStatusPinHandler;

// Exported for testing
export { statusByChatId, WORK_DELAY_MS, ELAPSED_INTERVAL_MS };
