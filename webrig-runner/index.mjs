#!/usr/bin/env node
// WebRig audio runner: the WebRig counterpart of discord-runner. It joins WebRig's audio
// WebSocket as one more client instead of a Discord voice connection. WebRig broadcasts the
// voice-channel audio it receives as AUDIO frames; this runner segments that stream with
// RNNoise voice activity, transcribes each utterance with ccv's speech-to-text, and appends it
// to <home>/heard.jsonl in the format chatjimmy-bridge.mjs reads. Replies arrive on a local
// /speak endpoint, are synthesized with ccv's TTS, and go back to WebRig as stereo Float32 PCM
// AUDIO frames, which WebRig plays into the voice channel.
//
// Protocol (same 4+4+N framing as WebRig's extension and swarm):
//   bytes 0..3  message type as LE uint32 (AUDIO = 1)
//   bytes 4..7  payload length as LE uint32
//   bytes 8..   interleaved stereo Float32 PCM at 48 kHz
import { appendFile, mkdir } from 'node:fs/promises'
import http from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDotEnv } from '/workspace/ccv/src/env.mjs'
import { loadStt, transcribePcm16k } from '/workspace/ccv/src/stt.mjs'
import { loadParadee, synthesize } from '/workspace/ccv/src/tts.mjs'
import { modelDir } from '/workspace/ccv/src/install.mjs'
import { createDenoiser, DENOISE_FRAME } from '/workspace/ccv/src/denoise.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
loadDotEnv(root)

const wsUrl = process.env.WEBRIG_WS_URL ?? 'ws://127.0.0.1:9888'
const speakPort = Number(process.env.WEBRIG_SPEAK_PORT ?? 8802)
const speaker = process.env.WEBRIG_SPEAKER_NAME ?? 'webrig'
const ccvHome = process.env.CCV_HOME ?? path.join(root, '.ccv')
const webrigHome = process.env.WEBRIG_HOME ?? path.join(root, '.webrig')
const heardPath = path.join(webrigHome, 'heard.jsonl')
const endSilenceMs = Number(process.env.WEBRIG_END_SILENCE_MS ?? 700)
const minSpeechMs = Number(process.env.WEBRIG_MIN_SPEECH_MS ?? 250)
const maxUtteranceMs = Number(process.env.WEBRIG_MAX_UTTERANCE_MS ?? 30000)
const vadThreshold = Number(process.env.WEBRIG_VAD_THRESHOLD ?? 0.5)
const vadRms = Number(process.env.WEBRIG_VAD_RMS ?? 120)

const MSG_AUDIO = 1
const SAMPLE_RATE = 48000
const FRAME_MS = 10
const AUDIO_FRAME_FLOATS = 1920

await mkdir(webrigHome, { recursive: true })

const log = (line) => console.log(`${new Date().toISOString()} [webrig-runner] ${line}`)
const [stt, tts] = await Promise.all([
  loadStt(modelDir(ccvHome, 'stt')),
  loadParadee(modelDir(ccvHome, 'tts')),
])
log('speech models loaded')

const concat16 = (parts) => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

const rmsOf = (pcm) => {
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
  return Math.sqrt(sum / pcm.length)
}

function toMono48(stereo) {
  const frames = stereo.length >> 1
  const mono = new Int16Array(frames)
  for (let i = 0; i < frames; i++) {
    const s = (stereo[2 * i] + stereo[2 * i + 1]) / 2
    mono[i] = s <= -1 ? -32768 : s >= 1 ? 32767 : Math.round(s * 32768)
  }
  return mono
}

function toSttPcm(mono48) {
  const out = new Int16Array(Math.floor(mono48.length / 3))
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round((mono48[3 * i] + mono48[3 * i + 1] + mono48[3 * i + 2]) / 3)
  }
  return out
}

function toStereo48(mono24) {
  const out = new Float32Array(mono24.length * 4)
  for (let i = 0; i < mono24.length; i++) {
    const a = mono24[i] / 32768
    const b = (i + 1 < mono24.length ? mono24[i + 1] : mono24[i]) / 32768
    const mid = (a + b) / 2
    const o = i * 4
    out[o] = a; out[o + 1] = a; out[o + 2] = mid; out[o + 3] = mid
  }
  return out
}

const denoiser = await createDenoiser()
let carry = new Int16Array(0)
let utterance = []
let voicedMs = 0
let silentMs = 0
let speaking = false
let lastAudioAt = 0
let sttChain = Promise.resolve()

function queueUtterance(pcm16k, at) {
  const run = sttChain.then(async () => {
    try {
      const text = (await transcribePcm16k(stt, pcm16k)).trim()
      if (text) log(`heard: ${text}`)
      await appendFile(heardPath, `${JSON.stringify({ from: speaker, text, at })}\n`)
    } catch (err) {
      log(`transcribe failed: ${err.message}`)
      await appendFile(heardPath, `${JSON.stringify({ from: speaker, text: '', at })}\n`).catch(() => {})
    }
  })
  sttChain = run.catch(() => {})
  return run
}

