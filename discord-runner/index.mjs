#!/usr/bin/env node
// Discord voice as an MCP server, launched by Claude Code from .mcp.json. Joins DISCORD_CHANNEL, transcribes each
// utterance with ccv's speech-to-text, and pushes it into the session as a channel event (source "discord") and into
// <DISCORD_HOME>/heard.jsonl. discord_speak synthesizes a reply with ccv's TTS and plays it into the voice channel.
// stdout is the MCP transport, so all logging goes to stderr.
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, EndBehaviorType, AudioPlayerStatus, StreamType, VoiceConnectionStatus } from '@discordjs/voice';
import prism from 'prism-media';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadDotEnv } from '/workspace/ccv/src/env.mjs';
import { loadStt, transcribePcm16k } from '/workspace/ccv/src/stt.mjs';
import { loadParadee, synthesizeStream } from '/workspace/ccv/src/tts.mjs';
import { modelDir } from '/workspace/ccv/src/install.mjs';
import { createDenoiser } from '/workspace/ccv/src/denoise.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
loadDotEnv(root);

const token = process.env.DISCORD_TOKEN;
const channelUrl = process.env.DISCORD_CHANNEL ?? '';
const [, guildId, channelId] = channelUrl.match(/channels\/(\d+)\/(\d+)/) ?? [];
const voiceChannelId = channelId ?? channelUrl.split('/').pop();
const ccvHome = process.env.CCV_HOME ?? path.join(root, '.ccv');
const discordHome = process.env.DISCORD_HOME ?? path.join(root, '.discord');
const heardPath = path.join(discordHome, 'heard.jsonl');
// Silence that ends an utterance. Lower than the old 800 ms default: raise it if sentences get cut at pauses.
const endSilenceMs = Number(process.env.DISCORD_END_SILENCE_MS ?? 400);
const minSpeechMs = 250;
const heardKeep = 50;

const problem = !token ? 'DISCORD_TOKEN is not set' : !voiceChannelId ? 'DISCORD_CHANNEL is not set' : null;
await mkdir(discordHome, { recursive: true });

const log = (line) => console.error(`${new Date().toISOString()} discord: ${line}`);
const textResult = (message) => ({ content: [{ type: 'text', text: message }] });

const state = { status: problem ? 'error' : 'starting', error: problem, heard: [], seq: 0, models: 'loading' };
const listeners = new Set();
let stt = null;
let tts = null;

const modelsLoaded = Promise.all([loadStt(modelDir(ccvHome, 'stt')), loadParadee(modelDir(ccvHome, 'tts'))])
  .then(([s, t]) => {
    stt = s;
    tts = t;
    state.models = 'ready';
    log('speech models loaded');
  })
  .catch((err) => {
    state.models = 'failed';
    state.error = `speech models failed: ${err.message}`;
    log(state.error);
  });

// 48 kHz stereo s16 -> mono 48 kHz s16.
function toMono48(stereo) {
  const frames = stereo.length / 2;
  const mono = new Int16Array(frames);
  for (let i = 0; i < frames; i++) mono[i] = (stereo[2 * i] + stereo[2 * i + 1]) >> 1;
  return mono;
}

// Mono 48 kHz s16 -> 16 kHz mono s16 for speech-to-text: average each group of three samples.
function toSttPcm(mono48) {
  const out = new Int16Array(Math.floor(mono48.length / 3));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round((mono48[i * 3] + mono48[i * 3 + 1] + mono48[i * 3 + 2]) / 3);
  }
  return out;
}

// RNNoise runs on every utterance before speech-to-text: the speaker is denoised, and the utterance is kept only
// when enough frames RNNoise rates as voice. Client mic activity alone does not count.
const VAD_THRESHOLD = 0.5;
const MIN_VOICED_FRAMES = Math.ceil(minSpeechMs / 10);
async function denoise(mono48) {
  const denoiser = await createDenoiser();
  try {
    const { pcm, vad } = denoiser.processFrames(mono48);
    const voiced = vad.reduce((n, v) => n + (v >= VAD_THRESHOLD ? 1 : 0), 0);
    return voiced >= MIN_VOICED_FRAMES ? pcm : null;
  } finally {
    denoiser.close();
  }
}

