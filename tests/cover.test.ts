import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseCoverFrame } from '../src/domain/cover.js';
import type { FixedLayoutProfile, ScenesLayoutProfile } from '../src/domain/layout.js';
import type { SceneTrack } from '../src/domain/model.js';

const SOURCE = { width: 1280, height: 720 };

const scenesLayout: ScenesLayoutProfile = {
  version: 3,
  strategy: 'scenes',
  layoutId: 'mix-scenes-v3',
  canvas: { width: 1080, height: 1920, fps: 30 },
  background: '#101010',
  font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
  hookBand: { rect: { x: 0, y: 0, w: 1, h: 0.215 }, background: '#C8102E', textColor: '#FFFFFF', sizePx: 58, maxCharsPerLine: 24, maxLines: 2, uppercase: true },
  captions: { sizePx: 62, textColor: '#FFFFFF', highlightColor: '#FFD400', outlineColor: '#000000', outlinePx: 6, shadowPx: 2, uppercase: true, maxWordsPerCue: 4, maxCharsPerLine: 16, maxLines: 2, centerY: 0.5521 },
  safeArea: { top: 0.135, bottom: 0.17, side: 0.055 },
  scene: { captionCenterY: { host: 0.72, content: 0.78 } },
};

const fixedLayout: FixedLayoutProfile = {
  ...scenesLayout,
  strategy: 'fixed',
  hookBand: null,
  panels: [
    { id: 'host', role: 'host', sourceRect: { x: 0.637, y: 0, w: 0.363, h: 1 }, canvasRect: { x: 0, y: 0.5521, w: 1, h: 0.4479 }, anchor: { x: 0.5, y: 0.42 } },
  ],
};

function segment(startSeconds: number, endSeconds: number, host: SceneTrack['segments'][number]['host']): SceneTrack['segments'][number] {
  return {
    startSeconds,
    endSeconds,
    host,
    content: host === null ? { box: { x: 0, y: 0, w: 0.6, h: 1 }, kind: 'document', vertical: false, subject: { x: 0.1, y: 0.1, w: 0.4, h: 0.8 } } : null,
    overlays: [],
  };
}

function track(segments: SceneTrack['segments']): SceneTrack {
  return { version: 1, analyzedAt: '2026-01-01T00:00:00.000Z', frame: { width: SOURCE.width, height: SOURCE.height }, segments };
}

test('scenes cover waits for the first usable host segment inside the retained clips', () => {
  const sceneTrack = track([
    segment(0, 10, null),
    segment(10, 20, { camera: { x: 0.25, y: 0, w: 0.5, h: 1 }, head: { x: 0.4, y: 0.2, w: 0.2, h: 0.3 } }),
  ]);
  const choice = chooseCoverFrame({
    clips: [{ sourceStart: 2, sourceEnd: 12 }],
    layout: scenesLayout,
    sceneTrack,
    hostFraming: null,
    source: SOURCE,
  });
  assert.equal(choice.sourceSeconds, 11);
  assert.ok(choice.sourceSeconds >= 10 && choice.sourceSeconds < 20);
  assert.equal(choice.portrait, true);
});

test('scenes cover crop is portrait 4:5 around the head inside the camera bounds', () => {
  const sceneTrack = track([
    segment(0, 10, null),
    segment(10, 20, { camera: { x: 0.25, y: 0, w: 0.5, h: 1 }, head: { x: 0.4, y: 0.2, w: 0.2, h: 0.3 } }),
  ]);
  const choice = chooseCoverFrame({
    clips: [{ sourceStart: 2, sourceEnd: 12 }],
    layout: scenesLayout,
    sceneTrack,
    hostFraming: null,
    source: SOURCE,
  });
  assert.deepEqual(choice.crop, { x: 434, y: 54, w: 410, h: 514 });
  const ratio = choice.crop.w / choice.crop.h;
  assert.ok(Math.abs(ratio - 0.8) < 0.01, `crop ratio ${ratio} is not 4:5`);
  const head = { x: 512, y: 144, w: 256, h: 216 };
  assert.ok(choice.crop.x <= head.x && head.x + head.w <= choice.crop.x + choice.crop.w, 'crop misses the head horizontally');
  assert.ok(choice.crop.y <= head.y && head.y + head.h <= choice.crop.y + choice.crop.h, 'crop misses the head vertically');
  assert.ok(choice.crop.x >= 320 && choice.crop.x + choice.crop.w <= 960, 'crop leaves the camera bounds horizontally');
  assert.ok(choice.crop.y >= 0 && choice.crop.y + choice.crop.h <= 720, 'crop leaves the camera bounds vertically');
});

test('scenes cover crop near the frame edge is clamped inside the camera bounds', () => {
  const sceneTrack = track([
    segment(0, 6, { camera: { x: 0.5, y: 0, w: 0.5, h: 1 }, head: { x: 0.85, y: 0.1, w: 0.1, h: 0.2 } }),
  ]);
  const choice = chooseCoverFrame({
    clips: [{ sourceStart: 0, sourceEnd: 6 }],
    layout: scenesLayout,
    sceneTrack,
    hostFraming: null,
    source: SOURCE,
  });
  assert.deepEqual(choice.crop, { x: 1004, y: 12, w: 274, h: 342 });
  assert.ok(choice.crop.x >= 640 && choice.crop.x + choice.crop.w <= 1280, 'crop leaves the camera bounds horizontally');
  assert.ok(choice.crop.y >= 0 && choice.crop.y + choice.crop.h <= 720, 'crop leaves the camera bounds vertically');
});

test('cover without a usable host keeps the full frame at the plain time rule', () => {
  const sceneTrack = track([segment(0, 50, null)]);
  const choice = chooseCoverFrame({
    clips: [{ sourceStart: 4, sourceEnd: 8 }],
    layout: scenesLayout,
    sceneTrack,
    hostFraming: null,
    source: SOURCE,
  });
  assert.equal(choice.sourceSeconds, 4 + Math.min(2, Math.max(0.3, 4 / 3)));
  assert.deepEqual(choice.crop, { x: 0, y: 0, w: SOURCE.width, h: SOURCE.height });
  assert.equal(choice.portrait, false);
});

test('fixed layout cover frames the host panel through the framing head box', () => {
  const choice = chooseCoverFrame({
    clips: [{ sourceStart: 5, sourceEnd: 9 }],
    layout: fixedLayout,
    sceneTrack: null,
    hostFraming: { headBox: { x: 0.7, y: 0.2, w: 0.15, h: 0.25 } },
    source: SOURCE,
  });
  assert.equal(choice.sourceSeconds, 5 + Math.min(2, Math.max(0.3, 4 / 3)));
  assert.deepEqual(choice.crop, { x: 820, y: 68, w: 342, h: 428 });
  const head = { x: 896, y: 144, w: 192, h: 180 };
  assert.ok(choice.crop.x <= head.x && head.x + head.w <= choice.crop.x + choice.crop.w, 'crop misses the head horizontally');
  assert.ok(choice.crop.y <= head.y && head.y + head.h <= choice.crop.y + choice.crop.h, 'crop misses the head vertically');
  assert.ok(choice.crop.x >= 815.36 && choice.crop.x + choice.crop.w <= 1280, 'crop leaves the host panel bounds horizontally');
});

test('cover frame choice throws without retained clips', () => {
  assert.throws(
    () => chooseCoverFrame({ clips: [], layout: fixedLayout, sceneTrack: null, hostFraming: null, source: SOURCE }),
    /requires at least one retained clip/,
  );
});
