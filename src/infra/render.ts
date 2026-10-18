import { stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { LayoutProfile } from '../domain/layout.js';
import type { Timeline, TimelineClip, TimelineEndCard, TimelinePanelPlacement } from '../domain/timeline.js';
import { HOST_BLUR_DARKEN, HOST_BLUR_SIGMA_PX } from '../domain/timeline.js';
import { buildEndCardAss, buildExportAss } from './ass.js';
import { runProcess } from './process.js';
import { ensureParent } from './util.js';

const RENDER_TIMEOUT_MS = 30 * 60_000;

export interface ExportRenderInput {
  timeline: Timeline;
  layout: LayoutProfile;
  sourceVideoPath: string;
  workDir: string;
  fontsDir: string;
  endCardThumbnailPath: string | null;
}

export interface ExportRenderResult {
  artifactPath: string;
  sizeBytes: number;
  durationSeconds: number;
}

const CHUNK_MAX_SOURCE_GAP_SECONDS = 20;
const CHUNK_MAX_CLIPS = 40;
const FADE_SECONDS = 0.015;
const AUDIO_SAMPLE_RATE = 48000;
const LOUDNORM_FILTER = 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000';

export async function renderShortExport(input: ExportRenderInput): Promise<ExportRenderResult> {
  const { timeline, layout } = input;
  if (timeline.clips.length === 0) {
    throw new Error('Nothing to export: every word is cut');
  }
  const fps = timeline.canvas.fps;
  const width = timeline.canvas.width;
  const height = timeline.canvas.height;
  const speed = timeline.speed;
  const assPath = join(input.workDir, 'captions.ass');
  await ensureParent(assPath);
  await writeFile(assPath, buildExportAss({ timeline, layout }), 'utf-8');
  const chunks = chunkClips(timeline.clips);
  const chunkPaths: string[] = [];
  for (const [index, clips] of chunks.entries()) {
    const chunkPath = join(input.workDir, `chunk_${index}.mkv`);
    const isLastChunk = index === chunks.length - 1;
    await renderChunk({
      clips,
      nextClip: timeline.clips[clips[clips.length - 1]!.index + 1] ?? null,
      continuesIntoEndCard: isLastChunk && timeline.endCard?.audio != null,
      sourceVideoPath: input.sourceVideoPath,
      outputPath: chunkPath,
      fps,
      width,
      height,
      background: layout.background,
      speed,
    });
    chunkPaths.push(chunkPath);
  }
  let endCardPath: string | null = null;
  if (timeline.endCard) {
    endCardPath = await renderEndCardMkv({
      endCard: timeline.endCard,
      lastClipEnd: timeline.clips[timeline.clips.length - 1]!.sourceEnd,
      speed,
      sourceVideoPath: input.sourceVideoPath,
      workDir: input.workDir,
      fontsDir: input.fontsDir,
      fps,
      thumbnailPath: input.endCardThumbnailPath,
      layout,
    });
  }
  const concatPath = join(input.workDir, 'chunks.txt');
  const concatBody = `${chunkPaths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join('\n')}\n`;
  await writeFile(concatPath, concatBody, 'utf-8');
  const artifactPath = join(input.workDir, 'short.mp4');
  await encodeFinal({ concatPath, endCardPath, workDir: input.workDir, fontsDir: input.fontsDir, fps, outputPath: artifactPath });
  const durationSeconds = await probeDurationSeconds(artifactPath);
  const sizeBytes = (await stat(artifactPath)).size;
  return { artifactPath, sizeBytes, durationSeconds };
}

async function renderChunk(input: {
  clips: TimelineClip[];
  nextClip: TimelineClip | null;
  continuesIntoEndCard: boolean;
  sourceVideoPath: string;
  outputPath: string;
  fps: number;
  width: number;
  height: number;
  background: string;
  speed: number;
}): Promise<void> {
  await ensureParent(input.outputPath);
  const chunkStart = input.clips[0]!.sourceStart;
  const chunkEnd = input.clips[input.clips.length - 1]!.sourceEnd;
  await runProcess('ffmpeg', [
    '-y',
    '-ss', num(chunkStart),
    '-to', num(chunkEnd),
    '-i', input.sourceVideoPath,
    '-filter_complex', buildChunkFilterGraph(input),
    '-map', '[vc]',
    '-map', '[ac]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '14',
    '-pix_fmt', 'yuv420p',
    '-r', String(input.fps),
    '-c:a', 'pcm_s16le',
    '-ar', String(AUDIO_SAMPLE_RATE),
    input.outputPath,
  ], { timeoutMs: RENDER_TIMEOUT_MS });
}

function buildChunkFilterGraph(input: {
  clips: TimelineClip[];
  nextClip: TimelineClip | null;
  continuesIntoEndCard: boolean;
  fps: number;
  width: number;
  height: number;
  background: string;
  speed: number;
}): string {
  const parts: string[] = [];
  const chunkStart = input.clips[0]!.sourceStart;
  const clipCount = input.clips.length;
  parts.push(`[0:v]split=${clipCount}${splitLabels('vsrc', clipCount, '')}`);
  parts.push(`[0:a]asplit=${clipCount}${splitLabels('asrc', clipCount, '')}`);
  input.clips.forEach((clip, index) => {
    const trimStart = clip.sourceStart - chunkStart;
    const trimEnd = clip.sourceEnd - chunkStart;
    const outputDuration = (clip.sourceEnd - clip.sourceStart) / input.speed;
    const audioSamples = Math.round(outputDuration * AUDIO_SAMPLE_RATE);
    const fadeLength = Math.min(FADE_SECONDS, outputDuration / 2);
    parts.push(
      `[vsrc${index}]trim=start=${num(trimStart)}:end=${num(trimEnd)},setpts=(PTS-STARTPTS)/${num(input.speed)},fps=${input.fps},split=${clip.panels.length}${splitLabels(`vcrop${index}`, clip.panels.length, '_')}`,
    );
    const overlayInputs = clip.panels.flatMap((panel, panelIndex) =>
      panelScaleChains(parts, index, panelIndex, panel),
    );
    parts.push(`color=c=${input.background}:s=${input.width}x${input.height}:r=${input.fps}:d=${num(outputDuration)}[vbase${index}]`);
    let previousLabel = `[vbase${index}]`;
    overlayInputs.forEach((overlayInput, inputIndex) => {
      const last = inputIndex === overlayInputs.length - 1;
      const label = last ? `[vclip${index}]` : `[vover${index}_${inputIndex}]`;
      parts.push(`${previousLabel}${overlayInput.label}overlay=x=${overlayInput.x}:y=${overlayInput.y}${last ? ',format=yuv420p' : ''}${label}`);
      previousLabel = label;
    });
    const audioChain = [`[asrc${index}]atrim=start=${num(trimStart)}:end=${num(trimEnd)},asetpts=PTS-STARTPTS,aresample=${AUDIO_SAMPLE_RATE}`];
    if (input.speed !== 1) {
      audioChain.push(`atempo=${num(input.speed)}`);
    }
    if (!clip.joinsPrevious) {
      audioChain.push(`afade=t=in:st=0:d=${num(fadeLength)}`);
    }
    const nextClip = index + 1 < clipCount ? input.clips[index + 1]! : input.nextClip;
    const continuesSeamlessly = nextClip === null ? input.continuesIntoEndCard : nextClip.joinsPrevious;
    if (!continuesSeamlessly) {
      audioChain.push(`afade=t=out:st=${num(Math.max(0, outputDuration - fadeLength))}:d=${num(fadeLength)}`);
    }
    audioChain.push('apad', `atrim=end_sample=${audioSamples}`);
    parts.push(`${audioChain.join(',')}[aclip${index}]`);
  });
  const pairs = input.clips.map((_, index) => `[vclip${index}][aclip${index}]`).join('');
  parts.push(`${pairs}concat=n=${clipCount}:v=1:a=1[vc][ac]`);
  return parts.join(';');
}

async function renderEndCardMkv(input: {
  endCard: TimelineEndCard;
  lastClipEnd: number;
  speed: number;
  sourceVideoPath: string;
  workDir: string;
  fontsDir: string;
  fps: number;
  thumbnailPath: string | null;
  layout: LayoutProfile;
}): Promise<string> {
  const outputPath = join(input.workDir, 'end-card.mkv');
  const backgroundPath = join(input.workDir, 'end-card-bg.jpg');
  const videoStreamDuration = await probeVideoStreamDurationSeconds(input.sourceVideoPath);
  const seekSeconds = Math.max(0, Math.min(input.lastClipEnd, videoStreamDuration) - 1 / input.fps);
  await extractFrame({
    videoPath: input.sourceVideoPath,
    seconds: seekSeconds,
    width: input.layout.canvas.width,
    outputPath: backgroundPath,
  });
  const assPath = join(input.workDir, 'end-card.ass');
  await writeFile(assPath, buildEndCardAss({ endCard: input.endCard, layout: input.layout }), 'utf-8');
  const assArg = buildSubtitlesFilterArg('end-card.ass', relative(input.workDir, input.fontsDir));
  const hasThumbnail = input.thumbnailPath !== null;
  const width = input.layout.canvas.width;
  const height = input.layout.canvas.height;
  const darken = num(input.endCard.darkenFactor);
  const background = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},colorchannelmixer=rr=${darken}:gg=${darken}:bb=${darken},gblur=sigma=24,setsar=1`;
  const thumbnailWidth = input.endCard.thumbnail.widthPx;
  const thumbnailCenterY = input.endCard.thumbnail.centerY;
  const graph = hasThumbnail
    ? `[0:v]${background}[bg];[1:v]scale=${thumbnailWidth}:-2[thumb];[bg][thumb]overlay=x=(W-w)/2:y=${thumbnailCenterY}-h/2[card];[card]${assArg}[vout]`
    : `[0:v]${background}[bg];[bg]${assArg}[vout]`;
  const duration = num(input.endCard.durationSeconds);
  const audio = input.endCard.audio;
  const audioInputIndex = hasThumbnail ? 2 : 1;
  const audioSamples = Math.round(input.endCard.durationSeconds * AUDIO_SAMPLE_RATE);
  const audioGraph = audio === null
    ? ''
    : `;[${audioInputIndex}:a:0]asetpts=PTS-STARTPTS,aresample=${AUDIO_SAMPLE_RATE}${input.speed !== 1 ? `,atempo=${num(input.speed)}` : ''},volume='${endCardVolumeExpression(input.endCard)}':eval=frame,apad,atrim=end_sample=${audioSamples}[aout]`;
  const args: string[] = [
    '-y',
    '-xerror',
    '-loop', '1', '-t', duration, '-framerate', String(input.fps), '-i', backgroundPath,
  ];
  if (hasThumbnail) {
    args.push('-loop', '1', '-t', duration, '-framerate', String(input.fps), '-i', input.thumbnailPath!);
  }
  if (audio === null) {
    args.push('-f', 'lavfi', '-t', duration, '-i', `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo`);
  } else {
    args.push('-ss', num(audio.sourceStart), '-t', num(audio.sourceEnd - audio.sourceStart), '-i', input.sourceVideoPath);
  }
  args.push(
    '-filter_complex', `${graph}${audioGraph}`,
    '-map', '[vout]',
    '-map', audio === null ? `${audioInputIndex}:a` : '[aout]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '14',
    '-pix_fmt', 'yuv420p',
    '-r', String(input.fps),
    '-c:a', 'pcm_s16le',
    '-ar', String(AUDIO_SAMPLE_RATE),
    '-t', duration,
    outputPath,
  );
  await runProcess('ffmpeg', args, { cwd: input.workDir, timeoutMs: RENDER_TIMEOUT_MS });
  return outputPath;
}

async function encodeFinal(input: {
  concatPath: string;
  endCardPath: string | null;
  workDir: string;
  fontsDir: string;
  fps: number;
  outputPath: string;
}): Promise<void> {
  await ensureParent(input.outputPath);
  const assArg = buildSubtitlesFilterArg('captions.ass', relative(input.workDir, input.fontsDir));
  const filterComplex = input.endCardPath
    ? `[0:v]${assArg}[vmain];[vmain][0:a][1:v][1:a]concat=n=2:v=1:a=1[vcat][acat];[acat]${LOUDNORM_FILTER}[aout]`
    : `[0:v]${assArg}[vcat];[0:a]${LOUDNORM_FILTER}[aout]`;
  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', input.concatPath];
  if (input.endCardPath) {
    args.push('-i', input.endCardPath);
  }
  args.push(
    '-filter_complex', filterComplex,
    '-map', '[vcat]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-r', String(input.fps),
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', String(AUDIO_SAMPLE_RATE),
    '-movflags', '+faststart',
    input.outputPath,
  );
  await runProcess('ffmpeg', args, { cwd: input.workDir, timeoutMs: RENDER_TIMEOUT_MS });
}

export async function extractFrame(input: { videoPath: string; seconds: number; width: number; outputPath: string }): Promise<void> {
  await ensureParent(input.outputPath);
  await runProcess('ffmpeg', [
    '-y',
    '-ss', num(input.seconds),
    '-i', input.videoPath,
    '-frames:v', '1',
    '-vf', `scale=${input.width}:-2`,
    '-q:v', '3',
    input.outputPath,
  ], { timeoutMs: RENDER_TIMEOUT_MS });
  try {
    await stat(input.outputPath);
  } catch {
    throw new Error(`ffmpeg wrote no frame to ${input.outputPath}`);
  }
}

const COVER_FOREGROUND_WIDTH_RATIO = 920 / 1080;

export async function renderCoverImage(input: { imagePath: string; outputPath: string; width: number; height: number }): Promise<void> {
  await ensureParent(input.outputPath);
  const foreground = Math.round(input.width * COVER_FOREGROUND_WIDTH_RATIO);
  await runProcess('ffmpeg', [
    '-y',
    '-i', input.imagePath,
    '-filter_complex',
    `[0:v]split=2[bgsrc][fgsrc];[bgsrc]scale=${input.width}:${input.height}:force_original_aspect_ratio=increase,crop=${input.width}:${input.height},boxblur=18:2[bg];[fgsrc]scale=${foreground}:${foreground}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuvj420p[vout]`,
    '-map', '[vout]',
    '-frames:v', '1',
    '-q:v', '2',
    input.outputPath,
  ], { timeoutMs: RENDER_TIMEOUT_MS });
  try {
    await stat(input.outputPath);
  } catch {
    throw new Error(`ffmpeg wrote no cover to ${input.outputPath}`);
  }
}

export function buildSubtitlesFilterArg(assPath: string, fontsDir: string): string {
  return `ass=filename=${escapeFiltergraphValue(assPath)}:fontsdir=${escapeFiltergraphValue(fontsDir)}`;
}

function escapeFiltergraphValue(value: string): string {
  const optionLevel = value.replace(/['\\:]/g, '\\$&');
  return optionLevel.replace(/['\\]/g, '\\$&');
}

function chunkClips(clips: TimelineClip[]): TimelineClip[][] {
  const chunks: TimelineClip[][] = [];
  let current: TimelineClip[] = [];
  for (const clip of clips) {
    const previous = current[current.length - 1];
    if (
      previous !== undefined &&
      !clip.joinsPrevious &&
      (clip.sourceStart - previous.sourceEnd > CHUNK_MAX_SOURCE_GAP_SECONDS || current.length >= CHUNK_MAX_CLIPS)
    ) {
      chunks.push(current);
      current = [];
    }
    current.push(clip);
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function splitLabels(prefix: string, count: number, separator: string): string {
  return Array.from({ length: count }, (_, index) => `[${prefix}${separator}${index}]`).join('');
}

interface PanelOverlayInput {
  label: string;
  x: number;
  y: number;
}

function panelScaleChains(
  parts: string[],
  clipIndex: number,
  panelIndex: number,
  panel: TimelinePanelPlacement,
): PanelOverlayInput[] {
  const cropStream = `[vcrop${clipIndex}_${panelIndex}]`;
  const cropArgs = `crop=${panel.source.w}:${panel.source.h}:${panel.source.x}:${panel.source.y}`;
  if (panel.fill === 'cover') {
    parts.push(`${cropStream}${cropArgs},scale=${panel.canvas.w}:${panel.canvas.h}:flags=lanczos,setsar=1[vscaled${clipIndex}_${panelIndex}]`);
    return [{ label: `[vscaled${clipIndex}_${panelIndex}]`, x: panel.canvas.x, y: panel.canvas.y }];
  }
  const cropAspect = panel.source.w / panel.source.h;
  const panelAspect = panel.canvas.w / panel.canvas.h;
  const coverWidth = cropAspect > panelAspect ? Math.ceil((panel.canvas.h * cropAspect) / 2) * 2 : panel.canvas.w;
  const coverHeight = cropAspect > panelAspect ? panel.canvas.h : Math.ceil((panel.canvas.w / cropAspect) / 2) * 2;
  const foregroundWidth = Math.max(2, Math.floor((panel.canvas.h * cropAspect) / 2) * 2);
  parts.push(`${cropStream}${cropArgs},split=2${splitLabels(`hblur${clipIndex}_${panelIndex}`, 2, '')}`);
  parts.push(
    `[hblur${clipIndex}_${panelIndex}0]scale=${coverWidth}:${coverHeight}:flags=lanczos,gblur=sigma=${num(HOST_BLUR_SIGMA_PX)},colorchannelmixer=rr=${num(HOST_BLUR_DARKEN)}:gg=${num(HOST_BLUR_DARKEN)}:bb=${num(HOST_BLUR_DARKEN)},crop=${panel.canvas.w}:${panel.canvas.h},setsar=1[hblurbg${clipIndex}_${panelIndex}]`,
  );
  parts.push(
    `[hblur${clipIndex}_${panelIndex}1]scale=${foregroundWidth}:${panel.canvas.h}:flags=lanczos,setsar=1[hblurfg${clipIndex}_${panelIndex}]`,
  );
  return [
    { label: `[hblurbg${clipIndex}_${panelIndex}]`, x: panel.canvas.x, y: panel.canvas.y },
    { label: `[hblurfg${clipIndex}_${panelIndex}]`, x: panel.canvas.x + Math.round((panel.canvas.w - foregroundWidth) / 2), y: panel.canvas.y },
  ];
}

async function probeVideoStreamDurationSeconds(path: string): Promise<number> {
  const { stdout } = await runProcess('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ], { timeoutMs: RENDER_TIMEOUT_MS });
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`No video stream duration found in ${path}`);
  }
  return duration;
}

async function probeDurationSeconds(path: string): Promise<number> {
  const { stdout } = await runProcess('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ], { timeoutMs: RENDER_TIMEOUT_MS });
  return Number(stdout.trim());
}

function endCardVolumeExpression(endCard: TimelineEndCard): string {
  const audio = endCard.audio!;
  const duck = `if(lt(t,${num(audio.duckSeconds)}),1-${num(1 - audio.duckGain)}*t/${num(audio.duckSeconds)},${num(audio.duckGain)})`;
  const fadeStart = num(endCard.durationSeconds - audio.fadeOutSeconds);
  const fade = `if(gt(t,${fadeStart}),max(0,(${num(endCard.durationSeconds)}-t)/${num(audio.fadeOutSeconds)}),1)`;
  return `${duck}*${fade}`;
}

function num(value: number): string {
  return String(Number(value.toFixed(6)));
}
