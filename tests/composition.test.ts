import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormRect, PxRect, ScenesLayoutProfile } from '../src/domain/layout.js';
import type { SceneSegment } from '../src/domain/model.js';
import {
  captionY,
  chooseStackSplit,
  compositionPanels,
  containForeground,
  contentFocus,
  contentWindow,
  documentPanelInset,
  type CompositionSpan,
} from '../src/domain/composition.js';
import { defaultComposition, hostUsable, allowedCompositions } from '../src/domain/scene.js';
import { buildTimeline } from '../src/domain/timeline.js';

const SOURCE = { width: 1920, height: 1080 };
const STACK_CONTENT_CANVAS: PxRect = { x: 0, y: 220, w: 1080, h: 850 };

function rect(x: number, y: number, w: number, h: number): NormRect {
  return { x, y, w, h };
}

function gaiofatoSegment(): SceneSegment {
  return {
    startSeconds: 80,
    endSeconds: 84,
    host: {
      camera: rect(719 / 1000, 55 / 1000, 263 / 1000, 362 / 1000),
      head: rect(788 / 1000, 76 / 1000, 96 / 1000, 220 / 1000),
    },
    content: {
      box: rect(0, 0, 1, 1),
      kind: 'footage',
      vertical: false,
      subject: rect(170 / 1000, 19 / 1000, 605 / 1000, 781 / 1000),
    },
    overlays: [
      rect(24 / 1000, 34 / 1000, 83 / 1000, 51 / 1000),
      rect(722 / 1000, 462 / 1000, 262 / 1000, 480 / 1000),
      rect(973 / 1000, 938 / 1000, 23 / 1000, 41 / 1000),
    ],
  };
}

