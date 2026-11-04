#!/usr/bin/env node
// An MCP server, started by start-mic.sh, that listens to the audio this machine plays and speaks replies into its
// microphone input. It keeps the frames RNNoise hears as voice, transcribes each utterance with ccv's speech-to-text,
// and pushes it into the session as a channel event (source "mic"). mic_speak synthesizes a reply with ccv's TTS and
// plays it into the mic input. The listening side closes while a reply plays, so a reply that also reaches the output
// is not heard back as speech. stdout is the MCP transport, so logs go to stderr.
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadDotEnv } from 'ccv/src/env.mjs';
import { loadStt, transcribePcm16k } from 'ccv/src/stt.mjs';
import { loadParadee, synthesizeStream } from 'ccv/src/tts.mjs';
import { modelDir } from 'ccv/src/install.mjs';
import { createDenoiser, DENOISE_FRAME } from 'ccv/src/denoise.mjs';
import { prosody, toneWords } from 'ccv/src/prosody.mjs';
import { createUtteranceJoiner } from '../discord-runner/utterance-join.mjs';
import { CAPTURE_RATE, startCapture, startPlayback } from './audio.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
loadDotEnv(root);

const ccvHome = process.env.CCV_HOME ?? path.join(root, '.ccv');
const endSilenceMs = Number(process.env.MIC_END_SILENCE_MS ?? 700);
const echoTailMs = Number(process.env.MIC_ECHO_TAIL_MS ?? 500);
const joinHoldMs = Number(process.env.MIC_JOIN_MS ?? 1000);
const speaker = process.env.MIC_SPEAKER_NAME || localUserName();
const minSpeechMs = 250;
const maxUtteranceMs = 30000;
const prerollFrames = 20;
const heardKeep = 50;
const toneHistoryKeep = 20;
const vadThreshold = 0.5;
const vadRms = 120;
const frameMs = (DENOISE_FRAME * 1000) / CAPTURE_RATE;
const restartMs = 2000;

const log = (line) => console.error(`${new Date().toISOString()} mic: ${line}`);
const textResult = (message) => ({ content: [{ type: 'text', text: message }] });

const denoiser = await createDenoiser();
const state = {
  status: 'starting',
  error: null,
  heard: [],
  seq: 0,
  models: 'loading',
  listen: process.env.MIC_LISTEN || 'default output',
  speak: process.env.MIC_SPEAK || 'default output',
};
// Last seq that mic_listen handed out; a caller's stale afterSeq can never replay an utterance at or below it.
let listenedSeq = 0;
const listeners = new Set();
let stt = null;
let tts = null;
let toneHistory = [];

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

function localUserName() {
  try {
    return os.userInfo().username;
  } catch {
    return 'mic';
  }
}

const rms = (pcm) => {
  let sum = 0;
  for (const s of pcm) sum += s * s;
  return Math.sqrt(sum / pcm.length);
};

const joinPcm = (pieces) => {
  const out = new Int16Array(pieces.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of pieces) { out.set(p, off); off += p.length; }
  return out;
};

// 48 kHz mono s16 -> 16 kHz mono s16 for speech-to-text: average each group of three samples.
function toSttPcm(mono48) {
  const out = new Int16Array(Math.floor(mono48.length / 3));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round((mono48[3 * i] + mono48[3 * i + 1] + mono48[3 * i + 2]) / 3);
  }
  return out;
}

let utterance = [];
let preroll = [];
let voicedMs = 0;
let silentMs = 0;
let speaking = false;
let playing = false;
let echoUntil = 0;
let pendingBytes = Buffer.alloc(0);

const listening = () => !playing && Date.now() >= echoUntil;

function resetUtterance() {
  utterance = [];
  preroll = [];
  voicedMs = 0;
  silentMs = 0;
  speaking = false;
}

// Speech-to-text runs one utterance at a time, in the order they ended.
let sttChain = Promise.resolve();
async function transcribeUtterance(sttPcm) {
  await modelsLoaded;
  if (!stt) throw new Error('speech models not loaded');
  return (await transcribePcm16k(stt, sttPcm)).trim();
}

