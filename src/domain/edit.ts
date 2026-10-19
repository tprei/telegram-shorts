import { z } from 'zod';
import type { Composition, LayoutProfile, NormRect } from './layout.js';
import { hostUsable } from './scene.js';
import type { SceneSegment, SceneTrack, TranscriptWord } from './model.js';

export interface WordRange {
  startWord: number;
  endWord: number;
}

export interface CropKeyframe {
  sourceSeconds: number;
  focus: NormRect;
  origin: 'auto' | 'manual';
}

export interface ShortLayoutEdit {
  split: number | null;
  overrides: { sourceSeconds: number; composition: Composition }[];
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
  layout: ShortLayoutEdit;
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

export const CompositionSchema = z.enum(['stack', 'host', 'content']);

export const ShortLayoutEditSchema = z.strictObject({
  split: z.number().finite().min(0.4).max(0.65).nullable(),
  overrides: z.array(z.strictObject({ sourceSeconds: z.number().finite().nonnegative(), composition: CompositionSchema })),
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
  layout: ShortLayoutEditSchema,
});

const CROP_KEYFRAME_TOLERANCE_SECONDS = 0.05;
const SCENE_EDIT_EPSILON = 1e-6;

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
      endCard: { enabled: true },
      layout: { split: null, overrides: [] },
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
  if (edit.layout.split !== null && (!Number.isFinite(edit.layout.split) || edit.layout.split < 0.4 || edit.layout.split > 0.65)) {
    throw new Error('Layout split must be a finite number between 0.40 and 0.65.');
  }
  for (const override of edit.layout.overrides) {
    if (!Number.isFinite(override.sourceSeconds) || override.sourceSeconds < 0) {
      throw new Error('Layout override times must be finite and non-negative.');
    }
  }
  const sortedOverrides = [...edit.layout.overrides].sort((left, right) => left.sourceSeconds - right.sourceSeconds);
  const overrides: ShortLayoutEdit['overrides'] = [];
  for (const override of sortedOverrides) {
    const previous = overrides[overrides.length - 1];
    if (previous !== undefined && previous.sourceSeconds === override.sourceSeconds) {
      overrides[overrides.length - 1] = override;
      continue;
    }
    overrides.push(override);
  }
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
    layout: { split: edit.layout.split, overrides },
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

function containingSegment(track: SceneTrack, sourceSeconds: number) {
  return track.segments.find(
    (segment) => sourceSeconds >= segment.startSeconds && sourceSeconds < segment.endSeconds,
  );
}

function assertCompositionAllowed(segment: SceneSegment, composition: Composition): void {
  if (composition === 'host' && !hostUsable(segment)) {
    throw new Error('Scene segment has no usable host for a host composition.');
  }
  if (composition === 'content' && segment.content === null) {
    throw new Error('Scene segment has no content for a content composition.');
  }
  if (composition === 'stack' && (segment.content === null || !hostUsable(segment))) {
    throw new Error('Scene segment needs usable host and content for a stack composition.');
  }
}

export function normalizeSceneEdit(edit: ShortEdit, layout: LayoutProfile, track: SceneTrack | null): ShortEdit {
  if (layout.strategy === 'fixed') {
    if (edit.layout.split !== null || edit.layout.overrides.length > 0) {
      throw new Error('Fixed layouts reject scene layout edits.');
    }
    return edit;
  }
  if (track === null) {
    if (edit.crops.length > 0 || edit.layout.overrides.length > 0) {
      throw new Error('Scene layout edits require scene analysis.');
    }
    return edit;
  }
  for (const crop of edit.crops) {
    const segment = containingSegment(track, crop.sourceSeconds);
    if (segment === undefined) {
      throw new Error(`Crop at ${crop.sourceSeconds}s is outside the scene track.`);
    }
    if (segment.content === null) {
      throw new Error(`Crop at ${crop.sourceSeconds}s has no content in its scene segment.`);
    }
    const focus = crop.focus;
    if (focus.x < -SCENE_EDIT_EPSILON || focus.y < -SCENE_EDIT_EPSILON || focus.x + focus.w > 1 + SCENE_EDIT_EPSILON || focus.y + focus.h > 1 + SCENE_EDIT_EPSILON) {
      throw new Error(`Crop focus at ${crop.sourceSeconds}s must stay inside its content box.`);
    }
  }
  const bySegment = new Map<number, Composition>();
  for (const override of edit.layout.overrides) {
    const segment = containingSegment(track, override.sourceSeconds);
    if (segment === undefined) {
      throw new Error(`Layout override at ${override.sourceSeconds}s is outside the scene track.`);
    }
    assertCompositionAllowed(segment, override.composition);
    bySegment.set(segment.startSeconds, override.composition);
  }
  const overrides = [...bySegment.entries()]
    .map(([sourceSeconds, composition]) => ({ sourceSeconds, composition }))
    .sort((left, right) => left.sourceSeconds - right.sourceSeconds);
  return { ...edit, layout: { split: edit.layout.split, overrides } };
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
