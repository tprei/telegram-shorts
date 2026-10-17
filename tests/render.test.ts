import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildEndCardAss, buildExportAss } from '../src/infra/ass.js';
import { buildSubtitlesFilterArg, extractFrame, renderShortExport } from '../src/infra/render.js';
import { runProcess } from '../src/infra/process.js';
import { buildTimeline } from '../src/domain/timeline.js';
import type { LayoutProfile, PxRect } from '../src/domain/layout.js';
import type { CaptionCue, CaptionWord, ShortEdit, Timeline, TimelineEndCard, TimelinePanelPlacement, TranscriptWord } from '../src/domain/timeline.js';

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
    { id: 'host', role: 'host', sourceRect: { x: 0.637, y: 0, w: 0.363, h: 1 }, canvasRect: { x: 0, y: 0.5521, w: 1, h: 0.4479 }, anchor: { x: 0.5, y: 0.42 } },
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

const screenCanvas: PxRect = { x: 0, y: 220, w: 1080, h: 840 };
const hostCanvas: PxRect = { x: 0, y: 1060, w: 1080, h: 858 };
const contentSource: PxRect = { x: 0, y: 68, w: 1212, h: 942 };
const hostSourceZoom1: PxRect = { x: 1222, y: 176, w: 696, h: 552 };
const hostSourceZoom125: PxRect = { x: 1292, y: 232, w: 556, h: 442 };

function panels(hostSource: PxRect): TimelinePanelPlacement[] {
  return [
    { panelId: 'screen', role: 'content', source: contentSource, canvas: screenCanvas },
    { panelId: 'host', role: 'host', source: hostSource, canvas: hostCanvas },
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
};

const fixtureCues: CaptionCue[] = [
  {
    lines: [[word(0, 'OLHA', 0, 0.5), word(1, 'COMO', 0.5, 1.0)], [word(2, 'ISSO', 1.0, 1.5)]],
    outputStart: 0,
    outputEnd: 1.75,
  },
  {
    lines: [[word(3, 'AQUI', 8.0, 8.5), word(4, 'FICA', 8.5, 9.0)]],
    outputStart: 8.0,
    outputEnd: 9.25,
  },
];

const fixtureTimeline: Timeline = {
  canvas: { width: 1080, height: 1920, fps: 30 },
  speed: 1.1,
  durationSeconds: 11.090909090909092,
  clips: [
    { index: 0, sourceStart: 20, sourceEnd: 24, outputStart: 0, outputEnd: 3.6363636363636362, joinsPrevious: false, zoom: 1, panels: panels(hostSourceZoom1) },
    { index: 1, sourceStart: 30, sourceEnd: 34, outputStart: 3.6363636363636362, outputEnd: 7.2727272727272725, joinsPrevious: false, zoom: 1.25, panels: panels(hostSourceZoom125) },
    { index: 2, sourceStart: 34, sourceEnd: 38.2, outputStart: 7.2727272727272725, outputEnd: 11.090909090909092, joinsPrevious: true, zoom: 1.25, panels: panels(hostSourceZoom125) },
  ],
  cues: fixtureCues,
  hook: { lines: ['POR QUE 90% DOS', 'DEVS ERRAM ASSIM'], canvas: { x: 0, y: 0, w: 1080, h: 220 }, sizePx: 58 },
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
  return buildTimeline({ edit, words: transcriptWords(3), layout, title, source: { width: 1920, height: 1080, durationSeconds: 180 } });
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
  };
  const hostPlacement: TimelinePanelPlacement = {
    panelId: 'host',
    role: 'host',
    source: { x: 408, y: 60, w: 232, h: 184 },
    canvas: hostCanvas,
  };
  const timeline: Timeline = {
    canvas: { width: 1080, height: 1920, fps: 30 },
    speed: 1,
    durationSeconds: 1,
    clips: [
      { index: 0, sourceStart: 0.2, sourceEnd: 0.7, outputStart: 0, outputEnd: 0.5, joinsPrevious: false, zoom: 1, panels: [contentPlacement, hostPlacement] },
      { index: 1, sourceStart: 0.7, sourceEnd: 1.2, outputStart: 0.5, outputEnd: 1, joinsPrevious: true, zoom: 1, panels: [contentPlacement, hostPlacement] },
    ],
    cues: [{
      lines: [[word(0, 'TESTE', 0, 0.25), word(1, 'DOIS', 0.25, 0.5)]],
      outputStart: 0,
      outputEnd: 0.75,
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
  await generateSource(sourcePath, 36);
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
    source: { width: 640, height: 360, durationSeconds: 36 },
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
  const samples = new Int16Array(await readFile(rawPath));
  const mainSamples = Math.floor(timeline.durationSeconds * 48000);
  const maxZeroRun = 48;
  let runStart = -1;
  for (let index = 4800; index < Math.min(mainSamples, samples.length); index += 1) {
    if (samples[index] === 0) {
      if (runStart < 0) {
        runStart = index;
      }
      assert.ok(index - runStart < maxZeroRun, `zero run of ${index - runStart + 1} samples ending at ${index / 48000}s`);
    } else {
      runStart = -1;
    }
  }
});
