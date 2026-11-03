# ccvdemo

Example Claude Code project that uses [ccv](https://github.com/AnEntrypoint/ccv) for realtime voice.

## Install

1. Launch this directory with `npx -y --package github:AnEntrypoint/ccv ccv-claude`. That wrapper starts Claude Code with `--dangerously-load-development-channels server:ccv`, which is what makes speech arrive on its own; plain `claude` still works, but the session has to call `voice_listen` to be woken by speech. Either way `.mcp.json` loads and starts `npx -y github:AnEntrypoint/ccv`.
2. Optional: copy `.env.example` to `.env` and set `HF_TOKEN` for faster model downloads.
3. Ask Claude to run `voice_setup`, then `voice_start`, then open http://127.0.0.1:8800/ and click join.
4. For the chatjimmy scripts (`start.mjs`, `chatjimmy-bridge.mjs`), run `npm install` in this directory once. Then `npm start` runs `start.mjs`, which starts the voice stack with `voice_start` and then the chatjimmy bridge.

Models and LiveKit install into `.ccv/` in this directory (git-ignored).

## Speech output

Both runners speak with ccv's TTS. `TTS=paradee` (the default) uses the Paradee model in `.ccv/models/tts`. `TTS=chatterbox` streams speech from the Chatterbox-Nano server at `CHATTERBOX_URL` (default `http://127.0.0.1:8765`). That server is `serve.py` in chatnano's `nano_fast/` (`python serve.py --port 8765`), and it must be running before the runner starts. If it does not answer at startup, the runner logs that and speaks with Paradee instead.

## Discord

Set `DISCORD_TOKEN` and `DISCORD_CHANNEL` (a voice channel URL or ID) in `.env`, then start Claude Code from this directory with `claude --dangerously-load-development-channels server:discord`. Claude Code launches the `discord` MCP server from `.mcp.json`, which joins the voice channel, transcribes speech with ccv's models, and delivers each utterance to the session. Replies go out with `discord_speak`. Without the flag, call `discord_listen` to wait for speech. `./start-discord.sh` does the same launch with only the discord server loaded, built-in tools off, and only its tools allowed.

## WebRig runner

`webrig-runner/` is the Discord-free counterpart of `discord-runner/`. Instead of joining a
Discord voice channel itself, it connects to a running [WebRig](https://github.com/AnEntrypoint/webrig)
audio bridge over WebRig's audio WebSocket, so the WebRig instance keeps owning the page capture
and the voice connection.

1. Start WebRig with its Discord bot configured (`DISCORD_BOT_TOKEN`, `GUILD_ID`, `CHANNEL_ID`)
   and its audio WebSocket listening (`WS_AUDIO_PORT`, default 9888). The browser extensions are
   audio *clients*: in browser-extension mode the socket is served by
   `node companion/index.js` (`npm run companion`), not by the extension itself.
2. Run `npm install` inside `webrig-runner/` once, then `node webrig-runner/index.mjs` (or `npm start` there). It loads the same
   ccv speech models, follows `.webrig/heard.jsonl`, and starts `chatjimmy-bridge.mjs` against it.
3. Replies are synthesized with ccv's TTS and sent back to WebRig as stereo Float32 AUDIO frames;
   WebRig plays them into the voice channel.

Configuration is the `WEBRIG_*` block in `.env.example`. Set `WEBRIG_BRIDGE=0` to run only the
audio bridge without the chatjimmy responder.