function queueUtterance(sttPcm, at) {
  const run = sttChain.then(() => transcribeUtterance(sttPcm));
  sttChain = run.catch(() => {});
  run.then((text) => {
    if (text) joiner.add(speaker, { text, pcm: sttPcm, at, from: speaker });
  }).catch((err) => log(`transcribe failed: ${err.message}`));
}

function finishUtterance() {
  if (!speaking) return;
  const parts = utterance;
  const voiced = voicedMs;
  resetUtterance();
  if (voiced < minSpeechMs) return;
  const pcm = joinPcm(parts);
  log(`utterance end (${voiced} ms voiced, ${Math.round((pcm.length / CAPTURE_RATE) * 1000)} ms captured)`);
  queueUtterance(toSttPcm(pcm), Date.now());
}

// RNNoise decides only whether a frame is voice. The utterance keeps the raw frame, which transcribes better on noisy speech.
function feedFrame(frame, voiced) {
  if (!speaking) {
    if (!voiced) {
      preroll.push(frame);
      if (preroll.length > prerollFrames) preroll.shift();
      return;
    }
    speaking = true;
    utterance = preroll;
    preroll = [];
    voicedMs = 0;
    silentMs = 0;
  }
  utterance.push(frame);
  if (voiced) {
    voicedMs += frameMs;
    silentMs = 0;
  } else {
    silentMs += frameMs;
  }
  if (silentMs >= endSilenceMs || utterance.length * frameMs >= maxUtteranceMs) finishUtterance();
}

function feed(chunk) {
  pendingBytes = pendingBytes.length ? Buffer.concat([pendingBytes, chunk]) : chunk;
  const frameBytes = DENOISE_FRAME * 2;
  const usable = pendingBytes.length - (pendingBytes.length % frameBytes);
  const samples = new Int16Array(pendingBytes.buffer.slice(pendingBytes.byteOffset, pendingBytes.byteOffset + usable));
  pendingBytes = Buffer.from(pendingBytes.subarray(usable));
  for (let off = 0; off < samples.length; off += DENOISE_FRAME) {
    const frame = samples.subarray(off, off + DENOISE_FRAME);
    const { pcm, vad } = denoiser.processFrames(frame);
    if (!listening()) {
      resetUtterance();
      continue;
    }
    feedFrame(frame, vad[0] >= vadThreshold && rms(pcm) >= vadRms);
  }
}

let capture = null;
let restartTimer = null;
function startListening() {
  restartTimer = null;
  try {
    capture = startCapture({
      onData: feed,
      onExit: (err) => {
        capture = null;
        resetUtterance();
        state.status = 'error';
        state.error = `microphone stopped: ${err.message}`;
        log(state.error);
        if (err.code !== 'ENOENT') restartTimer = setTimeout(startListening, restartMs);
      },
    });
    state.status = 'listening';
    state.error = null;
    log(`listening to ${state.listen}`);
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
    log(state.error);
  }
}

// Channel events carry the tone before the text, so it reaches the session as well as the terminal.
function notifyHeard(utt) {
  server.server.notification({
    method: 'notifications/claude/channel',
    params: { content: `[${utt.tone}] ${utt.text}`, meta: { from: utt.from, at: String(utt.at) } },
  }).catch((err) => log(`channel notify failed: ${err.message}`));
}

function wakeListeners(utt) {
  for (const listener of listeners) {
    if (utt.seq > listener.afterSeq && utt.seq > listenedSeq) listener.deliver(utt);
  }
}

function handOut(utt) {
  listenedSeq = utt.seq;
  return textResult(JSON.stringify(utt));
}

