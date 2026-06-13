# Usage reference

## CLI (`claude-anywhere`)

| Command | Description |
|---|---|
| `start` | Start the daemon in the background (launchd on macOS). |
| `stop` | Stop the daemon. |
| `restart` | Restart to pick up config changes. |
| `status` | Running state, PID, channels. |
| `logs [N]` | Tail the last N log lines (secrets redacted). Default 50. |
| `whoami` | Print your Telegram chat id from recent bot messages. Stop the daemon first (it can't poll while running). |
| `config` | Print the config file path. |
| `doctor` | Run diagnostics (Node, CLI, config, token validity, daemon health). |

## In-chat commands (Telegram)

| Command | Description |
|---|---|
| `/new [path]` | Start a new session (optionally in another git repo path). New worktree, empty context. |
| `/mode code\|ask\|plan` | `code` = autonomous (auto mode), `ask` = confirm each tool, `plan` = planning. |
| `/status` | Current session, working dir, mode, model. |
| `/sessions` | List recent sessions. |
| `/cwd /path` | Change the working directory of the current session. |
| `/stop` | Abort the running task. |
| `/bind <id>` | Reattach to an existing session. |
| `/perm allow\|allow_session\|deny <id>` | Text fallback for approvals. |
| `1` / `2` / `3` | Quick approve/deny on platforms without buttons. |
| `/help` | Show all commands. |

## Key config (`~/.claude-to-im/config.env`)

```ini
# Core
CTI_RUNTIME=claude                  # claude | codex | auto
CTI_ENABLED_CHANNELS=telegram
CTI_DEFAULT_WORKDIR=/path/to/git/repo   # MUST be a git repo
CTI_DEFAULT_MODE=code               # code | ask | plan

# Telegram
CTI_TG_BOT_TOKEN=...
CTI_TG_CHAT_ID=...
CTI_TG_ALLOWED_USERS=...            # required (fail-closed)

# Auto mode (no prompts in code/plan; ask always prompts)
CTI_AUTO_APPROVE=true
CTI_AUTO_APPROVE_ACK=i-understand

# Worktree isolation
CTI_WORKTREE_TTL_HOURS=72
CTI_WORKTREE_MAX=20
CTI_WORKTREE_MAX_DISK_MB=5000
# CTI_WORKTREE_ISOLATION=false      # opt out (NOT recommended)

# Abuse controls
CTI_MAX_CONCURRENT=3
CTI_RATE_PER_MIN=20
CTI_SESSION_TIMEOUT_SEC=600

# Context meter under replies
# CTI_CONTEXT_FOOTER=false          # turn the footer off
# CTI_CONTEXT_WINDOW=200000
```

The full annotated list lives in `Claude-to-IM-skill/config.env.example`.

## Tips

- Edit source under `Claude-to-IM*/src`, then `( cd Claude-to-IM-skill && npm run build ) && claude-anywhere restart`.
- Run the test suites: `( cd Claude-to-IM-skill && npm test )` and `( cd Claude-to-IM && npm test )`.
- Keep the Mac awake to stay reachable: `caffeinate -dimsu`.
