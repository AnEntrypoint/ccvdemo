#!/usr/bin/env node
// Discord voice runner. Joins DISCORD_CHANNEL, transcribes each speaker with ccv's speech-to-text,
// and writes utterances to <DISCORD_HOME>/heard.jsonl in the format chatjimmy-bridge.mjs reads.
// Replies arrive on a local /speak endpoint and are played into the voice channel with ccv's TTS.
// Starts chatjimmy-bridge.mjs as a child process, pointed at this runner, so one command runs the whole chain.
import { appendFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, EndBehaviorType, AudioPlayerStatus, StreamType, VoiceConnectionStatus } from '@discordjs/voice';
import prism from 'prism-media';
import { loadDotEnv } from '/workspace/ccv/src/env.mjs';
import { loadStt, transcribePcm16k } from '/workspace/ccv/src/stt.mjs';
import { loadParadee, synthesize } from '/workspace/ccv/src/tts.mjs';
import { modelDir } from '/workspace/ccv/src/install.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.dirname(here));

const token = process.env.DISCORD_TOKEN;
const channelUrl = process.env.DISCORD_CHANNEL ?? '';
const [, guildId, channelId] = channelUrl.match(/channels\/(\d+)\/(\d+)/) ?? [];
const voiceChannelId = channelId ?? channelUrl.split('/').pop();
const ccvHome = process.env.CCV_HOME ?? path.join(path.dirname(here), '.ccv');
const discordHome = process.env.DISCORD_HOME ?? path.join(path.dirname(here), '.discord');
const heardPath = path.join(discordHome, 'heard.jsonl');
const speakPort = Number(process.env.DISCORD_SPEAK_PORT ?? 8801);
const endSilenceMs = Number(process.env.DISCORD_END_SILENCE_MS ?? 800);
const minSpeechMs = 250;

if (!token) throw new Error('DISCORD_TOKEN is not set');
if (!voiceChannelId) throw new Error('DISCORD_CHANNEL is not set');
await mkdir(discordHome, { recursive: true });

const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

const [stt, tts] = await Promise.all([
  loadStt(modelDir(ccvHome, 'stt')),
  loadParadee(modelDir(ccvHome, 'tts')),
]);
log('speech models loaded');

// 48 kHz stereo s16 -> 16 kHz mono s16: average the channels, then average each group of three frames.
function toSttPcm(stereo) {
  const frames = stereo.length / 2;
  const out = new Int16Array(Math.floor(frames / 3));
  for (let i = 0; i < out.length; i++) {
    let acc = 0;
    for (let k = 0; k < 3; k++) {
      const f = (i * 3 + k) * 2;
      acc += stereo[f] + stereo[f + 1];
    }
    out[i] = Math.round(acc / 6);
  }
  return out;
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
  const run = sttChain.then(() => transcribePcm16k(stt, pcm));
  sttChain = run.catch(() => {});
  return run;
};

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
let connection = null;
let player = null;
const listening = new Set();
let decodeErrorLogged = false;

async function onSpeechEnd(userId, stereo) {
  const at = Date.now();
  const user = await client.users.fetch(userId).catch(() => null);
  const from = user?.username ?? userId;
  await appendFile(heardPath, `${JSON.stringify({ event: 'speechend', from, at })}\n`);
  const pcm = toSttPcm(stereo);
  if (pcm.length < (16000 * minSpeechMs) / 1000) return;
  try {
    const text = (await transcribe(pcm)).trim();
    if (!text) return;
    log(`[${from}] heard: ${text}`);
    await appendFile(heardPath, `${JSON.stringify({ from, text, at })}\n`);
  } catch (err) {
    log(`transcribe failed: ${err.message}`);
  }
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

let speakChain = Promise.resolve();
function speak(text) {
  const run = speakChain.then(async () => {
    const mono = await synthesize(tts, text);
    const pcm = toPlaybackPcm(mono);
    const resource = createAudioResource(Readable.from([Buffer.from(pcm.buffer)]), { inputType: StreamType.Raw });
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Playing, 5000).catch(() => {});
    await entersState(player, AudioPlayerStatus.Idle, 120000).catch(() => {});
  });
  speakChain = run.catch((err) => log(`speak failed: ${err.message}`));
  return run;
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/speak') {
    res.statusCode = 404;
    return res.end();
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const { text } = JSON.parse(body || '{}');
    if (!text) { res.statusCode = 400; return res.end('{"error":"text required"}'); }
    log(`speaking: ${text}`);
    await speak(text);
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
});

client.once('clientReady', async () => {
  log(`logged in as ${client.user.tag}`);
  const guild = await client.guilds.fetch(guildId ?? (await client.channels.fetch(voiceChannelId)).guildId);
  connection = joinVoiceChannel({ channelId: voiceChannelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
  await entersState(connection, VoiceConnectionStatus.Ready, 30000);
  player = createAudioPlayer();
  connection.subscribe(player);
  listen(connection.receiver);
  log(`joined voice channel ${voiceChannelId}`);
  server.listen(speakPort, '127.0.0.1', () => log(`speak endpoint on http://127.0.0.1:${speakPort}`));
});

// The chatjimmy bridge answers what this runner hears, so start it alongside: one command runs the whole chain.
const bridge = spawn(process.execPath, [path.join(path.dirname(here), 'chatjimmy-bridge.mjs')], {
  env: { ...process.env, CCV_HOME: discordHome, CCV_HOST_URL: `http://127.0.0.1:${speakPort}` },
  stdio: 'inherit',
});
bridge.on('exit', (code) => log(`chatjimmy bridge exited (${code})`));
const stopBridge = () => { bridge.kill(); process.exit(0); };
process.on('SIGINT', stopBridge);
process.on('SIGTERM', stopBridge);

client.login(token);
