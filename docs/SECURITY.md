# Security model

claude-anywhere runs **remote-triggered Claude Code on your machine**. That is
inherently sensitive, so this build hardens the bridge well beyond the upstream
defaults. Summary of what's enforced:

## Access control
- **Fail-closed sender allowlist.** Only ids in `CTI_TG_ALLOWED_USERS` (and/or
  `CTI_TG_CHAT_ID`) are accepted; with none set, the bridge denies everyone.
- **WeChat adapter is inert** unless an explicit `CTI_WEIXIN_ALLOWED_USERS` is set.

## Isolation
- **Per-session git worktree.** Every session runs with its `cwd` set to a unique
  worktree (`.cti-worktrees/<repo>-<id>` on branch `cti/<id>`), sibling to the repo,
  never nested. Edits cannot reach the main checkout; you merge via PR. Sessions are
  refused if the working dir isn't a git repo. Worktrees are GC'd by TTL / count /
  disk (`CTI_WORKTREE_*`).

## Approvals
- **Auto-approve is gated.** Off by default. Active only in `plan`/`code` modes, and
  `code`-mode auto requires `CTI_AUTO_APPROVE_ACK=i-understand`. `ask` mode always
  prompts. Enforced per-session, not just at startup.
- **Permission button clicks expire** (`CTI_PERM_TTL_SEC`, default 600s) and are
  bound to the originating chat + message (+ user, when wired). Single atomic claim
  prevents double-resolution.

## Abuse controls
- Global **max concurrent sessions** (`CTI_MAX_CONCURRENT`), per-session **rate limit**
  (`CTI_RATE_PER_MIN`), and **session timeout** (`CTI_SESSION_TIMEOUT_SEC`).

## Data at rest & logs
- State dirs/files are **owner-only** (`0700`/`0600`); a startup migration tightens
  any pre-existing loose modes, and the daemon runs under a private `umask`.
- Logs **redact secrets** — key/value pairs, bare and URL-embedded Telegram bot
  tokens, Bearer tokens.
- The bot token lives only in `~/.claude-to-im/config.env` (`0600`).

## Supply chain
- Vendored at pinned upstream commits; dependencies installed with
  `npm install --ignore-scripts` and an explicit build. Run `npm audit` in each
  subdir to review transitive advisories (the residual `axios` finding belongs to the
  optional Feishu SDK, which is dormant unless you enable that channel).

## Known limitations
- WeChat inbound messages carry no cryptographic signature (upstream protocol gap);
  the adapter is therefore disabled fail-closed.
- Same-user permission binding is enforced in the broker; threading the callback user
  id through the central router is a one-line follow-up (single-user DMs are already
  covered by chat+message+expiry binding).

## Reduce your exposure
- Prefer `ask` mode for anything you don't fully trust.
- Keep `CTI_DEFAULT_WORKDIR` pointed at a repo you're comfortable with an agent editing.
- Don't run the daemon on a shared/multi-user machine without reviewing the above.
