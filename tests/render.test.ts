import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildEndCardAss, buildExportAss } from '../src/infra/ass.js';
import { buildSubtitlesFilterArg, extractFrame, renderBrandedCover, renderCoverImage, renderShortExport } from '../src/infra/render.js';
import { runProcess } from '../src/infra/process.js';
import { buildTimeline } from '../src/domain/timeline.js';
import type { CoverBrand, SceneSegment } from '../src/domain/model.js';
import type { LayoutProfile, PxRect } from '../src/domain/layout.js';
import type { CaptionCue, CaptionWord, ShortEdit, Timeline, TimelineEndCard, TimelinePanelPlacement, TranscriptWord } from '../src/domain/timeline.js';

const layout: LayoutProfile = {
  version: 3,
  strategy: 'fixed',
  layoutId: 'screen-top-host-bottom-v3',
  canvas: { width: 1080, height: 1920, fps: 30 },
  background: '#101010',
  safeArea: { top: 0, bottom: 0, side: 0 },
  font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
  hookBand: {
    rect: { x: 0, y: 0, w: 1, h: 0.1146 },
    background: '#C8102E',
    textColor: '#FFFFFF',
    sizePx: 58,
    maxCharsPerLine: 24,
    maxLines: 2,
    uppercase: true,
  },
  panels: [
    { id: 'screen', role: 'content', sourceRect: { x: 0, y: 0, w: 0.632, h: 1 }, canvasRect: { x: 0, y: 0.1146, w: 1, h: 0.4375 } },
    { id: 'host', role: 'host', sourceRect: { x: 0.637, y: 0, w: 0.363, h: 1 }, canvasRect: { x: 0, y: 0.5521, w: 1, h: 0.4479 }, anchor: { x: 0.5, y: 0.42 } },
  ],
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

const screenCanvas: PxRect = { x: 0, y: 220, w: 1080, h: 840 };
const hostCanvas: PxRect = { x: 0, y: 1060, w: 1080, h: 858 };
const contentSource: PxRect = { x: 0, y: 68, w: 1212, h: 942 };
const hostSourceZoom1: PxRect = { x: 1222, y: 176, w: 696, h: 552 };
const hostSourceZoom125: PxRect = { x: 1292, y: 232, w: 556, h: 442 };

function panels(hostSource: PxRect): TimelinePanelPlacement[] {
  return [
    { panelId: 'screen', role: 'content', source: contentSource, canvas: screenCanvas, fill: 'cover' },
    { panelId: 'host', role: 'host', source: hostSource, canvas: hostCanvas, fill: 'cover' },
  ];
}

function word(wordIndex: number, text: string, outputStart: number, outputEnd: number): CaptionWord {
  return { wordIndex, text, outputStart, outputEnd };
}

const fixtureEndCard: TimelineEndCard = {
  durationSeconds: 2.4,
  darkenFactor: 0.55,
  thumbnail: { centerX: 540, centerY: 560, widthPx: 900 },
  titleLines: [{ text: 'Arquitetura que escala de verdade', centerX: 540, centerY: 1200, sizePx: 58 }],
  link: { text: 'Link na descrição', centerX: 540, centerY: 1700, sizePx: 44 },
  textOutlinePx: 2,
  textOutlineColor: '#000000',
  audio: null,
};

const fixtureCues: CaptionCue[] = [
  {
    lines: [[word(0, 'OLHA', 0, 0.5), word(1, 'COMO', 0.5, 1.0)], [word(2, 'ISSO', 1.0, 1.5)]],
    outputStart: 0,
    outputEnd: 1.75,
    centerY: 0.5521,
  },
  {
    lines: [[word(3, 'AQUI', 8.0, 8.5), word(4, 'FICA', 8.5, 9.0)]],
    outputStart: 8.0,
    outputEnd: 9.25,
    centerY: 0.5521,
  },
];

const fixtureTimeline: Timeline = {
  canvas: { width: 1080, height: 1920, fps: 30 },
  speed: 1.1,
  durationSeconds: 11.090909090909092,
  stackSplit: null,
  clips: [
    { index: 0, sourceStart: 20, sourceEnd: 24, outputStart: 0, outputEnd: 3.6363636363636362, joinsPrevious: false, zoom: 1, composition: null, sceneStartSeconds: null, captionCenterY: 0.5521, panels: panels(hostSourceZoom1) },
    { index: 1, sourceStart: 30, sourceEnd: 34, outputStart: 3.6363636363636362, outputEnd: 7.2727272727272725, joinsPrevious: false, zoom: 1.25, composition: null, sceneStartSeconds: null, captionCenterY: 0.5521, panels: panels(hostSourceZoom125) },
    { index: 2, sourceStart: 34, sourceEnd: 38.2, outputStart: 7.2727272727272725, outputEnd: 11.090909090909092, joinsPrevious: true, zoom: 1.25, composition: null, sceneStartSeconds: null, captionCenterY: 0.5521, panels: panels(hostSourceZoom125) },
  ],
  cues: fixtureCues,
  hook: { lines: ['POR QUE 90% DOS', 'DEVS ERRAM ASSIM'], canvas: { x: 0, y: 0, w: 1080, h: 220 }, sizePx: 58, textCenterY: 110 },
  endCard: fixtureEndCard,
};

interface AssEvent {
  layer: string;
  start: number;
  end: number;
  style: string;
  text: string;
}

function assSeconds(value: string): number {
  const [hours, minutes, rest] = value.split(':');
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(rest);
}

function dialogueEvents(ass: string, style: string): AssEvent[] {
  const events: AssEvent[] = [];
  for (const line of ass.split('\n')) {
    if (!line.startsWith('Dialogue: ')) {
      continue;
    }
    const fields = line.split(',');
    if (fields[3] !== style) {
      continue;
    }
    events.push({
      layer: fields[0]!.replace('Dialogue: ', ''),
      start: assSeconds(fields[1]!),
      end: assSeconds(fields[2]!),
      style,
      text: fields.slice(9).join(','),
    });
  }
  return events;
}

function transcriptWords(count: number): TranscriptWord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `w_${index}`,
    text: `palavra${index}`,
    startSeconds: index,
    endSeconds: index + 0.4,
    speakerId: 'A',
    confidence: 0.9,
  }));
}

