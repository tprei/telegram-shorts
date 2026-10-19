import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EDIT_LIMITS,
  addRange,
  createInitialEdit,
  detectFillerWords,
  extendEndBySeconds,
  extendStartBySeconds,
  keptText,
  keptWordIndices,
  normalizeEdit,
  normalizeFillerToken,
  normalizeSceneEdit,
  removeCropKeyframe,
  removeRangeAt,
  replaceAutoCrops,
  setRangeBoundary,
  setWordsRemoved,
  trimEndBySeconds,
  trimStartBySeconds,
  upsertCropKeyframe,
} from '../src/domain/edit.js';
import type { ShortEdit } from '../src/domain/edit.js';
import type { SceneTrack, TranscriptWord } from '../src/domain/model.js';
import type { FixedLayoutProfile, ScenesLayoutProfile } from '../src/domain/layout.js';

function word(text: string, index: number, secondsPerWord = 1): TranscriptWord {
  return {
    id: `w_${index}`,
    text,
    startSeconds: index * secondsPerWord,
    endSeconds: (index + 1) * secondsPerWord - 0.02,
    speakerId: 'A',
    confidence: 0.9,
  };
}

function uniformWords(texts: string[]): TranscriptWord[] {
  return texts.map((text, index) => word(text, index));
}

function baseEdit(): ShortEdit {
  return {
    ranges: [{ startWord: 0, endWord: 5 }],
    removedWords: [],
    tightenPauses: { enabled: false, maxGapSeconds: 0.35 },
    speed: 1,
    hook: { enabled: false, text: '' },
    captions: { enabled: true },
    crops: [],
    zoom: { enabled: true, strength: 1.12 },
    endCard: { enabled: false },
    layout: { split: null, overrides: [] },
  };
}

test('normalizeFillerToken lowercases pt-BR and strips edge punctuation', () => {
  assert.equal(normalizeFillerToken('  "Hã!" '), 'hã');
  assert.equal(normalizeFillerToken('HMM…'), 'hmm');
  assert.equal(normalizeFillerToken('olá'), 'olá');
  assert.equal(normalizeFillerToken('—'), '');
});

test('detectFillerWords finds fillers only inside the given ranges', () => {
  const words = uniformWords(['oi', 'HÃ,', 'gente', 'hmm...', 'beleza', 'ãh']);
  assert.deepEqual(detectFillerWords(words, [{ startWord: 0, endWord: 4 }]), [1, 3]);
  assert.deepEqual(detectFillerWords(words, [{ startWord: 2, endWord: 3 }]), [3]);
  assert.deepEqual(detectFillerWords(words, []), []);
});

test('createInitialEdit applies defaults, detects fillers, clamps speed and shapes the hook', () => {
  const words = uniformWords(['oi', 'hã,', 'gente', 'hmm', 'tudo', 'bem', 'hã']);
  const edit = createInitialEdit({ ranges: [{ startWord: 3, endWord: 4 }, { startWord: 1, endWord: 2 }], words, speed: 2, hookText: '  Começa pelo fim!  ' });
  assert.deepEqual(edit.ranges, [{ startWord: 1, endWord: 4 }]);
  assert.deepEqual(edit.removedWords, [1, 3]);
  assert.equal(edit.speed, EDIT_LIMITS.maxSpeed);
  assert.deepEqual(edit.tightenPauses, { enabled: true, maxGapSeconds: EDIT_LIMITS.defaultPauseGapSeconds });
  assert.deepEqual(edit.hook, { enabled: true, text: 'Começa pelo fim!' });
  assert.deepEqual(edit.captions, { enabled: true });
  assert.deepEqual(edit.crops, []);
  assert.deepEqual(edit.zoom, { enabled: true, strength: EDIT_LIMITS.defaultZoom });
  assert.deepEqual(edit.endCard, { enabled: true });

  const capped = createInitialEdit({ ranges: [{ startWord: 0, endWord: 1 }], words, speed: 1, hookText: 'a'.repeat(120) });
  assert.equal(capped.hook.text.length, EDIT_LIMITS.maxHookChars);
  const emptyHook = createInitialEdit({ ranges: [{ startWord: 0, endWord: 1 }], words, speed: 1, hookText: '   ' });
  assert.deepEqual(emptyHook.hook, { enabled: false, text: '' });
});

