// Plays one reply as a single continuous stream. Sentences are written as soon as they are synthesized, so synthesis runs
// ahead of playback and the player never idles between sentences. Playback starts once prebufferMs of audio is queued.
import { PassThrough } from 'node:stream';
import { AudioPlayerStatus, createAudioResource, entersState, StreamType } from '@discordjs/voice';

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

const createResource = (feed) => createAudioResource(feed, { inputType: StreamType.Raw });

export async function playReply({ player, sentences, prebufferMs, sampleRate = 24000, idleTimeoutMs = 120000 }) {
  const feed = new PassThrough();
  let queuedMs = 0;
  let started = false;
  try {
    for await (const pcm of sentences) {
      feed.write(Buffer.from(toPlaybackPcm(pcm).buffer));
      queuedMs += (pcm.length / sampleRate) * 1000;
      if (!started && queuedMs >= prebufferMs) {
        player.play(createResource(feed));
        started = true;
      }
    }
  } finally {
    feed.end();
  }
  if (queuedMs === 0) return;
  if (!started) player.play(createResource(feed));
  await entersState(player, AudioPlayerStatus.Idle, idleTimeoutMs).catch(() => {});
}
