// Joins a speaker's fragments into whole sentences. A fragment that ends a sentence goes out at once; one that does not
// waits up to holdMs for the same speaker's next utterance, so the channel never receives a half sentence.
const ENDS_SENTENCE = /[.!?…]["')\]]?$/;

export function createUtteranceJoiner({ holdMs, onFlush }) {
  const held = new Map();
  const flush = (userId) => {
    const pending = held.get(userId);
    if (!pending) return;
    clearTimeout(pending.timer);
    held.delete(userId);
    onFlush(userId, pending.parts);
  };
  return {
    add(userId, part) {
      const pending = held.get(userId) ?? { parts: [], timer: null };
      pending.parts.push(part);
      clearTimeout(pending.timer);
      held.set(userId, pending);
      if (ENDS_SENTENCE.test(part.text)) flush(userId);
      else pending.timer = setTimeout(() => flush(userId), holdMs);
    },
  };
}
