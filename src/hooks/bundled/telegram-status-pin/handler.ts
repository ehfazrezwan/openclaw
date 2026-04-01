/**
 * Telegram Status Pin hook handler
 *
 * Maintains a single pinned "status" message in Telegram chats that shows
 * real-time progress when the agent is doing long-running work. Functions
 * as a live task board — multiple named tasks can be tracked simultaneously.
 *
 * Hook behaviour (message:received / message:sent):
 *   - On received: starts a 15s pending timer. If no reply arrives, shows
 *     a generic "Working..." card.
 *   - On sent: cancels the pending timer and cleans up (if no named tasks
 *     are active).
 *
 * Programmatic API (trackTask / completeTask):
 *   - trackTask(chatId, taskId, label)  — adds a named task entry
 *   - completeTask(chatId, taskId)      — removes a named task entry
 *   Both immediately re-render the pinned card. When no tasks remain and
 *   no general working state is active, the card is deleted.
 */

import https from "node:https";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("hooks/telegram-status-pin");

const TELEGRAM_API_BASE = "https://api.telegram.org";
const WORK_DELAY_MS = 15_000;
const ELAPSED_INTERVAL_MS = 5_000;
/** Maximum lifetime for a persistent task before auto-cleanup (safety net). */
const TASK_TIMEOUT_MS = 30 * 60 * 1000;
/** Grace period after handleSent: force-clean orphaned tasks if still present. */
const SENT_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

interface TaskEntry {
  label: string;
  startedAt: Date;
  /** Safety-net timer: auto-completes the task after TASK_TIMEOUT_MS. */
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

interface ChatStatus {
  chatId: string;
  messageId?: number;
  /** True while a sendMessage call is in-flight (prevents duplicate creates) */
  sendInFlight?: boolean;
  pendingTimer?: ReturnType<typeof setTimeout>;
  elapsedTimer?: ReturnType<typeof setInterval>;
  /** General "working" start time — set when pendingTimer fires */
  workingStartedAt?: Date;
  /** Named tasks currently active (persistent tools like sessions_spawn) */
  tasks: Map<string, TaskEntry>;
  /** Latest ephemeral tool action (replaces previous, never accumulates) */
  currentAction?: { taskId: string; label: string; startedAt: Date };
  /** Grace timer: force-cleans orphaned tasks shortly after handleSent */
  sentGraceTimer?: ReturnType<typeof setTimeout>;
}

const statusByChatId = new Map<string, ChatStatus>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
}

function isHeartbeat(content: string): boolean {
  return content === "HEARTBEAT_OK" || content.startsWith("HEARTBEAT_OK");
}

