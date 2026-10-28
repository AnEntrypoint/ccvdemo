# Voice demo

This project runs the ccv voice stack through its MCP server.

- Launch with `npx -y --package github:AnEntrypoint/ccv ccv-claude` rather than `claude`, so speech arrives in the session on its own. The name after `server:` must match `ccv` exactly: a stray character, including the carriage return a paste can carry, silently matches no server and nothing is delivered.
- Start with `voice_setup` once (installs LiveKit and the models in the background).
- Then `voice_start`, and open the printed page to join the room.
- Speech arrives as `<channel source="ccv" ...>`; reply with `voice_speak`.
- If speech does not arrive, call `voice_listen`: it blocks until the user next speaks, so the session is woken without polling. Pass back the `seq` you handled as `afterSeq` on the next call.
- `voice_heard` lists what was said; check `voice_status` if anything is not working.
