import { readFile, writeFile } from 'node:fs/promises';

export async function readWavMono(file, targetRate) {
  const buf = await readFile(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file} is not a WAV file`);
  }
  let fmt = null;
  let data = null;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${file} has no fmt or data chunk`);
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error(`${file} must be 16-bit PCM WAV (got format ${fmt.format}, ${fmt.bits}-bit); convert it with ffmpeg first`);
  }
  const frames = Math.floor(data.length / (2 * fmt.channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2);
    mono[i] = sum / fmt.channels;
  }
  return { pcm: resample(mono, fmt.rate, targetRate), seconds: frames / fmt.rate };
}

function resample(mono, from, to) {
  if (from === to) return Int16Array.from(mono);
  const outLen = Math.floor((mono.length * to) / from);
  const out = new Int16Array(outLen);
  const step = from / to;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = mono[j] ?? 0;
    const b = mono[j + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

export async function writeWavMono(file, pcm, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length * 2, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length * 2, 40);
  const body = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  await writeFile(file, Buffer.concat([header, body]));
}