// Publishes one whole utterance built from the joined fragments.
function publishUtterance(_key, parts) {
  const text = parts.map((p) => p.text).join(' ');
  const acoustics = prosody(joinPcm(parts.map((p) => p.pcm)));
  const words = (text.match(/[A-Za-z0-9']+/g) ?? []).length;
  acoustics.wordsPerSec = acoustics.speechMs >= 600 && words >= 2 ? Number((words / (acoustics.speechMs / 1000)).toFixed(2)) : null;
  const tone = toneWords(acoustics, toneHistory);
  toneHistory = [...toneHistory, acoustics].slice(-toneHistoryKeep);
  const utt = { seq: ++state.seq, at: parts[0].at, from: parts[0].from, text, tone, prosody: acoustics };
  state.heard.push(utt);
  if (state.heard.length > heardKeep) state.heard.shift();
  wakeListeners(utt);
  notifyHeard(utt);
}

const joiner = createUtteranceJoiner({ holdMs: joinHoldMs, onFlush: publishUtterance });

// Each sentence plays as soon as it is synthesized; the next one synthesizes while the current one plays.
let playChain = Promise.resolve();
async function playReply(text) {
  await modelsLoaded;
  if (!tts) throw new Error('speech models not loaded');
  const player = startPlayback();
  playing = true;
  try {
    const sentences = synthesizeStream(tts, text)[Symbol.asyncIterator]();
    let next = sentences.next();
    for (;;) {
      const { value, done } = await next;
      if (done) break;
      next = sentences.next();
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (!player.stdin.write(bytes)) await Promise.race([once(player.stdin, 'drain'), player.done]);
    }
    player.stdin.end();
    await player.done;
  } catch (err) {
    player.kill();
    throw err;
  } finally {
    playing = false;
    echoUntil = Date.now() + echoTailMs;
  }
}

function speak(spoken) {
  const run = playChain.then(() => playReply(spoken));
  playChain = run.catch((err) => log(`speak failed: ${err.message}`));
  return run;
}

const server = new McpServer(
  { name: 'mic', version: '0.1.0' },
  {
    capabilities: { logging: {}, experimental: { 'claude/channel': {} } },
    instructions: 'Utterances from this machine\'s audio output arrive as <channel source="mic"> events. The [tone] before each text says how it was said versus the speaker\'s usual. Reply with mic_speak, or make no tool call when quiet. Never call mic_listen while they arrive. Use tone; never quote it.',
  },
);

server.registerTool('mic_status', {
  description: 'Listening and speaking device state, speech model state, last error.',
  inputSchema: {},
}, async () => textResult(JSON.stringify({
  status: state.status,
  error: state.error,
  listen: state.listen,
  speak: state.speak,
  models: state.models,
  utterances: state.seq,
}, null, 2)));

server.registerTool('mic_speak', {
  description: 'Speak text into this machine\'s microphone input. Returns when playback ends. Listening is paused while it plays.',
  inputSchema: { text: z.string().min(1) },
}, async ({ text: spoken }) => {
  try {
    await speak(spoken);
    return textResult('spoken');
  } catch (err) {
    return textResult(`speak failed: ${err.message}`);
  }
});

server.registerTool('mic_heard', {
  description: 'Recent utterances heard from the output audio, oldest first.',
  inputSchema: { since: z.number().optional().describe('only seq above this') },
}, async ({ since = 0 }) => textResult(JSON.stringify(state.heard.filter((u) => u.seq > since), null, 2)));

// Fallback for sessions that receive no channel events. Each utterance is handed out once.
server.registerTool('mic_listen', {
  description: 'Fallback for sessions with no channel events: block until the next utterance, return it once, or {"timeout":true} after timeoutMs. Call again after each reply.',
  inputSchema: {
    afterSeq: z.number().optional().describe('seq you last handled; older or already returned ones are skipped'),
    timeoutMs: z.number().optional().describe('ms; default 30000, max 300000'),
  },
}, async ({ afterSeq, timeoutMs = 30000 }, extra) => {
  const cursor = afterSeq === undefined ? (listenedSeq || state.seq) : Math.max(afterSeq, listenedSeq);
  const waiting = state.heard.find((u) => u.seq > cursor);
  if (waiting) return handOut(waiting);
  return new Promise((resolve) => {
    const give = Math.min(Math.max(timeoutMs, 1000), 300000);
    const listener = { afterSeq: cursor, deliver: (u) => { finish(); resolve(handOut(u)); } };
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
log('mic MCP server ready');
startListening();

const shutdown = () => {
  clearTimeout(restartTimer);
  capture?.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown);