test('normalizeEdit throws when a range reaches past the transcript', () => {
  assert.throws(() => normalizeEdit({ ...baseEdit(), ranges: [{ startWord: 0, endWord: 10 }] }, 6));
  assert.throws(() => normalizeEdit({ ...baseEdit(), ranges: [{ startWord: 6, endWord: 9 }] }, 6));
});

test('normalizeEdit sorts and merges overlapping and adjacent ranges', () => {
  const merged = normalizeEdit({ ...baseEdit(), ranges: [{ startWord: 5, endWord: 6 }, { startWord: 0, endWord: 1 }, { startWord: 2, endWord: 3 }] }, 10);
  assert.deepEqual(merged.ranges, [{ startWord: 0, endWord: 3 }, { startWord: 5, endWord: 6 }]);
  const overlapped = normalizeEdit({ ...baseEdit(), ranges: [{ startWord: 2, endWord: 5 }, { startWord: 4, endWord: 7 }] }, 10);
  assert.deepEqual(overlapped.ranges, [{ startWord: 2, endWord: 7 }]);
});

test('normalizeEdit sorts, dedupes and drops removed words outside ranges', () => {
  const edit = normalizeEdit(
    { ...baseEdit(), ranges: [{ startWord: 5, endWord: 7 }, { startWord: 0, endWord: 3 }], removedWords: [9, 2, 2, 20, 5] },
    10,
  );
  assert.deepEqual(edit.removedWords, [2, 5]);
});

test('normalizeEdit clamps speed, pause gap and zoom strength, and trims the hook', () => {
  const edit = normalizeEdit(
    {
      ...baseEdit(),
      speed: 4,
      tightenPauses: { enabled: true, maxGapSeconds: 9 },
      zoom: { enabled: true, strength: 5 },
      hook: { enabled: true, text: '  oi  ' },
    },
    6,
  );
  assert.equal(edit.speed, EDIT_LIMITS.maxSpeed);
  assert.equal(edit.tightenPauses.maxGapSeconds, EDIT_LIMITS.maxPauseGapSeconds);
  assert.equal(edit.zoom.strength, EDIT_LIMITS.maxZoom);
  assert.equal(edit.hook.text, 'oi');

  const low = normalizeEdit(
    { ...baseEdit(), speed: 0, tightenPauses: { enabled: false, maxGapSeconds: 0.01 }, zoom: { enabled: false, strength: 0.2 } },
    6,
  );
  assert.equal(low.speed, EDIT_LIMITS.minSpeed);
  assert.equal(low.tightenPauses.maxGapSeconds, EDIT_LIMITS.minPauseGapSeconds);
  assert.equal(low.zoom.strength, EDIT_LIMITS.minZoom);
});

test('normalizeEdit sorts crops and keeps the later keyframe inside the tolerance', () => {
  const edit = normalizeEdit(
    {
      ...baseEdit(),
      crops: [
        { sourceSeconds: 2, focus: { x: 0, y: 0, w: 0.5, h: 0.5 }, origin: 'auto' },
        { sourceSeconds: 1.98, focus: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 }, origin: 'manual' },
        { sourceSeconds: 9, focus: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, origin: 'auto' },
      ],
    },
    6,
  );
  assert.deepEqual(
    edit.crops.map((crop) => crop.sourceSeconds),
    [2, 9],
  );
  assert.equal(edit.crops[0]!.origin, 'auto');
});

test('addRange appends and normalizes, rejecting ranges outside the transcript', () => {
  const edit = addRange({ ...baseEdit(), ranges: [{ startWord: 0, endWord: 2 }] }, { startWord: 3, endWord: 5 }, 6);
  assert.deepEqual(edit.ranges, [{ startWord: 0, endWord: 5 }]);
  assert.throws(() => addRange(baseEdit(), { startWord: 8, endWord: 9 }, 6));
});

