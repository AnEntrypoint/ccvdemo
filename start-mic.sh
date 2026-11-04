#!/bin/sh
# Starts Claude Code for this project with only the mic MCP server loaded and its tools allowed. The server listens to
# this machine's output audio (MIC_LISTEN) and speaks replies into its microphone input (MIC_SPEAK). Built-in tools are
# off (--tools ""), no other MCP server is loaded (--strict-mcp-config), and utterances reach the session as channel
# events (server:mic).
set -eu
cd "$(dirname "$0")"

command -v claude >/dev/null 2>&1 || { echo "start-mic: claude is not on PATH" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "start-mic: node is not on PATH" >&2; exit 1; }

if [ ! -d mic-runner/node_modules/ccv ]; then
  (cd mic-runner && npm install)
fi
if [ ! -d .ccv/models/stt ]; then
  echo "start-mic: speech models not found in .ccv/models; the mic server will report them as failed" >&2
fi

# Extra arguments come first: the channel flag takes a list, so anything after it would be read as a server name.
exec claude "$@" \
  --strict-mcp-config \
  --mcp-config '{"mcpServers":{"mic":{"type":"stdio","command":"node","args":["mic-runner/index.mjs"]}}}' \
  --tools "" \
  --allowedTools mcp__mic \
  --dangerously-load-development-channels server:mic
