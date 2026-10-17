import { z } from 'zod';
import type { NormRect } from './layout.js';
import type { TranscriptWord } from './model.js';

export interface WordRange {
  startWord: number;
  endWord: number;
}

export interface CropKeyframe {
  sourceSeconds: number;
  focus: NormRect;
  origin: 'auto' | 'manual';
}

export interface ShortEdit {
  ranges: WordRange[];
  removedWords: number[];
  tightenPauses: { enabled: boolean; maxGapSeconds: number };
  speed: number;
  hook: { enabled: boolean; text: string };
  captions: { enabled: boolean };
  crops: CropKeyframe[];
  zoom: { enabled: boolean; strength: number };
  endCard: { enabled: boolean };
}

export const EDIT_LIMITS = {
  minSpeed: 1,
  maxSpeed: 1.5,
  minPauseGapSeconds: 0.15,
  maxPauseGapSeconds: 1.5,
  defaultPauseGapSeconds: 0.35,
  minZoom: 1,
  maxZoom: 1.3,
  defaultZoom: 1.12,
  maxHookChars: 90,
} as const;

const NormRectSchema = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().positive().max(1),
  h: z.number().positive().max(1),
});

export const WordRangeSchema = z.strictObject({
  startWord: z.number().int().min(0),
  endWord: z.number().int().min(0),
}).refine((range) => range.startWord <= range.endWord, { message: 'startWord must be <= endWord' });

export const CropKeyframeSchema = z.strictObject({
  sourceSeconds: z.number().min(0),
  focus: NormRectSchema,
  origin: z.enum(['auto', 'manual']),
});

export const ShortEditSchema = z.strictObject({
  ranges: z.array(WordRangeSchema).min(1),
  removedWords: z.array(z.number().int().min(0)),
  tightenPauses: z.strictObject({
    enabled: z.boolean(),
    maxGapSeconds: z.number().min(EDIT_LIMITS.minPauseGapSeconds).max(EDIT_LIMITS.maxPauseGapSeconds),
  }),
  speed: z.number().min(EDIT_LIMITS.minSpeed).max(EDIT_LIMITS.maxSpeed),
  hook: z.strictObject({ enabled: z.boolean(), text: z.string().max(EDIT_LIMITS.maxHookChars) }),
  captions: z.strictObject({ enabled: z.boolean() }),
  crops: z.array(CropKeyframeSchema),
  zoom: z.strictObject({ enabled: z.boolean(), strength: z.number().min(EDIT_LIMITS.minZoom).max(EDIT_LIMITS.maxZoom) }),
  endCard: z.strictObject({ enabled: z.boolean() }),
});

const CROP_KEYFRAME_TOLERANCE_SECONDS = 0.05;

export const FILLER_WORDS: ReadonlySet<string> = new Set([
  'hã',
  'hãã',
  'ãh',
  'ããh',
  'hum',
  'humm',
  'hmm',
  'uhm',
  'ahn',
  'éh',
  'ehh',
]);

