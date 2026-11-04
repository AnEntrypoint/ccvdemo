// The audio this machine plays (listened to) and the microphone input replies are spoken into, as raw PCM on stdio.
// Linux uses PulseAudio's parec and paplay, which PipeWire also serves. macOS and Windows use ffmpeg to capture and
// ffplay to play. Capturing system output needs a loopback device there (BlackHole, Stereo Mix, VB-Cable), set as
// MIC_LISTEN, or a whole command through MIC_CAPTURE_CMD. MIC_PLAY_CMD replaces playback the same way.
import { spawn } from 'node:child_process';

export const CAPTURE_RATE = 48000;
export const PLAY_RATE = 24000;
// PipeWire buffers a capture stream for about 1.5 s unless asked for less, which would delay every utterance and the echo gate.
const CAPTURE_LATENCY_MS = 40;

const FFMPEG_CAPTURE_HINT = 'install ffmpeg and put it on PATH, or set MIC_CAPTURE_CMD';

function ffmpegCapture(format, device) {
  return ['-hide_banner', '-loglevel', 'error', '-f', format, '-i', device, '-ac', '1', '-ar', String(CAPTURE_RATE), '-f', 's16le', 'pipe:1'];
}

function captureSpec() {
  if (process.env.MIC_CAPTURE_CMD) {
    return { command: process.env.MIC_CAPTURE_CMD, args: [], shell: true, hint: 'check MIC_CAPTURE_CMD' };
  }
  const listen = process.env.MIC_LISTEN || null;
  switch (process.platform) {
    case 'linux':
      return {
        command: 'parec',
        args: ['--raw', '--format=s16le', `--rate=${CAPTURE_RATE}`, '--channels=1', `--latency-msec=${CAPTURE_LATENCY_MS}`, `--device=${listen ?? '@DEFAULT_MONITOR@'}`],
        hint: 'install pulseaudio-utils (parec) or set MIC_CAPTURE_CMD',
      };
    case 'darwin':
      return { command: 'ffmpeg', args: ffmpegCapture('avfoundation', `:${listen ?? '0'}`), hint: FFMPEG_CAPTURE_HINT };
    case 'win32':
      if (!listen) throw new Error('set MIC_LISTEN to the dshow device that carries system output (e.g. Stereo Mix or CABLE Output; list them: ffmpeg -list_devices true -f dshow -i dummy)');
      return { command: 'ffmpeg', args: ffmpegCapture('dshow', `audio=${listen}`), hint: FFMPEG_CAPTURE_HINT };
    default:
      throw new Error(`no default microphone command on ${process.platform}; set MIC_CAPTURE_CMD`);
  }
}

function playSpec() {
  if (process.env.MIC_PLAY_CMD) {
    return { command: process.env.MIC_PLAY_CMD, args: [], shell: true, hint: 'check MIC_PLAY_CMD' };
  }
  const speak = process.env.MIC_SPEAK || null;
  switch (process.platform) {
    case 'linux':
      return {
        command: 'paplay',
        args: ['--raw', '--format=s16le', `--rate=${PLAY_RATE}`, '--channels=1', ...(speak ? [`--device=${speak}`] : [])],
        hint: 'install pulseaudio-utils (paplay) or set MIC_PLAY_CMD',
      };
    case 'darwin':
    case 'win32':
      return {
        command: 'ffplay',
        args: ['-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit', '-f', 's16le', '-ar', String(PLAY_RATE), '-ac', '1', '-i', 'pipe:0'],
        hint: 'install ffmpeg (it ships ffplay), or set MIC_PLAY_CMD to a command that plays into the virtual mic',
      };
    default:
      throw new Error(`no default playback command on ${process.platform}; set MIC_PLAY_CMD`);
  }
}

// Keeps only the tail of a child's stderr so a failure message names the cause without holding the whole log.
function tailOf(stderr) {
  return stderr.trim().split('\n').slice(-2).join(' ');
}

function failure(spec, err) {
  if (err.code === 'ENOENT') return Object.assign(new Error(`${spec.command} not found: ${spec.hint}`), { code: 'ENOENT' });
  return err;
}

// Calls onData with each raw chunk. onExit runs once if the capture ends on its own; stop() ends it quietly.
export function startCapture({ onData, onExit }) {
  const spec = captureSpec();
  const child = spawn(spec.command, spec.args, { shell: spec.shell, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let finished = false;
  const finish = (err) => {
    if (finished) return;
    finished = true;
    onExit(err);
  };
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-500); });
  child.stdout.on('data', onData);
  child.on('error', (err) => finish(failure(spec, err)));
  child.on('close', (code) => finish(new Error(`${spec.command} exited${code === null ? '' : ` with ${code}`}${stderr ? `: ${tailOf(stderr)}` : ''}`)));
  return {
    stop() {
      finished = true;
      child.kill();
    },
  };
}

// Plays raw PCM written to stdin. done settles when playback has drained and the process exits.
export function startPlayback() {
  const spec = playSpec();
  const child = spawn(spec.command, spec.args, { shell: spec.shell, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-500); });
  child.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => {
    child.on('error', (err) => reject(failure(spec, err)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${spec.command} exited${code === null ? '' : ` with ${code}`}${stderr ? `: ${tailOf(stderr)}` : ''}`));
    });
  });
  done.catch(() => {});
  return { stdin: child.stdin, done, kill: () => child.kill() };
}
