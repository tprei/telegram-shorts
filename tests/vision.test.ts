import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { analyzeContentCrops, boxToSourceFocus, distributeSampleBudget, hostHeadBoxFromFrames, hostHeadSampleTimes, medianHeadBox, medianValue, parseShowinfoSceneTimes, selectSpanSamples, wordsSpokenBetween } from '../src/infra/vision.js';
import { runProcess } from '../src/infra/process.js';
import { isTransientNetworkError } from '../src/infra/instagram-publisher.js';
import { ContentPanel, HostPanel, NormRect } from '../src/domain/layout.js';
import { TranscriptWord } from '../src/domain/model.js';
import type { AppConfig } from '../src/infra/env.js';

const visionConfig = {
  OPENROUTER_API_KEY: 'test-key',
  OPENROUTER_VISION_MODEL: 'test-vision-model',
} as AppConfig;

function chatCompletion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function hostPanelFixture(): HostPanel {
  return { id: 'host', role: 'host', sourceRect: { x: 0.637, y: 0, w: 0.363, h: 1 }, canvasRect: { x: 0, y: 0.5521, w: 1, h: 0.4479 }, anchor: { x: 0.5, y: 0.42 } };
}

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

test('hostHeadSampleTimes places five frames at 10/30/50/70/90% of the video', () => {
  assert.deepEqual(hostHeadSampleTimes(40), [4, 12, 20, 28, 36]);
  assert.deepEqual(hostHeadSampleTimes(0), [0, 0, 0, 0, 0]);
});

test('medianValue returns the middle value or the mean of the two middle values', () => {
  assert.equal(medianValue([3, 1, 2]), 2);
  assert.equal(medianValue([4, 1, 3, 2]), 2.5);
  assert.equal(medianValue([7]), 7);
  assert.throws(() => medianValue([]));
});

test('medianHeadBox medians the edges and rebuilds the box, not the sizes', () => {
  const boxes: NormRect[] = [
    { x: 0.1, y: 0.05, w: 0.6, h: 0.2 },
    { x: 0.3, y: 0.4, w: 0.1, h: 0.3 },
    { x: 0.7, y: 0.1, w: 0.2, h: 0.6 },
  ];
  const sizeMedian = {
    x: medianValue([0.1, 0.3, 0.7]),
    y: medianValue([0.05, 0.4, 0.1]),
    w: medianValue([0.6, 0.1, 0.2]),
    h: medianValue([0.2, 0.3, 0.6]),
  };
  const edgeMedian = medianHeadBox(boxes);
  assertRectClose(edgeMedian, { x: 0.3, y: 0.1, w: 0.4, h: 0.6 });
  assert.notDeepEqual(edgeMedian, sizeMedian);
});

test('boxToSourceFocus maps a Gemini host head box into source-normalized coordinates', () => {
  assertRectClose(boxToSourceFocus([147, 287, 858, 1000], hostPanelFixture()), { x: 0.741181, y: 0.147, w: 0.258819, h: 0.711 });
  assertRectClose(boxToSourceFocus([171, 320, 638, 852], hostPanelFixture()), { x: 0.75316, y: 0.171, w: 0.193116, h: 0.467 });
});