export function normalizeFillerToken(text: string): string {
  return text.toLocaleLowerCase('pt-BR').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

export function detectFillerWords(words: TranscriptWord[], ranges: WordRange[]): number[] {
  const fillers: number[] = [];
  for (const [index, word] of words.entries()) {
    if (!FILLER_WORDS.has(normalizeFillerToken(word.text))) {
      continue;
    }
    if (ranges.some((range) => index >= range.startWord && index <= range.endWord)) {
      fillers.push(index);
    }
  }
  return fillers;
}

export function createInitialEdit(input: { ranges: WordRange[]; words: TranscriptWord[]; speed: number; hookText: string }): ShortEdit {
  const hookText = input.hookText.trim();
  return normalizeEdit(
    {
      ranges: input.ranges.map((range) => ({ ...range })),
      removedWords: detectFillerWords(input.words, input.ranges),
      tightenPauses: { enabled: true, maxGapSeconds: EDIT_LIMITS.defaultPauseGapSeconds },
      speed: input.speed,
      hook: { enabled: hookText.length > 0, text: hookText.slice(0, EDIT_LIMITS.maxHookChars) },
      captions: { enabled: true },
      crops: [],
      zoom: { enabled: true, strength: EDIT_LIMITS.defaultZoom },
      endCard: { enabled: false },
    },
    input.words.length,
  );
}

export function normalizeEdit(edit: ShortEdit, wordCount: number): ShortEdit {
  for (const range of edit.ranges) {
    if (range.startWord >= wordCount || range.endWord >= wordCount) {
      throw new Error(`Range ${range.startWord}..${range.endWord} is outside the transcript of ${wordCount} words`);
    }
  }
  const sorted = [...edit.ranges].sort(
    (left, right) => left.startWord - right.startWord || left.endWord - right.endWord,
  );
  const ranges: WordRange[] = [];
  for (const range of sorted) {
    const previous = ranges[ranges.length - 1];
    if (previous && range.startWord <= previous.endWord + 1) {
      previous.endWord = Math.max(previous.endWord, range.endWord);
      continue;
    }
    ranges.push({ ...range });
  }
  const removedWords = [...new Set(edit.removedWords)]
    .filter((index) => ranges.some((range) => index >= range.startWord && index <= range.endWord))
    .sort((left, right) => left - right);
  return {
    ranges,
    removedWords,
    tightenPauses: {
      enabled: edit.tightenPauses.enabled,
      maxGapSeconds: clampNumber(edit.tightenPauses.maxGapSeconds, EDIT_LIMITS.minPauseGapSeconds, EDIT_LIMITS.maxPauseGapSeconds),
    },
    speed: clampNumber(edit.speed, EDIT_LIMITS.minSpeed, EDIT_LIMITS.maxSpeed),
    hook: { enabled: edit.hook.enabled, text: edit.hook.text.trim() },
    captions: { enabled: edit.captions.enabled },
    crops: normalizeCrops(edit.crops),
    zoom: { enabled: edit.zoom.enabled, strength: clampNumber(edit.zoom.strength, EDIT_LIMITS.minZoom, EDIT_LIMITS.maxZoom) },
    endCard: { enabled: edit.endCard.enabled },
  };
}

export function keptWordIndices(edit: ShortEdit, wordCount: number): number[] {
  const kept: number[] = [];
  for (let index = 0; index < wordCount; index += 1) {
    if (edit.removedWords.includes(index)) {
      continue;
    }
    if (edit.ranges.some((range) => index >= range.startWord && index <= range.endWord)) {
      kept.push(index);
    }
  }
  return kept;
}

export function keptText(edit: ShortEdit, words: TranscriptWord[]): string {
  return keptWordIndices(edit, words.length)
    .map((index) => words[index]!.text)
    .join(' ');
}

export function addRange(edit: ShortEdit, range: WordRange, wordCount: number): ShortEdit {
  return normalizeEdit({ ...edit, ranges: [...edit.ranges, range] }, wordCount);
}

export function removeRangeAt(edit: ShortEdit, rangeIndex: number, wordCount: number): ShortEdit {
  if (edit.ranges.length === 1) {
    throw new Error('A short needs at least one range');
  }
  return normalizeEdit({ ...edit, ranges: edit.ranges.filter((_, index) => index !== rangeIndex) }, wordCount);
}

export function setRangeBoundary(
  edit: ShortEdit,
  rangeIndex: number,
  side: 'start' | 'end',
  wordIndex: number,
  wordCount: number,
): ShortEdit {
  const range = edit.ranges[rangeIndex]!;
  if (side === 'start' && wordIndex > range.endWord) {
    throw new Error('Range start cannot move past its end');
  }
  if (side === 'end' && wordIndex < range.startWord) {
    throw new Error('Range end cannot move before its start');
  }
  const ranges = edit.ranges.map((current, index) => {
    if (index !== rangeIndex) {
      return current;
    }
    return side === 'start' ? { ...current, startWord: wordIndex } : { ...current, endWord: wordIndex };
  });
  return normalizeEdit({ ...edit, ranges }, wordCount);
}

export function setWordsRemoved(
  edit: ShortEdit,
  fromWord: number,
  toWord: number,
  removed: boolean,
  wordCount: number,
): ShortEdit {
  if (!removed) {
    const removedWords = edit.removedWords.filter((index) => index < fromWord || index > toWord);
    return normalizeEdit({ ...edit, removedWords }, wordCount);
  }
  const removedSet = new Set(edit.removedWords);
  for (let index = fromWord; index <= toWord; index += 1) {
    removedSet.add(index);
  }
  return normalizeEdit({ ...edit, removedWords: [...removedSet] }, wordCount);
}

export function trimStartBySeconds(edit: ShortEdit, words: TranscriptWord[], seconds: number): ShortEdit {
  const range = edit.ranges[0]!;
  const original = range.startWord;
  let startWord = original;
  while (startWord < range.endWord && words[startWord]!.startSeconds - words[original]!.startSeconds < seconds) {
    startWord += 1;
  }
  return normalizeEdit({ ...edit, ranges: [{ ...range, startWord }, ...edit.ranges.slice(1)] }, words.length);
}

export function extendStartBySeconds(edit: ShortEdit, words: TranscriptWord[], seconds: number): ShortEdit {
  const range = edit.ranges[0]!;
  const original = range.startWord;
  let startWord = original;
  while (startWord > 0 && words[original]!.startSeconds - words[startWord]!.startSeconds < seconds) {
    startWord -= 1;
  }
  return normalizeEdit({ ...edit, ranges: [{ ...range, startWord }, ...edit.ranges.slice(1)] }, words.length);
}

export function trimEndBySeconds(edit: ShortEdit, words: TranscriptWord[], seconds: number): ShortEdit {
  const range = edit.ranges[edit.ranges.length - 1]!;
  const original = range.endWord;
  let endWord = original;
  while (endWord > range.startWord && words[original]!.endSeconds - words[endWord]!.endSeconds < seconds) {
    endWord -= 1;
  }
  return normalizeEdit({ ...edit, ranges: [...edit.ranges.slice(0, -1), { ...range, endWord }] }, words.length);
}

export function extendEndBySeconds(edit: ShortEdit, words: TranscriptWord[], seconds: number): ShortEdit {
  const range = edit.ranges[edit.ranges.length - 1]!;
  const original = range.endWord;
  let endWord = original;
  while (endWord < words.length - 1 && words[endWord]!.endSeconds - words[original]!.endSeconds < seconds) {
    endWord += 1;
  }
  return normalizeEdit({ ...edit, ranges: [...edit.ranges.slice(0, -1), { ...range, endWord }] }, words.length);
}

export function upsertCropKeyframe(edit: ShortEdit, keyframe: CropKeyframe): ShortEdit {
  const crops = edit.crops.filter(
    (crop) => Math.abs(crop.sourceSeconds - keyframe.sourceSeconds) > CROP_KEYFRAME_TOLERANCE_SECONDS,
  );
  return { ...edit, crops: normalizeCrops([...crops, keyframe]) };
}

export function removeCropKeyframe(edit: ShortEdit, sourceSeconds: number): ShortEdit {
  const crops = edit.crops.filter(
    (crop) => Math.abs(crop.sourceSeconds - sourceSeconds) > CROP_KEYFRAME_TOLERANCE_SECONDS,
  );
  return { ...edit, crops: normalizeCrops(crops) };
}

export function replaceAutoCrops(edit: ShortEdit, keyframes: CropKeyframe[]): ShortEdit {
  const manual = edit.crops.filter((crop) => crop.origin === 'manual');
  const kept = keyframes.filter(
    (keyframe) => !manual.some((crop) => Math.abs(crop.sourceSeconds - keyframe.sourceSeconds) <= CROP_KEYFRAME_TOLERANCE_SECONDS),
  );
  return { ...edit, crops: normalizeCrops([...kept, ...manual]) };
}

function normalizeCrops(crops: CropKeyframe[]): CropKeyframe[] {
  const sorted = [...crops].sort((left, right) => left.sourceSeconds - right.sourceSeconds);
  const result: CropKeyframe[] = [];
  for (const crop of sorted) {
    const previous = result[result.length - 1];
    if (previous && Math.abs(crop.sourceSeconds - previous.sourceSeconds) <= CROP_KEYFRAME_TOLERANCE_SECONDS) {
      result[result.length - 1] = crop;
      continue;
    }
    result.push(crop);
  }
  return result;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
