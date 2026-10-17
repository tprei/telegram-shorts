import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CropKeyframe } from '../domain/edit.js';
import { normToPx, toEvenPxRect } from '../domain/geometry.js';
import { ContentPanel, HostPanel, NormRect, PxRect } from '../domain/layout.js';
import { CropFocusResponse, CropFocusResponseSchema, TranscriptWord } from '../domain/model.js';
import type { AppConfig } from './env.js';
import { requestStructuredJson } from './openrouter.js';
import { logError } from './util.js';
import { runProcess } from './process.js';

const DEFAULT_SCENE_THRESHOLD = 0.18;
const SAMPLE_MIN_GAP_SECONDS = 2;
const MAX_SAMPLES_PER_SPAN = 8;
const MAX_SAMPLES_TOTAL = 16;
const SAMPLE_LEAD_SECONDS = 0.5;
const VISION_CONCURRENCY = 3;
const VISION_TEMPERATURE = 0.1;
const FRAME_WIDTH = 1280;
const HOST_HEAD_SAMPLE_FRACTIONS = [0.1, 0.3, 0.5, 0.7, 0.9];
const MIN_HOST_HEAD_SAMPLES = 3;
const HOST_HEAD_FRAME_HEIGHT = 720;

const CROP_FOCUS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    box_2d: {
      type: 'array',
      items: { type: 'integer', minimum: 0, maximum: 1000 },
      minItems: 4,
      maxItems: 4,
    },
    reason: { type: 'string', minLength: 1 },
  },
  required: ['box_2d', 'reason'],
  additionalProperties: false,
};

const CROP_FOCUS_SYSTEM_PROMPT = [
  'Você enquadra o conteúdo de um short vertical a partir de um quadro de compartilhamento de tela.',
  'Responda com box_2d: [ymin, xmin, ymax, xmax] em escala 0-1000 relativa à imagem enviada.',
  'A região é o que o espectador precisa ler para acompanhar o que o apresentador está explicando.',
  '- Prefira o texto destacado ou selecionado, o título em evidência, ou o gráfico/imagem sendo comentado.',
  '- Inclua linhas completas; nunca corte palavras.',
  '- Exclua a moldura do navegador, abas, anúncios, barras laterais e margens vazias.',
  '- Prefira uma região de 40-70% da largura da imagem para o texto ficar legível no celular, a menos que o conteúdo precise de mais.',
].join('\n');

const HOST_HEAD_SYSTEM_PROMPT = [
  'Você localiza a cabeça do apresentador principal em um quadro de vídeo.',
  'Responda com box_2d: [ymin, xmin, ymax, xmax] em escala 0-1000 relativa à imagem enviada.',
  'A cabeça vai do topo do cabelo até a base do queixo e de orelha a orelha.',
  '- Exclua pescoço, ombros, microfone e qualquer outro objeto.',
  '- Se houver mais de uma pessoa, escolha o apresentador principal, aquele que está falando para a câmera.',
].join('\n');

const HOST_HEAD_USER_PROMPT = 'Localize a cabeça do apresentador principal neste quadro e responda com o box_2d.';

export function parseShowinfoSceneTimes(stderr: string): number[] {
  return stderr
    .split('\n')
    .filter((line) => line.includes('Parsed_showinfo'))
    .flatMap((line) => {
      const match = /pts_time:(\d+(?:\.\d+)?)/.exec(line);
      return match ? [Number(match[1])] : [];
    });
}

export function selectSpanSamples(spanStart: number, spanEnd: number, sceneTimes: number[]): number[] {
  const candidates = [spanStart, ...sceneTimes.filter((t) => t > spanStart && t < spanEnd)];
  const kept: number[] = [];
  for (const candidate of candidates) {
    if (kept.length >= MAX_SAMPLES_PER_SPAN) {
      break;
    }
    const previous = kept[kept.length - 1];
    if (previous !== undefined && candidate - previous < SAMPLE_MIN_GAP_SECONDS) {
      continue;
    }
    kept.push(candidate);
  }
  return kept;
}

export function distributeSampleBudget(spanSamples: number[][], maxTotal: number): number[][] {
  const result: number[][] = spanSamples.map(() => []);
  let total = 0;
  let remaining = true;
  while (remaining && total < maxTotal) {
    remaining = false;
    for (let index = 0; index < spanSamples.length; index += 1) {
      if (total >= maxTotal) {
        break;
      }
      const source = spanSamples[index];
      const target = result[index];
      if (target.length < source.length) {
        target.push(source[target.length]);
        total += 1;
        remaining = true;
      }
    }
  }
  return result;
}

