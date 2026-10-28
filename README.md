# ccvdemo

Example Claude Code project that uses [ccv](https://github.com/AnEntrypoint/ccv) for realtime voice.

## Install

1. Open this directory in Claude Code. It loads `.mcp.json`, which starts `npx -y github:AnEntrypoint/ccv`.
2. Optional: copy `.env.example` to `.env` and set `HF_TOKEN` for faster model downloads.
3. Ask Claude to run `voice_setup`, then `voice_start`, then open http://127.0.0.1:8800/ and click join.

Models and LiveKit install into `.ccv/` in this directory (git-ignored).

## Browser demo

`docs/index.html` is the GitHub Pages build. It runs entirely in the visitor's browser: speech recognition transcribes the microphone into the caption, and typed text is spoken back with speech synthesis. Nothing is uploaded. Open it at the Pages URL once Pages is enabled for the `docs/` folder on `main`.

The live room at http://127.0.0.1:8800/ is separate. That one needs the ccv host running, because the host does the transcription and the reply.