function endCardTimeline(title: string): Timeline {
  const edit: ShortEdit = {
    ranges: [{ startWord: 0, endWord: 2 }],
    removedWords: [],
    tightenPauses: { enabled: false, maxGapSeconds: 0.35 },
    speed: 1,
    hook: { enabled: false, text: '' },
    captions: { enabled: false },
    crops: [],
    zoom: { enabled: false, strength: 1.12 },
    endCard: { enabled: true },
  };
  return buildTimeline({ edit, words: transcriptWords(3), layout, title, source: { width: 1920, height: 1080, durationSeconds: 180 }, hostFraming: null, sceneTrack: null });
}

async function generateSource(target: string, seconds: number): Promise<void> {
  await runProcess('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-ac', '2', '-c:a', 'aac', '-b:a', '96k',
    target,
  ]);
}

async function probeVideoDuration(path: string): Promise<number> {
  const probe = await runProcess('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  return Number(probe.stdout.trim());
}

test('subtitle filter arg double-escapes paths for both filtergraph levels', () => {
  assert.equal(
    buildSubtitlesFilterArg('captions.ass', '../../assets/fonts'),
    'ass=filename=captions.ass:fontsdir=../../assets/fonts',
  );
  assert.equal(
    buildSubtitlesFilterArg("it's.ass", 'a:b'),
    "ass=filename=it\\\\\\'s.ass:fontsdir=a\\\\:b",
  );
});

test('ass header uses canvas resolution and font sizes scaled by assSizeScale', () => {
  const ass = buildExportAss({ timeline: fixtureTimeline, layout });
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /ScaledBorderAndShadow: yes/);
  assert.match(ass, /WrapStyle: 2/);
  assert.match(ass, /Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text/);
  assert.match(ass, /Style: Hook,Montserrat ExtraBold,91,/);
  assert.match(ass, /Style: Caption,Montserrat ExtraBold,97,/);
  assert.match(ass, /Style: Band,Arial,16,&H002E10C8,/);
  assert.match(ass, /Style: Caption,Montserrat ExtraBold,97,[^ ]*,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,6,2,5,/);
});

test('caption shadow colour follows the caption outline colour', () => {
  const ass = buildExportAss({
    timeline: fixtureTimeline,
    layout: { ...layout, captions: { ...layout.captions, outlineColor: '#3A2E1F' } },
  });
  assert.match(ass, /Style: Caption,[^,]+,\d+,&H00FFFFFF,&H000000FF,&H001F2E3A,&H001F2E3A,0,0,0,0,100,100,0,0,1,6,2,5,/);
});

test('exactly one caption event covers a given time and colors the active word', () => {
  const ass = buildExportAss({ timeline: fixtureTimeline, layout });
  const events = dialogueEvents(ass, 'Caption');
  assert.equal(events.length, 5);
  const visible = events.filter((event) => event.start <= 0.7 && 0.7 < event.end);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]!.text, '{\\an5\\pos(540,1060)}OLHA {\\c&H0000D4FF&}COMO{\\c&H00FFFFFF&}\\NISSO');
  const first = events[0]!;
  assert.equal(first.start, 0);
  assert.equal(first.text, '{\\an5\\pos(540,1060)}{\\c&H0000D4FF&}OLHA{\\c&H00FFFFFF&} COMO\\NISSO');
  const all = events.map((event) => `${event.start}-${event.end}`);
  assert.deepEqual(all, ['0-0.5', '0.5-1', '1-1.75', '8-8.5', '8.5-9.25']);
  const last = events[events.length - 1]!;
  assert.equal(last.end, 9.25);
});

test('band and hook span the whole timeline using the band rect and colors', () => {
  const ass = buildExportAss({ timeline: fixtureTimeline, layout });
  const bandEvents = dialogueEvents(ass, 'Band');
  assert.equal(bandEvents.length, 1);
  assert.equal(bandEvents[0]!.layer, '0');
  assert.equal(bandEvents[0]!.start, 0);
  assert.equal(bandEvents[0]!.end, 11.09);
  assert.equal(bandEvents[0]!.text, '{\\an7\\pos(0,0)\\p1}m 0 0 l 1080 0 l 1080 220 l 0 220{\\p0}');
  const hookEvents = dialogueEvents(ass, 'Hook');
  assert.equal(hookEvents.length, 2);
  assert.equal(hookEvents[0]!.layer, '1');
  assert.equal(hookEvents[0]!.start, 0);
  assert.equal(hookEvents[0]!.end, 11.09);
  assert.equal(hookEvents[0]!.text, '{\\an5\\pos(540,77.52)}POR QUE 90% DOS');
  assert.equal(hookEvents[1]!.text, '{\\an5\\pos(540,142.48)}DEVS ERRAM ASSIM');
});

test('timeline without hook emits no band or hook output but keeps captions', () => {
  const ass = buildExportAss({ timeline: { ...fixtureTimeline, hook: null }, layout: { ...layout, hookBand: null } });
  assert.doesNotMatch(ass, /Style: Band,/);
  assert.doesNotMatch(ass, /Style: Hook,/);
  assert.equal(dialogueEvents(ass, 'Band').length, 0);
  assert.equal(dialogueEvents(ass, 'Hook').length, 0);
  assert.equal(dialogueEvents(ass, 'Caption').length, 5);
});