export function wordsSpokenBetween(words: TranscriptWord[], fromSeconds: number, toSeconds: number): string {
  return words
    .filter((word) => word.startSeconds < toSeconds && word.endSeconds > fromSeconds)
    .map((word) => word.text)
    .join(' ');
}

export function boxToSourceFocus(box: [number, number, number, number], panel: { sourceRect: NormRect }): NormRect {
  const [ymin, xmin, ymax, xmax] = box;
  if (ymin >= ymax || xmin >= xmax) {
    throw new Error(`Invalid crop box [${box.join(', ')}]: expected [ymin, xmin, ymax, xmax] with ymin < ymax and xmin < xmax`);
  }
  const region = panel.sourceRect;
  return {
    x: region.x + (xmin / 1000) * region.w,
    y: region.y + (ymin / 1000) * region.h,
    w: ((xmax - xmin) / 1000) * region.w,
    h: ((ymax - ymin) / 1000) * region.h,
  };
}

export async function detectSceneTimes(input: {
  videoPath: string;
  region: PxRect;
  startSeconds: number;
  endSeconds: number;
  threshold?: number;
}): Promise<number[]> {
  const threshold = input.threshold ?? DEFAULT_SCENE_THRESHOLD;
  const { stderr } = await runProcess('ffmpeg', [
    '-ss', String(input.startSeconds),
    '-to', String(input.endSeconds),
    '-i', input.videoPath,
    '-an',
    '-vf', `crop=${input.region.w}:${input.region.h}:${input.region.x}:${input.region.y},scale=480:-2,select='gt(scene,${threshold})',showinfo`,
    '-f', 'null', '-',
  ]);
  return parseShowinfoSceneTimes(stderr)
    .map((ptsTime) => input.startSeconds + ptsTime)
    .sort((a, b) => a - b);
}

export async function analyzeContentCrops(input: {
  config: AppConfig;
  videoPath: string;
  source: { width: number; height: number };
  panel: ContentPanel;
  spans: Array<{ startSeconds: number; endSeconds: number; text: string }>;
  words: TranscriptWord[];
  workDir: string;
}): Promise<CropKeyframe[]> {
  const region = toEvenPxRect(normToPx(input.panel.sourceRect, input.source.width, input.source.height));
  const cropsDir = join(input.workDir, 'crops');
  await mkdir(cropsDir, { recursive: true });

  const spanSamples: number[][] = [];
  for (const span of input.spans) {
    const sceneTimes = await detectSceneTimes({
      videoPath: input.videoPath,
      region,
      startSeconds: span.startSeconds,
      endSeconds: span.endSeconds,
    });
    spanSamples.push(selectSpanSamples(span.startSeconds, span.endSeconds, sceneTimes));
  }

  const samples: Array<{ sampleSeconds: number; frameSeconds: number; nextSeconds: number; imagePath: string }> = [];
  distributeSampleBudget(spanSamples, MAX_SAMPLES_TOTAL).forEach((capped, spanIndex) => {
    const span = input.spans[spanIndex];
    capped.forEach((sampleSeconds, sampleIndex) => {
      const nextSeconds = sampleIndex + 1 < capped.length ? capped[sampleIndex + 1] : span.endSeconds;
      const frameSeconds = Math.min(sampleSeconds + SAMPLE_LEAD_SECONDS, span.endSeconds - 0.1);
      samples.push({
        sampleSeconds,
        frameSeconds,
        nextSeconds,
        imagePath: join(cropsDir, `${input.panel.id}_${frameSeconds.toFixed(2).replace('.', '_')}.jpg`),
      });
    });
  });

  const keyframes = await runWithConcurrency(samples, VISION_CONCURRENCY, async (sample) => {
    await extractContentFrame({
      videoPath: input.videoPath,
      region,
      frameSeconds: sample.frameSeconds,
      outputPath: sample.imagePath,
    });
    const spokenText = wordsSpokenBetween(input.words, sample.sampleSeconds, sample.nextSeconds);
    const response = await requestStructuredJson<CropFocusResponse>(input.config, {
      title: 'crop_focus',
      system: CROP_FOCUS_SYSTEM_PROMPT,
      userText: `Fala do apresentador neste trecho: "${spokenText}"\nResponda com o box_2d da região que o espectador precisa ler neste quadro.`,
      images: [{ mimeType: 'image/jpeg', base64: await readFile(sample.imagePath, 'base64') }],
      model: input.config.OPENROUTER_VISION_MODEL,
      temperature: VISION_TEMPERATURE,
      responseFormat: { name: 'crop_focus', schema: CROP_FOCUS_JSON_SCHEMA },
      parse: (value: unknown) => CropFocusResponseSchema.parse(value),
    });
    return {
      sourceSeconds: sample.sampleSeconds,
      focus: boxToSourceFocus(response.box_2d, input.panel),
      origin: 'auto' as const,
    };
  });
  return keyframes.sort((a, b) => a.sourceSeconds - b.sourceSeconds);
}

