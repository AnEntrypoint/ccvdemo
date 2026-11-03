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
if [ "${engine:-paradee}" = chatterbox ]; then
  chatterbox_url="${CHATTERBOX_URL:-$(env_value CHATTERBOX_URL)}"
  chatterbox_url="${chatterbox_url:-http://127.0.0.1:8765}"
  node -e "fetch(process.argv[1], { signal: AbortSignal.timeout(3000) }).then(() => process.exit(0), () => process.exit(1))" "$chatterbox_url" \
    || { echo "start-discord: TTS=chatterbox but nothing answers at $chatterbox_url. Start the server first (cd nano_fast && python serve.py --port 8765), or unset TTS to use paradee." >&2; exit 1; }
fi
if [ ! -d discord-runner/node_modules/discord.js ] || [ ! -d discord-runner/node_modules/ccv ]; then
  (cd discord-runner && npm install)
fi
if [ ! -d .ccv/models/stt ]; then
  echo "start-discord: speech models not found in .ccv/models; the discord server will report them as failed" >&2
fi

# Extra arguments come first: the channel flag takes a list, so anything after it would be read as a server name.
exec claude "$@" \
  --strict-mcp-config \
  --mcp-config '{"mcpServers":{"discord":{"type":"stdio","command":"node","args":["discord-runner/index.mjs"]}}}' \
  --tools "" \
  --allowedTools mcp__discord \
  --dangerously-load-development-channels server:discord
