import type { LayoutProfile, PxRect } from './layout.js';
import type { CropKeyframe, ShortEdit } from './edit.js';
import { keptWordIndices } from './edit.js';
import type { TranscriptWord } from './model.js';
import { formatCaptionWord, wrapHook, wrapWords } from './text.js';
import { contentSourceCrop, hostSourceCrop, normToPx, panelCanvasRect, toEvenPxRect } from './geometry.js';

export interface TimelinePanelPlacement {
  panelId: string;
  role: 'content' | 'host';
  source: PxRect;
  canvas: PxRect;
}

export interface TimelineClip {
  index: number;
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  joinsPrevious: boolean;
  zoom: number;
  panels: TimelinePanelPlacement[];
}

export interface CaptionWord {
  wordIndex: number;
  text: string;
  outputStart: number;
  outputEnd: number;
}

export interface CaptionCue {
  lines: CaptionWord[][];
  outputStart: number;
  outputEnd: number;
}

export interface TimelineHook {
  lines: string[];
  canvas: PxRect;
  sizePx: number;
}

export interface TimelineEndCardLine {
  text: string;
  centerX: number;
  centerY: number;
  sizePx: number;
}

export interface TimelineEndCardThumbnail {
  centerX: number;
  centerY: number;
  widthPx: number;
}

export interface TimelineEndCardAudio {
  sourceStart: number;
  sourceEnd: number;
  duckGain: number;
  duckSeconds: number;
  fadeOutSeconds: number;
}

export interface TimelineEndCard {
  durationSeconds: number;
  darkenFactor: number;
  thumbnail: TimelineEndCardThumbnail;
  titleLines: TimelineEndCardLine[];
  link: TimelineEndCardLine;
  textOutlinePx: number;
  textOutlineColor: string;
  audio: TimelineEndCardAudio | null;
}

export interface Timeline {
  canvas: { width: number; height: number; fps: number };
  speed: number;
  durationSeconds: number;
  clips: TimelineClip[];
  cues: CaptionCue[];
  hook: TimelineHook | null;
  endCard: TimelineEndCard | null;
}

export const CLIP_PAD_IN_SECONDS = 0.08;
export const CLIP_PAD_OUT_SECONDS = 0.12;
export const CROP_SPLIT_MARGIN_SECONDS = 0.3;
export const END_CARD_SECONDS = 2.4;
export const END_CARD_DARKEN_FACTOR = 0.55;
export const END_CARD_THUMBNAIL_WIDTH_PX = 900;
export const END_CARD_THUMBNAIL_CENTER_Y = 560;
export const END_CARD_TITLE_CENTER_Y = 1200;
export const END_CARD_LINK_TEXT = 'Link na descrição';
export const END_CARD_LINK_CENTER_Y = 1700;
export const END_CARD_LINK_SIZE_PX = 44;
export const END_CARD_TITLE_MAX_CHARS_PER_LINE = 22;
export const END_CARD_TITLE_MAX_LINES = 3;
export const END_CARD_TEXT_OUTLINE_PX = 2;
export const END_CARD_TEXT_OUTLINE_COLOR = '#000000';
export const END_CARD_LINE_HEIGHT_RATIO = 1.12;
export const END_CARD_AUDIO_DUCK_GAIN = 0.35;
export const END_CARD_AUDIO_DUCK_SECONDS = 0.5;
export const END_CARD_AUDIO_FADE_OUT_SECONDS = 1;
export const CUE_GAP_BREAK_SECONDS = 0.6;
export const CUE_TAIL_SECONDS = 0.25;

export interface SourceClip {
  sourceStart: number;
  sourceEnd: number;
  joinsPrevious: boolean;
  firstWord: number;
  lastWord: number;
}

export function computeSourceClips(edit: ShortEdit, words: TranscriptWord[], sourceDurationSeconds: number): SourceClip[] {
  const kept = keptWordIndices(edit, words.length);
  if (kept.length === 0) {
    return [];
  }
  const groups: number[][] = [[kept[0]!]];
  for (let k = 1; k < kept.length; k += 1) {
    const previousIndex = kept[k - 1]!;
    const index = kept[k]!;
    const gap = words[index]!.startSeconds - words[previousIndex]!.endSeconds;
    if (index !== previousIndex + 1 || (edit.tightenPauses.enabled && gap > edit.tightenPauses.maxGapSeconds)) {
      groups.push([index]);
      continue;
    }
    groups[groups.length - 1]!.push(index);
  }
  const clips: SourceClip[] = [];
  for (const group of groups) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const previousEnd = first > 0 ? words[first - 1]!.endSeconds : 0;
    const sourceStart = Math.max(
      words[first]!.startSeconds - CLIP_PAD_IN_SECONDS,
      (previousEnd + words[first]!.startSeconds) / 2,
      0,
    );
    const nextStart = last + 1 < words.length ? words[last + 1]!.startSeconds : sourceDurationSeconds;
    const sourceEnd = Math.min(
      words[last]!.endSeconds + CLIP_PAD_OUT_SECONDS,
      (words[last]!.endSeconds + nextStart) / 2,
      sourceDurationSeconds,
    );
    const previousClip = clips[clips.length - 1];
    clips.push({
      sourceStart,
      sourceEnd,
      joinsPrevious: previousClip !== undefined && Math.abs(sourceStart - previousClip.sourceEnd) < 0.001,
      firstWord: first,
      lastWord: last,
    });
  }
  return clips;
}

