---
name: neuralscape-memory
description: "Send conversation exchanges to NeuralScape for meaningful memory extraction"
homepage: https://docs.openclaw.ai/automation/hooks#neuralscape-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["message:sent"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# NeuralScape Memory Hook

Sends conversation exchanges to NeuralScape after each agent reply for meaningful memory extraction.

## What It Does

When the agent sends a reply (`message:sent`):

1. **Captures the exchange** - Pairs the cached user message with the assistant's reply
2. **Sends to NeuralScape** - POSTs the message pair to `http://localhost:8199/v1/memories`
3. **Fire and forget** - Does not block message delivery; silently fails if NeuralScape is unavailable

NeuralScape's mem0 integration uses LLM to extract meaningful facts from the conversation — no raw event logging.

## Requirements

- NeuralScape running at `http://localhost:8199` (optional — hook silently skips if unavailable)

## Skipped Messages

- Heartbeat messages (`HEARTBEAT_OK`)
- Failed sends (`success: false`)

## Disabling

```bash
openclaw hooks disable neuralscape-memory
```

Or in config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "neuralscape-memory": { "enabled": false }
      }
    }
  }
}
```
