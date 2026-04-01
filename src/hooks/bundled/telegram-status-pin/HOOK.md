---
name: telegram-status-pin
description: "Maintain a pinned Telegram status card showing real-time agent progress and active tasks"
homepage: https://docs.openclaw.ai/automation/hooks#telegram-status-pin
metadata:
  {
    "openclaw":
      {
        "emoji": "📍",
        "events": ["message:received", "message:sent"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Telegram Status Pin Hook

Maintains a single pinned status message in Telegram chats that functions as a live task board, showing real-time progress when the agent is working.

## What It Does

### Hook-driven behaviour (message events)

When the user sends a message (`message:received`):

1. **Starts a 15-second timer** — avoids flicker for instant responses
2. **If agent hasn't replied within 15s** — sends/edits a pinned status card showing "Working..."
3. **Updates elapsed time** every 5 seconds

When the agent replies (`message:sent`):

1. **Cancels the pending timer** if the agent replied within 15s
2. **Deletes the status card** — unless named tasks are still active

### Programmatic API (multi-task tracking)

The hook exports two functions that can be called from other parts of the system:

```ts
import { trackTask, completeTask } from "./handler.js";

// Add a named task to the board
trackTask("5225642693", "cc-1", "Claude Code: fix telegram hook");

// Remove a task when it completes
completeTask("5225642693", "cc-1");
```

Both functions immediately re-render the pinned card. When no tasks remain and no general working state is active, the card is deleted.

## Status Card Formats

**Multiple named tasks active:**

```
⚙️ K.I.T.T. is working...

• Claude Code: fix telegram hook (45s)
• Web search: Tailscale pricing (12s)
```

**General working state (no named tasks, 15s timer fired):**

```
⚙️ Working... (23s)
```

## Requirements

- `TELEGRAM_BOT_TOKEN` environment variable set with a valid Telegram Bot API token
- The bot must have permission to pin messages in the target chat

## Skipped Messages

- Heartbeat messages (`HEARTBEAT_OK`)
- Non-Telegram channels
- Messages without a `conversationId`

## Disabling

```bash
openclaw hooks disable telegram-status-pin
```

Or in config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "telegram-status-pin": { "enabled": false }
      }
    }
  }
}
```