export function outputDurationSeconds(edit: ShortEdit, words: TranscriptWord[], sourceDurationSeconds: number): number {
  return computeSourceClips(edit, words, sourceDurationSeconds).reduce(
    (total, clip) => total + (clip.sourceEnd - clip.sourceStart) / edit.speed,
    0,
  );
}

export function buildTimeline(input: {
  edit: ShortEdit;
  words: TranscriptWord[];
  layout: LayoutProfile;
  title: string;
  source: { width: number; height: number; durationSeconds: number };
}): Timeline {
  const { edit, words, layout, source } = input;
  const fps = layout.canvas.fps;
  const baseClips = computeSourceClips(edit, words, source.durationSeconds);
  const cropTimes = edit.crops.map((crop) => crop.sourceSeconds).sort((left, right) => left - right);
  const rawClips: SourceClip[] = [];
  for (const clip of baseClips) {
    const splits = cropTimes.filter(
      (t) => clip.sourceStart + CROP_SPLIT_MARGIN_SECONDS < t && t < clip.sourceEnd - CROP_SPLIT_MARGIN_SECONDS,
    );
    const boundaries = [clip.sourceStart, ...splits, clip.sourceEnd];
    for (let i = 0; i < boundaries.length - 1; i += 1) {
      rawClips.push({
        sourceStart: boundaries[i]!,
        sourceEnd: boundaries[i + 1]!,
        joinsPrevious: i === 0 ? clip.joinsPrevious : true,
        firstWord: clip.firstWord,
        lastWord: clip.lastWord,
      });
    }
  }
  const clips: TimelineClip[] = [];
  let outputStart = 0;
  for (const [index, clip] of rawClips.entries()) {
    const frames = Math.round(((clip.sourceEnd - clip.sourceStart) / edit.speed) * fps);
    if (frames < 1) {
      continue;
    }
    const outputEnd = outputStart + frames / fps;
    clips.push({
      index: clips.length,
      sourceStart: clip.sourceStart,
      sourceEnd: clip.sourceStart + (frames / fps) * edit.speed,
      outputStart,
      outputEnd,
      joinsPrevious: clip.joinsPrevious,
      zoom: 1,
      panels: [],
    });
    outputStart = outputEnd;
  }
  let zoomed = false;
  for (const [index, clip] of clips.entries()) {
    if (index > 0 && !clip.joinsPrevious) {
      zoomed = !zoomed;
    }
    clip.zoom = edit.zoom.enabled && zoomed ? edit.zoom.strength : 1;
  }
  const sortedCrops = [...edit.crops].sort((left, right) => left.sourceSeconds - right.sourceSeconds);
  for (const clip of clips) {
    const afterSplit = clip.index > 0 && clip.joinsPrevious;
    const focusLimit = clip.sourceStart + (afterSplit ? 0.001 : CROP_SPLIT_MARGIN_SECONDS);
    let focus: CropKeyframe | null = null;
    for (const crop of sortedCrops) {
      if (crop.sourceSeconds > focusLimit) {
        break;
      }
      focus = crop;
    }
    clip.panels = layout.panels.map((panel) => {
      const canvasRect = panelCanvasRect(panel, layout.canvas);
      const aspect = canvasRect.w / canvasRect.h;
      return {
        panelId: panel.id,
        role: panel.role,
        source:
          panel.role === 'content'
            ? contentSourceCrop(panel, focus ? focus.focus : null, source, aspect)
            : hostSourceCrop(panel, clip.zoom, source, aspect),
        canvas: canvasRect,
      };
    });
  }
  const cues: CaptionCue[] = [];
  if (edit.captions.enabled) {
    buildCaptionCues(cues, clips, edit, words, layout);
  }
  const hook = fitHook(edit, layout);
  return {
    canvas: { width: layout.canvas.width, height: layout.canvas.height, fps },
    speed: edit.speed,
    durationSeconds: outputStart,
    clips,
    cues,
    hook,
    endCard: edit.endCard.enabled ? buildEndCard(input.title, layout, endCardAudio(clips, edit.speed, source.durationSeconds)) : null,
  };
}