test('caption words escape backslashes and braces', () => {
  const escaped: CaptionCue = {
    lines: [[word(0, '\\{X}', 0, 1)]],
    outputStart: 0,
    outputEnd: 1.25,
    centerY: 0.5521,
  };
  const ass = buildExportAss({ timeline: { ...fixtureTimeline, cues: [escaped] }, layout });
  const events = dialogueEvents(ass, 'Caption');
  assert.equal(events[0]!.text, '{\\an5\\pos(540,1060)}{\\c&H0000D4FF&}\\\u2060\\{X\\}{\\c&H00FFFFFF&}');
});

test('end card ass draws the domain layout with wrapped title lines and the link line', () => {
  const timeline = endCardTimeline('Um titulo bem comprido que precisa quebrar em tres linhas diferentes');
  const ass = buildEndCardAss({ endCard: timeline.endCard!, layout });
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /Style: EndTitle,Montserrat ExtraBold,91,/);
  assert.match(ass, /Style: EndLink,Montserrat ExtraBold,69,/);
  assert.match(ass, /\{\\an5\\pos\(540,1135\.04\)\}Um titulo bem comprido/);
  assert.match(ass, /\{\\an5\\pos\(540,1200\)\}que precisa quebrar em/);
  assert.match(ass, /\{\\an5\\pos\(540,1264\.96\)\}tres linhas diferentes/);
  assert.match(ass, /\{\\an5\\pos\(540,1700\)\}Link na descrição/);
  const titleEvents = dialogueEvents(ass, 'EndTitle');
  assert.equal(titleEvents.length, 3);
  assert.equal(titleEvents[0]!.end, 2.4);
});

test('renderShortExport rejects an empty timeline before running ffmpeg', async () => {
  await assert.rejects(
    renderShortExport({
      timeline: { ...fixtureTimeline, clips: [], cues: [] },
      layout,
      sourceVideoPath: 'missing.mp4',
      workDir: 'missing-dir',
      fontsDir: 'missing-fonts',
      endCardThumbnailPath: null,
    }),
    /Nothing to export: every word is cut/,
  );
});

test('cover image centers the sharp thumbnail over a blurred full-bleed copy', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'render-cover-'));
  const thumbnailPath = join(dir, 'thumbnail.png');
  await runProcess('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=640x720,format=rgb24',
    '-f', 'lavfi', '-i', 'color=c=blue:s=640x720,format=rgb24',
    '-filter_complex', '[0][1]hstack=inputs=2',
    '-frames:v', '1',
    thumbnailPath,
  ]);
  const coverPath = join(dir, 'cover.jpg');
  await renderCoverImage({ imagePath: thumbnailPath, outputPath: coverPath, width: 1080, height: 1920 });
  const rawPath = join(dir, 'cover.rgb');
  await runProcess('ffmpeg', ['-y', '-i', coverPath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawPath]);
  const pixels = await readFile(rawPath);
  assert.equal(pixels.length, 1080 * 1920 * 3);
  const pixel = (x: number, y: number): { r: number; b: number } => ({ r: pixels[(y * 1080 + x) * 3]!, b: pixels[(y * 1080 + x) * 3 + 2]! });
  const foregroundLeft = pixel(520, 960);
  const foregroundRight = pixel(560, 960);
  assert.ok(foregroundLeft.r > 200 && foregroundLeft.b < 60, `foreground left ${JSON.stringify(foregroundLeft)}`);
  assert.ok(foregroundRight.b > 200 && foregroundRight.r < 60, `foreground right ${JSON.stringify(foregroundRight)}`);
  const backgroundEdge = pixel(530, 200);
  assert.ok(backgroundEdge.r > 60 && backgroundEdge.b > 60, `background is blurred across the edge ${JSON.stringify(backgroundEdge)}`);
});

test('branded cover draws band, stripes, title and the accent-bordered foreground', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'render-brand-'));
  const framePath = join(dir, 'frame.jpg');
  await runProcess('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=1280x720,format=rgb24', '-frames:v', '1', framePath]);
  const brand: CoverBrand = {
    bandColor: '#009C3B',
    textColor: '#FFFFFF',
    accentColor: '#FFDF00',
    stripeColors: ['#FFDF00', '#002776'],
    emblem: 'brazil_flag',
  };
  const coverPath = join(dir, 'cover.jpg');
  await renderBrandedCover({
    framePath,
    crop: { x: 0, y: 0, w: 1280, h: 720 },
    portrait: false,
    title: 'Banco Master infla o Flow',
    brand,
    fontFile: join(import.meta.dirname, '..', 'assets', 'fonts', 'Montserrat-ExtraBold.ttf'),
    outputPath: coverPath,
    width: 1080,
    height: 1920,
  });
  const rawPath = join(dir, 'cover.rgb');
  await runProcess('ffmpeg', ['-y', '-i', coverPath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawPath]);
  const pixels = await readFile(rawPath);
  assert.equal(pixels.length, 1080 * 1920 * 3);
  const pixel = (x: number, y: number): { r: number; g: number; b: number } => ({
    r: pixels[(y * 1080 + x) * 3]!,
    g: pixels[(y * 1080 + x) * 3 + 1]!,
    b: pixels[(y * 1080 + x) * 3 + 2]!,
  });
  const isBandGreen = (p: { r: number; g: number; b: number }): boolean => p.r < 100 && p.g > 110 && p.b < 110;
  const isStripeYellow = (p: { r: number; g: number; b: number }): boolean => p.r > 190 && p.g > 150 && p.b < 110;
  const isStripeBlue = (p: { r: number; g: number; b: number }): boolean => p.r < 70 && p.g < 90 && p.b > 70;
  const bandSample = pixel(20, 430);
  assert.ok(isBandGreen(bandSample), `band background ${JSON.stringify(bandSample)} is not the band color`);

  let whiteTextPixels = 0;
  for (let y = 380; y < 720; y += 1) {
    for (let x = 70; x < 1010; x += 4) {
      const p = pixel(x, y);
      if (p.r > 180 && p.g > 180 && p.b > 180) {
        whiteTextPixels += 1;
      }
    }
  }
  assert.ok(whiteTextPixels > 50, `band holds no text (${whiteTextPixels} white pixels)`);

  let bandBottom = -1;
  for (let y = 420; y < 900; y += 1) {
    if (!isBandGreen(pixel(20, y))) {
      bandBottom = y;
      break;
    }
  }
  assert.ok(bandBottom > 380, `band bottom ${bandBottom} not found below the band top`);
  const firstStripe = pixel(20, bandBottom + 9);
  assert.ok(isStripeYellow(firstStripe), `first stripe ${JSON.stringify(firstStripe)} is not yellow`);
  const secondStripe = pixel(20, bandBottom + 24);
  assert.ok(isStripeBlue(secondStripe), `second stripe ${JSON.stringify(secondStripe)} is not blue`);

  const stripesBottom = bandBottom + 18 + 12;
  const centerTop = stripesBottom + 40;
  let borderY = -1;
  for (let y = centerTop; y < 1660; y += 1) {
    if (isStripeYellow(pixel(44, y))) {
      borderY = y;
      break;
    }
  }
  assert.ok(borderY >= centerTop, `accent border ${borderY} not found below the stripes`);
  const borderWidth = pixel(44, borderY + 8);
  assert.ok(isStripeYellow(borderWidth), `accent border ${JSON.stringify(borderWidth)} is not solid below its top edge`);
  const outsideForeground = pixel(20, Math.min(1650, borderY + 100));
  assert.ok(!isStripeYellow(outsideForeground), 'accent color leaks outside the foreground border');
});

