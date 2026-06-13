# Dev-harness setup (Telegram) — hardened build

This fork enforces **per-session git worktree isolation** in the bridge and adds
security hardening. It needs **two sibling repos** (the skill depends on the core
bridge engine via `file:../Claude-to-IM`).

## 1. Clone both repos as siblings

```bash
mkdir -p ~/Code/claude-to-im && cd ~/Code/claude-to-im
git clone https://github.com/op7418/Claude-to-IM
git clone https://github.com/op7418/Claude-to-IM-skill
```

Layout (required):

```
~/Code/claude-to-im/
  Claude-to-IM/        # core bridge engine
  Claude-to-IM-skill/  # this skill  (depends on ../Claude-to-IM)
```

## 2. Build (supply-chain-gated)

```bash
# Core first (scripts disabled, explicit build)
cd ~/Code/claude-to-im/Claude-to-IM
npm ci --ignore-scripts && npm run build && npm test

# Skill
cd ../Claude-to-IM-skill
npm ci --ignore-scripts && npm run build && npm run typecheck && npm test
```

## 3. Register with Claude Code

```bash
ln -s ~/Code/claude-to-im/Claude-to-IM-skill ~/.claude/skills/claude-to-im
```

## 4. Configure (Telegram)

Copy `config.env.example` to `~/.claude-to-im/config.env` (chmod 600) and set:

```ini
CTI_RUNTIME=claude
CTI_ENABLED_CHANNELS=telegram
CTI_TG_BOT_TOKEN=...            # from @BotFather — YOU enter this
CTI_TG_CHAT_ID=...             # your chat id
CTI_TG_ALLOWED_USERS=...       # your user id (required for safety)
CTI_DEFAULT_WORKDIR=/path/to/a/GIT/repo   # MUST be a git repo
CTI_DEFAULT_MODE=ask
```

Then start the daemon: `scripts/daemon.sh start` (or `/claude-to-im setup`).

## What this fork changes

**Worktree isolation (enforced, not requested).** Every IM session runs with its
`cwd` set to a unique git worktree (`<repoParent>/.cti-worktrees/<repo>-<id>` on
branch `cti/<id>`). Edits land there, never in the main checkout; the agent opens a
PR from its branch. A reinforcement system prompt restates this. Sessions are
**refused** if `CTI_DEFAULT_WORKDIR` is not a git repo. Worktrees are GC'd by
TTL/count/disk. See the `CTI_WORKTREE_*` knobs in `config.env.example`.

**Security.**
- State files/dirs are owner-only (0600/0700); startup migrates pre-existing loose
  modes and sets a private umask.
- Logs redact secrets (key/value, bare + URL-embedded Telegram tokens, Bearer).
- Auto-approve is refused outside plan mode unless `CTI_AUTO_APPROVE_ACK=i-understand`.
- Abuse controls: max-concurrent sessions, per-session rate limit, session timeout.
- Permission button clicks expire (`CTI_PERM_TTL_SEC`) and are bound to the
  requesting chat/message/user.
- The WeChat adapter is **fail-closed** (inert unless `CTI_WEIXIN_ALLOWED_USERS` is set).

See `SECURITY-NOTES.md` (repo parent) for the full audit + residual notes.