test('removeRangeAt refuses to remove the last range', () => {
  const edit = { ...baseEdit(), ranges: [{ startWord: 0, endWord: 2 }, { startWord: 4, endWord: 5 }] };
  assert.deepEqual(removeRangeAt(edit, 0, 6).ranges, [{ startWord: 4, endWord: 5 }]);
  assert.throws(() => removeRangeAt(baseEdit(), 0, 6), /A short needs at least one range/);
});

test('setRangeBoundary rejects crossings and may merge with the neighbour range', () => {
  const edit = { ...baseEdit(), ranges: [{ startWord: 0, endWord: 2 }, { startWord: 4, endWord: 6 }] };
  assert.throws(() => setRangeBoundary(edit, 0, 'start', 3, 8));
  assert.throws(() => setRangeBoundary(edit, 1, 'end', 3, 8));
  assert.deepEqual(setRangeBoundary(edit, 0, 'end', 3, 8).ranges, [{ startWord: 0, endWord: 6 }]);
  assert.deepEqual(setRangeBoundary(edit, 0, 'start', 1, 8).ranges, [{ startWord: 1, endWord: 2 }, { startWord: 4, endWord: 6 }]);
  assert.deepEqual(setRangeBoundary(edit, 0, 'end', 2, 8).ranges, [{ startWord: 0, endWord: 2 }, { startWord: 4, endWord: 6 }]);
});

test('setWordsRemoved true only strikes words inside ranges, false only un-strikes', () => {
  const edit = { ...baseEdit(), ranges: [{ startWord: 2, endWord: 5 }], removedWords: [3] };
  assert.deepEqual(setWordsRemoved(edit, 0, 8, true, 10).removedWords, [2, 3, 4, 5]);
  assert.deepEqual(setWordsRemoved(edit, 0, 1, true, 10).removedWords, [3]);
  assert.deepEqual(setWordsRemoved(edit, 3, 4, false, 10).removedWords, []);
  assert.deepEqual(setWordsRemoved(edit, 3, 4, false, 10).ranges, [{ startWord: 2, endWord: 5 }]);
  assert.deepEqual(setWordsRemoved(edit, 2, 5, false, 10).removedWords, []);
});

test('seconds-based trims move inward by whole words and never past the opposite boundary', () => {
  const words = uniformWords(['a', 'b', 'c', 'd', 'e', 'f']);
  const trimmed = trimStartBySeconds(baseEdit(), words, 2.5);
  assert.deepEqual(trimmed.ranges, [{ startWord: 3, endWord: 5 }]);
  const cappedStart = trimStartBySeconds(baseEdit(), words, 100);
  assert.deepEqual(cappedStart.ranges, [{ startWord: 5, endWord: 5 }]);
  const trimmedEnd = trimEndBySeconds(baseEdit(), words, 1.2);
  assert.deepEqual(trimmedEnd.ranges, [{ startWord: 0, endWord: 3 }]);
  const cappedEnd = trimEndBySeconds(baseEdit(), words, 100);
  assert.deepEqual(cappedEnd.ranges, [{ startWord: 0, endWord: 0 }]);
});