test('extractFrame throws when ffmpeg exits without writing the frame', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'render-frame-'));
  const sourcePath = join(dir, 'source.mp4');
  await generateSource(sourcePath, 1);
  const framePath = join(dir, 'frame.jpg');
  await assert.rejects(extractFrame({ videoPath: sourcePath, seconds: 30, width: 640, outputPath: framePath }));
  assert.equal(existsSync(framePath), false);
});

test('renders through a work dir containing ffmpeg-hostile characters', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'render-path-'));
  const sourcePath = join(dir, 'source.mp4');
  await generateSource(sourcePath, 2);
  const contentPlacement: TimelinePanelPlacement = {
    panelId: 'screen',
    role: 'content',
    source: { x: 0, y: 22, w: 404, h: 314 },
    canvas: { x: 0, y: 114, w: 1080, h: 840 },
    fill: 'cover',
  };
  const hostPlacement: TimelinePanelPlacement = {
    panelId: 'host',
    role: 'host',
    source: { x: 408, y: 60, w: 232, h: 184 },
    canvas: hostCanvas,
    fill: 'cover',
  };
  const timeline: Timeline = {
    canvas: { width: 1080, height: 1920, fps: 30 },
    speed: 1,
    durationSeconds: 1,
    stackSplit: null,
    clips: [
      { index: 0, sourceStart: 0.2, sourceEnd: 0.7, outputStart: 0, outputEnd: 0.5, joinsPrevious: false, zoom: 1, composition: null, sceneStartSeconds: null, captionCenterY: 0.5521, panels: [contentPlacement, hostPlacement] },
      { index: 1, sourceStart: 0.7, sourceEnd: 1.2, outputStart: 0.5, outputEnd: 1, joinsPrevious: true, zoom: 1, composition: null, sceneStartSeconds: null, captionCenterY: 0.5521, panels: [contentPlacement, hostPlacement] },
    ],
    cues: [{
      lines: [[word(0, 'TESTE', 0, 0.25), word(1, 'DOIS', 0.25, 0.5)]],
      outputStart: 0,
      outputEnd: 0.75,
      centerY: 0.5521,
    }],
    hook: null,
    endCard: null,
  };
  const result = await renderShortExport({
    timeline,
    layout,
    sourceVideoPath: sourcePath,
    workDir: join(dir, "we:rd'work"),
    fontsDir: join(import.meta.dirname, '..', 'assets', 'fonts'),
    endCardThumbnailPath: null,
  });
  assert.ok(result.sizeBytes > 1_000);
  assert.ok(Math.abs(result.durationSeconds - 1) < 1 / 30, `duration ${result.durationSeconds}`);
});

