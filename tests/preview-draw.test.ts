import assert from 'node:assert/strict';
import { test } from 'node:test';

import { drawCaptions, drawClipPanels } from '../web/src/preview/draw.js';
import type { LayoutProfile } from '../src/domain/layout.js';
import type { CaptionCue, TimelineClip, TimelinePanelPlacement } from '../src/domain/timeline.js';

interface RecordedDraw {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

interface RecordedText {
  text: string;
  x: number;
  y: number;
}

class CanvasRecorder {
  readonly draws: RecordedDraw[] = [];
  readonly texts: RecordedText[] = [];
  readonly strokes: RecordedText[] = [];
  filter = 'none';

  save(): void {}
  restore(): void {}
  beginPath(): void {}
  rect(): void {}
  clip(): void {}
  drawImage(image: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void {
    this.draws.push({ sx, sy, sw, sh, dx, dy, dw, dh });
  }
  measureText(text: string): { width: number } {
    return { width: text.length * 10 };
  }
  fillText(text: string, x: number, y: number): void {
    this.texts.push({ text, x, y });
  }
  strokeText(text: string, x: number, y: number): void {
    this.strokes.push({ text, x, y });
  }
}

const layout: LayoutProfile = {
  version: 3,
  strategy: 'fixed',
  layoutId: 'preview-test',
  canvas: { width: 1080, height: 1920, fps: 30 },
  background: '#101010',
  font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
  hookBand: null,
  panels: [],
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

function clipWithPanel(panel: TimelinePanelPlacement): TimelineClip {
  return {
    index: 0,
    sourceStart: 0,
    sourceEnd: 1,
    outputStart: 0,
    outputEnd: 1,
    joinsPrevious: false,
    zoom: 1,
    composition: null,
    sceneStartSeconds: null,
    captionCenterY: 0.5521,
    panels: [panel],
  };
}

function cueOf(lines: Array<Array<{ text: string }>>): CaptionCue {
  let wordIndex = 0;
  return {
    lines: lines.map((line) => line.map((word) => ({ wordIndex: wordIndex++, text: word.text, outputStart: 0, outputEnd: 0.5 }))),
    outputStart: 0,
    outputEnd: 1,
    centerY: 0.75,
  };
}

test('preview contain geometry and cue Y match exported placements', () => {
  const fakeImage = {} as CanvasImageSource;
  const wideRecorder = new CanvasRecorder();
  drawClipPanels(
    wideRecorder as unknown as CanvasRenderingContext2D,
    clipWithPanel({ panelId: 'content', role: 'content', source: { x: 0, y: 0, w: 1920, h: 400 }, canvas: { x: 0, y: 200, w: 1080, h: 600 }, fill: 'contain' }),
    fakeImage,
  );
  assert.deepEqual(wideRecorder.draws, [
    { sx: 0, sy: 0, sw: 1920, sh: 400, dx: -930, dy: 170, dw: 2940, dh: 660 },
    { sx: 0, sy: 0, sw: 1920, sh: 400, dx: 0, dy: 388, dw: 1080, dh: 224 },
  ]);

  const tallRecorder = new CanvasRecorder();
  drawClipPanels(
    tallRecorder as unknown as CanvasRenderingContext2D,
    clipWithPanel({ panelId: 'content', role: 'content', source: { x: 0, y: 0, w: 400, h: 1500 }, canvas: { x: 0, y: 200, w: 1080, h: 600 }, fill: 'contain' }),
    fakeImage,
  );
  assert.deepEqual(tallRecorder.draws, [
    { sx: 0, sy: 0, sw: 400, sh: 1500, dx: -30, dy: -1555, dw: 1140, dh: 4110 },
    { sx: 0, sy: 0, sw: 400, sh: 1500, dx: 460, dy: 200, dw: 160, dh: 600 },
  ]);

  const captionRecorder = new CanvasRecorder();
  drawCaptions(captionRecorder as unknown as CanvasRenderingContext2D, layout, cueOf([[{ text: 'OLHA' }, { text: 'AQUI' }], [{ text: 'AGORA' }]]), null);
  const lineHeight = 1.12 * 62;
  const expectedY = [0.75 * 1920 - ((2 - 1) / 2) * lineHeight, 0.75 * 1920 + ((2 - 1) / 2) * lineHeight];
  assert.deepEqual(captionRecorder.texts, [
    { text: 'OLHA', x: 495, y: expectedY[0] },
    { text: 'AQUI', x: 545, y: expectedY[0] },
    { text: 'AGORA', x: 515, y: expectedY[1] },
  ]);
  assert.deepEqual(captionRecorder.strokes.map((stroke) => ({ x: stroke.x, y: stroke.y })), captionRecorder.texts.map((text) => ({ x: text.x, y: text.y })));
});