async function extractContentFrame(input: {
  videoPath: string;
  region: PxRect;
  frameSeconds: number;
  outputPath: string;
}): Promise<void> {
  await runProcess('ffmpeg', [
    '-y',
    '-ss', String(input.frameSeconds),
    '-i', input.videoPath,
    '-frames:v', '1',
    '-vf', `crop=${input.region.w}:${input.region.h}:${input.region.x}:${input.region.y},scale=${FRAME_WIDTH}:-2`,
    '-q:v', '3',
    input.outputPath,
  ]);
}

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

export function hostHeadSampleTimes(durationSeconds: number): number[] {
  return HOST_HEAD_SAMPLE_FRACTIONS.map((fraction) => fraction * durationSeconds);
}

export function medianValue(values: number[]): number {
  if (values.length === 0) {
    throw new Error('Cannot take the median of an empty list.');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function medianHeadBox(boxes: NormRect[]): NormRect {
  const left = medianValue(boxes.map((box) => box.x));
  const top = medianValue(boxes.map((box) => box.y));
  const right = medianValue(boxes.map((box) => box.x + box.w));
  const bottom = medianValue(boxes.map((box) => box.y + box.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export async function detectHostHead(input: {
  config: AppConfig;
  videoPath: string;
  source: { width: number; height: number };
  panel: HostPanel;
  durationSeconds: number;
  workDir: string;
}): Promise<NormRect> {
  const region = toEvenPxRect(normToPx(input.panel.sourceRect, input.source.width, input.source.height));
  const framesDir = join(input.workDir, 'host-head');
  await mkdir(framesDir, { recursive: true });
  const frames: Array<{ mimeType: 'image/jpeg'; base64: string }> = [];
  for (const frameSeconds of hostHeadSampleTimes(input.durationSeconds)) {
    const outputPath = join(framesDir, `host_head_${frameSeconds.toFixed(2).replace('.', '_')}.jpg`);
    await extractHostHeadFrame({ videoPath: input.videoPath, region, frameSeconds, outputPath });
    frames.push({ mimeType: 'image/jpeg', base64: await readFile(outputPath, 'base64') });
  }
  return hostHeadBoxFromFrames(input.config, frames, input.panel);
}

export async function hostHeadBoxFromFrames(
  config: AppConfig,
  frames: Array<{ mimeType: 'image/jpeg' | 'image/png'; base64: string }>,
  panel: { sourceRect: NormRect },
): Promise<NormRect> {
  const outcomes = await runWithConcurrency(frames, VISION_CONCURRENCY, async (frame): Promise<{ box: NormRect } | { error: unknown }> => {
    try {
      const response = await requestStructuredJson<CropFocusResponse>(config, {
        title: 'host_head',
        system: HOST_HEAD_SYSTEM_PROMPT,
        userText: HOST_HEAD_USER_PROMPT,
        images: [frame],
        model: config.OPENROUTER_VISION_MODEL,
        temperature: VISION_TEMPERATURE,
        responseFormat: { name: 'crop_focus', schema: CROP_FOCUS_JSON_SCHEMA },
        parse: (value: unknown) => CropFocusResponseSchema.parse(value),
      });
      return { box: boxToSourceFocus(response.box_2d, panel) };
    } catch (error) {
      logError('Host head detection sample failed', error);
      return { error };
    }
  });
  const boxes: NormRect[] = [];
  let lastError: unknown = null;
  for (const outcome of outcomes) {
    if ('box' in outcome) {
      boxes.push(outcome.box);
    } else {
      lastError = outcome.error;
    }
  }
  if (boxes.length < MIN_HOST_HEAD_SAMPLES) {
    throw new Error(`Host head detection succeeded on only ${boxes.length} of ${frames.length} frames; need at least ${MIN_HOST_HEAD_SAMPLES}.`, { cause: lastError });
  }
  return medianHeadBox(boxes);
}

async function extractHostHeadFrame(input: {
  videoPath: string;
  region: PxRect;
  frameSeconds: number;
  outputPath: string;
}): Promise<void> {
  await runProcess('ffmpeg', [
    '-y',
    '-ss', String(input.frameSeconds),
    '-i', input.videoPath,
    '-frames:v', '1',
    '-vf', `crop=${input.region.w}:${input.region.h}:${input.region.x}:${input.region.y},scale=-2:${HOST_HEAD_FRAME_HEIGHT}`,
    '-q:v', '3',
    input.outputPath,
  ]);
}