// 24 kHz mono s16 TTS -> 48 kHz stereo s16 for Discord: repeat each sample twice, duplicate to both channels.
function toPlaybackPcm(mono24) {
  const out = new Int16Array(mono24.length * 4);
  for (let i = 0; i < mono24.length; i++) {
    const a = mono24[i];
    const b = i + 1 < mono24.length ? mono24[i + 1] : a;
    const mid = Math.round((a + b) / 2);
    const o = i * 4;
    out[o] = a; out[o + 1] = a;
    out[o + 2] = mid; out[o + 3] = mid;
  }
  return out;
}

let sttChain = Promise.resolve();
const transcribe = (pcm) => {
  const run = sttChain.then(() => {
    if (!stt) throw new Error('speech models not loaded');
    return transcribePcm16k(stt, pcm);
  });
  sttChain = run.catch(() => {});
  return run;
};

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
client.on('error', (err) => log(`client error: ${err.message}`));
let connection = null;
let player = null;
const listening = new Set();
let decodeErrorLogged = false;

// Hands an utterance to every waiting discord_listen call; one that asked for a newer cursor stays waiting.
function wakeListeners(utterance) {
  for (const listener of listeners) {
    if (utterance.seq > listener.afterSeq) listener.deliver(utterance);
  }
}

// Pushes an utterance into the Claude session as a channel event. Clients without the channel flag ignore it.
function notifyHeard(utterance) {
  server.server.notification({
    method: 'notifications/claude/channel',
    params: { content: utterance.text, meta: { from: utterance.from, at: String(utterance.at) } },
  }).catch((err) => log(`channel notify failed: ${err.message}`));
}

async function onSpeechEnd(userId, stereo) {
  const at = Date.now();
  const [user, voiced] = await Promise.all([client.users.fetch(userId).catch(() => null), denoise(toMono48(stereo))]);
  const from = user?.username ?? userId;
  if (!voiced) {
    log(`[${from}] dropped: no speech (RNNoise VAD)`);
    return;
  }
  const transcript = (await transcribe(toSttPcm(voiced))).trim();
  if (!transcript) return;
  log(`[${from}] heard: ${transcript}`);
  const utterance = { seq: ++state.seq, at, from, text: transcript };
  state.heard.push(utterance);
  if (state.heard.length > heardKeep) state.heard.shift();
  await appendFile(heardPath, `${JSON.stringify(utterance)}\n`);
  wakeListeners(utterance);
  notifyHeard(utterance);
}

function listen(receiver) {
  receiver.speaking.on('start', (userId) => {
    if (listening.has(userId)) return;
    listening.add(userId);
    const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: endSilenceMs } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks = [];
    decoder.on('data', (c) => chunks.push(c));
    decoder.on('error', (err) => {
      if (!decodeErrorLogged) log(`decode error (dropping utterances that hit one): ${err.message}`);
      decodeErrorLogged = true;
      chunks.length = 0;
      listening.delete(userId);
    });
    decoder.on('end', () => {
      listening.delete(userId);
      const joined = Buffer.concat(chunks);
      const stereo = new Int16Array(joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.length));
      onSpeechEnd(userId, stereo).catch((err) => log(`speech end failed: ${err.message}`));
    });
    opus.on('error', (err) => { listening.delete(userId); log(`receive error: ${err.message}`); });
    opus.pipe(decoder);
  });
}

// Plays each sentence as soon as it is synthesized; the next sentence synthesizes while the current one plays.
let speakChain = Promise.resolve();
function speak(spoken) {
  const run = speakChain.then(async () => {
    const sentences = synthesizeStream(tts, spoken)[Symbol.asyncIterator]();
    let pending = sentences.next();
    for (;;) {
      const { value, done } = await pending;
      if (done) break;
      pending = sentences.next();
      const pcm = toPlaybackPcm(value);
      player.play(createAudioResource(Readable.from([Buffer.from(pcm.buffer)]), { inputType: StreamType.Raw }));
      await entersState(player, AudioPlayerStatus.Idle, 120000).catch(() => {});
    }
  });
  speakChain = run.catch((err) => log(`speak failed: ${err.message}`));
  return run;
}

