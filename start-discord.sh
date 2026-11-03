#!/bin/sh
# Starts Claude Code for this project with only the discord MCP server loaded and its tools allowed.
# Built-in tools are off (--tools ""), no other MCP server is loaded (--strict-mcp-config), and the
# server's utterances reach the session as channel events (server:discord).
set -eu
cd "$(dirname "$0")"

command -v claude >/dev/null 2>&1 || { echo "start-discord: claude is not on PATH" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "start-discord: node is not on PATH" >&2; exit 1; }

# The discord server reads .env itself, and a variable already set in the shell wins over .env.
env_value() {
  sed -n "s/^$1=//p" .env 2>/dev/null | tr -d '\r' | tail -n 1
}
[ -n "${DISCORD_TOKEN:-}" ] || [ -n "$(env_value DISCORD_TOKEN)" ] \
  || { echo "start-discord: DISCORD_TOKEN is not set in the environment or .env" >&2; exit 1; }
[ -n "${DISCORD_CHANNEL:-}" ] || [ -n "$(env_value DISCORD_CHANNEL)" ] \
  || { echo "start-discord: DISCORD_CHANNEL is not set in the environment or .env" >&2; exit 1; }

engine="${TTS:-$(env_value TTS)}"
chatterbox_pid=""
stop_chatterbox() {
  [ -z "$chatterbox_pid" ] || kill "$chatterbox_pid" 2>/dev/null || true
}
trap stop_chatterbox EXIT
trap 'exit 130' INT TERM
if [ "${engine:-paradee}" = chatterbox ]; then
  chatterbox_url="${CHATTERBOX_URL:-$(env_value CHATTERBOX_URL)}"
  chatterbox_url="${chatterbox_url:-http://127.0.0.1:8765}"
  probe='fetch(process.argv[1], { signal: AbortSignal.timeout(3000) }).then(() => process.exit(0), () => process.exit(1))'
  if ! node -e "$probe" "$chatterbox_url"; then
    serve_dir="${CHATTERBOX_DIR:-$(env_value CHATTERBOX_DIR)}"
    serve_dir="${serve_dir:-../chatnano/nano_fast}"
    python_bin="${CHATTERBOX_PYTHON:-$(env_value CHATTERBOX_PYTHON)}"
    python_bin="${python_bin:-python3}"
    port="$(node -e 'console.log(new URL(process.argv[1]).port || 80)' "$chatterbox_url")"
    mkdir -p .discord
    echo "start-discord: starting Chatterbox-Nano on port $port (log: .discord/chatterbox.log)" >&2
    (cd "$serve_dir" && exec "$python_bin" serve.py --port "$port") > .discord/chatterbox.log 2>&1 &
    chatterbox_pid=$!
    waited=0
    until node -e "$probe" "$chatterbox_url"; do
      kill -0 "$chatterbox_pid" 2>/dev/null || { echo "start-discord: Chatterbox-Nano exited; see .discord/chatterbox.log" >&2; exit 1; }
      waited=$((waited + 1))
      [ "$waited" -lt 180 ] || { echo "start-discord: Chatterbox-Nano not ready after 180 s; see .discord/chatterbox.log" >&2; exit 1; }
      sleep 1
    done
  fi
fi
if [ ! -d discord-runner/node_modules/discord.js ] || [ ! -d discord-runner/node_modules/ccv ]; then
  (cd discord-runner && npm install)
fi
if [ ! -d .ccv/models/stt ]; then
  echo "start-discord: speech models not found in .ccv/models; the discord server will report them as failed" >&2
fi

# Extra arguments come first: the channel flag takes a list, so anything after it would be read as a server name.
status=0
claude "$@" \
  --strict-mcp-config \
  --mcp-config '{"mcpServers":{"discord":{"type":"stdio","command":"node","args":["discord-runner/index.mjs"]}}}' \
  --tools "" \
  --allowedTools mcp__discord \
  --dangerously-load-development-channels server:discord || status=$?
exit "$status"
