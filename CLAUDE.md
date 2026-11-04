@AGENTS.md

# Voice demo

This project runs the ccv voice stack through its MCP server.

- Launch with `npx -y --package github:AnEntrypoint/ccv ccv-claude` rather than `claude`, so speech arrives in the session on its own. The name after `server:` must match `ccv` exactly: a stray character, including the carriage return a paste can carry, silently matches no server and nothing is delivered.
- Start with `voice_setup` once (installs LiveKit and the models in the background).
- Then `voice_start`, and open the printed page to join the room.
- Speech arrives as `<channel source="ccv" ...>`; reply with `voice_speak`.
- If speech does not arrive as channel events, call `voice_listen`: it blocks until the user next speaks, so the session is woken without polling. Pass back the `seq` you handled as `afterSeq` on the next call; never call it while channel events arrive.
- `voice_heard` lists what was said; check `voice_status` if anything is not working.

## Discord

`discord-runner/index.mjs` is the `discord` MCP server in `.mcp.json`. Claude Code starts it; it joins `DISCORD_CHANNEL` with `DISCORD_TOKEN` at launch, transcribes each utterance with ccv's STT, and writes it to `.discord/heard.jsonl`. Utterances arrive as `<channel source="discord" ...>` when Claude Code was started with `--dangerously-load-development-channels server:discord`; otherwise call `discord_listen`, which blocks until someone speaks. In a channel session, never call `discord_listen`: channel events are the only delivery path there. Reply with `discord_speak`, which plays through ccv's TTS into the voice channel. `discord_heard` lists recent utterances and `discord_status` shows the connection and the last error. Nothing on this path uses the chatjimmy bridge.

## Mic runner

Launch with `./start-mic.sh`: it listens to this machine's output audio and speaks replies into its microphone
input (see the README). Utterances arrive as `<channel source="mic" ...>`; reply with `mic_speak`. `mic_status`
reports the listening and speaking devices and any error; `mic_listen` is the fallback when no channel events arrive.

## WebRig runner

`webrig-runner/index.mjs` replaces the Discord voice connection with WebRig's audio WebSocket. It
receives WebRig's broadcast AUDIO frames as interleaved stereo Float32 at 48 kHz, segments them
with RNNoise voice activity, transcribes each utterance with ccv's STT, and appends the same
`heard.jsonl` records `chatjimmy-bridge.mjs` reads. `/speak` on `WEBRIG_SPEAK_PORT` (default 8802)
synthesizes a reply with ccv's TTS and sends it back to WebRig as framed AUDIO. `WEBRIG_HOME`
(default `.webrig/`) holds `heard.jsonl`; `WEBRIG_BRIDGE=0` disables the chatjimmy child process.
The runner needs WebRig's 9888 audio server: the Electron host (`npm start`) or, for the browser
extensions, `npm run companion` — an extension alone does not listen.
