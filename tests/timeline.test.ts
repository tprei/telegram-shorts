import assert from 'node:assert/strict';
import test from 'node:test';
import type { ShortEdit } from '../src/domain/edit.js';
import type { TranscriptWord } from '../src/domain/model.js';
import type { LayoutProfile } from '../src/domain/layout.js';
import {
  END_CARD_SECONDS,
  activeCueAt,
  buildTimeline,
  computeSourceClips,
  outputDurationSeconds,
  outputToSource,
  sourceToOutput,
} from '../src/domain/timeline.js';
import type { Timeline } from '../src/domain/timeline.js';
import {
  MAX_CONTENT_ZOOM,
  contentSourceCrop,
  fitRectToAspect,
  hostSourceCrop,
  normToPx,
  panelCanvasRect,
  toEvenPxRect,
} from '../src/domain/geometry.js';

function approx(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be close to ${expected}`);
}

function word(text: string, startSeconds: number, endSeconds: number, index: number): TranscriptWord {
  return { id: `w_${index}`, text, startSeconds, endSeconds, speakerId: 'A', confidence: 0.9 };
}

function studioWords(): TranscriptWord[] {
  const spans: Array<[number, number]> = [
    [0.0, 0.48],
    [0.5, 0.98],
    [1.0, 1.48],
    [1.5, 1.98],
    [2.0, 2.48],
    [2.5, 2.98],
    [5.0, 5.48],
    [5.5, 5.98],
    [6.0, 6.48],
    [6.5, 6.98],
    [7.0, 7.48],
    [7.5, 7.98],
  ];
  return spans.map(([start, end], index) => word(`palavra${index}`, start, end, index));
}

function baseEdit(): ShortEdit {
  return {
    ranges: [
      { startWord: 0, endWord: 5 },
      { startWord: 6, endWord: 11 },
    ],
    removedWords: [2],
    tightenPauses: { enabled: true, maxGapSeconds: 0.35 },
    speed: 1,
    hook: { enabled: false, text: '' },
    captions: { enabled: true },
    crops: [],
    zoom: { enabled: true, strength: 1.12 },
    endCard: { enabled: false },
  };
}

const layout: LayoutProfile = {
  version: 2,
  creatorId: 'filipe_boni',
  layoutId: 'screen-top-host-bottom-v2',
  canvas: { width: 1080, height: 1920, fps: 30 },
  background: '#101010',
  defaultSpeed: 1.1,
  font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
  panels: [
    { id: 'screen', role: 'content', sourceRect: { x: 0, y: 0, w: 0.632, h: 1 }, canvasRect: { x: 0, y: 0.1146, w: 1, h: 0.4375 } },
    {
      id: 'host',
      role: 'host',
      sourceRect: { x: 0.637, y: 0, w: 0.363, h: 1 },
      canvasRect: { x: 0, y: 0.5521, w: 1, h: 0.4479 },
      anchor: { x: 0.5, y: 0.42 },
    },
  ],
  hookBand: {
    rect: { x: 0, y: 0, w: 1, h: 0.1146 },
    background: '#C8102E',
    textColor: '#FFFFFF',
    sizePx: 58,
    maxCharsPerLine: 24,
    maxLines: 2,
    uppercase: true,
  },
  captions: {
    sizePx: 62,
    textColor: '#FFFFFF',
    highlightColor: '#FFD400',
    outlineColor: '#000000',
    outlinePx: 6,
    shadowPx: 2,
    uppercase: true,
    maxWordsPerCue: 4,
    maxCharsPerLine: 16,
    maxLines: 2,
    centerY: 0.5521,
  },
};

const source = { width: 1920, height: 1080, durationSeconds: 180 };
const testTitle = 'Um titulo de teste';

function contiguousWords(texts: string[], startSeconds = 0, secondsPerWord = 0.5): TranscriptWord[] {
  return texts.map((text, index) =>
    word(text, startSeconds + index * secondsPerWord, startSeconds + (index + 1) * secondsPerWord - 0.02, index),
  );
}

function singleRangeEdit(texts: TranscriptWord[]): ShortEdit {
  return { ...baseEdit(), ranges: [{ startWord: 0, endWord: texts.length - 1 }], removedWords: [], tightenPauses: { enabled: false, maxGapSeconds: 0.35 } };
}

test('computeSourceClips splits at pause gaps above the threshold and not below', () => {
  const words = studioWords();
  const clips = computeSourceClips(baseEdit(), words, source.durationSeconds);
  assert.equal(clips.length, 3);
  approx(clips[0]!.sourceStart, 0);
  approx(clips[0]!.sourceEnd, 0.99);
  approx(clips[1]!.sourceStart, 1.49);
  approx(clips[1]!.sourceEnd, 3.10);
  approx(clips[2]!.sourceStart, 4.92);
  approx(clips[2]!.sourceEnd, 8.10);
  assert.deepEqual(clips.map((clip) => clip.firstWord), [0, 3, 6]);
  assert.deepEqual(clips.map((clip) => clip.lastWord), [1, 5, 11]);
  assert.ok(clips.every((clip) => !clip.joinsPrevious));

  const belowThreshold = { ...baseEdit(), ranges: [{ startWord: 0, endWord: 5 }, { startWord: 6, endWord: 11 }], removedWords: [] };
  const nearWords = studioWords().map((entry, index) =>
    index >= 6
      ? { ...entry, startSeconds: 3.28 + (index - 6) * 0.5, endSeconds: 3.76 + (index - 6) * 0.5 }
      : entry,
  );
  const joined = computeSourceClips(belowThreshold, nearWords, source.durationSeconds);
  assert.equal(joined.length, 1);
  assert.deepEqual([joined[0]!.firstWord, joined[0]!.lastWord], [0, 11]);
});

test('tightenPauses disabled merges the gap-separated groups back together', () => {
  const words = studioWords();
  const edit = { ...baseEdit(), tightenPauses: { enabled: false, maxGapSeconds: 0.35 } };
  const clips = computeSourceClips(edit, words, source.durationSeconds);
  assert.equal(clips.length, 2);
  approx(clips[1]!.sourceStart, 1.49);
  approx(clips[1]!.sourceEnd, 8.10);
});

test('removed words never contribute audio and padding stops at the neighbour midpoint', () => {
  const words = studioWords();
  const clips = computeSourceClips(baseEdit(), words, source.durationSeconds);
  for (const clip of clips) {
    assert.ok(clip.sourceEnd <= 1.0 || clip.sourceStart >= 1.48, `clip ${clip.sourceStart}..${clip.sourceEnd} covers removed word 2`);
  }
  approx(clips[0]!.sourceEnd, 0.99);
  approx(clips[1]!.sourceStart, 1.49);
});

test('clips join when the pad lands exactly on the shared midpoint of a cut word', () => {
  const words = [word('a', 0, 0.5, 0), word('b', 0.5, 0.5, 1), word('c', 0.5, 0.98, 2)];
  const edit = { ...baseEdit(), ranges: [{ startWord: 0, endWord: 2 }], removedWords: [1] };
  const clips = computeSourceClips(edit, words, 180);
  assert.equal(clips.length, 2);
  approx(clips[0]!.sourceEnd, 0.5);
  approx(clips[1]!.sourceStart, 0.5);
  assert.equal(clips[1]!.joinsPrevious, true);
});

test('speed scales output times and outputDurationSeconds', () => {
  const words = studioWords();
  const fast = buildTimeline({ edit: { ...baseEdit(), speed: 2 }, words, layout, title: testTitle, source });
  const slow = buildTimeline({ edit: baseEdit(), words, layout, title: testTitle, source });
  assert.equal(fast.speed, 2);
  approx(fast.durationSeconds, slow.durationSeconds / 2, 1 / layout.canvas.fps);
  approx(outputDurationSeconds(baseEdit(), words, source.durationSeconds), slow.durationSeconds, 0.06);
  approx(outputDurationSeconds({ ...baseEdit(), speed: 2 }, words, source.durationSeconds), slow.durationSeconds / 2, 0.06);
  approx(fast.clips[0]!.outputEnd, slow.clips[0]!.outputEnd / 2);
  approx(fast.clips[2]!.outputStart, slow.clips[2]!.outputStart / 2);
});

test('crop keyframes split clips into joinsPrevious sub-clips inside the margin only', () => {
  const words = studioWords();
  const edit: ShortEdit = {
    ...baseEdit(),
    crops: [
      { sourceSeconds: 5.5, focus: { x: 0, y: 0, w: 0.5, h: 0.5 }, origin: 'auto' },
      { sourceSeconds: 2, focus: { x: 0.6, y: 0.6, w: 0.1, h: 0.1 }, origin: 'manual' },
    ],
  };
  const timeline = buildTimeline({ edit, words, layout, title: testTitle, source });
  const expected: Array<[number, number, boolean]> = [
    [0, 1, false],
    [1.49, 1.99, false],
    [2, 3.1, true],
    [4.92, 4.92 + 17 / 30, false],
    [5.5, 8.1, true],
  ];
  assert.equal(timeline.clips.length, expected.length);
  for (const [index, clip] of timeline.clips.entries()) {
    const [wantStart, wantEnd, wantJoins] = expected[index]!;
    approx(clip.sourceStart, wantStart);
    approx(clip.sourceEnd, wantEnd);
    assert.equal(clip.joinsPrevious, wantJoins);
  }
  const last = timeline.clips[timeline.clips.length - 1]!;
  assert.equal(last.joinsPrevious, true);

  const insideMargin = buildTimeline({ edit: { ...baseEdit(), crops: [{ sourceSeconds: 1.7, focus: { x: 0, y: 0, w: 0.5, h: 0.5 }, origin: 'auto' }] }, words, layout, title: testTitle, source });
  assert.equal(insideMargin.clips.length, 3);
});

test('zoom toggles only at real cuts and persists across joined clips', () => {
  const words = studioWords();
  const edit: ShortEdit = {
    ...baseEdit(),
    crops: [
      { sourceSeconds: 5.5, focus: { x: 0, y: 0, w: 0.5, h: 0.5 }, origin: 'auto' },
      { sourceSeconds: 2, focus: { x: 0.6, y: 0.6, w: 0.1, h: 0.1 }, origin: 'auto' },
    ],
  };
  const timeline = buildTimeline({ edit, words, layout, title: testTitle, source });
  assert.deepEqual(
    timeline.clips.map((clip) => clip.zoom),
    [1, 1.12, 1.12, 1, 1],
  );
  const disabled = buildTimeline({ edit: { ...edit, zoom: { enabled: false, strength: 1.12 } }, words, layout, title: testTitle, source });
  assert.ok(disabled.clips.every((clip) => clip.zoom === 1));
  const joined = buildTimeline({
    edit: { ...baseEdit(), ranges: [{ startWord: 0, endWord: 2 }], removedWords: [1] },
    words: [word('a', 0, 0.5, 0), word('b', 0.5, 0.5, 1), word('c', 0.5, 0.98, 2)],
    layout,
    source,
  });
  assert.deepEqual(
    joined.clips.map((clip) => clip.zoom),
    [1, 1],
  );
});

test('panel placements keep aspect, stay in bounds and follow the active crop focus', () => {
  const words = studioWords();
  const edit: ShortEdit = {
    ...baseEdit(),
    crops: [
      { sourceSeconds: 5.5, focus: { x: 0, y: 0, w: 0.5, h: 0.5 }, origin: 'manual' },
      { sourceSeconds: 2, focus: { x: 0.6, y: 0.6, w: 0.1, h: 0.1 }, origin: 'auto' },
    ],
  };
  const timeline = buildTimeline({ edit, words, layout, title: testTitle, source });
  assert.equal(timeline.clips.length, 5);
  for (const clip of timeline.clips) {
    assert.deepEqual(clip.panels.map((panel) => panel.panelId), ['screen', 'host']);
    assert.deepEqual(clip.panels.map((panel) => panel.role), ['content', 'host']);
    for (const placement of clip.panels) {
      const { source: src, canvas } = placement;
      assert.ok(src.x >= 0 && src.y >= 0, `crop origin ${src.x},${src.y} outside source`);
      assert.ok(src.x + src.w <= source.width && src.y + src.h <= source.height, `crop ${src.x},${src.y},${src.w},${src.h} outside source`);
      assert.ok(Math.abs(src.w / src.h - canvas.w / canvas.h) < 0.02, `crop aspect ${src.w / src.h} != canvas aspect ${canvas.w / canvas.h}`);
      assert.equal(src.w % 2, 0);
      assert.equal(src.h % 2, 0);
      assert.equal(canvas.w % 2, 0);
      assert.equal(canvas.h % 2, 0);
    }
  }
  assert.deepEqual(timeline.clips[0]!.panels[0]!.source, { x: 0, y: 68, w: 1212, h: 942 });
  assert.deepEqual(timeline.clips[2]!.panels[0]!.source, { x: 728, y: 512, w: 484, h: 376 });
  assert.deepEqual(timeline.clips[3]!.panels[0]!.source, { x: 728, y: 512, w: 484, h: 376 });
  assert.deepEqual(timeline.clips[4]!.panels[0]!.source, { x: 0, y: 0, w: 960, h: 746 });
  const zoomed = timeline.clips[1]!.panels[1]!.source;
  const unzoomed = timeline.clips[0]!.panels[1]!.source;
  assert.ok(zoomed.w < unzoomed.w);
  assert.ok(zoomed.x >= 0.637 * source.width - 2 && zoomed.x + zoomed.w <= source.width);
});

test('outputToSource and sourceToOutput round-trip and null inside cuts', () => {
  const words = studioWords();
  const timeline = buildTimeline({ edit: baseEdit(), words, layout, title: testTitle, source });
  for (const t of [0, 0.5, 0.99, 1.5, 2.7, 5.7]) {
    const { clipIndex, sourceSeconds } = outputToSource(timeline, t);
    assert.ok(sourceToOutput(timeline, sourceSeconds) !== null);
    approx(sourceToOutput(timeline, sourceSeconds)!, t, 1e-9);
    assert.equal(timeline.clips[clipIndex]!.index, clipIndex);
  }
  const inside = outputToSource(timeline, 1.5);
  assert.equal(inside.clipIndex, 1);
  approx(inside.sourceSeconds, 1.99);
  assert.equal(sourceToOutput(timeline, 1.2), null);
  assert.equal(sourceToOutput(timeline, 4.0), null);
  assert.equal(sourceToOutput(timeline, -1), null);
  const clamped = outputToSource(timeline, 999);
  approx(clamped.sourceSeconds, timeline.clips[timeline.clips.length - 1]!.sourceEnd);
  const atZero = outputToSource(timeline, -5);
  assert.equal(atZero.clipIndex, 0);
  approx(atZero.sourceSeconds, 0);
});

test('empty edits produce an empty timeline and safe mapping', () => {
  const words = studioWords();
  const edit = { ...baseEdit(), ranges: [{ startWord: 0, endWord: 1 }], removedWords: [0, 1] };
  const timeline = buildTimeline({ edit, words, layout, title: testTitle, source });
  assert.deepEqual(timeline.clips, []);
  assert.equal(timeline.durationSeconds, 0);
  assert.deepEqual(timeline.cues, []);
  assert.equal(activeCueAt(timeline, 0), null);
  assert.deepEqual(outputToSource(timeline, 3), { clipIndex: 0, sourceSeconds: 0 });
  assert.equal(sourceToOutput(timeline, 1), null);
  assert.equal(outputDurationSeconds(edit, words, source.durationSeconds), 0);
});

function captionTimeline(texts: string[]): Timeline {
  const words = contiguousWords(texts);
  return buildTimeline({ edit: singleRangeEdit(words), words, layout, title: testTitle, source });
}

test('cues break on max words, punctuation, gaps and line overflow', () => {
  const fourWord = captionTimeline(['um', 'dois', 'três', 'quatro.', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez']);
  assert.deepEqual(
    fourWord.cues.map((cue) => cue.lines.map((line) => line.map((word) => word.text))),
    [
      [['UM', 'DOIS', 'TRÊS'], ['QUATRO.']],
      [['CINCO', 'SEIS', 'SETE'], ['OITO']],
      [['NOVE', 'DEZ']],
    ],
  );
  approx(fourWord.cues[0]!.outputStart, 0);
  approx(fourWord.cues[0]!.outputEnd, fourWord.cues[1]!.outputStart);
  approx(fourWord.cues[1]!.outputStart, 2.0);
  approx(fourWord.cues[2]!.outputEnd, 4.98 + 0.25);

  const punctuated = captionTimeline(['sim.', 'não', 'talvez', 'hoje']);
  assert.deepEqual(
    punctuated.cues.map((cue) => cue.lines.flat().length),
    [1, 3],
  );

  const gapped = buildTimeline({
    edit: singleRangeEdit(contiguousWords(['um', 'dois', 'três', 'quatro'])),
    words: [word('um', 0, 0.48, 0), word('dois', 0.5, 0.98, 1), word('três', 2.0, 2.48, 2), word('quatro', 2.5, 2.98, 3)],
    layout,
    title: testTitle,
    source,
  });
  assert.deepEqual(
    gapped.cues.map((cue) => cue.lines.flat().map((entry) => entry.wordIndex)),
    [[0, 1], [2, 3]],
  );

  const overflow = captionTimeline(['paralelepípedo', 'internacional', 'extraordinário']);
  assert.equal(overflow.cues.length, 2);
  assert.equal(overflow.cues[0]!.lines.length, 2);
  assert.deepEqual(overflow.cues[0]!.lines.map((line) => line.map((entry) => entry.text)), [['PARALELEPÍPEDO'], ['INTERNACIONAL']]);
  assert.equal(overflow.cues[1]!.lines.length, 1);
});

test('captions disabled produce no cues', () => {
  const words = contiguousWords(['um', 'dois', 'três']);
  const timeline = buildTimeline({ edit: { ...singleRangeEdit(words), captions: { enabled: false } }, words, layout, title: testTitle, source });
  assert.deepEqual(timeline.cues, []);
});

test('activeCueAt selects the cue and the last started word', () => {
  const timeline = captionTimeline(['um', 'dois', 'três', 'quatro.', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez']);
  const first = activeCueAt(timeline, 0.2);
  assert.equal(first!.cue.outputStart, timeline.cues[0]!.outputStart);
  assert.equal(first!.activeWordIndex, 0);
  assert.equal(activeCueAt(timeline, 0.7)!.activeWordIndex, 1);
  assert.equal(activeCueAt(timeline, 1.99)!.activeWordIndex, 3);
  assert.equal(activeCueAt(timeline, 2.0)!.activeWordIndex, 0);
  assert.equal(activeCueAt(timeline, 99), null);
  assert.equal(activeCueAt(timeline, -1), null);
});

test('hook renders when enabled with a band and text, otherwise null', () => {
  const words = contiguousWords(['um', 'dois', 'três']);
  const enabled = buildTimeline({ edit: { ...singleRangeEdit(words), hook: { enabled: true, text: 'o segredo do focus' } }, words, layout, title: testTitle, source });
  assert.deepEqual(enabled.hook, { lines: ['O SEGREDO DO FOCUS'], canvas: { x: 0, y: 0, w: 1080, h: 220 }, sizePx: 58 });
  const disabled = buildTimeline({ edit: { ...singleRangeEdit(words), hook: { enabled: false, text: 'o segredo do focus' } }, words, layout, title: testTitle, source });
  assert.equal(disabled.hook, null);
  const empty = buildTimeline({ edit: { ...singleRangeEdit(words), hook: { enabled: true, text: '   ' } }, words, layout, title: testTitle, source });
  assert.equal(empty.hook, null);
  const noBand = buildTimeline({ edit: { ...singleRangeEdit(words), hook: { enabled: true, text: 'o segredo do focus' } }, words, layout: { ...layout, hookBand: null }, title: testTitle, source });
  assert.equal(noBand.hook, null);
});

test('end card carries the full layout and is excluded from durationSeconds', () => {
  const words = contiguousWords(['um', 'dois', 'três']);
  const withCard = buildTimeline({ edit: { ...singleRangeEdit(words), endCard: { enabled: true } }, words, layout, title: testTitle, source });
  const withoutCard = buildTimeline({ edit: singleRangeEdit(words), words, layout, title: testTitle, source });
  assert.deepEqual(withCard.endCard, {
    durationSeconds: END_CARD_SECONDS,
    darkenFactor: 0.55,
    thumbnail: { centerX: 540, centerY: 560, widthPx: 900 },
    titleLines: [{ text: 'Um titulo de teste', centerX: 540, centerY: 1200, sizePx: 58 }],
    link: { text: 'Link na descrição', centerX: 540, centerY: 1700, sizePx: 44 },
    textOutlinePx: 2,
    textOutlineColor: '#000000',
  });
  assert.equal(withoutCard.endCard, null);
  assert.equal(withCard.durationSeconds, withoutCard.durationSeconds);
});

test('clip output lengths snap to whole frames and sub-frame clips are dropped', () => {
  const words = studioWords();
  const fps = layout.canvas.fps;
  const timeline = buildTimeline({ edit: baseEdit(), words, layout, title: testTitle, source });
  for (const clip of timeline.clips) {
    const frames = (clip.outputEnd - clip.outputStart) * fps;
    assert.ok(Math.abs(frames - Math.round(frames)) < 1e-9, `clip ${clip.index} spans ${frames} frames`);
    approx(clip.sourceEnd, clip.sourceStart + (frames / fps) * timeline.speed);
  }
  assert.ok(Math.abs(timeline.durationSeconds * fps - Math.round(timeline.durationSeconds * fps)) < 1e-9);

  const tinyWords = [word('a', 0, 0.5, 0), word('b', 0.5, 0.505, 1), word('c', 0.51, 1.0, 2)];
  const tinyEdit: ShortEdit = {
    ...baseEdit(),
    ranges: [{ startWord: 0, endWord: 2 }],
    removedWords: [0, 2],
    tightenPauses: { enabled: false, maxGapSeconds: 0.35 },
  };
  const tiny = buildTimeline({ edit: tinyEdit, words: tinyWords, layout, title: testTitle, source });
  assert.deepEqual(tiny.clips, []);
  assert.equal(tiny.durationSeconds, 0);
});

test('hook auto-fit shrinks the font until the wrapped lines fit the band', () => {
  const words = contiguousWords(['um', 'dois']);
  const edit = { ...singleRangeEdit(words), hook: { enabled: true, text: 'aaaaaaaaa bbbbbbbbb ccccccccc ddddddddd eeeeeeeee' } };
  const timeline = buildTimeline({ edit, words, layout, title: testTitle, source });
  assert.deepEqual(timeline.hook, {
    lines: ['AAAAAAAAA BBBBBBBBB CCCCCCCCC', 'DDDDDDDDD EEEEEEEEE'],
    canvas: { x: 0, y: 0, w: 1080, h: 220 },
    sizePx: Math.round(58 * 0.74),
  });
});

test('hook auto-fit keeps the smallest size when no size fits', () => {
  const words = contiguousWords(['um', 'dois']);
  const edit = { ...singleRangeEdit(words), hook: { enabled: true, text: 'aaaaaaaaaaaa bbbbbbbbbbbb cccccccccccc dddddddddddd eeeeeeeeeeee' } };
  const timeline = buildTimeline({ edit, words, layout, title: testTitle, source });
  assert.deepEqual(timeline.hook, {
    lines: ['AAAAAAAAAAAA BBBBBBBBBBBB', 'CCCCCCCCCCCC DDDDDDDDDDDD', 'EEEEEEEEEEEE'],
    canvas: { x: 0, y: 0, w: 1080, h: 220 },
    sizePx: Math.round(58 * 0.74),
  });
});

test('split sub-clips resolve crop keyframes at their own source start', () => {
  const words = studioWords();
  const edit: ShortEdit = {
    ...baseEdit(),
    crops: [
      { sourceSeconds: 6, focus: { x: 0, y: 0, w: 0.5, h: 0.5 }, origin: 'manual' },
      { sourceSeconds: 6.2, focus: { x: 0.6, y: 0.6, w: 0.1, h: 0.1 }, origin: 'manual' },
    ],
  };
  const timeline = buildTimeline({ edit, words, layout, title: testTitle, source });
  const expected: Array<[number, number, boolean]> = [
    [0, 1, false],
    [1.49, 3.09, false],
    [4.92, 4.92 + 32 / 30, false],
    [6, 6.2, true],
    [6.2, 8.1, true],
  ];
  assert.equal(timeline.clips.length, expected.length);
  expected.forEach(([wantStart, wantEnd, wantJoins], index) => {
    const clip = timeline.clips[index]!;
    approx(clip.sourceStart, wantStart);
    approx(clip.sourceEnd, wantEnd);
    assert.equal(clip.joinsPrevious, wantJoins);
  });
  assert.deepEqual(timeline.clips[2]!.panels[0]!.source, { x: 0, y: 68, w: 1212, h: 942 });
  assert.deepEqual(timeline.clips[3]!.panels[0]!.source, { x: 0, y: 0, w: 960, h: 746 });
  assert.deepEqual(timeline.clips[4]!.panels[0]!.source, { x: 728, y: 512, w: 484, h: 376 });
});

test('geometry converts normalized rects to even pixel rects', () => {
  assert.deepEqual(toEvenPxRect({ x: 3, y: -3.2, w: 1079.9, h: 1 }), { x: 2, y: -4, w: 1078, h: 2 });
  assert.deepEqual(normToPx({ x: 0.5, y: 0.25, w: 0.25, h: 0.5 }, 1920, 1080), { x: 960, y: 270, w: 480, h: 540 });
  assert.deepEqual(panelCanvasRect(layout.panels[0]!, layout.canvas), { x: 0, y: 220, w: 1080, h: 840 });
  assert.deepEqual(panelCanvasRect(layout.panels[1]!, layout.canvas), { x: 0, y: 1060, w: 1080, h: 858 });
});

test('fitRectToAspect expands the shorter side, honors minWidth and clamps into bounds', () => {
  assert.deepEqual(fitRectToAspect({ x: 10, y: 20, w: 100, h: 100 }, 2, { x: 0, y: 0, w: 800, h: 600 }, 0), { x: 0, y: 20, w: 200, h: 100 });
  assert.deepEqual(fitRectToAspect({ x: 10, y: 20, w: 100, h: 100 }, 2, { x: 0, y: 0, w: 800, h: 600 }, 300), { x: 0, y: 0, w: 300, h: 150 });
  assert.deepEqual(fitRectToAspect({ x: 10, y: 20, w: 100, h: 100 }, 2, { x: 0, y: 0, w: 200, h: 50 }, 0), { x: 10, y: 0, w: 100, h: 50 });
});

test('contentSourceCrop respects bounds and the maximum zoom-out floor', () => {
  const panel = layout.panels[0];
  if (panel.role !== 'content') {
    throw new Error('expected content panel');
  }
  const crop = contentSourceCrop(panel, { x: 0.3, y: 0.3, w: 100 / 1920, h: 200 / 1080 }, source, layout.canvas.width / 840);
  assert.deepEqual(crop, { x: 382, y: 234, w: 484, h: 376 });
  assert.ok(crop.w >= Math.floor(panel.sourceRect.w * source.width / MAX_CONTENT_ZOOM / 2) * 2 - 2);
  const full = contentSourceCrop(panel, null, source, layout.canvas.width / 840);
  assert.deepEqual(full, { x: 0, y: 68, w: 1212, h: 942 });
});

test('hostSourceCrop anchors, clamps and zooms around the anchor', () => {
  const panel = layout.panels[1];
  if (panel.role !== 'host') {
    throw new Error('expected host panel');
  }
  const aspect = layout.canvas.width / panelCanvasRect(panel, layout.canvas).h;
  assert.deepEqual(hostSourceCrop(panel, 1, source, aspect), { x: 1222, y: 176, w: 696, h: 552 });
  assert.deepEqual(hostSourceCrop(panel, 1.12, source, aspect), { x: 1260, y: 206, w: 622, h: 494 });
});