test('renders frame-accurate audio and video across many crop-split clips', { timeout: 600_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'render-sync-'));
  const sourcePath = join(dir, 'source.mp4');
  await generateSource(sourcePath, 40);
  const words: TranscriptWord[] = Array.from({ length: 70 }, (_, index) => ({
    id: `w_${index}`,
    text: `palavra${index}`,
    startSeconds: index * 0.5,
    endSeconds: index * 0.5 + 0.48,
    speakerId: 'A',
    confidence: 0.9,
  }));
  const crops = Array.from({ length: 82 }, (_, index) => ({
    sourceSeconds: 1 + index * 0.4,
    focus: { x: 0, y: 0, w: 0.5, h: 0.5 },
    origin: 'auto' as const,
  }));
  const edit: ShortEdit = {
    ranges: [{ startWord: 0, endWord: 69 }],
    removedWords: [40],
    tightenPauses: { enabled: false, maxGapSeconds: 0.35 },
    speed: 1,
    hook: { enabled: true, text: 'gancho bem longo que precisa caber na faixa do preview sem estourar' },
    captions: { enabled: true },
    crops,
    zoom: { enabled: false, strength: 1.12 },
    endCard: { enabled: true },
  };
  const canvas = { width: 540, height: 960, fps: 30 };
  const smallLayout: LayoutProfile = { ...layout, canvas };
  const timeline = buildTimeline({
    edit,
    words,
    layout: smallLayout,
    title: 'Um titulo de teste para o cartao final do short',
    source: { width: 640, height: 360, durationSeconds: 40 },
    hostFraming: null,
    sceneTrack: null,
  });
  assert.ok(timeline.clips.length >= 60, `clips ${timeline.clips.length}`);
  assert.ok(timeline.clips.some((clip) => clip.joinsPrevious));
  const result = await renderShortExport({
    timeline,
    layout: smallLayout,
    sourceVideoPath: sourcePath,
    workDir: join(dir, 'export'),
    fontsDir: join(import.meta.dirname, '..', 'assets', 'fonts'),
    endCardThumbnailPath: null,
  });
  const expected = timeline.durationSeconds + timeline.endCard!.durationSeconds;
  const videoDuration = await probeVideoDuration(result.artifactPath);
  assert.ok(Math.abs(videoDuration - expected) < 1 / 30, `video ${videoDuration} vs timeline ${expected}`);

  const rawPath = join(dir, 'audio.raw');
  await runProcess('ffmpeg', [
    '-y',
    '-i', result.artifactPath,
    '-map', '0:a',
    '-ac', '1',
    '-ar', '48000',
    '-f', 's16le',
    rawPath,
  ]);
  const pcm = await readFile(rawPath);
  const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
  const mainSamples = Math.floor(timeline.durationSeconds * 48000);
  const maxZeroRun = 48;
  let runStart = -1;
  const continuityEnd = Math.min(mainSamples + 24000, samples.length);
  for (let index = 4800; index < continuityEnd; index += 1) {
    if (samples[index] === 0) {
      if (runStart < 0) {
        runStart = index;
      }
      assert.ok(index - runStart < maxZeroRun, `zero run of ${index - runStart + 1} samples ending at ${index / 48000}s`);
    } else {
      runStart = -1;
    }
  }
  const rms = (fromSeconds: number, toSeconds: number): number => {
    const window = samples.subarray(Math.floor(fromSeconds * 48000), Math.floor(toSeconds * 48000));
    return Math.sqrt(window.reduce((sum, sample) => sum + sample * sample, 0) / window.length);
  };
  const main = timeline.durationSeconds;
  const body = rms(main - 0.4, main - 0.05);
  const ducked = rms(main + 0.7, main + 1.2);
  const tail = rms(main + timeline.endCard!.durationSeconds - 0.08, main + timeline.endCard!.durationSeconds - 0.01);
  assert.ok(ducked > body * 0.15 && ducked < body * 0.7, `end card audio ${ducked} vs body ${body}`);
  assert.ok(tail < body * 0.15, `end card tail ${tail} vs body ${body}`);
});

test('renderShortExport with a contained host panel produces the right output size and centered foreground', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'render-contain-'));
  const sourcePath = join(dir, 'source.mp4');
  await runProcess('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x360,format=rgb24',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x360,format=rgb24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-filter_complex', '[0][1]hstack=inputs=2[v]',
    '-map', '[v]', '-map', '2:a',
    '-t', '1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-ac', '2', '-c:a', 'aac', '-b:a', '96k',
    sourcePath,
  ]);
  const hostPlacement: TimelinePanelPlacement = {
    panelId: 'host',
    role: 'host',
    source: { x: 220, y: 0, w: 200, h: 360 },
    canvas: hostCanvas,
    fill: 'contain',
  };
  const timeline: Timeline = {
    canvas: { width: 1080, height: 1920, fps: 30 },
    speed: 1,
    durationSeconds: 0.5,
    stackSplit: null,
    clips: [
      {
        index: 0,
        sourceStart: 0.1,
        sourceEnd: 0.6,
        outputStart: 0,
        outputEnd: 0.5,
        joinsPrevious: false,
        zoom: 1,
        composition: null,
        sceneStartSeconds: null,
        captionCenterY: 0.5521,
        panels: [hostPlacement],
      },
    ],
    cues: [],
    hook: null,
    endCard: null,
  };
  const result = await renderShortExport({
    timeline,
    layout,
    sourceVideoPath: sourcePath,
    workDir: join(dir, 'export'),
    fontsDir: join(import.meta.dirname, '..', 'assets', 'fonts'),
    endCardThumbnailPath: null,
  });
  assert.ok(result.sizeBytes > 1_000);
  assert.ok(Math.abs(result.durationSeconds - 0.5) < 1 / 30, `duration ${result.durationSeconds}`);

  const probe = await runProcess('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'json',
    result.artifactPath,
  ]);
  const streamInfo = JSON.parse(probe.stdout) as { streams: Array<{ width: number; height: number }> };
  assert.equal(streamInfo.streams[0]?.width, 1080);
  assert.equal(streamInfo.streams[0]?.height, 1920);

  const rawPath = join(dir, 'frame.rgb');
  await runProcess('ffmpeg', [
    '-y',
    '-i', result.artifactPath,
    '-vframes', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    rawPath,
  ]);
  const pixels = await readFile(rawPath);
  assert.equal(pixels.length, 1080 * 1920 * 3);
  const pixel = (x: number, y: number): { r: number; b: number } => {
    const offset = (y * 1080 + x) * 3;
    return { r: pixels[offset]!, b: pixels[offset + 2]! };
  };
  const sampleY = 1489;
  const fgLeft = pixel(500, sampleY);
  const fgRight = pixel(580, sampleY);
  assert.ok(fgLeft.r > 150 && fgLeft.b < 80, `foreground left should be red, got ${JSON.stringify(fgLeft)}`);
  assert.ok(fgRight.b > 150 && fgRight.r < 80, `foreground right should be blue, got ${JSON.stringify(fgRight)}`);
  const bgLeft = pixel(100, sampleY);
  const bgRight = pixel(980, sampleY);
  assert.ok(bgLeft.r < 200 && bgLeft.r > 30, `blurred left should be darkened red, got ${JSON.stringify(bgLeft)}`);
  assert.ok(bgRight.b < 200 && bgRight.b > 30, `blurred right should be darkened blue, got ${JSON.stringify(bgRight)}`);
});

