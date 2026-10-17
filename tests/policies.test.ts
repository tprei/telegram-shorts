import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSentences, detectStrongSpeakers } from '../src/domain/policies.js';
import type { TranscriptWord } from '../src/domain/model.js';

function word(text: string, startSeconds: number, endSeconds: number, index: number, speakerId = 'A'): TranscriptWord {
  return { id: `w_${index}`, text, startSeconds, endSeconds, speakerId, confidence: 0.9 };
}

function interleavedWords(): TranscriptWord[] {
  return [
    word('oi', 0.0, 0.5, 0),
    word('gente', 0.5, 1.0, 1),
    word('blá', 1.0, 1.5, 2, 'B'),
    word('blé', 1.5, 2.0, 3, 'B'),
    word('voltando', 2.0, 2.5, 4),
    word('ao', 2.5, 3.0, 5),
    word('assunto.', 3.0, 3.5, 6),
  ];
}

test('buildSentences maps startWord/endWord back to the original array when another speaker is interleaved', () => {
  const sentences = buildSentences(interleavedWords(), 'A');
  assert.equal(sentences.length, 2);
  assert.deepEqual(
    sentences.map((sentence) => [sentence.startWord, sentence.endWord]),
    [
      [0, 1],
      [4, 6],
    ],
  );
  assert.deepEqual(
    sentences.map((sentence) => [sentence.index, sentence.speakerId]),
    [
      [0, 'A'],
      [1, 'A'],
    ],
  );
  assert.equal(sentences[0]!.text, 'oi gente');
  assert.equal(sentences[1]!.text, 'voltando ao assunto.');
  assert.equal(sentences[1]!.startSeconds, 2.0);
  assert.equal(sentences[1]!.endSeconds, 3.5);
});

test('buildSentences breaks on speaker changes, terminal punctuation and long gaps', () => {
  const sentences = buildSentences(interleavedWords());
  assert.deepEqual(
    sentences.map((sentence) => [sentence.speakerId, sentence.startWord, sentence.endWord]),
    [
      ['A', 0, 1],
      ['B', 2, 3],
      ['A', 4, 6],
    ],
  );

  const punctuated = buildSentences([word('fecha aqui.', 0, 0.5, 0), word('começa outro', 0.6, 1.1, 1)]);
  assert.deepEqual(
    punctuated.map((sentence) => [sentence.startWord, sentence.endWord]),
    [
      [0, 0],
      [1, 1],
    ],
  );

  const gapped = buildSentences([word('um', 0, 0.5, 0), word('dois', 5.0, 5.5, 1)]);
  assert.equal(gapped.length, 2);
});

test('detectStrongSpeakers keeps only speakers above the threshold, loudest first', () => {
  const words: TranscriptWord[] = [];
  let index = 0;
  for (let second = 0; second < 20; second += 1) {
    words.push(word('palavra', second, second + 0.95, index++, 'main'));
  }
  for (let second = 20; second < 23; second += 1) {
    words.push(word('palavra', second, second + 0.95, index++, 'side'));
  }
  for (let second = 23; second < 36; second += 1) {
    words.push(word('palavra', second, second + 0.95, index++, 'other'));
  }
  const speakers = detectStrongSpeakers(words);
  assert.deepEqual(
    speakers.map((speaker) => speaker.speakerId),
    ['main', 'other'],
  );
  assert.equal(speakers[0]!.totalSeconds, 19);
  assert.equal(speakers[1]!.totalSeconds, 12.35);
  assert.ok(speakers[0]!.sampleSentences.length > 0);
  assert.ok(speakers[0]!.sampleSentences.length <= 3);
  assert.ok(speakers[0]!.sampleSentences.every((sentence) => sentence.speakerId === 'main'));
});