function fitHook(edit: ShortEdit, layout: LayoutProfile): TimelineHook | null {
  const band = layout.hookBand;
  const text = edit.hook.text.trim();
  if (!edit.hook.enabled || band === null || text.length === 0) {
    return null;
  }
  const canvas = toEvenPxRect(normToPx(band.rect, layout.canvas.width, layout.canvas.height));
  const candidateSizes = [band.sizePx, Math.round(band.sizePx * 0.86), Math.round(band.sizePx * 0.74)];
  let chosenSize = candidateSizes[candidateSizes.length - 1]!;
  let lines = wrapHook(text, {
    ...band,
    maxCharsPerLine: Math.floor((band.maxCharsPerLine * band.sizePx) / chosenSize),
  });
  for (const size of candidateSizes) {
    const candidate = wrapHook(text, {
      ...band,
      maxCharsPerLine: Math.floor((band.maxCharsPerLine * band.sizePx) / size),
    });
    if (candidate.length <= band.maxLines) {
      chosenSize = size;
      lines = candidate;
      break;
    }
  }
  return { lines, canvas, sizePx: chosenSize };
}

function endCardAudio(clips: TimelineClip[], speed: number, sourceDurationSeconds: number): TimelineEndCardAudio | null {
  const lastClip = clips.at(-1);
  if (lastClip === undefined || lastClip.sourceEnd >= sourceDurationSeconds) {
    return null;
  }
  return {
    sourceStart: lastClip.sourceEnd,
    sourceEnd: Math.min(sourceDurationSeconds, lastClip.sourceEnd + END_CARD_SECONDS * speed),
    duckGain: END_CARD_AUDIO_DUCK_GAIN,
    duckSeconds: END_CARD_AUDIO_DUCK_SECONDS,
    fadeOutSeconds: END_CARD_AUDIO_FADE_OUT_SECONDS,
  };
}

export function endCardAudioGain(endCard: TimelineEndCard, elapsedSeconds: number): number {
  const audio = endCard.audio;
  if (audio === null) {
    return 0;
  }
  const t = Math.min(Math.max(0, elapsedSeconds), endCard.durationSeconds);
  const duck = t < audio.duckSeconds ? 1 - ((1 - audio.duckGain) * t) / audio.duckSeconds : audio.duckGain;
  const fadeStart = endCard.durationSeconds - audio.fadeOutSeconds;
  const fade = t > fadeStart ? (endCard.durationSeconds - t) / audio.fadeOutSeconds : 1;
  return duck * fade;
}

function buildEndCard(title: string, layout: LayoutProfile, audio: TimelineEndCardAudio | null): TimelineEndCard {
  const width = layout.canvas.width;
  const titleSizePx = layout.hookBand?.sizePx ?? layout.captions.sizePx;
  const titleWords = title.replace(/\s+/g, ' ').trim().split(' ').filter((word) => word.length > 0);
  const lines = wrapWords(titleWords, END_CARD_TITLE_MAX_CHARS_PER_LINE)
    .slice(0, END_CARD_TITLE_MAX_LINES)
    .map((line) => line.map((index) => titleWords[index]!).join(' '));
  const lineHeight = END_CARD_LINE_HEIGHT_RATIO * titleSizePx;
  return {
    durationSeconds: END_CARD_SECONDS,
    darkenFactor: END_CARD_DARKEN_FACTOR,
    thumbnail: {
      centerX: width / 2,
      centerY: END_CARD_THUMBNAIL_CENTER_Y,
      widthPx: END_CARD_THUMBNAIL_WIDTH_PX,
    },
    titleLines: lines.map((text, index) => ({
      text,
      centerX: width / 2,
      centerY: Math.round((END_CARD_TITLE_CENTER_Y + (index - (lines.length - 1) / 2) * lineHeight) * 100) / 100,
      sizePx: titleSizePx,
    })),
    link: {
      text: END_CARD_LINK_TEXT,
      centerX: width / 2,
      centerY: END_CARD_LINK_CENTER_Y,
      sizePx: END_CARD_LINK_SIZE_PX,
    },
    textOutlinePx: END_CARD_TEXT_OUTLINE_PX,
    textOutlineColor: END_CARD_TEXT_OUTLINE_COLOR,
    audio,
  };
}