test('ASS uses each cue position across changing compositions', () => {
  const timeline: Timeline = {
    ...fixtureTimeline,
    cues: [
      { lines: [[word(0, 'UM', 0, 0.5)]], outputStart: 0, outputEnd: 1, centerY: 0.4 },
      { lines: [[word(1, 'DOIS', 1, 1.5)]], outputStart: 1, outputEnd: 2, centerY: 0.8 },
    ],
  };
  const ass = buildExportAss({ timeline, layout });
  const events = dialogueEvents(ass, 'Caption');
  assert.equal(events.length, 2);
  assert.match(events[0]!.text, /\{\\an5\\pos\(540,768\)\}/);
  assert.match(events[1]!.text, /\{\\an5\\pos\(540,1536\)\}/);
});

async function generateBarsVideo(target: string): Promise<void> {
  await runProcess('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=640x360:r=30:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-vf', 'drawbox=x=0:y=0:w=20:h=360:color=red:t=fill,drawbox=x=620:y=0:w=20:h=360:color=blue:t=fill,drawbox=x=0:y=0:w=640:h=20:color=yellow:t=fill,drawbox=x=0:y=340:w=640:h=20:color=cyan:t=fill',
    '-map', '0:v', '-map', '1:a',
    '-t', '1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-ac', '2', '-c:a', 'aac', '-b:a', '96k',
    target,
  ]);
}

function containTimeline(source: TimelinePanelPlacement['source'], canvas: TimelinePanelPlacement['canvas']): Timeline {
  return {
    canvas: { width: 1080, height: 1920, fps: 30 },
    speed: 1,
    durationSeconds: 0.5,
    stackSplit: null,
    clips: [{
      index: 0,
      sourceStart: 0,
      sourceEnd: 0.5,
      outputStart: 0,
      outputEnd: 0.5,
      joinsPrevious: false,
      zoom: 1,
      composition: null,
      sceneStartSeconds: null,
      captionCenterY: 0.5521,
      panels: [{ panelId: 'content', role: 'content', source, canvas, fill: 'contain' }],
    }],
    cues: [],
    hook: null,
    endCard: null,
  };
}

