#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from 'ccv/src/env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(here);

if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CHANNEL) {
  console.error('start-discord-chatjimmy: DISCORD_TOKEN and DISCORD_CHANNEL must be set in the environment or .env');
  process.exit(1);
}
if (!existsSync(path.join(here, 'discord-runner', 'node_modules', 'discord.js'))) {
  console.error('start-discord-chatjimmy: run npm install in discord-runner first');
  process.exit(1);
}

const discordHome = path.resolve(here, process.env.DISCORD_HOME ?? '.discord');
const speakPort = process.env.DISCORD_SPEAK_PORT ?? '8803';

const runner = spawn(process.execPath, [path.join(here, 'discord-runner', 'index.mjs')], {
  cwd: here,
  env: { ...process.env, DISCORD_HOME: discordHome, DISCORD_SPEAK_PORT: speakPort, DISCORD_MCP: '0' },
  stdio: 'inherit',
});
const bridge = spawn(process.execPath, [path.join(here, 'chatjimmy-bridge.mjs')], {
  cwd: here,
  env: { ...process.env, CCV_HOME: discordHome, CCV_HOST_URL: `http://127.0.0.1:${speakPort}` },
  stdio: 'inherit',
});

const stop = (code) => {
  runner.kill();
  bridge.kill();
  process.exit(code);
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
runner.on('exit', (code) => stop(code ?? 0));
bridge.on('exit', (code) => stop(code ?? 0));
