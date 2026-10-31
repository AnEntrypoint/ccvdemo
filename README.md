# ccvdemo

Example Claude Code project that uses [ccv](https://github.com/AnEntrypoint/ccv) for realtime voice.

## Install

1. Launch this directory with `npx -y --package github:AnEntrypoint/ccv ccv-claude`. That wrapper starts Claude Code with `--dangerously-load-development-channels server:ccv`, which is what makes speech arrive on its own; plain `claude` still works, but the session has to call `voice_listen` to be woken by speech. Either way `.mcp.json` loads and starts `npx -y github:AnEntrypoint/ccv`.
2. Optional: copy `.env.example` to `.env` and set `HF_TOKEN` for faster model downloads.
3. Ask Claude to run `voice_setup`, then `voice_start`, then open http://127.0.0.1:8800/ and click join.

Models and LiveKit install into `.ccv/` in this directory (git-ignored).

## WebRig runner

`webrig-runner/` is the Discord-free counterpart of `discord-runner/`. Instead of joining a
Discord voice channel itself, it connects to a running [WebRig](https://github.com/AnEntrypoint/webrig)
audio bridge over WebRig's audio WebSocket, so the WebRig instance keeps owning the page capture
and the voice connection.

1. Start WebRig with its Discord bot configured (`DISCORD_BOT_TOKEN`, `GUILD_ID`, `CHANNEL_ID`)
   and its audio WebSocket listening (`WS_AUDIO_PORT`, default 9888).
2. Run `node webrig-runner/index.mjs` (or `npm start` inside `webrig-runner/`). It loads the same
   ccv speech models, follows `.webrig/heard.jsonl`, and starts `chatjimmy-bridge.mjs` against it.
3. Replies are synthesized with ccv's TTS and sent back to WebRig as stereo Float32 AUDIO frames;
   WebRig plays them into the voice channel.

Configuration is the `WEBRIG_*` block in `.env.example`. Set `WEBRIG_BRIDGE=0` to run only the
audio bridge without the chatjimmy responder.
