import type { SpeakerSample, TranscriptSentence, TranscriptWord } from './model.js';

export function buildSentences(words: TranscriptWord[], chosenSpeakerId?: string): TranscriptSentence[] {
  const entries = words.map((word, index) => ({ word, index }));
  const filtered = chosenSpeakerId
    ? entries.filter((entry) => entry.word.speakerId === chosenSpeakerId)
    : entries;
  const ordered = filtered.sort(
    (left, right) => left.word.startSeconds - right.word.startSeconds || left.word.endSeconds - right.word.endSeconds,
  );
  const sentences: TranscriptSentence[] = [];
  let current: Array<{ word: TranscriptWord; index: number }> = [];
  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const sentence: TranscriptSentence = {
      id: `s_${String(sentences.length + 1).padStart(4, '0')}`,
      index: sentences.length,
      speakerId: current[0].word.speakerId,
      startWord: current[0].index,
      endWord: current[current.length - 1].index,
      startSeconds: current[0].word.startSeconds,
      endSeconds: current[current.length - 1].word.endSeconds,
      text: '',
    };
    sentence.text = sentenceText(words, sentence);
    if (sentence.text.length > 0) {
      sentences.push(sentence);
    }
    current = [];
  };
  for (const [position, entry] of ordered.entries()) {
    if (current.length > 0) {
      const previous = current[current.length - 1];
      if (previous.word.speakerId !== entry.word.speakerId || entry.word.startSeconds - previous.word.endSeconds > 0.9) {
        flush();
      }
    }
    current.push(entry);
    const next = ordered[position + 1];
    const gapToNext = next ? next.word.startSeconds - entry.word.endSeconds : 0;
    const duration = current[current.length - 1].word.endSeconds - current[0].word.startSeconds;
    if (!next || endsSentence(entry.word.text) || gapToNext > 0.75 || (duration > 18 && gapToNext > 0.25)) {
      flush();
    }
  }
  flush();
  return sentences;
}

export function sentenceText(words: TranscriptWord[], sentence: TranscriptSentence): string {
  const texts: string[] = [];
  for (let index = sentence.startWord; index <= sentence.endWord; index += 1) {
    const word = words[index];
    if (word !== undefined && word.speakerId === sentence.speakerId) {
      texts.push(word.text);
    }
  }
  return normalizeSentenceText(texts.join(' '));
}

export function detectStrongSpeakers(words: TranscriptWord[]): SpeakerSample[] {
  const buckets = new Map<string, { totalSeconds: number }>();
  for (const word of words) {
    const current = buckets.get(word.speakerId) ?? { totalSeconds: 0 };
    current.totalSeconds += Math.max(0, word.endSeconds - word.startSeconds);
    buckets.set(word.speakerId, current);
  }
  const totalSpeech = [...buckets.values()].reduce((sum, value) => sum + value.totalSeconds, 0);
  const threshold = Math.max(12, totalSpeech * 0.18);
  const sentences = buildSentences(words);
  return [...buckets.entries()]
    .filter(([, value]) => value.totalSeconds >= threshold)
    .sort((left, right) => right[1].totalSeconds - left[1].totalSeconds)
    .map(([speakerId, value]) => ({
      speakerId,
      totalSeconds: roundSeconds(value.totalSeconds),
      sampleSentences: sentences.filter((sentence) => sentence.speakerId === speakerId).slice(0, 3),
    }));
}

function normalizeSentenceText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function endsSentence(text: string): boolean {
  const value = text.trim();
  return value.endsWith('.') || value.endsWith('!') || value.endsWith('?') || value.endsWith('…');
}