function buildCaptionCues(cues: CaptionCue[], clips: TimelineClip[], edit: ShortEdit, words: TranscriptWord[], layout: LayoutProfile): void {
  const style = layout.captions;
  const captionWords: CaptionWord[] = [];
  for (const wordIndex of keptWordIndices(edit, words.length)) {
    const word = words[wordIndex]!;
    const text = formatCaptionWord(word.text, style.uppercase);
    if (text.length === 0) {
      continue;
    }
    const startClip = clipForTime(clips, word.startSeconds);
    const endClip = clipForTime(clips, word.endSeconds);
    if (startClip === undefined || endClip === undefined) {
      continue;
    }
    captionWords.push({
      wordIndex,
      text,
      outputStart: mapToOutput(startClip, word.startSeconds, edit.speed),
      outputEnd: mapToOutput(endClip, word.endSeconds, edit.speed),
    });
  }
  let current: CaptionWord[] = [];
  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const lines = wrapWords(current.map((entry) => entry.text), style.maxCharsPerLine).map((line) =>
      line.map((wordIndex) => current[wordIndex]!),
    );
    cues.push({
      lines,
      outputStart: current[0]!.outputStart,
      outputEnd: current[current.length - 1]!.outputEnd,
    });
    current = [];
  };
  for (const word of captionWords) {
    if (current.length >= style.maxWordsPerCue) {
      flush();
    } else if (current.length > 0) {
      const last = current[current.length - 1]!;
      if (word.outputStart - last.outputEnd > CUE_GAP_BREAK_SECONDS || endsWithBreakPunctuation(last.text)) {
        flush();
      } else {
        const projected = wrapWords([...current.map((entry) => entry.text), word.text], style.maxCharsPerLine);
        if (projected.length > style.maxLines) {
          flush();
        }
      }
    }
    current.push(word);
  }
  flush();
  for (const [index, cue] of cues.entries()) {
    const next = cues[index + 1];
    const lastLine = cue.lines[cue.lines.length - 1]!;
    const lastWord = lastLine[lastLine.length - 1]!;
    cue.outputEnd = Math.min(lastWord.outputEnd + CUE_TAIL_SECONDS, next ? next.outputStart : Number.POSITIVE_INFINITY);
  }
}

function clipForTime(clips: TimelineClip[], timeSeconds: number): TimelineClip | undefined {
  let result: TimelineClip | undefined;
  for (const clip of clips) {
    if (clip.sourceStart > timeSeconds) {
      break;
    }
    result = clip;
  }
  return result;
}

function mapToOutput(clip: TimelineClip, timeSeconds: number, speed: number): number {
  return Math.min(clip.outputEnd, Math.max(clip.outputStart, clip.outputStart + (timeSeconds - clip.sourceStart) / speed));
}

const CUE_BREAK_PUNCTUATION = ['.', '!', '?', '…'];

function endsWithBreakPunctuation(text: string): boolean {
  return CUE_BREAK_PUNCTUATION.some((char) => text.endsWith(char));
}

export function outputToSource(timeline: Timeline, outputSeconds: number): { clipIndex: number; sourceSeconds: number } {
  const output = Math.min(Math.max(outputSeconds, 0), timeline.durationSeconds);
  for (const clip of timeline.clips) {
    if (output < clip.outputEnd) {
      return { clipIndex: clip.index, sourceSeconds: clip.sourceStart + (output - clip.outputStart) * timeline.speed };
    }
  }
  const last = timeline.clips[timeline.clips.length - 1];
  if (!last) {
    return { clipIndex: 0, sourceSeconds: 0 };
  }
  return { clipIndex: last.index, sourceSeconds: last.sourceEnd };
}

export function sourceToOutput(timeline: Timeline, sourceSeconds: number): number | null {
  for (const clip of timeline.clips) {
    if (sourceSeconds >= clip.sourceStart && sourceSeconds < clip.sourceEnd) {
      return clip.outputStart + (sourceSeconds - clip.sourceStart) / timeline.speed;
    }
  }
  return null;
}

export function activeCueAt(timeline: Timeline, outputSeconds: number): { cue: CaptionCue; activeWordIndex: number | null } | null {
  const cue = timeline.cues.find((entry) => outputSeconds >= entry.outputStart && outputSeconds < entry.outputEnd);
  if (!cue) {
    return null;
  }
  const words = cue.lines.flat();
  let activeWordIndex: number | null = null;
  for (const [index, word] of words.entries()) {
    if (word.outputStart <= outputSeconds) {
      activeWordIndex = index;
    }
  }
  return { cue, activeWordIndex };
}
