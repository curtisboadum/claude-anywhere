#!/usr/bin/env bash
# claude-anywhere installer — build, register, and prep config in one shot.
# Usage:  ./install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="$ROOT/Claude-to-IM"
SKILL="$ROOT/Claude-to-IM-skill"
CTI_HOME="${CTI_HOME:-$HOME/.claude-to-im}"
SKILLS_DIR="$HOME/.claude/skills"
LINK="$SKILLS_DIR/claude-anywhere"

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

say "claude-anywhere installer"

# ── 1. Prerequisites ──
command -v git  >/dev/null || die "git is required."
command -v node >/dev/null || die "Node.js >= 20 is required (https://nodejs.org)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js >= 20 required (found $(node -v))."
if command -v claude >/dev/null; then
  ok "Claude CLI: $(claude --version 2>/dev/null | head -1)"
else
  warn "Claude Code CLI not found on PATH. Install it: https://docs.anthropic.com/en/docs/claude-code"
  warn "(You can also set CTI_RUNTIME=codex to use Codex instead.)"
fi

# ── 2. Build the core (scripts disabled, explicit build) ──
say "Building bridge core…"
( cd "$CORE" && npm install --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null )
ok "core built"

# ── 3. Build the skill ──
say "Building skill…"
( cd "$SKILL" && npm install --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null )
ok "skill built (dist/daemon.mjs)"

# ── 4. Register with Claude Code (optional, non-fatal) ──
mkdir -p "$SKILLS_DIR"
if [ -L "$LINK" ] || [ -e "$LINK" ]; then
  warn "skill link already exists at $LINK (left as-is)"
else
  ln -s "$SKILL" "$LINK" && ok "linked into Claude Code skills: $LINK"
fi

# ── 5. CLI on PATH ──
chmod +x "$ROOT/bin/claude-anywhere"
BIN_TARGET=""
if [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
  BIN_TARGET="/usr/local/bin/claude-anywhere"
else
  mkdir -p "$HOME/.local/bin" && BIN_TARGET="$HOME/.local/bin/claude-anywhere"
fi
if [ -n "$BIN_TARGET" ] && ln -sf "$ROOT/bin/claude-anywhere" "$BIN_TARGET" 2>/dev/null; then
  ok "CLI installed: $BIN_TARGET"
  case ":$PATH:" in
    *":$(dirname "$BIN_TARGET"):"*) :;;
    *) warn "$(dirname "$BIN_TARGET") is not on your PATH. Add to your shell rc:  export PATH=\"$(dirname "$BIN_TARGET"):\$PATH\"";;
  esac
else
  warn "Could not install the CLI — run it directly: $ROOT/bin/claude-anywhere"
fi

# ── 6. Seed config ──
mkdir -p "$CTI_HOME"; chmod 700 "$CTI_HOME"
if [ ! -f "$CTI_HOME/config.env" ]; then
  umask 077
  cp "$SKILL/config.env.example" "$CTI_HOME/config.env"
  chmod 600 "$CTI_HOME/config.env"
  ok "starter config: $CTI_HOME/config.env"
  CONFIG_FRESH=1
else
  warn "existing config kept: $CTI_HOME/config.env"
fi

cat <<EOF

$(ok "Install complete.")

Next steps (Telegram):
  1. Create a bot:  message @BotFather → /newbot → copy the token
  2. Edit your config:  \$EDITOR $CTI_HOME/config.env
       CTI_TG_BOT_TOKEN=...          (from BotFather)
       CTI_DEFAULT_WORKDIR=/path/to/a/GIT/repo
  3. Get your chat id:  message your new bot once, then run:
       claude-anywhere whoami
     and paste the printed id into CTI_TG_CHAT_ID and CTI_TG_ALLOWED_USERS.
  4. Start it:  claude-anywhere start
  5. Message your bot from your phone.  Type /help in the chat for commands.

Full guide:  $ROOT/README.md   ·   $ROOT/docs/USAGE.md
EOF