test('seconds-based extends move outward by whole words and stop at the transcript bounds', () => {
  const words = uniformWords(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  const extended = extendStartBySeconds({ ...baseEdit(), ranges: [{ startWord: 3, endWord: 5 }] }, words, 2.5);
  assert.deepEqual(extended.ranges, [{ startWord: 0, endWord: 5 }]);
  const extendedEnd = extendEndBySeconds({ ...baseEdit(), ranges: [{ startWord: 0, endWord: 2 }] }, words, 2.5);
  assert.deepEqual(extendedEnd.ranges, [{ startWord: 0, endWord: 5 }]);
  const cappedStart = extendStartBySeconds({ ...baseEdit(), ranges: [{ startWord: 3, endWord: 5 }] }, words, 100);
  assert.deepEqual(cappedStart.ranges, [{ startWord: 0, endWord: 5 }]);
  const cappedEnd = extendEndBySeconds({ ...baseEdit(), ranges: [{ startWord: 0, endWord: 2 }] }, words, 100);
  assert.deepEqual(cappedEnd.ranges, [{ startWord: 0, endWord: 7 }]);
});

test('trimStart drops removed words that fell outside the kept ranges', () => {
  const words = uniformWords(['a', 'b', 'c', 'd', 'e', 'f']);
  const edit = { ...baseEdit(), removedWords: [1] };
  assert.deepEqual(trimStartBySeconds(edit, words, 2.5).removedWords, []);
});

test('keptWordIndices and keptText reflect ranges minus removed words', () => {
  const edit = { ...baseEdit(), ranges: [{ startWord: 0, endWord: 5 }, { startWord: 8, endWord: 9 }], removedWords: [2] };
  assert.deepEqual(keptWordIndices(edit, 10), [0, 1, 3, 4, 5, 8, 9]);
  const words = uniformWords(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  assert.equal(keptText(edit, words), 'a b d e f i j');
});

test('upsertCropKeyframe replaces keyframes within the tolerance and keeps others sorted', () => {
  const edit: ShortEdit = {
    ...baseEdit(),
    crops: [{ sourceSeconds: 5, focus: { x: 0, y: 0, w: 0.5, h: 0.5 }, origin: 'auto' }],
  };
  const replaced = upsertCropKeyframe(edit, { sourceSeconds: 5.03, focus: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, origin: 'manual' });
  assert.deepEqual(replaced.crops, [{ sourceSeconds: 5.03, focus: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, origin: 'manual' }]);
  const added = upsertCropKeyframe(edit, { sourceSeconds: 5.2, focus: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, origin: 'manual' });
  assert.deepEqual(
    added.crops.map((crop) => crop.sourceSeconds),
    [5, 5.2],
  );
  assert.deepEqual(edit.crops, [{ sourceSeconds: 5, focus: { x: 0, y: 0, w: 0.5, h: 0.5 }, origin: 'auto' }]);
});

test('removeCropKeyframe drops keyframes within the tolerance', () => {
  const edit: ShortEdit = {
    ...baseEdit(),
    crops: [
      { sourceSeconds: 1, focus: { x: 0, y: 0, w: 0.5, h: 0.5 }, origin: 'auto' },
      { sourceSeconds: 5, focus: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 }, origin: 'manual' },
    ],
  };
  const removed = removeCropKeyframe(edit, 5.01);
  assert.deepEqual(removed.crops, [{ sourceSeconds: 1, focus: { x: 0, y: 0, w: 0.5, h: 0.5 }, origin: 'auto' }]);
});

test('replaceAutoCrops keeps manual keyframes and a manual wins against a near auto', () => {
  const edit: ShortEdit = {
    ...baseEdit(),
    crops: [
      { sourceSeconds: 1, focus: { x: 0, y: 0, w: 0.5, h: 0.5 }, origin: 'auto' },
      { sourceSeconds: 3, focus: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 }, origin: 'manual' },
    ],
  };
  const replaced = replaceAutoCrops(edit, [
    { sourceSeconds: 3.02, focus: { x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, origin: 'auto' },
    { sourceSeconds: 7, focus: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, origin: 'auto' },
  ]);
  assert.deepEqual(replaced.crops, [
    { sourceSeconds: 3, focus: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 }, origin: 'manual' },
    { sourceSeconds: 7, focus: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, origin: 'auto' },
  ]);
  assert.deepEqual(
    edit.crops.map((crop) => crop.origin),
    ['auto', 'manual'],
  );
});

