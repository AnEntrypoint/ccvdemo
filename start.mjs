#!/usr/bin/env node
// One command for the chatjimmy voice setup: starts the ccv voice stack (LiveKit and the voice host)
// through ccv's own voice_start, then runs the chatjimmy bridge that answers utterances.
// The ccv server is only the lifecycle owner here; replies come from chatjimmy, not from a session over MCP.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '/workspace/ccv/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '/workspace/ccv/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['/workspace/ccv/bin/ccv.mjs'],
  cwd: here,
  stderr: 'inherit',
});
const client = new Client({ name: 'ccvdemo-start', version: '0.1.0' });
await client.connect(transport);

const result = await client.callTool({ name: 'voice_start', arguments: {} }, undefined, { timeout: 15 * 60 * 1000 });
const message = result.content?.map((c) => c.text).join('\n') ?? '';
console.log(message);
if (result.isError) {
  await client.close();
  process.exit(1);
}

const bridge = spawn(process.execPath, [path.join(here, 'chatjimmy-bridge.mjs')], { cwd: here, stdio: 'inherit' });
const shutdown = async () => {
  bridge.kill();
  await client.callTool({ name: 'voice_stop', arguments: {} }).catch(() => {});
  await client.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
bridge.on('exit', shutdown);