function finishUtterance(reason) {
  if (!speaking) return
  const parts = utterance
  const voiced = voicedMs
  speaking = false
  utterance = []
  voicedMs = 0
  silentMs = 0
  if (voiced < minSpeechMs) return
  const pcm = concat16(parts)
  if (!pcm.length) return
  const at = Date.now()
  log(`utterance end (${reason}, ${voiced} ms voiced, ${Math.round((pcm.length / SAMPLE_RATE) * 1000)} ms captured)`)
  appendFile(heardPath, `${JSON.stringify({ event: 'speechend', from: speaker, at })}\n`).catch(() => {})
  queueUtterance(toSttPcm(pcm), at)
}

function resetCapture() {
  carry = new Int16Array(0)
  utterance = []
  voicedMs = 0
  silentMs = 0
  speaking = false
}

function feed(payload) {
  lastAudioAt = Date.now()
  const stereo = new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength >> 2)
  const mono = toMono48(stereo)
  const joined = carry.length ? concat16([carry, mono]) : mono
  const usable = joined.length - (joined.length % DENOISE_FRAME)
  carry = usable < joined.length ? joined.slice(usable) : new Int16Array(0)

  for (let off = 0; off < usable; off += DENOISE_FRAME) {
    const { pcm, vad } = denoiser.processFrames(joined.subarray(off, off + DENOISE_FRAME))
    const voiced = vad[0] >= vadThreshold && rmsOf(pcm) >= vadRms
    if (!speaking) {
      if (!voiced) continue
      speaking = true
      voicedMs = 0
      silentMs = 0
      utterance = []
    }
    utterance.push(pcm)
    if (voiced) {
      voicedMs += FRAME_MS
      silentMs = 0
    } else {
      silentMs += FRAME_MS
    }
    if (silentMs >= endSilenceMs) return finishUtterance('silence')
    if (utterance.length * FRAME_MS >= maxUtteranceMs) return finishUtterance('max length')
  }
}

setInterval(() => {
  if (speaking && Date.now() - lastAudioAt >= endSilenceMs) finishUtterance('no audio')
}, 100).unref()

function frameMessage(type, payload) {
  const header = Buffer.allocUnsafe(8)
  header.writeUInt32LE(type, 0)
  header.writeUInt32LE(payload.byteLength, 4)
  return Buffer.concat([header, Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)])
}

let ws = null
let recvBuf = Buffer.alloc(0)

function connect() {
  const socket = new WebSocket(wsUrl)
  socket.binaryType = 'arraybuffer'
  socket.onopen = () => {
    ws = socket
    recvBuf = Buffer.alloc(0)
    log(`connected to ${wsUrl}`)
  }
  socket.onmessage = (event) => {
    recvBuf = Buffer.concat([recvBuf, Buffer.from(event.data)])
    while (recvBuf.length >= 8) {
      const type = recvBuf.readUInt32LE(0)
      const len = recvBuf.readUInt32LE(4)
      if (recvBuf.length < 8 + len) break
      const payload = recvBuf.subarray(8, 8 + len)
      recvBuf = recvBuf.subarray(8 + len)
      if (type === MSG_AUDIO) feed(payload)
    }
  }
  socket.onerror = () => {}
  socket.onclose = () => {
    if (ws === socket) ws = null
    resetCapture()
    log(`disconnected from ${wsUrl}, retrying`)
    setTimeout(connect, 2000)
  }
}

function sendPcm(stereo) {
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('WebRig audio socket is not connected')
  for (let off = 0; off < stereo.length; off += AUDIO_FRAME_FLOATS) {
    ws.send(frameMessage(MSG_AUDIO, stereo.subarray(off, Math.min(off + AUDIO_FRAME_FLOATS, stereo.length))))
  }
}

let speakChain = Promise.resolve()
function speak(text) {
  const run = speakChain.then(async () => {
    const mono = await synthesize(tts, text)
    sendPcm(toStereo48(mono))
  })
  speakChain = run.catch((err) => log(`speak failed: ${err.message}`))
  return run
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/speak') {
    res.statusCode = 404
    return res.end()
  }
  let body = ''
  for await (const chunk of req) body += chunk
  try {
    const { text } = JSON.parse(body || '{}')
    if (!text) {
      res.statusCode = 400
      return res.end('{"error":"text required"}')
    }
    log(`speaking: ${text}`)
    await speak(text)
    res.setHeader('content-type', 'application/json')
    res.end('{"ok":true}')
  } catch (err) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: err.message }))
  }
})

server.listen(speakPort, '127.0.0.1', () => log(`speak endpoint on http://127.0.0.1:${speakPort}`))

const bridge = process.env.WEBRIG_BRIDGE === '0' ? null : spawn(process.execPath, [path.join(root, 'chatjimmy-bridge.mjs')], {
  env: { ...process.env, CCV_HOME: webrigHome, CCV_HOST_URL: `http://127.0.0.1:${speakPort}`, CJ_ECHO_WINDOW: '0' },
  stdio: 'inherit',
})
if (bridge) bridge.on('exit', (code) => log(`chatjimmy bridge exited (${code})`))

const shutdown = () => {
  bridge?.kill()
  server.close()
  ws?.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

connect()