async function joinVoice() {
  const guild = await client.guilds.fetch(guildId ?? (await client.channels.fetch(voiceChannelId)).guildId);
  connection = joinVoiceChannel({ channelId: voiceChannelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
  await entersState(connection, VoiceConnectionStatus.Ready, 30000);
  player = createAudioPlayer();
  connection.subscribe(player);
  listen(connection.receiver);
  state.status = 'joined';
  log(`joined voice channel ${voiceChannelId}`);
}

client.once('clientReady', async () => {
  log(`logged in as ${client.user.tag}`);
  state.status = 'joining';
  try {
    await modelsLoaded;
    await joinVoice();
  } catch (err) {
    state.status = 'error';
    state.error = `join failed: ${err.message}`;
    log(state.error);
  }
});

const server = new McpServer(
  { name: 'discord', version: '0.1.0' },
  {
    capabilities: { logging: {}, experimental: { 'claude/channel': {} } },
    instructions: 'Utterances arrive as <channel source="discord">. Reply with discord_speak. If none arrive, call discord_listen, which blocks until someone speaks.',
  },
);

server.registerTool('discord_status', {
  description: 'Connection state, voice channel, speech model state, last error.',
  inputSchema: {},
}, async () => textResult(JSON.stringify({
  status: state.status,
  error: state.error,
  channel: voiceChannelId,
  models: state.models,
  utterances: state.seq,
}, null, 2)));

server.registerTool('discord_speak', {
  description: 'Speak text in the Discord voice channel. Returns when playback ends.',
  inputSchema: { text: z.string().min(1) },
}, async ({ text: spoken }) => {
  if (!player) return textResult('not in a Discord voice channel yet; check discord_status');
  try {
    await speak(spoken);
    return textResult('spoken');
  } catch (err) {
    return textResult(`speak failed: ${err.message}`);
  }
});

server.registerTool('discord_heard', {
  description: 'Recent utterances, oldest first.',
  inputSchema: { since: z.number().optional().describe('only seq above this') },
}, async ({ since = 0 }) => textResult(JSON.stringify(state.heard.filter((u) => u.seq > since), null, 2)));

// For sessions that never registered the channel handler: the call blocks until someone speaks.
server.registerTool('discord_listen', {
  description: 'Block until the next utterance, or {"timeout":true} after timeoutMs. Call again after each reply, passing afterSeq.',
  inputSchema: {
    afterSeq: z.number().optional().describe('last seq you handled; only newer utterances return'),
    timeoutMs: z.number().optional().describe('ms; default 30000, max 300000'),
  },
}, async ({ afterSeq, timeoutMs = 30000 }, extra) => {
  const cursor = afterSeq ?? state.seq;
  const waiting = state.heard.find((u) => u.seq > cursor);
  if (waiting) return textResult(JSON.stringify(waiting));
  return new Promise((resolve) => {
    const give = Math.min(Math.max(timeoutMs, 1000), 300000);
    const listener = { afterSeq: cursor, deliver: (u) => { finish(); resolve(textResult(JSON.stringify(u))); } };
    const timer = setTimeout(() => {
      finish();
      resolve(textResult(JSON.stringify({ timeout: true, afterSeq: cursor, newestSeq: state.seq })));
    }, give);
    const cancel = () => {
      finish();
      resolve(textResult(JSON.stringify({ cancelled: true, afterSeq: cursor })));
    };
    function finish() {
      clearTimeout(timer);
      listeners.delete(listener);
      extra?.signal?.removeEventListener('abort', cancel);
    }
    listeners.add(listener);
    extra?.signal?.addEventListener('abort', cancel, { once: true });
  });
});

await server.connect(new StdioServerTransport());
log('discord MCP server ready');
if (problem) log(problem);
else client.login(token).catch((err) => {
  state.status = 'error';
  state.error = `login failed: ${err.message}`;
  log(state.error);
});

const shutdown = () => {
  connection?.destroy();
  client.destroy();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown);
