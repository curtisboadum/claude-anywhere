# claude-anywhere

**Drive Claude Code from your phone.** Run real, full-power Claude Code sessions on
your Mac by messaging a Telegram bot — with every session isolated in its own git
worktree, so nothing collides and nothing touches your main checkout until you open
a PR.

> A hardened, security-reviewed packaging of the excellent
> [op7418/Claude-to-IM](https://github.com/op7418/Claude-to-IM) bridge (MIT). See
> [Credits](#credits) and [docs/SECURITY.md](docs/SECURITY.md).

---

## Why

- **Your real dev environment, from anywhere.** It's the actual `claude` CLI running
  on your machine — your files, your tools, your auth. Not a toy chatbot.
- **Safe by construction.** Each session runs in a throwaway git worktree
  (`.cti-worktrees/<repo>-<id>` on its own branch). Edits land there; your main
  checkout stays clean. You merge via a PR when you're happy.
- **Locked to you.** Fail-closed allowlist — only your Telegram user id can talk to it.
- **Hands-off or hands-on.** Auto mode runs tasks without asking; `/mode ask` puts
  approve/deny buttons back. Toggle from the chat.

## 60-second install

```bash
git clone https://github.com/curtisboadum/claude-anywhere
cd claude-anywhere
./install.sh
```

That builds everything, registers the skill, installs the `claude-anywhere` CLI, and
drops a starter config at `~/.claude-to-im/config.env`.

**Requirements:** macOS or Linux · Node.js ≥ 20 · the
[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (logged in), or set
`CTI_RUNTIME=codex`.

## Connect Telegram (2 minutes)

1. **Make a bot.** In Telegram, message **@BotFather** → `/newbot` → copy the token.
2. **Configure.** Edit `~/.claude-to-im/config.env`:
   ```ini
   CTI_TG_BOT_TOKEN=123456:AA...           # from BotFather
   CTI_DEFAULT_WORKDIR=/path/to/a/git/repo # MUST be a git repo
   ```
3. **Get your id.** Message your new bot once ("hi"), then:
   ```bash
   claude-anywhere whoami
   ```
   Paste the printed id into **both** `CTI_TG_CHAT_ID` and `CTI_TG_ALLOWED_USERS`.
4. **Go.**
   ```bash
   claude-anywhere start
   ```
   Message your bot. Send a task. Watch it work. Type `/help` in the chat for commands.

## Using it from Telegram

Just talk to the bot — anything you'd type into Claude Code. You'll see streaming
replies and tool activity, plus a context meter under each reply:

> `— context ~48.3k / 200k (24%) · out 1.2k`

**Slash commands** (also in Telegram's native `/` menu):

| Command | Does |
|---|---|
| `/new [path]` | Start a fresh session (new worktree, empty context) |
| `/mode code\|ask\|plan` | Switch mode (see below) |
| `/status` | Session, working dir, mode, model |
| `/sessions` | List recent sessions |
| `/cwd /path` | Change working directory |
| `/stop` | Abort the running task |
| `/bind <id>` | Reattach to a session |
| `/help` | Full list |

**Modes:**
- **`code`** — autonomous. Runs tools without asking. *(Auto mode.)*
- **`ask`** — confirm each tool with Allow / Deny buttons.
- **`plan`** — planning / read-only-ish.

`/mode` flips this live from your phone.

## Maximizing outputs

- **Point `CTI_DEFAULT_WORKDIR` at the repo you actually work in.** Each session
  worktrees it, so you can run several tasks in parallel without conflicts.
- **Use `code` mode for momentum, `ask` for risky changes.** Flip per-task with `/mode`.
- **Watch the context meter; `/new` when it climbs past ~70%.** A fresh session is
  faster and sharper than a bloated one. (The model also auto-compacts at the limit.)
- **Run tasks in parallel.** Start one, `/new`, start another — different worktrees,
  no collisions. (Default cap: 3 concurrent — raise with `CTI_MAX_CONCURRENT`.)
- **Send screenshots.** Photos go to Claude's vision — great for "fix this UI" or
  pasting an error.
- **Be specific and outcome-oriented.** "Add X, run the tests, and open a PR" beats
  "look at X". It can finish the loop: edit → test → commit → PR from its branch.
- **Keep the Mac awake** if you're away — see below.

## Keep it reachable while you're away

The daemon survives reboots/crashes (it's registered with `launchd` on macOS). But
macOS **pauses background work while asleep**. To stay reachable from your phone,
keep the Mac awake:

```bash
caffeinate -dimsu     # leave this running; Ctrl-C to release
```

(or System Settings → Lock Screen / Battery → prevent automatic sleeping.)

## Managing it

```bash
claude-anywhere start | stop | restart | status
claude-anywhere logs 100      # tail logs (secrets redacted)
claude-anywhere doctor        # diagnostics
claude-anywhere whoami        # print your Telegram id (stop the daemon first)
```

## Tweaking the system

Everything lives in this folder:

```
claude-anywhere/
  Claude-to-IM/        ← bridge engine (adapters, routing, permissions)
  Claude-to-IM-skill/  ← this layer (worktree isolation, providers, config, security)
  bin/claude-anywhere  ← the CLI
  install.sh
  docs/
```

After editing source under `Claude-to-IM*/src`, rebuild and restart:

```bash
( cd Claude-to-IM-skill && npm run build ) && claude-anywhere restart
```

All the knobs (worktree TTL/limits, rate limits, context window, auto-approve,
session prompt) are documented in `Claude-to-IM-skill/config.env.example`.

## Other chat platforms

The underlying bridge also supports Discord, Feishu/Lark, QQ, and WeChat. Telegram is
the primary, hardened path here; see `config.env.example` for the others.

## Security

Remote-triggered code execution on your machine is inherently sensitive. This build
adds: fail-closed sender allowlist, owner-only state files (0600/0700) with a startup
migration, secret-redacted logs, auto-approve gated on mode + explicit ack, rate
limits + concurrency caps + session timeouts, worktree GC quotas, and permission
callback expiry. Full writeup: [docs/SECURITY.md](docs/SECURITY.md).

## Credits

Built on [op7418/Claude-to-IM](https://github.com/op7418/Claude-to-IM) and
[op7418/Claude-to-IM-skill](https://github.com/op7418/Claude-to-IM-skill) (MIT,
© op7418), vendored here with security hardening and worktree isolation. Upstream
licenses are preserved in each subdirectory; see [NOTICE](NOTICE). This packaging is
MIT — see [LICENSE](LICENSE).