function scenesLayout(): ScenesLayoutProfile {
  return {
    version: 3,
    layoutId: 'mix-scenes-v3',
    strategy: 'scenes',
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
      shadowPx: 2,
      uppercase: true,
      maxWordsPerCue: 4,
      maxCharsPerLine: 16,
      maxLines: 2,
      centerY: 0.5521,
    },
    hookBand: {
      rect: { x: 0, y: 0, w: 1, h: 220 / 1920 },
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

function overlapArea(a: PxRect, b: PxRect): number {
  const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function assertContainsFocus(source: PxRect, focus: NormRect, frame: { width: number; height: number } = SOURCE): void {
  const px = { x: focus.x * frame.width, y: focus.y * frame.height, w: focus.w * frame.width, h: focus.h * frame.height };
  assert.ok(px.x >= source.x && px.y >= source.y, `focus left/top escaped ${JSON.stringify(source)}`);
  assert.ok(
    px.x + px.w <= source.x + source.w && px.y + px.h <= source.y + source.h,
    `focus ${JSON.stringify(px)} escaped crop ${JSON.stringify(source)}`,
  );
}

test('Gaiofato-style PiP inside content is excluded when a lower-overlap window exists', () => {
  const segment = {
    ...gaiofatoSegment(),
    overlays: [gaiofatoSegment().overlays[1]!, gaiofatoSegment().overlays[2]!],
    content: { box: rect(0, 0, 1, 1), kind: 'footage' as const, vertical: false, subject: rect(0.35, 0.15, 0.35, 0.7) },
  };
  const window = contentWindow({ segment, focus: null, source: SOURCE, canvas: STACK_CONTENT_CANVAS, inset: null });
  const camera = { x: 1380.48, y: 59.4, w: 504.96, h: 390.96 };
  const chat = { x: 1386.24, y: 498.96, w: 503.04, h: 518.4 };
  assert.equal(overlapArea(window.source, camera), 0);
  assert.equal(overlapArea(window.source, chat), 0);
  assertContainsFocus(window.source, segment.content.subject);
  assert.deepEqual(window.source, { x: 0, y: 0, w: 1374, h: 1080 });
  const again = contentWindow({ segment, focus: null, source: SOURCE, canvas: STACK_CONTENT_CANVAS, inset: null });
  assert.deepEqual(again, window);
});

test('chat QR logo and Libras overlap costs rank content windows', () => {
  const base: SceneSegment = {
    startSeconds: 0,
    endSeconds: 4,
    host: null,
    content: { box: rect(0, 0, 1, 1), kind: 'footage', vertical: false, subject: rect(0.1, 0.2, 0.3, 0.4) },
    overlays: [],
  };
  const smallCanvas: PxRect = { x: 0, y: 0, w: 540, h: 540 };
  const smallSource = { width: 960, height: 540 };
  const chatPx = { x: 480, y: 0, w: 79.68, h: 540 };
  const qrPx = { x: 19.2, y: 16.2, w: 96, h: 81 };
  const librasPx = { x: 96, y: 405, w: 192, h: 108 };
  const baseline = contentWindow({ segment: base, focus: null, source: smallSource, canvas: smallCanvas, inset: null });
  assert.deepEqual(baseline.source, { x: 0, y: 0, w: 540, h: 540 });
  const chatOnly: SceneSegment = { ...base, overlays: [rect(0.5, 0, 83 / 1000, 1)] };
  const chatWindow = contentWindow({ segment: chatOnly, focus: null, source: smallSource, canvas: smallCanvas, inset: null });
  assert.equal(overlapArea(chatWindow.source, chatPx), 0);
  assertContainsFocus(chatWindow.source, base.content.subject, smallSource);

  const qrOnly: SceneSegment = { ...base, overlays: [rect(0.02, 0.03, 0.1, 0.15)] };
  const qrWindow = contentWindow({ segment: qrOnly, focus: null, source: smallSource, canvas: smallCanvas, inset: null });
  assert.notDeepEqual(qrWindow.source, baseline.source);
  assert.ok(overlapArea(qrWindow.source, qrPx) < 96 * 81 / 2, `QR overlap not reduced: ${JSON.stringify(qrWindow.source)}`);

  const librasOnly: SceneSegment = { ...base, overlays: [rect(0.05, 0.75, 0.2, 0.2)] };
  const librasWindow = contentWindow({ segment: librasOnly, focus: null, source: smallSource, canvas: smallCanvas, inset: null });
  assert.notDeepEqual(librasWindow.source, baseline.source);
  assert.ok(overlapArea(librasWindow.source, librasPx) < 192 * 108 / 2, `Libras overlap not reduced: ${JSON.stringify(librasWindow.source)}`);

  const persistent: SceneSegment = {
    ...gaiofatoSegment(),
    content: { box: rect(0, 0, 1, 1), kind: 'footage', vertical: false, subject: rect(0, 0, 1, 1) },
  };
  const forced = contentWindow({ segment: persistent, focus: null, source: SOURCE, canvas: STACK_CONTENT_CANVAS, inset: null });
  assert.equal(forced.fill, 'contain');
  assert.deepEqual(forced.source, { x: 0, y: 0, w: 1920, h: 1080 });
  assert.equal(forced.subjectCutShare, 0);
});

test('a document covering more than one fifth of the head selects content', () => {
  const head = rect(0.4, 0.2, 0.2, 0.2);
  const boundary: SceneSegment = {
    startSeconds: 0,
    endSeconds: 4,
    host: { camera: rect(0, 0, 1, 1), head },
    content: { box: rect(0.4, 0.36, 0.2, 0.04), kind: 'document', vertical: false, subject: rect(0.42, 0.37, 0.16, 0.02) },
    overlays: [],
  };
  assert.ok(Math.abs(overlapAreaNormalized(boundary.content.box, head) - 0.008) < 1e-12);
  assert.equal(hostUsable(boundary), true);
  assert.deepEqual(allowedCompositions(boundary), ['stack', 'host', 'content']);
  assert.equal(defaultComposition(boundary), 'stack');

  const occluded: SceneSegment = {
    ...boundary,
    content: { box: rect(0.4, 0.355, 0.2, 0.045), kind: 'document', vertical: false, subject: rect(0.42, 0.37, 0.16, 0.02) },
  };
  assert.equal(hostUsable(occluded), false);
  assert.deepEqual(allowedCompositions(occluded), ['content']);
  assert.equal(defaultComposition(occluded), 'content');

  const koboriQuestionCard: SceneSegment = {
    startSeconds: 4,
    endSeconds: 8,
    host: { camera: rect(0, 0, 1, 1), head: rect(399 / 1000, 95 / 1000, 184 / 1000, 179 / 1000) },
    content: {
      box: rect(26 / 1000, 270 / 1000, 950 / 1000, 535 / 1000),
      kind: 'document',
      vertical: false,
      subject: rect(52 / 1000, 301 / 1000, 805 / 1000, 468 / 1000),
    },
    overlays: [rect(24 / 1000, 34 / 1000, 102 / 1000, 241 / 1000)],
  };
  assert.equal(defaultComposition(koboriQuestionCard), 'stack');
  assert.equal(defaultComposition({ ...koboriQuestionCard, content: null }), 'host');
});

function overlapAreaNormalized(a: NormRect, b: NormRect): number {
  const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

test('vertical content selects content composition', () => {
  const borelliVertical: SceneSegment = {
    startSeconds: 0,
    endSeconds: 4,
    host: null,
    content: {
      box: rect(341 / 1000, 0, 317 / 1000, 1),
      kind: 'footage',
      vertical: true,
      subject: rect(443 / 1000, 468 / 1000, 215 / 1000, 259 / 1000),
    },
    overlays: [rect(762 / 1000, 929 / 1000, 230 / 1000, 54 / 1000)],
  };
  assert.equal(defaultComposition(borelliVertical), 'content');
  assert.deepEqual(allowedCompositions(borelliVertical), ['content']);

  const verticalWithPip: SceneSegment = {
    ...borelliVertical,
    host: { camera: rect(719 / 1000, 55 / 1000, 263 / 1000, 362 / 1000), head: rect(788 / 1000, 76 / 1000, 96 / 1000, 220 / 1000) },
  };
  assert.equal(defaultComposition(verticalWithPip), 'content');
  assert.deepEqual(allowedCompositions(verticalWithPip), ['stack', 'host', 'content']);
});

test('full-frame host with non-document content stays host', () => {
  const base: SceneSegment = {
    startSeconds: 0,
    endSeconds: 4,
    host: { camera: rect(0, 0, 1, 1), head: rect(0.4, 0.1, 0.2, 0.18) },
    content: { box: rect(0.55, 0.35, 0.4, 0.3), kind: 'footage', vertical: false, subject: rect(0.6, 0.4, 0.3, 0.2) },
    overlays: [],
  };
  assert.equal(defaultComposition(base), 'host');
  assert.deepEqual(allowedCompositions(base), ['stack', 'host', 'content']);
  assert.equal(defaultComposition({ ...base, content: { ...base.content!, kind: 'document' } }), 'stack');
  assert.equal(defaultComposition({ ...base, content: { ...base.content!, vertical: true } }), 'content');
  assert.throws(() => defaultComposition({ ...base, host: null, content: null }));
});

test('wide document focus is contained without cutting words horizontally', () => {
  const wideDocument: SceneSegment = {
    startSeconds: 0,
    endSeconds: 4,
    host: null,
    content: { box: rect(0, 0, 1, 1), kind: 'document', vertical: false, subject: rect(0.1, 0.4, 0.8, 0.2) },
    overlays: [],
  };
  const window = contentWindow({ segment: wideDocument, focus: null, source: SOURCE, canvas: STACK_CONTENT_CANVAS, inset: null });
  assert.equal(window.fill, 'contain');
  assert.equal(window.source.x, 192);
  assert.equal(window.source.w, 1536);
  assert.equal(window.subjectCutShare, 0);
  assertContainsFocus(window.source, wideDocument.content.subject);

  const wideFootage: SceneSegment = {
    ...wideDocument,
    content: { box: rect(0, 0, 1, 1), kind: 'footage', vertical: false, subject: rect(0.1, 0.35, 0.7, 0.3) },
  };
  const footageWindow = contentWindow({ segment: wideFootage, focus: null, source: SOURCE, canvas: STACK_CONTENT_CANVAS, inset: null });
  assert.equal(footageWindow.fill, 'contain');
  assert.equal(footageWindow.subjectCutShare, 0);

  const narrowFocus: NormRect = rect(0.55, 0.2, 0.1, 0.1);
  const manual = contentWindow({ segment: wideDocument, focus: narrowFocus, source: SOURCE, canvas: STACK_CONTENT_CANVAS, inset: null });
  assertContainsFocus(manual.source, narrowFocus);
  assert.deepEqual(contentFocus(wideDocument, narrowFocus), rect(0.55, 0.2, 0.1, 0.1));
  assert.deepEqual(contentFocus({ ...wideDocument, content: { ...wideDocument.content!, box: rect(0.5, 0.1, 0.4, 0.2) } }, rect(0, 0, 0.5, 0.5)), rect(0.5, 0.1, 0.2, 0.1));
});

test('persistent Gaiofato chat overlap still produces a focus-preserving composition', () => {
  const segment = gaiofatoSegment();
  const window = contentWindow({ segment, focus: null, source: SOURCE, canvas: STACK_CONTENT_CANVAS, inset: null });
  assertContainsFocus(window.source, segment.content.subject);
  assert.ok(window.source.x >= 0 && window.source.y >= 0);
  assert.ok(window.source.x + window.source.w <= SOURCE.width && window.source.y + window.source.h <= SOURCE.height);
  const repeat = contentWindow({ segment, focus: null, source: SOURCE, canvas: STACK_CONTENT_CANVAS, inset: null });
  assert.deepEqual(repeat, window);

  const hostSegment: SceneSegment = {
    startSeconds: 84,
    endSeconds: 88,
    host: segment.host,
    content: null,
    overlays: [],
  };
  const timeline = buildTimeline({
    edit: {
      ranges: [{ startWord: 0, endWord: 7 }],
      removedWords: [],
      tightenPauses: { enabled: false, maxGapSeconds: 0.35 },
      speed: 1,
      hook: { enabled: false, text: '' },
      captions: { enabled: false },
      crops: [],
      zoom: { enabled: false, strength: 1.12 },
      endCard: { enabled: false },
      layout: { split: 0.5, overrides: [] },
    },
    words: [0, 1, 2, 3, 4, 5, 6, 7].map((index) => ({
      id: `w${index}`,
      text: `p${index}`,
      startSeconds: 80.5 + index * 0.5,
      endSeconds: 80.9 + index * 0.5,
      speakerId: 'A',
      confidence: null,
    })),
    layout: scenesLayout(),
    title: 't',
    source: { ...SOURCE, durationSeconds: 88 },
    hostFraming: null,
    sceneTrack: {
      version: 1,
      analyzedAt: '2026-10-19T10:00:00.000Z',
      frame: { width: SOURCE.width, height: SOURCE.height },
      segments: [segment, hostSegment],
    },
  });
  assert.ok(timeline.clips.length >= 2);
  for (const clip of timeline.clips) {
    for (const placement of clip.panels) {
      assert.ok(placement.source.x >= 0 && placement.source.y >= 0);
      assert.ok(placement.source.x + placement.source.w <= SOURCE.width);
      assert.ok(placement.source.y + placement.source.h <= SOURCE.height);
    }
  }
  const stackClip = timeline.clips[0]!;
  assert.deepEqual(stackClip.composition, 'stack');
  const contentPlacement = stackClip.panels.find((panel) => panel.role === 'content')!;
  const stageWindow = contentWindow({ segment, focus: null, source: SOURCE, canvas: STACK_CONTENT_CANVAS, inset: null });
  assert.deepEqual(contentPlacement.source, stageWindow.source);
  assert.deepEqual(contentPlacement.canvas, STACK_CONTENT_CANVAS);
  assert.deepEqual(stackClip.panels.find((panel) => panel.role === 'host')!.canvas, { x: 0, y: 1070, w: 1080, h: 850 });
});

test('one-percent overlap buckets rank before area and focus-center distance', () => {
  const occluded: SceneSegment = {
    startSeconds: 0,
    endSeconds: 4,
    host: null,
    content: { box: rect(0, 0, 1, 1), kind: 'footage', vertical: false, subject: rect(0.25, 0.25, 0.25, 0.25) },
    overlays: [rect(0, 0, 0.3, 0.3)],
  };
  const window = contentWindow({ segment: occluded, focus: null, source: { width: 400, height: 400 }, canvas: { x: 0, y: 0, w: 200, h: 200 }, inset: null });
  assert.deepEqual(window.source, { x: 100, y: 100, w: 300, h: 300 });

  const offCenter: SceneSegment = {
    ...occluded,
    overlays: [],
    content: { box: rect(0, 0, 1, 1), kind: 'footage', vertical: false, subject: rect(0.4, 0.43, 0.1, 0.06) },
  };
  const centered = contentWindow({ segment: offCenter, focus: null, source: { width: 1000, height: 1000 }, canvas: { x: 0, y: 0, w: 500, h: 250 }, inset: null });
  assert.deepEqual(centered.source, { x: 0, y: 204, w: 1000, h: 502 });
});

function documentSpan(outputSeconds: number, source: { width: number; height: number }): CompositionSpan {
  return {
    segment: {
      startSeconds: 0,
      endSeconds: 10,
      host: { camera: rect(0.1, 0.6, 0.5, 0.4), head: rect(0.3, 0.66, 0.1, 0.15) },
      content: { box: rect(0.4, 0, 0.25, 0.5), kind: 'document', vertical: false, subject: rect(0.42, 0.05, 0.2, 0.4) },
      overlays: [],
    },
    composition: 'stack',
    focus: null,
    outputSeconds,
    zoom: 1,
  };
}

function footageSpan(outputSeconds: number, source: { width: number; height: number }): CompositionSpan {
  return {
    segment: {
      startSeconds: 10,
      endSeconds: 20,
      host: { camera: rect(0.65, 0.55, 0.3, 0.4), head: rect(0.75, 0.6, 0.08, 0.12) },
      content: { box: rect(0, 0, 1, 0.5), kind: 'footage', vertical: false, subject: rect(0.1, 0.1, 0.4, 0.3) },
      overlays: [],
    },
    composition: 'stack',
    focus: rect(0.15, 0.18, 0.12, 0.12),
    outputSeconds,
    zoom: 1,
  };
}

test('split cost is source-resolution invariant and duration weighted', () => {
  const quarter = { width: 1280, height: 720 };
  const documentSplit = chooseStackSplit({ spans: [documentSpan(10, SOURCE)], layout: scenesLayout(), source: SOURCE });
  assert.equal(documentSplit, chooseStackSplit({ spans: [documentSpan(10, quarter)], layout: scenesLayout(), source: quarter }));
  const footageSplit = chooseStackSplit({ spans: [footageSpan(10, SOURCE)], layout: scenesLayout(), source: SOURCE });
  assert.equal(footageSplit, chooseStackSplit({ spans: [footageSpan(10, quarter)], layout: scenesLayout(), source: quarter }));
  assert.notEqual(documentSplit, footageSplit);
  assert.equal(chooseStackSplit({ spans: [documentSpan(10, SOURCE), footageSpan(0.5, SOURCE)], layout: scenesLayout(), source: SOURCE }), documentSplit);
  assert.equal(chooseStackSplit({ spans: [documentSpan(0.5, SOURCE), footageSpan(10, SOURCE)], layout: scenesLayout(), source: SOURCE }), footageSplit);
});

test('split ties select the center and no-stack shorts use one half', () => {
  assert.equal(chooseStackSplit({ spans: [], layout: scenesLayout(), source: SOURCE }), 0.5);
  const contentOnly: CompositionSpan = { ...documentSpan(5, SOURCE), composition: 'content' };
  assert.equal(chooseStackSplit({ spans: [contentOnly], layout: scenesLayout(), source: SOURCE }), 0.5);
  const smallFocus: CompositionSpan = {
    ...documentSpan(5, SOURCE),
    segment: {
      startSeconds: 0,
      endSeconds: 10,
      host: { camera: rect(0.1, 0.6, 0.5, 0.4), head: rect(0.3, 0.66, 0.1, 0.15) },
      content: { box: rect(0, 0, 1, 0.5), kind: 'document', vertical: false, subject: rect(0.45, 0.2, 0.06, 0.06) },
      overlays: [],
    },
  };
  assert.equal(chooseStackSplit({ spans: [smallFocus], layout: scenesLayout(), source: SOURCE }), 0.5);
});

test('caption positions come from the layout per composition and containForeground centers both axes', () => {
  const layout = scenesLayout();
  assert.equal(captionY(layout, 'host', null), 0.85);
  assert.equal(captionY(layout, 'content', null), 0.9);
  assert.equal(captionY(layout, 'stack', 0.5), (220 + 850) / 1920);
  assert.equal(captionY(layout, 'stack', 0.65), (220 + 2 * Math.round((1700 * 0.65) / 2)) / 1920);
  assert.throws(() => captionY(layout, 'stack', null));
  assert.equal(
    captionY({ ...scenesLayout(), strategy: 'fixed', panels: [] }, null, null),
    0.5521,
  );

  const wide = containForeground({ x: 0, y: 0, w: 1920, h: 1080 }, { x: 0, y: 220, w: 1080, h: 1700 });
  assert.deepEqual(wide, { x: 0, y: 767, w: 1080, h: 606 });
  const tall = containForeground({ x: 0, y: 0, w: 608, h: 1080 }, { x: 0, y: 220, w: 1080, h: 1700 });
  assert.deepEqual(tall, { x: 62, y: 220, w: 956, h: 1700 });
});

test('document windows inset by the safe area render contain while footage keeps cover', () => {
  const insetLayout: ScenesLayoutProfile = {
    ...scenesLayout(),
    safeArea: { top: 0.135, bottom: 0.17, side: 0.055 },
  };
  const stage: PxRect = { x: 0, y: 220, w: 1080, h: 1700 };
  const inset = documentPanelInset(insetLayout, stage);
  assert.deepEqual(inset, { x: 59.4, y: 220, w: 961.2, h: 1700 });
  assert.equal(documentPanelInset(scenesLayout(), stage), null);
  assert.equal(documentPanelInset(insetLayout, { x: 100, y: 220, w: 880, h: 1700 }), null);

  const portraitDocument: SceneSegment = {
    startSeconds: 0,
    endSeconds: 4,
    host: null,
    content: { box: rect(0.2, 0, 0.6, 1), kind: 'document', vertical: true, subject: rect(0.34, 0.05, 0.28, 0.9) },
    overlays: [],
  };
  const documentWindow = contentWindow({ segment: portraitDocument, focus: null, source: SOURCE, canvas: stage, inset });
  assert.equal(documentWindow.fill, 'contain');
  assert.ok(Math.abs(documentWindow.source.w / documentWindow.source.h - inset.w / inset.h) < 0.02, `document crop aspect ${documentWindow.source.w / documentWindow.source.h} != inset aspect`);
  assertContainsFocus(documentWindow.source, portraitDocument.content.subject);
  const placement = compositionPanels({ segment: portraitDocument, composition: 'content', focus: null, source: SOURCE, layout: insetLayout, split: 0.5, zoom: 1 });
  assert.deepEqual(placement[0]!.canvas, stage);
  assert.deepEqual(placement[0]!.source, documentWindow.source);

  const wideFootage: SceneSegment = {
    ...portraitDocument,
    content: { box: rect(0, 0, 1, 1), kind: 'footage', vertical: false, subject: rect(0.35, 0.1, 0.3, 0.55) },
  };
  const footagePlacement = compositionPanels({ segment: wideFootage, composition: 'content', focus: null, source: SOURCE, layout: insetLayout, split: 0.5, zoom: 1 });
  assert.equal(footagePlacement[0]!.fill, 'cover');
  assert.ok(Math.abs(footagePlacement[0]!.source.w / footagePlacement[0]!.source.h - stage.w / stage.h) < 0.02);

  const stackSegment: SceneSegment = {
    ...portraitDocument,
    host: { camera: rect(0.85, 0.05, 0.12, 0.2), head: rect(0.88, 0.08, 0.06, 0.1) },
  };
  const stackPlacement = compositionPanels({ segment: stackSegment, composition: 'stack', focus: null, source: SOURCE, layout: insetLayout, split: 0.5, zoom: 1 });
  assert.equal(stackPlacement[0]!.fill, 'contain');
  assert.deepEqual(stackPlacement[0]!.canvas, { x: 0, y: 220, w: 1080, h: 850 });
  assert.ok(Math.abs(stackPlacement[0]!.source.w / stackPlacement[0]!.source.h - (961.2 / 850)) < 0.02);
});