async function framePixels(videoPath: string, outputPath: string): Promise<Buffer> {
  await runProcess('ffmpeg', ['-v', 'error', '-y', '-i', videoPath, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', outputPath]);
  return readFile(outputPath);
}

function pixelOf(pixels: Buffer, width: number, x: number, y: number): { r: number; g: number; b: number } {
  const offset = (y * width + x) * 3;
  return { r: pixels[offset]!, g: pixels[offset + 1]!, b: pixels[offset + 2]! };
}

test('contained wide and tall panels fit sharp foreground in both axes', { timeout: 300_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'render-two-axis-'));
  try {
    const sourcePath = join(dir, 'bars.mp4');
    await generateBarsVideo(sourcePath);
    const fontsDir = join(import.meta.dirname, '..', 'assets', 'fonts');

    const wide = await renderShortExport({
      timeline: containTimeline({ x: 0, y: 120, w: 640, h: 80 }, { x: 0, y: 0, w: 1080, h: 400 }),
      layout,
      sourceVideoPath: sourcePath,
      workDir: join(dir, 'wide'),
      fontsDir,
      endCardThumbnailPath: null,
    });
    assert.ok(Math.abs(wide.durationSeconds - 0.5) < 1 / 30, `wide duration ${wide.durationSeconds}`);
    const widePixels = await framePixels(wide.artifactPath, join(dir, 'wide.rgb'));
    const wideForeground = pixelOf(widePixels, 1080, 10, 200);
    assert.ok(wideForeground.r > 200 && wideForeground.g < 90 && wideForeground.b < 90, `wide left edge ${JSON.stringify(wideForeground)}`);
    const wideRight = pixelOf(widePixels, 1080, 1070, 200);
    assert.ok(wideRight.b > 200 && wideRight.r < 90, `wide right edge ${JSON.stringify(wideRight)}`);
    const wideCenter = pixelOf(widePixels, 1080, 540, 200);
    assert.ok(wideCenter.g > 110 && wideCenter.r < 90, `wide foreground body ${JSON.stringify(wideCenter)}`);
    const above = pixelOf(widePixels, 1080, 540, 60);
    const below = pixelOf(widePixels, 1080, 540, 380);
    assert.ok(above.g > 40 && above.g < 130 && above.r < 80 && above.b < 80, `wide background above ${JSON.stringify(above)}`);
    assert.ok(Math.abs(above.g - below.g) < 30, `wide background not centered vertically: ${JSON.stringify(above)} vs ${JSON.stringify(below)}`);

    const tall = await renderShortExport({
      timeline: containTimeline({ x: 300, y: 0, w: 40, h: 360 }, { x: 0, y: 0, w: 400, h: 800 }),
      layout,
      sourceVideoPath: sourcePath,
      workDir: join(dir, 'tall'),
      fontsDir,
      endCardThumbnailPath: null,
    });
    assert.ok(Math.abs(tall.durationSeconds - 0.5) < 1 / 30, `tall duration ${tall.durationSeconds}`);
    const tallPixels = await framePixels(tall.artifactPath, join(dir, 'tall.rgb'));
    const tallTop = pixelOf(tallPixels, 1080, 200, 10);
    assert.ok(tallTop.r > 200 && tallTop.g > 180 && tallTop.b < 130, `tall top edge ${JSON.stringify(tallTop)}`);
    const tallBottom = pixelOf(tallPixels, 1080, 200, 790);
    assert.ok(tallBottom.b > 200 && tallBottom.g > 180 && tallBottom.r < 130, `tall bottom edge ${JSON.stringify(tallBottom)}`);
    const tallCenter = pixelOf(tallPixels, 1080, 200, 400);
    assert.ok(tallCenter.g > 110 && tallCenter.r < 90, `tall foreground body ${JSON.stringify(tallCenter)}`);
    const left = pixelOf(tallPixels, 1080, 80, 400);
    const right = pixelOf(tallPixels, 1080, 320, 400);
    assert.ok(left.g > 40 && left.g < 130 && left.r < 80 && left.b < 80, `tall background left ${JSON.stringify(left)}`);
    assert.ok(Math.abs(left.g - right.g) < 30, `tall background not centered horizontally: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

interface CountedSceneFixture {
  composition: 'stack' | null;
}

function sceneCutTimeline(input: CountedSceneFixture): Timeline {
  const fps = 30;
  const speed = 1.1;
  const sourceBounds = [0, 0.5, 1, 1.5, 2, 2.5];
  const contentCanvas = { x: 0, y: 0, w: 540, h: 400 };
  const hostCanvasPanel = { x: 0, y: 400, w: 540, h: 400 };
  const panels: TimelinePanelPlacement[] = [
    { panelId: 'content', role: 'content', source: { x: 0, y: 0, w: 320, h: 180 }, canvas: contentCanvas, fill: 'cover' },
    { panelId: 'host', role: 'host', source: { x: 320, y: 0, w: 320, h: 180 }, canvas: hostCanvasPanel, fill: 'contain' },
  ];
  let cumulativeFrames = 0;
  let outputStart = 0;
  const clips = sourceBounds.slice(0, -1).map((sourceStart, index) => {
    const sourceEnd = sourceBounds[index + 1]!;
    if (input.composition !== null) {
      const targetFrames = Math.round(((sourceEnd / speed) * fps));
      const frames = targetFrames - cumulativeFrames;
      const outputEnd = targetFrames / fps;
      const clip = {
        index,
        sourceStart,
        sourceEnd,
        outputStart,
        outputEnd,
        joinsPrevious: index > 0,
        zoom: 1,
        composition: input.composition,
        sceneStartSeconds: sourceStart,
        captionCenterY: 0.55,
        panels,
      };
      cumulativeFrames = targetFrames;
      outputStart = outputEnd;
      return clip;
    }
    const outputDuration = (sourceEnd - sourceStart) / speed;
    const clip = {
      index,
      sourceStart,
      sourceEnd,
      outputStart,
      outputEnd: outputStart + outputDuration,
      joinsPrevious: index > 0,
      zoom: 1,
      composition: null,
      sceneStartSeconds: null,
      captionCenterY: 0.55,
      panels,
    };
    outputStart += outputDuration;
    return clip;
  });
  return {
    canvas: { width: 540, height: 960, fps },
    speed,
    durationSeconds: clips[clips.length - 1]!.outputEnd,
    stackSplit: input.composition === null ? null : 0.5,
    clips,
    cues: [],
    hook: null,
    endCard: null,
  };
}

async function countVideoFrames(videoPath: string): Promise<number> {
  const probe = await runProcess('ffprobe', [
    '-v', 'error', '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]);
  return Number(probe.stdout.trim());
}

async function chunkAudioSamples(workDir: string, outputPath: string): Promise<number> {
  await runProcess('ffmpeg', [
    '-v', 'error', '-y',
    '-i', join(workDir, 'chunk_0.mkv'),
    '-map', '0:a', '-ac', '1', '-ar', '48000',
    '-f', 's16le',
    outputPath,
  ]);
  const pcm = await readFile(outputPath);
  return pcm.byteLength / 2;
}

test('many scene cuts preserve frame count audio duration and frozen geometry', { timeout: 300_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'render-scene-cuts-'));
  try {
    const sourcePath = join(dir, 'source.mp4');
    await generateSource(sourcePath, 6);
    const timeline = sceneCutTimeline({ composition: 'stack' });
    assert.equal(timeline.clips.map((clip) => Math.round((clip.outputEnd - clip.outputStart) * 30)).reduce((sum, frames) => sum + frames, 0), 68);
    const result = await renderShortExport({
      timeline,
      layout: { ...layout, canvas: timeline.canvas },
      sourceVideoPath: sourcePath,
      workDir: join(dir, 'export'),
      fontsDir: join(import.meta.dirname, '..', 'assets', 'fonts'),
      endCardThumbnailPath: null,
    });
    assert.equal(await countVideoFrames(result.artifactPath), 68);
    assert.ok(Math.abs(result.durationSeconds - 68 / 30) < 1 / 30, `duration ${result.durationSeconds}`);
    assert.equal(await chunkAudioSamples(join(dir, 'export'), join(dir, 'audio.raw')), 108800);
    const beforeCut = await outputFramePixels(result.artifactPath, 0.4, join(dir, 'before.rgb'));
    const afterCut = await outputFramePixels(result.artifactPath, 0.5, join(dir, 'after.rgb'));
    for (const pixels of [beforeCut, afterCut]) {
      const band = pixelOf(pixels, 540, 270, 900);
      assert.ok(band.r < 40 && band.g < 40 && band.b < 40, `frozen background band moved: ${JSON.stringify(band)}`);
      const contentTop = pixelOf(pixels, 540, 270, 100);
      const hostBottom = pixelOf(pixels, 540, 270, 700);
      assert.ok(contentTop.g + contentTop.b + contentTop.r > 40, 'content panel missing before the cut');
      assert.ok(hostBottom.g + hostBottom.b + hostBottom.r > 40, 'host panel missing after the cut');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


async function outputFramePixels(videoPath: string, seconds: number, outputPath: string): Promise<Buffer> {
  await runProcess('ffmpeg', ['-v', 'error', '-y', '-ss', String(seconds), '-i', videoPath, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', outputPath]);
  return readFile(outputPath);
}

test('fixed exports keep baseline frame and audio sample counts', { timeout: 300_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'render-fixed-baseline-'));
  try {
    const sourcePath = join(dir, 'source.mp4');
    await generateSource(sourcePath, 6);
    const timeline = sceneCutTimeline({ composition: null });
    const result = await renderShortExport({
      timeline,
      layout: { ...layout, canvas: timeline.canvas },
      sourceVideoPath: sourcePath,
      workDir: join(dir, 'export'),
      fontsDir: join(import.meta.dirname, '..', 'assets', 'fonts'),
      endCardThumbnailPath: null,
    });
    assert.equal(await countVideoFrames(result.artifactPath), 70);
    assert.ok(Math.abs(result.durationSeconds - 70 / 30) < 1 / 30, `duration ${result.durationSeconds}`);
    assert.equal(await chunkAudioSamples(join(dir, 'export'), join(dir, 'audio.raw')), 111418);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renders scenes timelines with output frames equal to the timeline frames', { timeout: 600_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'render-scenes-frames-'));
  const sourcePath = join(dir, 'source.mp4');
  await generateSource(sourcePath, 20);
  const words: TranscriptWord[] = Array.from({ length: 18 }, (_, index) => ({
    id: `w_${index}`,
    text: `palavra${index}`,
    startSeconds: index < 9 ? index * 0.5 : 6 + (index - 9) * 0.5,
    endSeconds: index < 9 ? index * 0.5 + 0.48 : 6 + (index - 9) * 0.5 + 0.48,
    speakerId: 'A',
    confidence: 0.9,
  }));
  const edit: ShortEdit = {
    ranges: [{ startWord: 0, endWord: 17 }],
    removedWords: [],
    tightenPauses: { enabled: true, maxGapSeconds: 0.35 },
    speed: 1,
    hook: { enabled: false, text: '' },
    captions: { enabled: true },
    crops: [],
    zoom: { enabled: false, strength: 1.12 },
    endCard: { enabled: false },
    layout: { split: null, overrides: [] },
  };
  const scenesLayout: LayoutProfile = {
    version: 3,
    layoutId: 'mix-scenes-v3',
    strategy: 'scenes',
    canvas: { width: 540, height: 960, fps: 30 },
    background: '#101010',
    safeArea: { top: 0.135, bottom: 0.17, side: 0.055 },
    font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
    hookBand: { rect: { x: 0, y: 0, w: 1, h: 0.1146 }, background: '#C8102E', textColor: '#FFFFFF', sizePx: 40, maxCharsPerLine: 24, maxLines: 2, uppercase: true },
    captions: { sizePx: 42, textColor: '#FFFFFF', highlightColor: '#FFD400', outlineColor: '#000000', outlinePx: 4, shadowPx: 2, uppercase: true, maxWordsPerCue: 4, maxCharsPerLine: 16, maxLines: 2, centerY: 0.5521 },
    scene: { captionCenterY: { host: 0.72, content: 0.78 } },
  };
  const sceneSegment = (startSeconds: number, endSeconds: number): SceneSegment => ({
    startSeconds,
    endSeconds,
    host: { camera: { x: 0.15, y: 0.6, w: 0.5, h: 0.35 }, head: { x: 0.35, y: 0.66, w: 0.1, h: 0.15 } },
    content: { box: { x: 0, y: 0, w: 1, h: 0.5 }, kind: 'document', vertical: false, subject: { x: 0.2, y: 0.05, w: 0.4, h: 0.3 } },
    overlays: [],
  });
  const probeTimeline = buildTimeline({
    edit,
    words,
    layout: scenesLayout,
    title: 'Titulo do cartao final',
    source: { width: 640, height: 360, durationSeconds: 20 },
    hostFraming: null,
    sceneTrack: { version: 1, analyzedAt: '2026-10-19T10:00:00.000Z', frame: { width: 640, height: 360 }, segments: [sceneSegment(0, 12)] },
  });
  const clipEnd = probeTimeline.clips[probeTimeline.clips.length - 1]!.sourceEnd;
  const timeline = buildTimeline({
    edit,
    words,
    layout: scenesLayout,
    title: 'Titulo do cartao final',
    source: { width: 640, height: 360, durationSeconds: 20 },
    hostFraming: null,
    sceneTrack: { version: 1, analyzedAt: '2026-10-19T10:00:00.000Z', frame: { width: 640, height: 360 }, segments: [sceneSegment(0, clipEnd - 0.01), sceneSegment(clipEnd - 0.01, 12)] },
  });
  assert.ok(timeline.clips.length >= 2, `clips ${timeline.clips.length}`);
  const lastClip = timeline.clips[timeline.clips.length - 1]!;
  assert.ok(Math.abs(lastClip.sourceEnd - clipEnd) < 1e-6, `last source end ${lastClip.sourceEnd}`);
  const result = await renderShortExport({
    timeline,
    layout: scenesLayout,
    sourceVideoPath: sourcePath,
    workDir: join(dir, 'export'),
    fontsDir: join(import.meta.dirname, '..', 'assets', 'fonts'),
    endCardThumbnailPath: null,
  });
  const probe = await runProcess('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', 'stream=nb_read_frames',
    '-of', 'csv=p=0',
    result.artifactPath,
  ]);
  const expectedFrames = timeline.clips.reduce((total, clip) => total + Math.round(clip.outputEnd * 30) - Math.round(clip.outputStart * 30), 0);
  assert.equal(Number(probe.stdout.trim()), expectedFrames);
});
