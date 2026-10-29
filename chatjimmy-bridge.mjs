#!/usr/bin/env node
// Answers ccv utterances with chatjimmy as the inference, instead of a Claude session over MCP.
// Follows <CCV_HOME>/heard.jsonl. Utterances are batched until 3 s of silence, then sent to the local
// cj client as one transcript: the recent conversation, both the room's lines and the bot's own,
// followed by the new lines. A reply of "..." means stay quiet. Anything the room picks up from our
// own speaker (during playback, or echoing the last reply) is dropped so the bot does not answer itself.
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { createChatClient } from '/workspace/ccvcj/src/client.mjs';

const home = process.env.CCV_HOME ?? path.join(path.dirname(new URL(import.meta.url).pathname), '.ccv');
const heardPath = path.join(home, 'heard.jsonl');
const hostUrl = process.env.CCV_HOST_URL ?? 'http://127.0.0.1:8800';
const pollMs = 250;
const silenceMs = Number(process.env.CJ_SILENCE_MS ?? 3000);
const tailMs = 2000;
const historyBudgetChars = Number(process.env.CJ_HISTORY_CHARS ?? 1500);
const quiet = '...';
const name = process.env.CJ_NAME ?? 'Jenny';
const system = process.env.CJ_SYSTEM ?? [
  `You are ${name}, an improv performer in a voice chat.`,
  'Play yes, and: accept what the room just said as true and add one new detail on top of it. Never contradict, correct, dismiss, or quiz them.',
  'Respond to the line just said, in its own words. Each reply stands alone: no setups, no promises, no callbacks to earlier lines.',
  'This is a group conversation. Most lines are not aimed at you.',
  'Transcripts are unreliable. If a line is unclear, stay quiet rather than building on one odd word.',
  `Silence is the default. When in doubt, reply with exactly ${quiet}.`,
].join('\n');

const candidateFormat = [
  'Write 5 candidate replies in exactly this format, one pair per candidate:',
  'QUOTE: <2 to 5 words copied exactly from the latest Room line>',
  'SAY: <one spoken sentence under 15 words that plays yes, and on the QUOTE>',
  `If nothing you could say is both relevant and funny, write only: SAY: ${quiet}`,
].join('\n');