function fixedEditLayout(): FixedLayoutProfile {
  return {
    version: 3,
    layoutId: 'screen-top-host-bottom-v2',
    strategy: 'fixed',
    canvas: { width: 1080, height: 1920, fps: 30 },
    background: '#101010',
    safeArea: { top: 0, bottom: 0, side: 0 },
    font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
    captions: {
      sizePx: 62,
      textColor: '#FFFFFF',
      highlightColor: '#FFD400',
      outlineColor: '#000000',
      outlinePx: 6,
      shadowPx: 0,
      uppercase: true,
      maxWordsPerCue: 4,
      maxCharsPerLine: 22,
      maxLines: 2,
      centerY: 0.92,
    },
    hookBand: null,
    safeArea: { top: 0.135, bottom: 0.17, side: 0.055 },
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
  };
}

function scenesEditLayout(): ScenesLayoutProfile {
  return {
    version: 3,
    layoutId: 'mix-scenes-v3',
    strategy: 'scenes',
    canvas: { width: 1080, height: 1920, fps: 30 },
    background: '#101010',
    safeArea: { top: 0, bottom: 0, side: 0 },
    hookBand: {
      rect: { x: 0, y: 0, w: 1, h: 220 / 1920 },
      background: '#C8102E',
      textColor: '#FFFFFF',
      sizePx: 58,
      maxCharsPerLine: 24,
      maxLines: 2,
      uppercase: true,
    },
    font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
    captions: {
      sizePx: 62,
      textColor: '#FFFFFF',
      highlightColor: '#FFD400',
      outlineColor: '#000000',
      outlinePx: 6,
      shadowPx: 0,
      uppercase: true,
      maxWordsPerCue: 4,
      maxCharsPerLine: 22,
      maxLines: 2,
      centerY: 0.92,
    },
    safeArea: { top: 0.135, bottom: 0.17, side: 0.055 },
    scene: { captionCenterY: { host: 0.85, content: 0.9 } },
  };
}

function sceneEditTrack(): SceneTrack {
  return {
    version: 1,
    analyzedAt: '2026-10-19T10:00:00.000Z',
    frame: { width: 1920, height: 1080 },
    segments: [
      {
        startSeconds: 0,
        endSeconds: 10,
        host: {
          camera: { x: 0.1, y: 0.6, w: 0.6, h: 0.35 },
          head: { x: 0.4, y: 0.7, w: 0.2, h: 0.15 },
        },
        content: {
          box: { x: 0.05, y: 0.05, w: 0.9, h: 0.55 },
          kind: 'document',
          vertical: false,
          subject: { x: 0.2, y: 0.1, w: 0.4, h: 0.3 },
        },
        overlays: [],
      },
      {
        startSeconds: 10,
        endSeconds: 20,
        host: null,
        content: {
          box: { x: 0, y: 0, w: 1, h: 1 },
          kind: 'footage',
          vertical: false,
          subject: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
        },
        overlays: [],
      },
      {
        startSeconds: 20,
        endSeconds: 30,
        host: {
          camera: { x: 0.1, y: 0.6, w: 0.6, h: 0.35 },
          head: { x: 0.4, y: 0.7, w: 0.2, h: 0.15 },
        },
        content: null,
        overlays: [],
      },
    ],
  };
}

