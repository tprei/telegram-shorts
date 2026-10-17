import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boxToSourceFocus, distributeSampleBudget, parseShowinfoSceneTimes, selectSpanSamples, wordsSpokenBetween } from '../src/infra/vision.js';
import { ContentPanel } from '../src/domain/layout.js';
import { TranscriptWord } from '../src/domain/model.js';

function makeWord(id: string, text: string, startSeconds: number, endSeconds: number): TranscriptWord {
  return { id, text, startSeconds, endSeconds, speakerId: 'S0', confidence: null };
}

function assertRectClose(actual: { x: number; y: number; w: number; h: number }, expected: { x: number; y: number; w: number; h: number }): void {
  for (const key of ['x', 'y', 'w', 'h'] as const) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${key}: ${actual[key]} ≈ ${expected[key]}`);
  }
}

test('parseShowinfoSceneTimes extracts pts_time values in order', () => {
  const stderr = [
    'ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers',
    "[Parsed_showinfo_3 @ 0x55f0a3c1b6c0] n:   0 pts:  12000 pts_time:0.5 pos:      12000 pts_time:0.5",
    '[Parsed_showinfo_3 @ 0x55f0a3c1b6c0] n:   1 pts: 108000 pts_time:4.5',
    '[Parsed_showinfo_3 @ 0x55f0a3c1b6c0] n:   2 pts: 307200 pts_time:12.8',
  ].join('\n');
  assert.deepEqual(parseShowinfoSceneTimes(stderr), [0.5, 4.5, 12.8]);
});

test('parseShowinfoSceneTimes returns empty list without matches', () => {
  assert.deepEqual(parseShowinfoSceneTimes('frame= 120 fps=80 q=-0.0 size=N/A time=00:00:02.00 bitrate=N/A speed=3.2x'), []);
});

test('selectSpanSamples starts at span start, merges samples closer than 2s, keeps first', () => {
  assert.deepEqual(selectSpanSamples(10, 60, [10.5, 14, 15.1, 22, 40]), [10, 14, 22, 40]);
});

test('selectSpanSamples filters scenes outside the span and drops scene at span start', () => {
  assert.deepEqual(selectSpanSamples(10, 60, [5, 10, 60, 70]), [10]);
});

test('selectSpanSamples caps at 8 samples per span', () => {
  const scenes = Array.from({ length: 12 }, (_, index) => 3 * (index + 1));
  assert.deepEqual(selectSpanSamples(0, 120, scenes), [0, 3, 6, 9, 12, 15, 18, 21]);
});

test('distributeSampleBudget returns spans unchanged within budget', () => {
  assert.deepEqual(distributeSampleBudget([[1, 2], [3]], 16), [[1, 2], [3]]);
});

test('distributeSampleBudget round-robins over budget in span order', () => {
  const span = Array.from({ length: 8 }, (_, index) => index);
  assert.deepEqual(distributeSampleBudget([span, span, span], 16), [
    [0, 1, 2, 3, 4, 5],
    [0, 1, 2, 3, 4],
    [0, 1, 2, 3, 4],
  ]);
});

test('distributeSampleBudget with zero budget empties every span', () => {
  assert.deepEqual(distributeSampleBudget([[1], [2, 3]], 0), [[], []]);
});

test('boxToSourceFocus maps panel-relative 0-1000 box into source-normalized rect', () => {
  const panel: ContentPanel = { id: 'screen', role: 'content', sourceRect: { x: 0, y: 0, w: 0.5, h: 1 }, canvasRect: { x: 0, y: 0, w: 1, h: 0.5 } };
  assertRectClose(boxToSourceFocus([100, 200, 500, 800], panel), { x: 0.1, y: 0.1, w: 0.3, h: 0.4 });
});

test('boxToSourceFocus offsets by the panel source rect', () => {
  const panel: ContentPanel = { id: 'screen', role: 'content', sourceRect: { x: 0.637, y: 0, w: 0.363, h: 1 }, canvasRect: { x: 0, y: 0.5, w: 1, h: 0.5 } };
  assertRectClose(boxToSourceFocus([0, 0, 1000, 1000], panel), { x: 0.637, y: 0, w: 0.363, h: 1 });
});

test('boxToSourceFocus throws on degenerate boxes', () => {
  const panel: ContentPanel = { id: 'screen', role: 'content', sourceRect: { x: 0, y: 0, w: 0.5, h: 1 }, canvasRect: { x: 0, y: 0, w: 1, h: 0.5 } };
  assert.throws(() => boxToSourceFocus([500, 0, 500, 100], panel));
  assert.throws(() => boxToSourceFocus([0, 600, 100, 600], panel));
});

test('wordsSpokenBetween joins words overlapping the interval', () => {
  const words = [
    makeWord('w1', 'olá', 0, 1),
    makeWord('w2', 'pessoal', 1, 2.4),
    makeWord('w3', 'hoje', 2.5, 3.4),
    makeWord('w4', 'tudo', 3.5, 4),
  ];
  assert.equal(wordsSpokenBetween(words, 0.5, 2.5), 'olá pessoal');
  assert.equal(wordsSpokenBetween(words, 3.45, 4), 'tudo');
  assert.equal(wordsSpokenBetween(words, 10, 20), '');
});