function formatElapsed(startedAt: Date): string {
  const seconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

/**
 * Build the status card text from current state.
 *
 * Two-tier rendering:
 * - Persistent tasks (sessions_spawn): shown as bullet points that persist
 * - Ephemeral current action: shown as a single line with wrench prefix
 * - If neither exists, fall back to generic "Working..." line
 */
function renderCard(state: ChatStatus): string {
  const lines: string[] = [];
  const hasPersistentTasks = state.tasks.size > 0;
  const hasCurrentAction = state.currentAction !== undefined;

  if (hasPersistentTasks || hasCurrentAction) {
    lines.push("\u2699\uFE0F K.I.T.T. is working...");

    if (hasPersistentTasks) {
      lines.push("");
      for (const entry of state.tasks.values()) {
        lines.push(`\u2022 ${entry.label} (${formatElapsed(entry.startedAt)})`);
      }
    }

    if (hasCurrentAction) {
      lines.push(
        `\uD83D\uDD27 ${state.currentAction!.label} (${formatElapsed(state.currentAction!.startedAt)})`,
      );
    }
  } else if (state.workingStartedAt) {
    const elapsed = formatElapsed(state.workingStartedAt);
    const seconds = Math.round((Date.now() - state.workingStartedAt.getTime()) / 1000);
    if (seconds < 5) {
      lines.push("\u2699\uFE0F Working...");
    } else {
      lines.push(`\u2699\uFE0F Working... (${elapsed})`);
    }
  }

  return lines.join("\n");
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
  state: ChatStatus,
  text: string,
): Promise<number | undefined> {
  if (state.messageId) {
    const res = await callTelegramApi(token, "editMessageText", {
      chat_id: state.chatId,
      message_id: state.messageId,
      text,
    });
    if (res.ok) {
      return state.messageId;
    }
    // If edit fails (message deleted etc.), fall through to send a new one
    log.debug("editMessageText failed, sending new message", { chatId: state.chatId });
  }

  // Guard: if another call is already creating a new message, skip to avoid duplicates
  if (state.sendInFlight) {
    return undefined;
  }

  state.sendInFlight = true;
  try {
    const res = await callTelegramApi(token, "sendMessage", {
      chat_id: state.chatId,
      text,
      disable_notification: true,
    });

    const messageId = res.result?.message_id;
    if (res.ok && messageId) {
      state.messageId = messageId;
      await callTelegramApi(token, "pinChatMessage", {
        chat_id: state.chatId,
        message_id: messageId,
        disable_notification: true,
      });
      return messageId;
    }

    return undefined;
  } finally {
    state.sendInFlight = false;
  }
}

async function deleteStatusMessage(token: string, state: ChatStatus): Promise<void> {
  if (state.messageId) {
    await callTelegramApi(token, "deleteMessage", {
      chat_id: state.chatId,
      message_id: state.messageId,
    }).catch(() => {
      // Swallow delete failures silently
    });
    state.messageId = undefined;
  }
}

// ---------------------------------------------------------------------------
// Shared rendering helpers
// ---------------------------------------------------------------------------

function ensureElapsedTimer(token: string, state: ChatStatus): void {
  if (state.elapsedTimer) {
    return;
  }

  state.elapsedTimer = setInterval(() => {
    rerender(token, state).catch((err) => {
      log.debug("Failed to update elapsed time", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, ELAPSED_INTERVAL_MS);
}

/**
 * Re-render the card for a given chatId.
 * Creates the pinned message if needed, or deletes it if nothing to show.
 */
async function rerenderImpl(token: string, state: ChatStatus): Promise<void> {
  const hasWork =
    state.tasks.size > 0 ||
    state.workingStartedAt !== undefined ||
    state.currentAction !== undefined;

  if (!hasWork) {
    clearTimers(state);
    await deleteStatusMessage(token, state);
    statusByChatId.delete(state.chatId);
    return;
  }

  const text = renderCard(state);
  await sendStatusMessage(token, state, text);
  ensureElapsedTimer(token, state);
}

/** Per-chatId mutex to prevent concurrent rerender race conditions. */
const rerenderLocks = new Map<string, Promise<void>>();

async function rerender(token: string, state: ChatStatus): Promise<void> {
  const chatId = state.chatId;
  const prev = rerenderLocks.get(chatId) ?? Promise.resolve();
  const next = prev.then(() => rerenderImpl(token, state)).catch(() => {});
  rerenderLocks.set(chatId, next);
  await next;
}

// ---------------------------------------------------------------------------
// Timer helpers
// ---------------------------------------------------------------------------

function clearTimers(state: ChatStatus): void {
  if (state.pendingTimer) {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = undefined;
  }
  if (state.elapsedTimer) {
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = undefined;
  }
  // Clear safety-net timeouts for all tracked tasks
  for (const task of state.tasks.values()) {
    if (task.timeoutTimer) {
      clearTimeout(task.timeoutTimer);
      task.timeoutTimer = undefined;
    }
  }
  if (state.sentGraceTimer) {
    clearTimeout(state.sentGraceTimer);
    state.sentGraceTimer = undefined;
  }
}

// ---------------------------------------------------------------------------
// Programmatic API — trackTask / completeTask
// ---------------------------------------------------------------------------

function getOrCreateState(chatId: string): ChatStatus {
  let state = statusByChatId.get(chatId);
  if (!state) {
    state = { chatId, tasks: new Map() };
    statusByChatId.set(chatId, state);
  }
  return state;
}

/**
 * Add a named task to the board for a given chatId.
 * Immediately re-renders the pinned message.
 */
function trackTask(chatId: string, taskId: string, label: string): void {
  const token = getBotToken();
  if (!token) {
    return;
  }

  const state = getOrCreateState(chatId);

  // Safety-net timeout: auto-complete the task if completeTask is never called
  const timeoutTimer = setTimeout(() => {
    log.debug("Task timeout — auto-completing orphaned task", { chatId, taskId });
    completeTask(chatId, taskId);
  }, TASK_TIMEOUT_MS);

  state.tasks.set(taskId, { label, startedAt: new Date(), timeoutTimer });

  rerender(token, state).catch((err) => {
    log.debug("Failed to re-render after trackTask", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Remove a named task from the board (called when a persistent task completes).
 * Immediately re-renders the pinned message. If no tasks remain and
 * no general working state is active, deletes the message.
 */
function completeTask(chatId: string, taskId: string): void {
  const token = getBotToken();
  if (!token) {
    return;
  }

  const state = statusByChatId.get(chatId);
  if (!state) {
    return;
  }

  // Clear the safety-net timeout for this task
  const task = state.tasks.get(taskId);
  if (task?.timeoutTimer) {
    clearTimeout(task.timeoutTimer);
  }

  state.tasks.delete(taskId);

  // Clear the sent grace timer — task completed normally
  if (state.sentGraceTimer) {
    clearTimeout(state.sentGraceTimer);
    state.sentGraceTimer = undefined;
  }

  // Auto-delete immediately when nothing remains
  if (state.tasks.size === 0 && !state.currentAction && !state.workingStartedAt) {
    clearTimers(state);
    deleteStatusMessage(token, state).catch(() => {});
    statusByChatId.delete(chatId);
    return;
  }

  rerender(token, state).catch((err) => {
    log.debug("Failed to re-render after completeTask", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Set the current ephemeral action (replaces any previous one).
 * Immediately re-renders the pinned card.
 */
function setCurrentAction(chatId: string, taskId: string, label: string): void {
  const token = getBotToken();
  if (!token) {
    return;
  }

  const state = getOrCreateState(chatId);
  state.currentAction = { taskId, label, startedAt: new Date() };

  rerender(token, state).catch((err) => {
    log.debug("Failed to re-render after setCurrentAction", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Clear the current ephemeral action, but only if taskId matches.
 * A newer action that already replaced this one is left untouched.
 */
function clearCurrentAction(chatId: string, taskId: string): void {
  const token = getBotToken();
  if (!token) {
    return;
  }

  const state = statusByChatId.get(chatId);
  if (!state) {
    return;
  }

  if (state.currentAction?.taskId !== taskId) {
    return;
  }

  state.currentAction = undefined;

  // Auto-delete immediately when nothing remains
  if (state.tasks.size === 0 && !state.workingStartedAt) {
    clearTimers(state);
    deleteStatusMessage(token, state).catch(() => {});
    statusByChatId.delete(chatId);
    return;
  }

  rerender(token, state).catch((err) => {
    log.debug("Failed to re-render after clearCurrentAction", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// ---------------------------------------------------------------------------
// Hook handler (message:received / message:sent)
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

function handleReceived(token: string, chatId: string): void {
  const state = getOrCreateState(chatId);

  // Clear the pending timer (but NOT the elapsed timer — named tasks may
  // already be updating it).
  if (state.pendingTimer) {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = undefined;
  }

  // Only show the generic "Working..." card if no reply arrives within 15s
  state.pendingTimer = setTimeout(() => {
    state.pendingTimer = undefined;
    state.workingStartedAt = new Date();

    rerender(token, state).catch((err) => {
      log.debug("Failed to send working status", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, WORK_DELAY_MS);
}

async function handleSent(token: string, chatId: string): Promise<void> {
  const state = statusByChatId.get(chatId);
  if (!state) {
    return;
  }

  // Clear the pending "working" timer
  if (state.pendingTimer) {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = undefined;
  }

  // Clear ephemeral state
  state.workingStartedAt = undefined;
  state.currentAction = undefined;

  // If persistent tasks are still active, re-render without the ephemeral
  // lines but keep the card alive for the tasks — but set a grace timer
  // to force-clean orphaned tasks if completeTask never arrives.
  if (state.tasks.size > 0) {
    if (state.sentGraceTimer) {
      clearTimeout(state.sentGraceTimer);
    }
    state.sentGraceTimer = setTimeout(() => {
      state.sentGraceTimer = undefined;
      // If tasks are still present, they're orphaned — force-clean them
      if (state.tasks.size > 0) {
        log.debug("Sent grace period expired — force-cleaning orphaned tasks", {
          chatId,
          taskCount: state.tasks.size,
        });
        // Clear all task timeout timers before wiping the map
        for (const task of state.tasks.values()) {
          if (task.timeoutTimer) {
            clearTimeout(task.timeoutTimer);
          }
        }
        state.tasks.clear();
        clearTimers(state);
        deleteStatusMessage(token, state).catch(() => {});
        statusByChatId.delete(chatId);
      }
    }, SENT_GRACE_MS);

    await rerender(token, state);
    return;
  }

  // No tasks and no working state — clean up entirely
  clearTimers(state);
  await deleteStatusMessage(token, state);
  statusByChatId.delete(chatId);
}

export default telegramStatusPinHandler;

// Exported for programmatic use
export { trackTask, completeTask, setCurrentAction, clearCurrentAction };

// Exported for testing
export {
  statusByChatId,
  WORK_DELAY_MS,
  ELAPSED_INTERVAL_MS,
  TASK_TIMEOUT_MS,
  SENT_GRACE_MS,
  renderCard,
  rerenderLocks,
};
