# idle-notify

Pi extension that sends a `notify-send` desktop notification when the agent becomes idle.

## What it does

- sends a notification on `agent_end`
- includes the current working directory
- uses different emojis for:
  - `✅` idle and done
  - `❓` idle and waiting for your answer

## Files

- `idle-notify/index.ts`

## Notes

The icon and title are decided from the last assistant message contents.

It now uses a cheap, fast nested `pi -p` classifier call that returns only:
- `WAITING`
- `DONE`

If that classifier fails, it falls back to a simple text heuristic.

Subagent processes are skipped by checking `PI_SUBAGENT_DEPTH > 0`, so only the main agent sends desktop notifications.

The notification body only shows the directory.

## Optional env vars

- `PI_IDLE_NOTIFY_MODEL` - override the classifier model
- `PI_IDLE_NOTIFY_TIMEOUT_MS` - classifier timeout
- `PI_IDLE_NOTIFY_NOTIFICATION_TIMEOUT_MS` - how long the desktop notification stays visible (default `60000`)
- `PI_IDLE_NOTIFY_MAX_MESSAGE_CHARS` - truncate very long assistant messages before classification
- `PI_IDLE_NOTIFY_DISABLED=1` - disable notifications