test('hostHeadBoxFromFrames maps each sample and medians each edge in source coordinates', async () => {
  const panel = hostPanelFixture();
  const boxes: Array<[number, number, number, number]> = [
    [140, 280, 860, 1000],
    [150, 300, 850, 990],
    [147, 287, 858, 1000],
    [160, 310, 840, 980],
    [155, 290, 845, 995],
  ];
  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const box = boxes[call];
    call += 1;
    return chatCompletion(JSON.stringify({ box_2d: box, reason: 'cabeça do apresentador' }));
  }) as typeof fetch;
  try {
    const frames = Array.from({ length: 5 }, () => ({ mimeType: 'image/jpeg' as const, base64: 'x' }));
    const headBox = await hostHeadBoxFromFrames(visionConfig, frames, panel);
    assert.equal(call, 5);
    assertRectClose(headBox, boxToSourceFocus([150, 290, 850, 995], panel));
    assertRectClose(headBox, { x: 0.74227, y: 0.15, w: 0.255915, h: 0.7 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hostHeadBoxFromFrames throws when fewer than three samples succeed, carrying the last sample error as cause', async () => {
  const panel = hostPanelFixture();
  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    call += 1;
    if (call <= 2) {
      return chatCompletion(JSON.stringify({ box_2d: [147, 287, 858, 1000], reason: 'cabeça do apresentador' }));
    }
    return new Response('vision provider unavailable', { status: 500 });
  }) as typeof fetch;
  try {
    const frames = Array.from({ length: 5 }, () => ({ mimeType: 'image/jpeg' as const, base64: 'x' }));
    await assert.rejects(
      () => hostHeadBoxFromFrames(visionConfig, frames, panel),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /succeeded on only 2 of 5 frames/);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, /500 vision provider unavailable/);
        return true;
      },
    );
    assert.equal(call, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hostHeadBoxFromFrames carries a transient cause when the failing samples hit network errors', async () => {
  const panel = hostPanelFixture();
  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    call += 1;
    if (call <= 2) {
      return chatCompletion(JSON.stringify({ box_2d: [147, 287, 858, 1000], reason: 'cabeça do apresentador' }));
    }
    const error = new Error('connect timed out');
    (error as Error & { code: string }).code = 'ETIMEDOUT';
    throw error;
  }) as typeof fetch;
  try {
    const frames = Array.from({ length: 5 }, () => ({ mimeType: 'image/jpeg' as const, base64: 'x' }));
    await assert.rejects(
      () => hostHeadBoxFromFrames(visionConfig, frames, panel),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /succeeded on only 2 of 5 frames/);
        assert.equal(isTransientNetworkError(error.cause), true);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scene document crops respect one short-wide budget and stay in their segment', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vision-crops-'));
  const videoPath = join(dir, 'source.mp4');
  await runProcess('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=30:d=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    videoPath,
  ]);
  const panel: ContentPanel = {
    id: 'screen',
    role: 'content',
    sourceRect: { x: 0, y: 0, w: 1, h: 1 },
    canvasRect: { x: 0, y: 0.1146, w: 1, h: 0.4375 },
  };
  const spans = [
    { startSeconds: 0.2, endSeconds: 2.2, text: 'primeira fala' },
    { startSeconds: 2.6, endSeconds: 2.8, text: 'fala curta' },
    { startSeconds: 5.85, endSeconds: 6, text: 'fala final' },
  ];
  const words: TranscriptWord[] = [
    makeWord('w0', 'primeira', 0.2, 1),
    makeWord('w1', 'fala', 2.6, 2.8),
    makeWord('w2', 'final', 5.85, 5.95),
  ];
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return chatCompletion(JSON.stringify({ box_2d: [100, 100, 900, 900], reason: 'manchete' }));
  }) as typeof fetch;
  try {
    const budgeted = await analyzeContentCrops({
      config: visionConfig,
      videoPath,
      source: { width: 320, height: 180 },
      panel,
      spans,
      words,
      workDir: dir,
      maxSamples: 2,
    });
    assert.equal(calls, 2);
    assert.deepEqual(budgeted.map((keyframe) => keyframe.sourceSeconds), [0.2, 2.6]);
    assert.deepEqual(budgeted.map((keyframe) => keyframe.focus), [{ x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }]);
    assert.ok(budgeted.every((keyframe) => keyframe.origin === 'auto'));

    calls = 0;
    const full = await analyzeContentCrops({
      config: visionConfig,
      videoPath,
      source: { width: 320, height: 180 },
      panel,
      spans,
      words,
      workDir: dir,
      maxSamples: 16,
    });
    assert.equal(calls, 3);
    assert.deepEqual(full.map((keyframe) => keyframe.sourceSeconds), [0.2, 2.6, 5.85]);
    assert.ok(full.every((keyframe) => spans.some((span) =>
      keyframe.sourceSeconds >= span.startSeconds && keyframe.sourceSeconds < span.endSeconds,
    )));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});
