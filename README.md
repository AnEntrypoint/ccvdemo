# ccvdemo

Example Claude Code project that uses [ccv](https://github.com/AnEntrypoint/ccv) for realtime voice.

## Install

1. Launch this directory with `npx -y --package github:AnEntrypoint/ccv ccv-claude`. That wrapper starts Claude Code with `--dangerously-load-development-channels server:ccv`, which is what makes speech arrive on its own; plain `claude` still works, but the session has to call `voice_listen` to be woken by speech. Either way `.mcp.json` loads and starts `npx -y github:AnEntrypoint/ccv`.
2. Optional: copy `.env.example` to `.env` and set `HF_TOKEN` for faster model downloads.
3. Ask Claude to run `voice_setup`, then `voice_start`, then open http://127.0.0.1:8800/ and click join.

Models and LiveKit install into `.ccv/` in this directory (git-ignored).
