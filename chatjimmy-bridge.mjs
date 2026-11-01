#!/usr/bin/env node
// Answers ccv utterances with chatjimmy as the inference, instead of a Claude session over MCP.
// Follows <CCV_HOME>/heard.jsonl. Utterances are batched per speech end, then sent to the local
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
const tailMs = 2000;
const historyBudgetChars = Number(process.env.CJ_HISTORY_CHARS ?? 2500);
const quiet = '...';
const name = process.env.CJ_NAME ?? 'Jenny';
const system = process.env.CJ_SYSTEM ?? [
  `You are ${name}, a playful, edgy improv performer in a voice chat. Hilarious is the goal; relevant is the constituent: every line must relate to what was just said, and the aim is to make it funny. Accept what was said as true, then add one new detail with a bit of bite. Never contradict or correct them.`,
  'Use the room\'s own words and register. Pick up and riff on jokes or phrases the room has already used; plant nothing new for later.',
  'If something is new or unclear to you, ask a short question instead of pretending to know it. Playful exaggeration is fine; claim no real facts you cannot know.',
  'Think privately inside (brackets) if you need to; brackets are never spoken.',
  'Most lines are not for you, and transcripts are often wrong: skip a line only when it is truly not for you or truly unclear.',
  `Answer people who reply to you. Otherwise reply with exactly ${quiet} when you have nothing worth saying.`,
].join('\n');

// Three candidates normally; five when someone is talking to us, to give the pick more to choose from.
const candidateFormat = (count) => [
  `${count} candidates, exactly this format:`,
  'QUOTE: <2 to 5 words copied exactly from the latest Room line>',
  'SAY: <one spoken sentence under 15 words>',
  `Or SAY: ${quiet} if none would land.`,
].join('\n');

const stopWords = new Set('a an the and or but of to in on at for with is are was were be it its this that i you he she we they me my your so just do does did not no yeah oh um uh like'.split(' '));
const contentWords = (text) => (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((w) => !stopWords.has(w));

// Picks the candidate whose quote is literally in the latest room line and longest, so the
// reply is anchored to what was just said. Lexical choice only: the model is never asked to judge.
const stripBrackets = (text) => cleanText(text.replace(/\([^)]*\)/g, ' ')).replace(/^["']|["']$/g, '');
const pickCandidate = (raw, latest, addressed = false) => {
  const latestLower = latest.toLowerCase();
  const pairs = [...raw.matchAll(/QUOTE:\s*(.+?)\s*\n\s*SAY:\s*(.+)/gi)].map((m) => ({ quote: cleanText(m[1]).replace(/^["']|["']$/g, ''), say: stripBrackets(m[2]) }));
  // Someone talking to us directly gets an answer, with no grounding filter.
  if (addressed) {
    // Prefer an answer that reuses a word from what was just said; otherwise take the first real answer.
    const referents = new Set(contentWords(latest));
    const real = pairs.filter((p) => p.say && !p.say.startsWith(quiet) && contentWords(p.say).length >= 1);
    const answer = real.find((p) => contentWords(p.say).some((w) => referents.has(w))) ?? real[0];
    return answer?.say ?? null;
  }
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

// The playback echo window only matters when our own speaker can reach our mic (the LiveKit room).
// WebRig's runner turns the window off (CJ_ECHO_WINDOW=0).
const echoWindow = process.env.CJ_ECHO_WINDOW !== '0';
let speakingUntil = 0;
let lastReply = '';
let lastSpokeAt = 0;
// A room reply within this window is an answer to us, even without our name or a "you".
const replyWindowMs = 30000;
const isEcho = (text) => {
  if (echoWindow && Date.now() < speakingUntil) return true;
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

// Someone is talking to us when they say our name, or ask a question that includes "you".
const questionWords = /\b(what|why|how|who|where|when|do|does|did|are|is|can|could|would|will)\b/i;
const isAddressed = (text) => new RegExp(`\\b${name}\\b`, 'i').test(text) || (/\byou\b/i.test(text) && questionWords.test(text));

const promptFor = (fresh, addressed) => {
  const before = transcript.map((l) => `${l.who}: ${l.text}`).join('\n');
  const now = fresh.map((u) => `Room: ${u.text}`).join('\n');
  const lastSaid = transcript.findLast((l) => l.who === name && l.text !== quiet);
  return [
    before && `Conversation so far:\n${before}`,
    `Latest from the room:\n${now}`,
    lastSaid && `You last said: "${lastSaid.text}"`,
    addressed && `They are talking to you: answer them.`,
    candidateFormat(addressed ? 5 : 3),
  ].filter(Boolean).join('\n\n');
};

let offset = (await stat(heardPath).catch(() => ({ size: 0 }))).size;
let batch = [];
let timer = null;
let busy = false;

// Speech that ended but whose transcript has not arrived yet. Holds the reply briefly so the
// transcript lands in the same batch. Entries expire so a transcript that never arrives cannot block forever.
const pendingStt = [];
const sttGraceMs = 2000;
const hasPendingStt = () => {
  const cutoff = Date.now() - sttGraceMs;
  while (pendingStt.length && pendingStt[0] < cutoff) pendingStt.shift();
  return pendingStt.length > 0;
};

const respond = async () => {
  if (busy || !batch.length) return;
  if (hasPendingStt()) {
    schedule(250);
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
    const latest = fresh.map((u) => u.text).join(' ');
    const addressed = isAddressed(latest) || Date.now() - lastSpokeAt < replyWindowMs;
    const result = await client.chat({ model, messages: [{ role: 'user', content: promptFor(fresh, addressed) }], systemPrompt: system });
    let reply = pickCandidate(result.text, latest, addressed) ?? quiet;
    if (reply.length < 3 || reply.startsWith(quiet)) reply = quiet;
    transcript.push({ who: name, text: reply });
    trimTranscript();
    if (reply === quiet) {
      console.log(`reply: (quiet)`);
    } else {
      console.log(`reply: ${reply}`);
      lastReply = reply;
      lastSpokeAt = Date.now();
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
const schedule = (ms = 0) => {
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
      if (pendingStt.length) pendingStt.shift();
      if (!entry.text) continue;
      if (isEcho(entry.text)) {
        console.log(`dropped echo: ${entry.text}`);
        continue;
      }
      batch.push(entry);
      if (!timerArmed) schedule();
    } catch { /* partial or malformed line: skip */ }
  }
};

console.log(`chatjimmy bridge: model ${model}, following ${heardPath}, speaking via ${hostUrl}`);
setInterval(() => { poll().catch((err) => console.error(`bridge: ${err.message}`)); }, pollMs);
