---
name: telegram-status-pin
description: "Maintain a pinned Telegram status message showing real-time agent progress"
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

Maintains a single pinned status message in Telegram chats that shows real-time progress when the agent is working on long-running tasks.

## What It Does

When the user sends a message (`message:received`):

1. **Starts a 3-second timer** — avoids flicker for instant responses
2. **If agent hasn't replied within 3s** — sends/edits a pinned status message to show "Working..."
3. **Tracks start time** for duration calculation

When the agent replies (`message:sent`):

1. **Cancels the pending timer** if the agent replied within 3s
2. **Updates status to "Done"** with the elapsed duration
3. **After 10s of idle** — switches to "Standby" state

## Status Message States

**Working:**

```
⚙️ K.I.T.T. — Working
──────────────────────
⏳ Processing your request...
Started: 17:23:14
```

**Ready:**

```
⚙️ K.I.T.T. — Ready
──────────────────────
✅ Last response: 2s ago
```

**Standby:**

```
⚙️ K.I.T.T. — Standby
──────────────────────
💤 Waiting for input
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
