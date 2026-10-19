import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { ShortEdit } from '../src/domain/edit.js';
import type { SceneSegment, SceneTrack, TranscriptWord } from '../src/domain/model.js';
import type { HostPanel, LayoutProfile, NormRect, PxRect, ScenesLayoutProfile } from '../src/domain/layout.js';
import { STACK_SPLITS } from '../src/domain/composition.js';
import {
  END_CARD_SECONDS,
  MIN_SCENE_PIECE_SECONDS,
  activeCueAt,
  buildTimeline,
  computeSourceClips,
  endCardAudioGain,
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
    layout: { split: null, overrides: [] },
  };
}

const layout: LayoutProfile = {
  version: 3,
  layoutId: 'screen-top-host-bottom-v2',
  strategy: 'fixed',
  canvas: { width: 1080, height: 1920, fps: 30 },
  background: '#101010',
  safeArea: { top: 0, bottom: 0, side: 0 },
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
  const fast = buildTimeline({ edit: { ...baseEdit(), speed: 2 }, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  const slow = buildTimeline({ edit: baseEdit(), words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
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
  const timeline = buildTimeline({ edit, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
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

  const insideMargin = buildTimeline({ edit: { ...baseEdit(), crops: [{ sourceSeconds: 1.7, focus: { x: 0, y: 0, w: 0.5, h: 0.5 }, origin: 'auto' }] }, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
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
  const timeline = buildTimeline({ edit, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  assert.deepEqual(
    timeline.clips.map((clip) => clip.zoom),
    [1, 1.12, 1.12, 1, 1],
  );
  const disabled = buildTimeline({ edit: { ...edit, zoom: { enabled: false, strength: 1.12 } }, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  assert.ok(disabled.clips.every((clip) => clip.zoom === 1));
  const joined = buildTimeline({
    edit: { ...baseEdit(), ranges: [{ startWord: 0, endWord: 2 }], removedWords: [1] },
    words: [word('a', 0, 0.5, 0), word('b', 0.5, 0.5, 1), word('c', 0.5, 0.98, 2)],
    layout,
    title: testTitle,
    source,
    hostFraming: null,
    sceneTrack: null,
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
  const timeline = buildTimeline({ edit, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
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
  const timeline = buildTimeline({ edit: baseEdit(), words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
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
  const timeline = buildTimeline({ edit, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
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
  return buildTimeline({ edit: singleRangeEdit(words), words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
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
    hostFraming: null,
    sceneTrack: null,
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
  const timeline = buildTimeline({ edit: { ...singleRangeEdit(words), captions: { enabled: false } }, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
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
  const enabled = buildTimeline({ edit: { ...singleRangeEdit(words), hook: { enabled: true, text: 'o segredo do focus' } }, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  assert.deepEqual(enabled.hook, { lines: ['O SEGREDO DO FOCUS'], canvas: { x: 0, y: 0, w: 1080, h: 220 }, sizePx: 58, textCenterY: 110 });
  const disabled = buildTimeline({ edit: { ...singleRangeEdit(words), hook: { enabled: false, text: 'o segredo do focus' } }, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  assert.equal(disabled.hook, null);
  const empty = buildTimeline({ edit: { ...singleRangeEdit(words), hook: { enabled: true, text: '   ' } }, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  assert.equal(empty.hook, null);
  const noBand = buildTimeline({ edit: { ...singleRangeEdit(words), hook: { enabled: true, text: 'o segredo do focus' } }, words, layout: { ...layout, hookBand: null }, title: testTitle, source, hostFraming: null, sceneTrack: null });
  assert.equal(noBand.hook, null);
});

test('end card carries the full layout and is excluded from durationSeconds', () => {
  const words = contiguousWords(['um', 'dois', 'três']);
  const withCard = buildTimeline({ edit: { ...singleRangeEdit(words), endCard: { enabled: true } }, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  const withoutCard = buildTimeline({ edit: singleRangeEdit(words), words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  const lastClip = withCard.clips.at(-1)!;
  assert.deepEqual(withCard.endCard, {
    durationSeconds: END_CARD_SECONDS,
    darkenFactor: 0.55,
    thumbnail: { centerX: 540, centerY: 560, widthPx: 900 },
    titleLines: [{ text: 'Um titulo de teste', centerX: 540, centerY: 1200, sizePx: 58 }],
    link: { text: 'Link na descrição', centerX: 540, centerY: 1700, sizePx: 44 },
    textOutlinePx: 2,
    textOutlineColor: '#000000',
    audio: {
      sourceStart: lastClip.sourceEnd,
      sourceEnd: lastClip.sourceEnd + END_CARD_SECONDS * withCard.speed,
      duckGain: 0.35,
      duckSeconds: 0.5,
      fadeOutSeconds: 1,
    },
  });
  assert.equal(withoutCard.endCard, null);
  assert.equal(withCard.durationSeconds, withoutCard.durationSeconds);
});

test('end card audio continues the source after the last clip, clamped to the source end', () => {
  const words = contiguousWords(['um', 'dois', 'três']);
  const edit = { ...singleRangeEdit(words), endCard: { enabled: true }, speed: 1.2 };
  const nearEnd = buildTimeline({ edit, words, layout, title: testTitle, source: { ...source, durationSeconds: 2 }, hostFraming: null, sceneTrack: null });
  const audio = nearEnd.endCard!.audio!;
  approx(audio.sourceStart, nearEnd.clips.at(-1)!.sourceEnd);
  assert.equal(audio.sourceEnd, 2);
  const atSourceEnd = buildTimeline({ edit: singleRangeEdit(words), words, layout, title: testTitle, source: { ...source, durationSeconds: 1.5 }, hostFraming: null, sceneTrack: null });
  const endsAtSource = buildTimeline({ edit: { ...singleRangeEdit(words), endCard: { enabled: true } }, words, layout, title: testTitle, source: { ...source, durationSeconds: 1.5 }, hostFraming: null, sceneTrack: null });
  assert.equal(atSourceEnd.clips.at(-1)!.sourceEnd, 1.5);
  assert.equal(endsAtSource.endCard!.audio, null);
});

test('end card audio ducks under the card and fades to silence by its end', () => {
  const words = contiguousWords(['um', 'dois', 'três']);
  const endCard = buildTimeline({ edit: { ...singleRangeEdit(words), endCard: { enabled: true } }, words, layout, title: testTitle, source, hostFraming: null }).endCard!;
  approx(endCardAudioGain(endCard, 0), 1);
  approx(endCardAudioGain(endCard, 0.25), 1 - 0.65 / 2);
  approx(endCardAudioGain(endCard, 1), 0.35);
  approx(endCardAudioGain(endCard, END_CARD_SECONDS - 0.5), 0.35 / 2);
  approx(endCardAudioGain(endCard, END_CARD_SECONDS), 0);
  assert.equal(endCardAudioGain({ ...endCard, audio: null }, 1), 0);
});

test('clip indices stay contiguous when a sub-frame clip is dropped mid-timeline', () => {
  const words = [word('a', 0, 0.5, 0), word('x', 0.5, 0.6, 1), word('b', 0.6, 0.605, 2), word('y', 0.605, 1.0, 3), word('c', 1.0, 1.5, 4)];
  const edit: ShortEdit = { ...baseEdit(), ranges: [{ startWord: 0, endWord: 4 }], removedWords: [1, 3] };
  const timeline = buildTimeline({ edit, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  assert.equal(timeline.clips.length, 2);
  assert.deepEqual(timeline.clips.map((clip) => clip.index), [0, 1]);
});

test('clip output lengths snap to whole frames and sub-frame clips are dropped', () => {
  const words = studioWords();
  const fps = layout.canvas.fps;
  const timeline = buildTimeline({ edit: baseEdit(), words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
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
  const tiny = buildTimeline({ edit: tinyEdit, words: tinyWords, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  assert.deepEqual(tiny.clips, []);
  assert.equal(tiny.durationSeconds, 0);
});

test('hook auto-fit shrinks the font until the wrapped lines fit the band', () => {
  const words = contiguousWords(['um', 'dois']);
  const edit = { ...singleRangeEdit(words), hook: { enabled: true, text: 'aaaaaaaaa bbbbbbbbb ccccccccc ddddddddd eeeeeeeee' } };
  const timeline = buildTimeline({ edit, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  assert.deepEqual(timeline.hook, {
    lines: ['AAAAAAAAA BBBBBBBBB CCCCCCCCC', 'DDDDDDDDD EEEEEEEEE'],
    canvas: { x: 0, y: 0, w: 1080, h: 220 },
    sizePx: Math.round(58 * 0.74),
    textCenterY: 110,
  });
});

test('hook auto-fit keeps the smallest size when no size fits', () => {
  const words = contiguousWords(['um', 'dois']);
  const edit = { ...singleRangeEdit(words), hook: { enabled: true, text: 'aaaaaaaaaaaa bbbbbbbbbbbb cccccccccccc dddddddddddd eeeeeeeeeeee' } };
  const timeline = buildTimeline({ edit, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  assert.deepEqual(timeline.hook, {
    lines: ['AAAAAAAAAAAA BBBBBBBBBBBB', 'CCCCCCCCCCCC DDDDDDDDDDDD', 'EEEEEEEEEEEE'],
    canvas: { x: 0, y: 0, w: 1080, h: 220 },
    sizePx: Math.round(58 * 0.74),
    textCenterY: 110,
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
  const timeline = buildTimeline({ edit, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
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

test('hostSourceCrop null keeps the anchor behaviour', () => {
  const panel = layout.panels[1];
  if (panel.role !== 'host') {
    throw new Error('expected host panel');
  }
  const aspect = layout.canvas.width / panelCanvasRect(panel, layout.canvas).h;
  assert.deepEqual(hostSourceCrop(panel, 1, source, aspect, null), {
    source: { x: 1222, y: 176, w: 696, h: 552 },
    fill: 'cover',
  });
  assert.deepEqual(hostSourceCrop(panel, 1.12, source, aspect, null), {
    source: { x: 1260, y: 206, w: 622, h: 494 },
    fill: 'cover',
  });
});

function profileLayout(name: string): LayoutProfile {
  return JSON.parse(readFileSync(new URL(`../profiles/${name}`, import.meta.url), 'utf8')) as LayoutProfile;
}

function hostPanelOf(layout: LayoutProfile): HostPanel {
  const panel = layout.panels.find((candidate) => candidate.role === 'host');
  if (panel === undefined || panel.role !== 'host') {
    throw new Error('expected host panel');
  }
  return panel;
}

function assertEvenInsideBounds(crop: PxRect, panel: HostPanel): void {
  for (const value of [crop.x, crop.y, crop.w, crop.h]) {
    assert.equal(value % 2, 0, `crop component not even: ${JSON.stringify(crop)}`);
  }
  const bounds = toEvenPxRect(normToPx(panel.sourceRect, source.width, source.height));
  assert.ok(crop.x >= bounds.x && crop.y >= bounds.y, `crop origin outside bounds: ${JSON.stringify(crop)} vs ${JSON.stringify(bounds)}`);
  assert.ok(
    crop.x + crop.w <= bounds.x + bounds.w && crop.y + crop.h <= bounds.y + bounds.h,
    `crop exceeds bounds: ${JSON.stringify(crop)} vs ${JSON.stringify(bounds)}`,
  );
}

function assertHeadInside(crop: PxRect, head: NormRect): void {
  const headPx = normToPx(head, source.width, source.height);
  assert.ok(headPx.x >= crop.x && headPx.y >= crop.y, `head left/top outside crop: ${JSON.stringify(headPx)} vs ${JSON.stringify(crop)}`);
  assert.ok(
    headPx.x + headPx.w <= crop.x + crop.w && headPx.y + headPx.h <= crop.y + crop.h,
    `head right/bottom outside crop: ${JSON.stringify(headPx)} vs ${JSON.stringify(crop)}`,
  );
}

test('hostSourceCrop keeps the fitting head in a full-width cover crop and stops zoom before cropping it', () => {
  const layout = profileLayout('filipe_boni_layout.json');
  const panel = hostPanelOf(layout);
  const aspect = layout.canvas.width / panelCanvasRect(panel, layout.canvas).h;
  const columnWidth = toEvenPxRect(normToPx(panel.sourceRect, source.width, source.height)).w;
  const head: NormRect = { x: 0.78, y: 0.28, w: 0.2011, h: 0.44 };
  const zoomOne = hostSourceCrop(panel, 1, source, aspect, head);
  for (const zoom of [1, 1.12, 1.3]) {
    const result = hostSourceCrop(panel, zoom, source, aspect, head);
    assert.equal(result.fill, 'cover', `zoom ${zoom}`);
    assert.equal(result.source.w, columnWidth, `zoom ${zoom}`);
    assertHeadInside(result.source, head);
    assertEvenInsideBounds(result.source, panel);
  }
  assert.deepEqual(hostSourceCrop(panel, 1.12, source, aspect, head).source, zoomOne.source);
  assert.deepEqual(hostSourceCrop(panel, 1.3, source, aspect, head).source, zoomOne.source);
});

test('hostSourceCrop uses the contained regime for a close-up head and keeps it fully inside at every zoom', () => {
  const layout = profileLayout('filipe_boni_layout.json');
  const panel = hostPanelOf(layout);
  const aspect = layout.canvas.width / panelCanvasRect(panel, layout.canvas).h;
  const columnWidth = toEvenPxRect(normToPx(panel.sourceRect, source.width, source.height)).w;
  const head: NormRect = { x: 0.6871, y: 0.136, w: 0.2686, h: 0.691 };
  for (const zoom of [1, 1.12, 1.3]) {
    const result = hostSourceCrop(panel, zoom, source, aspect, head);
    assert.equal(result.fill, 'contain', `zoom ${zoom}`);
    assert.equal(result.source.w, columnWidth, `zoom ${zoom}`);
    assertHeadInside(result.source, head);
    assertEvenInsideBounds(result.source, panel);
  }
  const extreme: NormRect = { x: 0.65, y: 0.08, w: 0.3, h: 0.85 };
  for (const zoom of [1, 1.12, 1.3]) {
    const result = hostSourceCrop(panel, zoom, source, aspect, extreme);
    assert.equal(result.fill, 'contain', `zoom ${zoom}`);
    assertHeadInside(result.source, extreme);
    assertEvenInsideBounds(result.source, panel);
  }
});

test('hostSourceCrop keeps the Jones layout anchor crop height and centers a fitting head', () => {
  const layout = profileLayout('jones_manoel_layout.json');
  const panel = hostPanelOf(layout);
  const aspect = layout.canvas.width / panelCanvasRect(panel, layout.canvas).h;
  const head: NormRect = { x: 0.4, y: 0.15, w: 0.2, h: 0.46 };
  const anchor = hostSourceCrop(panel, 1, source, aspect, null);
  const result = hostSourceCrop(panel, 1, source, aspect, head);
  assert.equal(result.fill, 'cover');
  assert.equal(result.source.h, anchor.source.h);
  assertHeadInside(result.source, head);
  assertEvenInsideBounds(result.source, panel);
  const bounds = normToPx(panel.sourceRect, source.width, source.height);
  const headPx = normToPx(head, source.width, source.height);
  const center = Math.min(
    bounds.x + bounds.w - result.source.w / 2,
    Math.max(bounds.x + result.source.w / 2, headPx.x + headPx.w / 2),
  );
  assert.ok(Math.abs(result.source.x + result.source.w / 2 - center) <= 2);
});

function scenesLayout(): ScenesLayoutProfile {
  return {
    version: 3,
    layoutId: 'mix-scenes-v3',
    strategy: 'scenes',
    canvas: { width: 1080, height: 1920, fps: 30 },
    background: '#101010',
    safeArea: { top: 0.135, bottom: 0.17, side: 0.055 },
    font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
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
    hookBand: {
      rect: { x: 0, y: 0, w: 1, h: 0.215 },
      background: '#C8102E',
      textColor: '#FFFFFF',
      sizePx: 58,
      maxCharsPerLine: 24,
      maxLines: 2,
      uppercase: true,
    },
    scene: { captionCenterY: { host: 0.85, content: 0.9 } },
  };
}

function hostSceneSegment(startSeconds: number, endSeconds: number): SceneSegment {
  return {
    startSeconds,
    endSeconds,
    host: { camera: { x: 0.1, y: 0.55, w: 0.55, h: 0.4 }, head: { x: 0.3, y: 0.62, w: 0.12, h: 0.18 } },
    content: null,
    overlays: [],
  };
}

function stackSceneSegment(startSeconds: number, endSeconds: number): SceneSegment {
  return {
    startSeconds,
    endSeconds,
    host: { camera: { x: 0.15, y: 0.6, w: 0.5, h: 0.35 }, head: { x: 0.35, y: 0.66, w: 0.1, h: 0.15 } },
    content: { box: { x: 0, y: 0, w: 1, h: 0.5 }, kind: 'document', vertical: false, subject: { x: 0.2, y: 0.05, w: 0.4, h: 0.3 } },
    overlays: [],
  };
}

function contentSceneSegment(startSeconds: number, endSeconds: number): SceneSegment {
  return {
    startSeconds,
    endSeconds,
    host: null,
    content: { box: { x: 0, y: 0, w: 1, h: 1 }, kind: 'footage', vertical: false, subject: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } },
    overlays: [],
  };
}

function scenesTrack(segments: SceneSegment[]): SceneTrack {
  return { version: 1, analyzedAt: '2026-10-19T10:00:00.000Z', frame: { width: 1920, height: 1080 }, segments };
}

function rect(x: number, y: number, w: number, h: number): NormRect {
  return { x, y, w, h };
}

test('fixed timelines keep null scene metadata and the layout caption position', () => {
  const timeline = buildTimeline({ edit: baseEdit(), words: studioWords(), layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  assert.ok(timeline.clips.every((clip) => clip.composition === null && clip.sceneStartSeconds === null && clip.captionCenterY === 0.5521));
  assert.equal(timeline.stackSplit, null);
  assert.ok(timeline.cues.every((cue) => cue.centerY === 0.5521));
});

test('scenes composing requires an analyzed scene track', () => {
  assert.throws(
    () => buildTimeline({ edit: baseEdit(), words: studioWords(), layout: scenesLayout(), title: testTitle, source, hostFraming: null, sceneTrack: null }),
    /Scene analysis is required before composing this short/,
  );
});

test('scene cuts split clips without toggling zoom or bleeding keyframes', () => {
  const track = scenesTrack([stackSceneSegment(0, 5), stackSceneSegment(5, 8.2)]);
  const edit: ShortEdit = {
    ...baseEdit(),
    crops: [{ sourceSeconds: 5.5, focus: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, origin: 'manual' }],
  };
  const timeline = buildTimeline({ edit, words: studioWords(), layout: scenesLayout(), title: testTitle, source, hostFraming: null, sceneTrack: track });
  const expected: Array<[number, number, boolean]> = [
    [0, 0.99, false],
    [1.49, 3.1, false],
    [4.92, 5, false],
    [5, 5.5, true],
    [5.5, 8.1, true],
  ];
  assert.equal(timeline.clips.length, expected.length);
  expected.forEach(([wantStart, wantEnd, wantJoins], index) => {
    const clip = timeline.clips[index]!;
    approx(clip.sourceStart, wantStart);
    approx(clip.sourceEnd, wantEnd);
    assert.equal(clip.joinsPrevious, wantJoins);
  });
  assert.deepEqual(
    timeline.clips.map((clip) => clip.zoom),
    [1, 1.12, 1, 1, 1],
  );
  assert.ok(timeline.clips.every((clip) => clip.sceneStartSeconds !== null && clip.composition === 'stack'));
  const withoutKeyframe = timeline.clips[3]!.panels[0]!.source;
  const withKeyframe = timeline.clips[4]!.panels[0]!.source;
  const earlySegment = timeline.clips[0]!.panels[0]!.source;
  assert.deepEqual(withoutKeyframe, earlySegment);
  assert.notDeepEqual(withKeyframe, withoutKeyframe);
  const keyframeFocus = { x: 0.1, y: 0.05, w: 0.2, h: 0.1 };
  const focusPx = normToPx(keyframeFocus, source.width, source.height);
  assert.ok(focusPx.x >= withKeyframe.x && focusPx.y >= withKeyframe.y);
  assert.ok(
    focusPx.x + focusPx.w <= withKeyframe.x + withKeyframe.w && focusPx.y + focusPx.h <= withKeyframe.y + withKeyframe.h,
    `keyframe focus ${JSON.stringify(focusPx)} escaped crop ${JSON.stringify(withKeyframe)}`,
  );
});

test('one split is shared across all stack clips and manual split wins', () => {
  const track = scenesTrack([stackSceneSegment(0, 4), stackSceneSegment(4, 8.2)]);
  const manual = buildTimeline({
    edit: { ...baseEdit(), layout: { split: 0.65, overrides: [] } },
    words: studioWords(),
    layout: scenesLayout(),
    title: testTitle,
    source,
    hostFraming: null,
    sceneTrack: track,
  });
  assert.equal(manual.stackSplit, 0.65);
  const stageHeight = manual.clips[0]!.panels.reduce((total, panel) => total + panel.canvas.h, 0);
  const manualHeights = manual.clips.map((clip) => clip.panels.map((panel) => (panel.role === 'content' ? panel.canvas.h : null)));
  assert.ok(manualHeights.every((heights) => heights.every((height) => height === null || height === 2 * Math.round((stageHeight * 0.65) / 2))));
  assert.ok(manual.clips.every((clip) => {
    const content = clip.panels.find((panel) => panel.role === 'content')!;
    return clip.captionCenterY === (content.canvas.y + content.canvas.h) / 1920;
  }));

  const automatic = buildTimeline({ edit: baseEdit(), words: studioWords(), layout: scenesLayout(), title: testTitle, source, hostFraming: null, sceneTrack: track });
  assert.ok(automatic.stackSplit !== null && STACK_SPLITS.includes(automatic.stackSplit));
  const automaticHeights = automatic.clips.map((clip) => clip.panels.find((panel) => panel.role === 'content')!.canvas.h);
  assert.ok(new Set(automaticHeights).size === 1);
});

test('flash inheritance uses total retained segment duration at playback speed', () => {
  const track = scenesTrack([hostSceneSegment(0, 5.2), contentSceneSegment(5.2, 5.6), contentSceneSegment(5.6, 8.2)]);
  const edit: ShortEdit = {
    ...baseEdit(),
    layout: { split: null, overrides: [{ sourceSeconds: 5.2, composition: 'content' }] },
  };
  const timeline = buildTimeline({ edit, words: studioWords(), layout: scenesLayout(), title: testTitle, source, hostFraming: null, sceneTrack: track });
  const pieces = timeline.clips.map((clip) => [clip.sourceStart, clip.sourceEnd] as const);
  assert.deepEqual(pieces, [
    [0, 0.99],
    [1.49, 3.1],
    [4.92, 5.2],
    [5.2, 5.6],
    [5.6, 8.1],
  ]);
  const displayed = timeline.clips[2]!;
  const flash = timeline.clips[3]!;
  assert.equal(displayed.composition, 'host');
  assert.equal(flash.composition, 'host');
  assert.deepEqual(flash.panels, displayed.panels);
  assert.equal(flash.captionCenterY, displayed.captionCenterY);
  assert.equal(flash.captionCenterY, 0.85);
  const afterFlash = timeline.clips[4]!;
  assert.equal(afterFlash.composition, 'content');
  assert.deepEqual(afterFlash.panels.map((panel) => panel.panelId), ['content']);

  const fast = buildTimeline({
    edit: { ...edit, speed: 2 },
    words: studioWords(),
    layout: scenesLayout(),
    title: testTitle,
    source,
    hostFraming: null,
    sceneTrack: scenesTrack([hostSceneSegment(0, 5.2), contentSceneSegment(5.2, 5.9), contentSceneSegment(5.9, 8.2)]),
  });
  const fastFlash = fast.clips.find((clip) => clip.sourceStart === 5.2)!;
  assert.equal(fastFlash.composition, 'host');

  const leading = scenesTrack([contentSceneSegment(0, 0.4), hostSceneSegment(0.4, 8.2)]);
  const leadingTimeline = buildTimeline({ edit: baseEdit(), words: studioWords(), layout: scenesLayout(), title: testTitle, source, hostFraming: null, sceneTrack: leading });
  assert.equal(leadingTimeline.clips[0]!.composition, 'content');
  assert.deepEqual(leadingTimeline.clips[0]!.panels.map((panel) => panel.panelId), ['content']);
});

test('captions choose position at cue start and keep it through a scene change', () => {
  const words = [
    word('um', 4.6, 5.08, 0),
    word('dois.', 4.8, 5.3, 1),
    word('três', 5.35, 5.83, 2),
    word('quatro', 5.9, 6.38, 3),
  ];
  const track = scenesTrack([hostSceneSegment(0, 5), stackSceneSegment(5, 8.2)]);
  const edit: ShortEdit = { ...baseEdit(), ranges: [{ startWord: 0, endWord: 3 }], removedWords: [], tightenPauses: { enabled: false, maxGapSeconds: 0.35 } };
  const timeline = buildTimeline({ edit, words, layout: scenesLayout(), title: testTitle, source, hostFraming: null, sceneTrack: track });
  assert.equal(timeline.clips.length, 2);
  assert.equal(timeline.clips[0]!.captionCenterY, 0.85);
  const seamY = (timeline.clips[1]!.panels[0]!.canvas.y + timeline.clips[1]!.panels[0]!.canvas.h) / 1920;
  assert.equal(timeline.clips[1]!.captionCenterY, seamY);
  const crossing = timeline.cues[0]!;
  assert.ok(crossing.outputStart < timeline.clips[0]!.outputEnd);
  assert.ok(crossing.outputEnd > timeline.clips[1]!.outputStart);
  assert.equal(crossing.centerY, 0.85);
  const afterCut = timeline.cues[1]!;
  assert.ok(afterCut.outputStart >= timeline.clips[1]!.outputStart);
  assert.equal(afterCut.centerY, seamY);
  assert.notEqual(afterCut.centerY, 0.85);
  const boundary = sourceToOutput(timeline, 5);
  assert.ok(boundary !== null);
  assert.equal(boundary, timeline.clips[1]!.outputStart);
});

test('scenes timelines merge sub-frame pieces at segment boundaries near clip edges', () => {
  const words = studioWords();
  const track = scenesTrack([stackSceneSegment(0, 8.09), stackSceneSegment(8.09, 60)]);
  const timeline = buildTimeline({ edit: baseEdit(), words, layout: scenesLayout(), title: testTitle, source, hostFraming: null, sceneTrack: track });
  const fps = scenesLayout().canvas.fps;
  assert.ok(timeline.clips.length >= 2, `clips ${timeline.clips.length}`);
  for (const clip of timeline.clips) {
    assert.ok(clip.outputEnd - clip.outputStart >= 1 / fps - 1e-9, `clip ${clip.index} output span ${clip.outputEnd - clip.outputStart}`);
    assert.ok(clip.sourceEnd - clip.sourceStart >= MIN_SCENE_PIECE_SECONDS - 1e-9, `clip ${clip.index} source span ${clip.sourceEnd - clip.sourceStart}`);
  }
  for (const [index, clip] of timeline.clips.entries()) {
    const next = timeline.clips[index + 1];
    if (next && next.joinsPrevious) {
      approx(next.sourceStart, clip.sourceEnd);
      approx(next.outputStart, clip.outputEnd);
    }
  }
  approx(timeline.clips[timeline.clips.length - 1]!.sourceEnd, 8.1, 1e-6);
});

test('hook text center sits inside the safe area', () => {
  const words = contiguousWords(['um', 'dois']);
  const edit = { ...singleRangeEdit(words), hook: { enabled: true, text: 'o segredo do focus' } };
  const timeline = buildTimeline({ edit, words, layout: scenesLayout(), title: testTitle, source, hostFraming: null, sceneTrack: scenesTrack([stackSceneSegment(0, 5), stackSceneSegment(5, 8.2)]) });
  const safeTop = 0.135 * 1920;
  assert.notEqual(timeline.hook, null);
  assert.equal(timeline.hook!.textCenterY, Math.round((Math.max(0, safeTop) + 0.215 * 1920) / 2));
  assert.ok(timeline.hook!.textCenterY >= safeTop - 1, `hook center ${timeline.hook!.textCenterY} above safe top ${safeTop}`);
  const legacy = buildTimeline({ edit, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  assert.equal(legacy.hook!.textCenterY, Math.round((legacy.hook!.canvas.y + legacy.hook!.canvas.h) / 2));
});

test('a fixed content panel with a side margin keeps the focus fully inside the inset rect', () => {
  const words = studioWords();
  const sideLayout: LayoutProfile = {
    ...layout,
    safeArea: { top: 0.135, bottom: 0.17, side: 0.055 },
  };
  const focus = { x: 0.3, y: 0.3, w: 0.2, h: 0.2 };
  const timeline = buildTimeline({
    edit: { ...baseEdit(), crops: [{ sourceSeconds: 0.2, focus, origin: 'manual' }] },
    words,
    layout: sideLayout,
    title: testTitle,
    source,
    hostFraming: null,
    sceneTrack: null,
  });
  const content = timeline.clips[0]!.panels.find((panel) => panel.role === 'content')!;
  assert.equal(content.fill, 'contain');
  const insetWidth = 1080 - 2 * 0.055 * 1080;
  const panelCanvas = content.canvas;
  assert.equal(panelCanvas.x, 0);
  const insetAspect = insetWidth / panelCanvas.h;
  assert.ok(Math.abs(content.source.w / content.source.h - insetAspect) < 0.02, `crop aspect ${content.source.w / content.source.h} != inset aspect ${insetAspect}`);
  const host = timeline.clips[0]!.panels.find((panel) => panel.role === 'host')!;
  assert.equal(host.fill, 'cover');
  const focusPx = normToPx(focus, source.width, source.height);
  assert.ok(focusPx.x >= content.source.x && focusPx.y >= content.source.y);
  assert.ok(
    focusPx.x + focusPx.w <= content.source.x + content.source.w && focusPx.y + focusPx.h <= content.source.y + content.source.h,
    `focus ${JSON.stringify(focusPx)} escaped inset crop ${JSON.stringify(content.source)}`,
  );

  const zero = buildTimeline({ edit: { ...baseEdit(), crops: [{ sourceSeconds: 0.2, focus, origin: 'manual' }] }, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  const zeroContent = zero.clips[0]!.panels.find((panel) => panel.role === 'content')!;
  assert.equal(zeroContent.fill, 'cover');
  assert.ok(Math.abs(zeroContent.source.w / zeroContent.source.h - panelCanvas.w / panelCanvas.h) < 0.02);
});

test('a portrait document with a usable host stacks', () => {
  const portraitDocument: SceneSegment = {
    startSeconds: 0,
    endSeconds: 5,
    host: { camera: rect(0.719, 0.055, 0.263, 0.362), head: rect(0.788, 0.076, 0.096, 0.22) },
    content: {
      box: rect(0.22, 0, 0.56, 1),
      kind: 'document',
      vertical: true,
      subject: rect(0.3, 0.1, 0.4, 0.8),
    },
    overlays: [],
  };
  const timeline = buildTimeline({ edit: baseEdit(), words: studioWords(), layout: scenesLayout(), title: testTitle, source, hostFraming: null, sceneTrack: scenesTrack([portraitDocument, stackSceneSegment(5, 8.2)]) });
  assert.ok(timeline.clips.every((clip) => clip.composition === 'stack'));
  assert.ok(timeline.clips.every((clip) => clip.panels.map((panel) => panel.panelId).join(',') === 'content,host'));
});

test('end card link respects the safe area bottom', () => {
  const words = contiguousWords(['um', 'dois', 'três']);
  const safeBottomLayout: LayoutProfile = { ...layout, safeArea: { top: 0, bottom: 0.17, side: 0 } };
  const endCard = buildTimeline({ edit: { ...singleRangeEdit(words), endCard: { enabled: true } }, words, layout: safeBottomLayout, title: testTitle, source, hostFraming: null, sceneTrack: null }).endCard!;
  assert.equal(endCard.link.centerY, Math.round(Math.min(1700, 1920 * (1 - 0.17) - 2 * 44)));
  assert.equal(endCard.link.centerY, 1506);
  const legacy = buildTimeline({ edit: { ...singleRangeEdit(words), endCard: { enabled: true } }, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null }).endCard!;
  assert.equal(legacy.link.centerY, 1700);
});

test('a long hook keeps its text block below the safe top', () => {
  const words = contiguousWords(['um', 'dois']);
  const longText = 'este e um titulo realmente comprido que precisa de varias linhas para caber na faixa do topo do canvas';
  const timeline = buildTimeline({ edit: { ...singleRangeEdit(words), hook: { enabled: true, text: longText } }, words, layout: scenesLayout(), title: testTitle, source, hostFraming: null, sceneTrack: scenesTrack([stackSceneSegment(0, 5), stackSceneSegment(5, 8.2)]) });
  const hook = timeline.hook!;
  const blockHeight = hook.lines.length * 1.12 * hook.sizePx;
  const safeTop = 0.135 * 1920;
  assert.ok(hook.lines.length > 2, `expected overflow lines, got ${hook.lines.length}`);
  assert.ok(hook.textCenterY - blockHeight / 2 >= safeTop - 0.51, `block top ${hook.textCenterY - blockHeight / 2} above safe top ${safeTop}`);
  assert.ok(hook.textCenterY > (Math.max(hook.canvas.y, safeTop) + hook.canvas.y + hook.canvas.h) / 2);
  const legacy = buildTimeline({ edit: { ...singleRangeEdit(words), hook: { enabled: true, text: longText } }, words, layout, title: testTitle, source, hostFraming: null, sceneTrack: null });
  assert.equal(legacy.hook!.textCenterY, 110);
});