test('scene overrides target one segment and impossible modes are rejected', () => {
  const layout = scenesEditLayout();
  const track = sceneEditTrack();
  const canonical = normalizeSceneEdit(
    { ...baseEdit(), layout: { split: null, overrides: [{ sourceSeconds: 5, composition: 'content' }] } },
    layout,
    track,
  );
  assert.deepEqual(canonical.layout.overrides, [{ sourceSeconds: 0, composition: 'content' }]);
  const duplicate = normalizeSceneEdit(
    {
      ...baseEdit(),
      layout: {
        split: 0.55,
        overrides: [
          { sourceSeconds: 5, composition: 'host' },
          { sourceSeconds: 7, composition: 'content' },
        ],
      },
    },
    layout,
    track,
  );
  assert.deepEqual(duplicate.layout.overrides, [{ sourceSeconds: 0, composition: 'content' }]);
  assert.equal(duplicate.layout.split, 0.55);
  assert.throws(
    () => normalizeSceneEdit({ ...baseEdit(), layout: { split: null, overrides: [{ sourceSeconds: 15, composition: 'host' }] } }, layout, track),
    /no usable host/,
  );
  assert.throws(
    () => normalizeSceneEdit({ ...baseEdit(), layout: { split: null, overrides: [{ sourceSeconds: 15, composition: 'stack' }] } }, layout, track),
    /stack/,
  );
  assert.throws(
    () => normalizeSceneEdit({ ...baseEdit(), layout: { split: null, overrides: [{ sourceSeconds: 35, composition: 'host' }] } }, layout, track),
    /outside the scene track/,
  );
  assert.throws(
    () => normalizeSceneEdit({ ...baseEdit(), layout: { split: 0.5, overrides: [] } }, fixedEditLayout(), null),
    /Fixed layouts reject scene layout edits/,
  );
  assert.throws(
    () => normalizeSceneEdit({ ...baseEdit(), layout: { split: null, overrides: [{ sourceSeconds: 1, composition: 'host' }] } }, fixedEditLayout(), null),
    /Fixed layouts reject scene layout edits/,
  );
  const untouched = normalizeSceneEdit(baseEdit(), fixedEditLayout(), null);
  assert.deepEqual(untouched.layout, { split: null, overrides: [] });
  assert.throws(
    () => normalizeSceneEdit({ ...baseEdit(), crops: [{ sourceSeconds: 1, focus: { x: 0, y: 0, w: 0.1, h: 0.1 }, origin: 'manual' }] }, layout, null),
    /require scene analysis/,
  );
});

test('normalizeEdit validates split and override times', () => {
  assert.throws(() => normalizeEdit({ ...baseEdit(), layout: { split: 0.7, overrides: [] } }, 6));
  assert.throws(() => normalizeEdit({ ...baseEdit(), layout: { split: 0.3, overrides: [] } }, 6));
  assert.throws(() => normalizeEdit({ ...baseEdit(), layout: { split: Number.NaN, overrides: [] } }, 6));
  assert.throws(() => normalizeEdit({ ...baseEdit(), layout: { split: null, overrides: [{ sourceSeconds: -1, composition: 'host' }] } }, 6));
  const deduped = normalizeEdit(
    {
      ...baseEdit(),
      layout: {
        split: null,
        overrides: [
          { sourceSeconds: 3, composition: 'host' },
          { sourceSeconds: 2, composition: 'content' },
          { sourceSeconds: 3, composition: 'stack' },
        ],
      },
    },
    6,
  );
  assert.deepEqual(deduped.layout.overrides, [
    { sourceSeconds: 2, composition: 'content' },
    { sourceSeconds: 3, composition: 'stack' },
  ]);
});

test('scene focus is local to its content box and is rejected outside it', () => {
  const layout = scenesEditLayout();
  const track = sceneEditTrack();
  const local = normalizeSceneEdit(
    { ...baseEdit(), crops: [{ sourceSeconds: 4, focus: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 }, origin: 'manual' }] },
    layout,
    track,
  );
  assert.deepEqual(local.crops, [{ sourceSeconds: 4, focus: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 }, origin: 'manual' }]);
  assert.throws(
    () => normalizeSceneEdit(
      { ...baseEdit(), crops: [{ sourceSeconds: 4, focus: { x: 0.5, y: 0.2, w: 0.6, h: 0.3 }, origin: 'manual' }] },
      layout,
      track,
    ),
    /inside its content box/,
  );
  assert.throws(
    () => normalizeSceneEdit(
      { ...baseEdit(), crops: [{ sourceSeconds: 25, focus: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 }, origin: 'auto' }] },
      layout,
      track,
    ),
    /no content/,
  );
  assert.throws(
    () => normalizeSceneEdit(
      { ...baseEdit(), crops: [{ sourceSeconds: 35, focus: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 }, origin: 'auto' }] },
      layout,
      track,
    ),
    /outside the scene track/,
  );
});