const stopWords = new Set('a an the and or but of to in on at for with is are was were be it its this that i you he she we they me my your so just do does did not no yeah oh um uh like'.split(' '));
const contentWords = (text) => (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((w) => !stopWords.has(w));

// Picks the candidate whose quote is literally in the latest room line and longest, so the
// reply is anchored to what was just said. Lexical choice only: the model is never asked to judge.
const pickCandidate = (raw, latest) => {
  const latestLower = latest.toLowerCase();
  const pairs = [...raw.matchAll(/QUOTE:\s*(.+?)\s*\n\s*SAY:\s*(.+)/gi)].map((m) => ({ quote: cleanText(m[1]).replace(/^["']|["']$/g, ''), say: cleanText(m[2]).replace(/^["']|["']$/g, '') }));
  const latestWords = new Set(contentWords(latest));
  const grounded = pairs.filter((p) => p.quote && p.say && !p.say.startsWith(quiet)
    && contentWords(p.quote).length >= 2
    && latestLower.includes(p.quote.toLowerCase())
    && contentWords(p.say).some((w) => latestWords.has(w)));
  if (!grounded.length) return null;
  return grounded.reduce((best, p) => (contentWords(p.quote).length > contentWords(best.quote).length ? p : best)).say;
};

const client = createChatClient({});
const model = process.env.CJ_MODEL ?? await client.defaultModel();

const cleanText = (text) => text.replace(/\s+/g, ' ').trim();
const words = (text) => new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? []);

// Transcript lines the model sees: { who: 'Room' | name, text }.
const transcript = [];
const transcriptChars = () => transcript.reduce((n, l) => n + l.who.length + l.text.length + 4, 0);
const trimTranscript = () => {
  while (transcript.length > 2 && transcriptChars() > historyBudgetChars) transcript.shift();
};

let speakingUntil = 0;
let lastReply = '';
const isEcho = (text) => {
  if (Date.now() < speakingUntil) return true;
  const heardWords = words(text);
  const replyWords = words(lastReply);
  if (!heardWords.size || !replyWords.size) return false;
  let shared = 0;
  for (const w of heardWords) if (replyWords.has(w)) shared += 1;
  return shared / heardWords.size >= 0.6;
};

const speak = async (text) => {
  const seconds = text.split(/\s+/).length / 2.5 + 1;
  speakingUntil = Date.now() + seconds * 1000 + tailMs;
  const res = await fetch(`${hostUrl}/speak`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`/speak ${res.status}: ${await res.text()}`);
  speakingUntil = Date.now() + tailMs;
};

const promptFor = (fresh) => {
  const before = transcript.map((l) => `${l.who}: ${l.text}`).join('\n');
  const now = fresh.map((u) => `Room: ${u.text}`).join('\n');
  const lastSaid = transcript.findLast((l) => l.who === name && l.text !== quiet);
  const followUp = lastSaid ? `You last said: "${lastSaid.text}". Work out whether the room's new lines answer it, and build on any answer.` : '';
  return [
    before && `Conversation so far:\n${before}`,
    followUp,
    `New from the room:\n${now}`,
    candidateFormat,
    `Silence is the default: if none of the candidates would land, write only SAY: ${quiet}.`,
  ].filter(Boolean).join('\n\n');
};

let offset = (await stat(heardPath).catch(() => ({ size: 0 }))).size;
let batch = [];
let timer = null;
let busy = false;

// Speech that ended but whose transcript has not arrived yet. Holds the reply briefly so the
// transcript lands in the same batch. Entries expire so a silent (empty) transcript cannot block forever.
const pendingStt = [];
const sttGraceMs = 6000;
const hasPendingStt = () => {
  const cutoff = Date.now() - sttGraceMs;
  while (pendingStt.length && pendingStt[0] < cutoff) pendingStt.shift();
  return pendingStt.length > 0;
};

const respond = async () => {
  if (busy || !batch.length) return;
  if (hasPendingStt()) {
    schedule(1000);
    return;
  }
  busy = true;
  const fresh = batch.map((u) => ({ text: cleanText(u.text) })).filter((u) => u.text);
  batch = [];
  try {
    if (!fresh.length) return;
    console.log(`heard: ${fresh.map((u) => u.text).join(' / ')}`);
    if (!contentWords(fresh.map((u) => u.text).join(' ')).length) {
      console.log('reply: (quiet, nothing to build on)');
      return;
    }
    for (const u of fresh) transcript.push({ who: 'Room', text: u.text });
    trimTranscript();
    const result = await client.chat({ model, messages: [{ role: 'user', content: promptFor(fresh) }], systemPrompt: system });
    const latest = fresh.map((u) => u.text).join(' ');
    let reply = pickCandidate(result.text, latest) ?? quiet;
    if (reply.length < 3 || reply.startsWith(quiet)) reply = quiet;
    transcript.push({ who: name, text: reply });
    trimTranscript();
    if (reply === quiet) {
      console.log(`reply: (quiet)`);
    } else {
      console.log(`reply: ${reply}`);
      lastReply = reply;
      await speak(reply);
    }
  } catch (err) {
    console.error(`bridge: ${err.message}`);
  } finally {
    busy = false;
    if (batch.length) schedule();
  }
};

let timerArmed = false;
const schedule = (ms = silenceMs) => {
  clearTimeout(timer);
  timerArmed = true;
  timer = setTimeout(() => { timerArmed = false; respond(); }, ms);
};

const poll = async () => {
  const size = (await stat(heardPath).catch(() => ({ size: 0 }))).size;
  if (size < offset) offset = 0;
  if (size === offset) return;
  const fh = await open(heardPath, 'r');
  const buf = Buffer.alloc(size - offset);
  await fh.read(buf, 0, buf.length, offset);
  await fh.close();
  offset = size;
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      // Speech ended (VAD): the silence window starts here, not when the transcript arrives.
      if (entry.event === 'speechend') {
        pendingStt.push(Date.now());
        schedule();
        continue;
      }
      if (!entry.text) continue;
      if (pendingStt.length) pendingStt.shift();
      if (isEcho(entry.text)) {
        console.log(`dropped echo: ${entry.text}`);
        continue;
      }
      batch.push(entry);
      if (!timerArmed) schedule();
    } catch { /* partial or malformed line: skip */ }
  }
};

console.log(`chatjimmy bridge: model ${model}, ${silenceMs} ms silence window, following ${heardPath}, speaking via ${hostUrl}`);
setInterval(() => { poll().catch((err) => console.error(`bridge: ${err.message}`)); }, pollMs);
