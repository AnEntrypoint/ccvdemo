#!/usr/bin/env node
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadDotEnv } from 'ccv/src/env.mjs';
import { loadStt, transcribePcm16k } from 'ccv/src/stt.mjs';
import { loadParadee, synthesizeStream, SAMPLE_RATE as TTS_RATE } from 'ccv/src/tts.mjs';
import { modelDir } from 'ccv/src/install.mjs';
import { readWavMono, writeWavMono } from './wav.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
loadDotEnv(root);

const ccvHome = process.env.CCV_HOME ?? path.join(root, '.ccv');
const clipsDir = path.resolve(root, process.env.CLIPS_DIR ?? 'clips');
const STT_RATE = 16000;

const log = (line) => console.error(`${new Date().toISOString()} clips: ${line}`);
const textResult = (text) => ({ content: [{ type: 'text', text }] });
const errorResult = (text) => ({ ...textResult(text), isError: true });

const models = { stt: null, tts: null, error: null };
const loading = Promise.all([loadStt(modelDir(ccvHome, 'stt')), loadParadee(modelDir(ccvHome, 'tts'))])
  .then(([stt, tts]) => {
    models.stt = stt;
    models.tts = tts;
    log('speech models loaded');
  })
  .catch((err) => {
    models.error = `speech models not available (run voice_setup in ccv first): ${err.message}`;
    log(models.error);
  });

async function ready() {
  await loading;
  if (models.error) throw new Error(models.error);
}

function clipPath(name) {
  const file = path.resolve(clipsDir, path.basename(name));
  if (path.dirname(file) !== clipsDir) throw new Error('clip names may not contain directories');
  return file.toLowerCase().endsWith('.wav') ? file : `${file}.wav`;
}

const server = new McpServer({ name: 'clips', version: '0.1.0' });

server.registerTool('clip_speak', {
  description: 'Synthesize text into a WAV clip in CLIPS_DIR with the ccv TTS model. Returns the file path and duration.',
  inputSchema: {
    text: z.string().min(1).describe('Text to speak. Punctuation sets the pauses.'),
    name: z.string().min(1).describe('Clip file name, without directory. ".wav" is added when missing.'),
    speed: z.number().min(0.5).max(2).optional().describe('Speaking rate, 1 is normal.'),
  },
}, async ({ text, name, speed }) => {
  try {
    await ready();
  } catch (err) {
    return errorResult(err.message);
  }
  const file = clipPath(name);
  const chunks = [];
  for await (const pcm of synthesizeStream(models.tts, text, speed ?? 1)) chunks.push(pcm);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Int16Array(total);
  let off = 0;
  for (const c of chunks) { pcm.set(c, off); off += c.length; }
  await mkdir(clipsDir, { recursive: true });
  await writeWavMono(file, pcm, TTS_RATE);
  return textResult(JSON.stringify({ path: file, seconds: Number((total / TTS_RATE).toFixed(2)), sampleRate: TTS_RATE }));
});

server.registerTool('clip_transcribe', {
  description: 'Transcribe a 16-bit PCM WAV file with the ccv STT model. Relative paths resolve inside CLIPS_DIR.',
  inputSchema: {
    file: z.string().min(1).describe('WAV file path, absolute or relative to CLIPS_DIR.'),
  },
}, async ({ file }) => {
  try {
    await ready();
    const target = path.isAbsolute(file) ? file : path.resolve(clipsDir, file);
    const { pcm, seconds } = await readWavMono(target, STT_RATE);
    const text = (await transcribePcm16k(models.stt, pcm)).trim();
    return textResult(JSON.stringify({ path: target, seconds: Number(seconds.toFixed(2)), text }));
  } catch (err) {
    return errorResult(err.message);
  }
});

await server.connect(new StdioServerTransport());
log('ready');
