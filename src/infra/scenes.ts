import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import sharp from 'sharp';
import { z } from 'zod';

import { normToPx, toEvenPxRect } from '../domain/geometry.js';
import type { NormRect } from '../domain/layout.js';
import type { CreatorSceneConfig, SceneSegment, SceneTrack, SourceMedia } from '../domain/model.js';
import {
  buildSceneSegments,
  buildSceneShots,
  CAMERA_CLUSTER_IOU,
  CAMERA_EDGE_MAX_FRAMES,
  clusterCameras,
  evenlySpacedMemberIndices,
  isFullFrameCamera,
  rectContains,
  rectIoU,
  refineCameraEdges,
  SCENE_EPSILON,
  sceneSampleTimes,
  sceneSignature,
  smoothSceneHeads,
  snapCameraClusters,
} from '../domain/scene.js';
import type { CameraCluster, ClusteredObservation, GreyFrame, SceneObservation, SceneShot } from '../domain/scene.js';
import type { AppConfig } from './env.js';
import { requestStructuredJson } from './openrouter.js';
import { runProcess } from './process.js';
import { logError, nowIso } from './util.js';

export const SCENE_DETECT_FPS = 5;
export const SCENE_DETECT_WIDTH = 256;
export const SCENE_DETECT_THRESHOLD = 10;
export const SCENE_CUT_REFINE_SECONDS = 0.4;
export const SCENE_FRAME_WIDTH = 1280;
export const SCENE_VISION_CONCURRENCY = 6;
export const SCENE_VISION_TEMPERATURE = 0.1;
export const SCENE_SCAN_TIMEOUT_MS = 30 * 60_000;
export const SCENE_REFINE_TIMEOUT_MS = 120_000;
export const SCENE_EXTRACT_TIMEOUT_MS = 60_000;
export const SCENE_VISION_TIMEOUT_MS = 90_000;
const SCENE_CAMERA_THRESHOLD = 15;
const SCENE_CHANGE_MARGIN_SECONDS = 1;
const SCENE_CHANGE_SAMPLE_DELAY_SECONDS = 0.4;
const SCENE_CONTENT_VERTICAL_RATIO = 0.7;
const SCENE_FRAME_DIFF_THRESHOLD = 0.1;
const SCENE_DIFF_THUMB_WIDTH = 64;
const SCENE_DIFF_THUMB_HEIGHT = 36;
const SCENE_CAMERA_MIN_SIDE_PX = 64;
const SCENE_CAMERA_CANDIDATE_LIMIT = 32;

export interface ScdetScore {
  sourceSeconds: number;
  score: number;
}

const SCENE_SYSTEM_PROMPT = [
  'Você analisa um quadro de um vídeo horizontal de comentários do YouTube para recompor um short vertical 9:16.',
  'Todas as caixas são box_2d: [ymin, xmin, ymax, xmax], inteiros de 0 a 1000 relativos à imagem inteira.',
  'Identifique o apresentador descrito pelo usuário, não um convidado, jornalista ou pessoa no material exibido.',
  'host_camera_box: limites exatos da câmera do apresentador, incluindo todo o inset ou painel lateral. Se a câmera ocupa o quadro inteiro, use [0,0,1000,1000]. Se ausente, host_visible=false e ambas as caixas do apresentador [0,0,0,0].',
  'host_head_box: do topo do cabelo à base do queixo, de orelha a orelha; exclua pescoço, ombros e microfone. Deve ficar dentro da câmera.',
  'content_box: limites do material principal além da câmera: artigo, postagem, gráfico, slide, tabela, foto, vídeo, reportagem ou janela de chamada de um convidado. Exclua margens vazias ou desfocadas, barras pretas, chat, QR codes, logotipos e faixas.',
  'content_kind: document para texto, artigos, postagens, slides, gráficos ou tabelas; person quando o material é principalmente uma pessoa falando; footage para os demais vídeos e fotos; none quando não há conteúdo.',
  'subject_box: dentro do conteúdo, a região que precisa aparecer: cabeça e ombros de quem fala, manchete, texto destacado ou evidência visual principal. Não confunda com a cabeça do apresentador.',
  'Se não houver conteúdo, use content_visible=false, content_kind=none e content_box/subject_box=[0,0,0,0].',
  'overlay_boxes: caixas exatas de chat, QR codes, logotipos, inscrições, faixas, rodapés e intérpretes de Libras. Não inclua a câmera do apresentador nesta lista.',
  'reason: justificativa curta em português. Retorne somente o objeto JSON solicitado.',
].join('\n');

const BoxSchema = z.tuple([
  z.number().int().min(0).max(1000),
  z.number().int().min(0).max(1000),
  z.number().int().min(0).max(1000),
  z.number().int().min(0).max(1000),
]);

const visibleBox = (b: [number, number, number, number]): boolean => b[0] < b[2] && b[1] < b[3];
const zeroBox = (b: [number, number, number, number]): boolean => b.every((v) => v === 0);

export const SceneVisionResponseSchema = z.strictObject({
  host_visible: z.boolean(),
  host_camera_box: BoxSchema,
  host_head_box: BoxSchema,
  content_visible: z.boolean(),
  content_box: BoxSchema,
  content_kind: z.enum(['document', 'footage', 'person', 'none']),
  subject_box: BoxSchema,
  overlay_boxes: z.array(BoxSchema),
  reason: z.string().min(1),
})
  .refine((r) => (r.host_visible ? visibleBox(r.host_camera_box) && visibleBox(r.host_head_box) : zeroBox(r.host_camera_box) && zeroBox(r.host_head_box)), { message: 'Invalid host boxes' })
  .refine((r) => (r.content_visible ? r.content_kind !== 'none' && visibleBox(r.content_box) && visibleBox(r.subject_box) : r.content_kind === 'none' && zeroBox(r.content_box) && zeroBox(r.subject_box)), { message: 'Invalid content boxes' })
  .refine((r) => r.overlay_boxes.every(visibleBox), { message: 'Invalid overlay box' })
  .refine((r) => r.host_visible || r.content_visible, { message: 'No usable visual material' });

export type SceneVisionResponse = z.infer<typeof SceneVisionResponseSchema>;

const BOX_JSON = { type: 'array', items: { type: 'integer', minimum: 0, maximum: 1000 }, minItems: 4, maxItems: 4 };

export const SCENE_VISION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    host_visible: { type: 'boolean' },
    host_camera_box: BOX_JSON,
    host_head_box: BOX_JSON,
    content_visible: { type: 'boolean' },
    content_box: BOX_JSON,
    content_kind: { type: 'string', enum: ['document', 'footage', 'person', 'none'] },
    subject_box: BOX_JSON,
    overlay_boxes: { type: 'array', items: BOX_JSON },
    reason: { type: 'string' },
  },
  required: ['host_visible', 'host_camera_box', 'host_head_box', 'content_visible', 'content_box', 'content_kind', 'subject_box', 'overlay_boxes', 'reason'],
};

const SCDET_SCORE_LINE = /lavfi\.scd\.score=([0-9.]+)/;
const SCDET_TIME_LINE = /pts_time:(\d+(?:\.\d+)?)/;

const scdetFilter = `scdet=threshold=${SCENE_DETECT_THRESHOLD},metadata=mode=print:key=lavfi.scd.score`;

export function parseScdetScores(text: string, offsetSeconds: number): ScdetScore[] {
  const scores: ScdetScore[] = [];
  let currentSeconds: number | null = null;
  for (const line of text.split('\n')) {
    const time = SCDET_TIME_LINE.exec(line);
    if (time !== null) {
      currentSeconds = Number(time[1]);
    }
    const score = SCDET_SCORE_LINE.exec(line);
    if (score !== null && currentSeconds !== null) {
      scores.push({ sourceSeconds: offsetSeconds + currentSeconds, score: Number(score[1]) });
      currentSeconds = null;
    }
  }
  return scores;
}

function roundToFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps) / fps;
}

function peakScore(scores: readonly ScdetScore[], referenceSeconds: number): ScdetScore | null {
  let best: ScdetScore | null = null;
  for (const score of scores) {
    if (best === null || score.score > best.score) {
      best = score;
      continue;
    }
    if (score.score < best.score) {
      continue;
    }
    const bestDistance = Math.abs(best.sourceSeconds - referenceSeconds);
    const distance = Math.abs(score.sourceSeconds - referenceSeconds);
    if (distance < bestDistance || (distance === bestDistance && score.sourceSeconds < best.sourceSeconds)) {
      best = score;
    }
  }
  return best;
}

export async function detectShotCuts(input: { videoPath: string; durationSeconds: number; fps: number }): Promise<number[]> {
  const { stderr } = await runProcess('ffmpeg', [
    '-nostdin', '-hide_banner', '-v', 'info',
    '-i', input.videoPath,
    '-an',
    '-vf', `fps=${SCENE_DETECT_FPS},scale=${SCENE_DETECT_WIDTH}:-2,scdet=threshold=${SCENE_DETECT_THRESHOLD},metadata=mode=print:key=lavfi.scd.score`,
    '-f', 'null', '-',
  ], { timeoutMs: SCENE_SCAN_TIMEOUT_MS });
  const coarse = parseScdetScores(stderr, 0)
    .filter((score) => score.score >= SCENE_DETECT_THRESHOLD)
    .map((score) => score.sourceSeconds);
  const refined = await runWithConcurrency(coarse, 2, (candidateSeconds) =>
    refineShotCut({
      videoPath: input.videoPath,
      candidateSeconds,
      durationSeconds: input.durationSeconds,
      fps: input.fps,
    }));
  return [...new Set(refined)].sort((a, b) => a - b);
}

export async function refineShotCut(input: { videoPath: string; candidateSeconds: number; durationSeconds: number; fps: number }): Promise<number> {
  const start = Math.max(0, input.candidateSeconds - SCENE_CUT_REFINE_SECONDS);
  const end = Math.min(input.durationSeconds, input.candidateSeconds + SCENE_CUT_REFINE_SECONDS);
  const { stderr } = await runProcess('ffmpeg', [
    '-nostdin', '-hide_banner', '-v', 'info',
    '-ss', String(start), '-to', String(end),
    '-i', input.videoPath,
    '-an',
    '-vf', `scale=${SCENE_DETECT_WIDTH}:-2,${scdetFilter}`,
    '-f', 'null', '-',
  ], { timeoutMs: SCENE_REFINE_TIMEOUT_MS });
  const candidates = parseScdetScores(stderr, start).filter((score) => score.score >= SCENE_DETECT_THRESHOLD);
  const peak = peakScore(candidates, input.candidateSeconds);
  return roundToFrame(peak === null ? input.candidateSeconds : peak.sourceSeconds, input.fps);
}

export async function locateInShotChange(input: {
  videoPath: string;
  fromSeconds: number;
  toSeconds: number;
  camera: NormRect;
  source: { width: number; height: number };
  fps: number;
}): Promise<number | null> {
  const region = toEvenPxRect(normToPx(input.camera, input.source.width, input.source.height));
  const { stderr } = await runProcess('ffmpeg', [
    '-nostdin', '-hide_banner', '-v', 'info',
    '-ss', String(input.fromSeconds), '-to', String(input.toSeconds),
    '-i', input.videoPath,
    '-an',
    '-vf', `crop=${region.w}:${region.h}:${region.x}:${region.y},scale='min(${SCENE_DETECT_WIDTH},iw)':-2,${scdetFilter}`,
    '-f', 'null', '-',
  ], { timeoutMs: SCENE_REFINE_TIMEOUT_MS });
  const midpoint = (input.fromSeconds + input.toSeconds) / 2;
  const scores = parseScdetScores(stderr, input.fromSeconds).filter((score) =>
    score.score >= SCENE_DETECT_THRESHOLD
    && score.sourceSeconds > input.fromSeconds
    && score.sourceSeconds < input.toSeconds);
  const peak = peakScore(scores, midpoint);
  if (peak === null) {
    return null;
  }
  const seconds = roundToFrame(peak.sourceSeconds, input.fps);
  return seconds > input.fromSeconds && seconds < input.toSeconds ? seconds : null;
}

export type AnalyzeScenesFunction = typeof analyzeScenes;

type SampleOutcome = { observation: SceneObservation; imagePath: string } | { error: unknown };

interface SceneSample {
  shotIndex: number;
  imagePath: string;
  observation: ClusteredObservation;
}

interface CameraRegistry {
  cameras: Map<number, NormRect>;
  nextClusterId: number;
}

interface CameraCandidate {
  shotIndex: number;
  peakSeconds: number;
  sampleSeconds: number;
}

interface DisagreementPair {
  left: SceneSample;
  right: SceneSample;
  midpoint: SceneSample | null;
}

export async function analyzeScenes(input: {
  config: AppConfig;
  media: SourceMedia;
  scene: CreatorSceneConfig;
  workDir: string;
}): Promise<SceneTrack> {
  const { config, media, scene } = input;
  const cuts = await detectShotCuts({
    videoPath: media.videoPath,
    durationSeconds: media.durationSeconds,
    fps: media.fps,
  });
  const shots = buildSceneShots(cuts, media.durationSeconds, media.fps);
  const framesDir = join(input.workDir, 'scenes');
  await mkdir(framesDir, { recursive: true });

  const scheduled = shots.flatMap((shot, shotIndex) => sceneSampleTimes(shot).map((seconds) => ({ shotIndex, seconds })));
  const scheduledOutcomes = await observeSamples({
    config,
    scene,
    media,
    framesDir,
    firstIndex: 0,
    seconds: scheduled.map((sample) => sample.seconds),
  });
  const successful: Array<{ shotIndex: number; imagePath: string; observation: SceneObservation }> = [];
  let lastError: unknown = null;
  for (const [index, outcome] of scheduledOutcomes.entries()) {
    if ('error' in outcome) {
      lastError = outcome.error;
      continue;
    }
    successful.push({ shotIndex: scheduled[index]!.shotIndex, imagePath: outcome.imagePath, observation: outcome.observation });
  }
  if (successful.length * 2 < scheduled.length) {
    throw new Error(`Scene analysis succeeded on ${successful.length} of ${scheduled.length} samples; at least 50% are required.`, { cause: lastError });
  }

  const clustered = clusterCameras(successful.map((sample) => sample.observation));
  const cameras = await refineClusterCameras(clustered.clusters, successful.map((sample) => sample.imagePath));
  const snapped = snapCameraClusters(clustered.observations, cameras);
  const registry: CameraRegistry = { cameras, nextClusterId: clustered.clusters.length };
  const samples: SceneSample[] = successful.map((sample, index) => ({
    shotIndex: sample.shotIndex,
    imagePath: sample.imagePath,
    observation: snapped[index]!,
  }));

  const peaks: ScdetScore[] = [];
  for (const [clusterId, camera] of cameras) {
    peaks.push(...(await scanCameraChanges({ videoPath: media.videoPath, media, camera, framesDir, clusterId })));
  }
  const candidates = selectCameraCandidates({
    peaks,
    shots,
    takenSeconds: samples.map((sample) => sample.observation.sourceSeconds),
  });
  const cameraOutcomes = await observeSamples({
    config,
    scene,
    media,
    framesDir,
    firstIndex: scheduled.length,
    seconds: candidates.map((candidate) => candidate.sampleSeconds),
  });
  const changes: Array<{ shotIndex: number; sourceSeconds: number }> = [];
  for (const [index, outcome] of cameraOutcomes.entries()) {
    if ('error' in outcome) {
      continue;
    }
    const candidate = candidates[index]!;
    samples.push(await attachSample(registry, { shotIndex: candidate.shotIndex, imagePath: outcome.imagePath, observation: outcome.observation }));
    changes.push({ shotIndex: candidate.shotIndex, sourceSeconds: candidate.peakSeconds });
  }

  samples.sort(bySourceSeconds);
  const pairs = pairsNeedingChange(samples, changes);
  const located = await runWithConcurrency(pairs, 2, async (pair) => ({
    pair,
    seconds: await locateInShotChange({
      videoPath: media.videoPath,
      fromSeconds: pair.left.observation.sourceSeconds,
      toSeconds: pair.right.observation.sourceSeconds,
      camera: cameraUnion(pair.left.observation.host?.camera ?? null, pair.right.observation.host?.camera ?? null),
      source: { width: media.width, height: media.height },
      fps: media.fps,
    }),
  }));
  const unlocated: Array<{ left: SceneSample; right: SceneSample }> = [];
  for (const { pair, seconds } of located) {
    if (seconds === null) {
      unlocated.push(pair);
    } else {
      changes.push({ shotIndex: pair.right.shotIndex, sourceSeconds: seconds });
    }
  }
  const differences = await runWithConcurrency(unlocated, 2, (pair) => frameDifference(pair.left.imagePath, pair.right.imagePath));
  const disagreements: DisagreementPair[] = [];
  for (const [index, pair] of unlocated.entries()) {
    if (differences[index]! >= SCENE_FRAME_DIFF_THRESHOLD) {
      changes.push(midpointChange(pair.left, pair.right, media.fps));
    } else {
      disagreements.push({ left: pair.left, right: pair.right, midpoint: null });
    }
  }
  const midpointOutcomes = await observeSamples({
    config,
    scene,
    media,
    framesDir,
    firstIndex: scheduled.length + candidates.length,
    seconds: disagreements.map((pair) => (pair.left.observation.sourceSeconds + pair.right.observation.sourceSeconds) / 2),
  });
  for (const [index, outcome] of midpointOutcomes.entries()) {
    if ('error' in outcome) {
      continue;
    }
    const disagreement = disagreements[index]!;
    const midpoint = await attachSample(registry, { shotIndex: disagreement.left.shotIndex, imagePath: outcome.imagePath, observation: outcome.observation });
    disagreement.midpoint = midpoint;
    samples.push(midpoint);
  }

  const removed = new Set<SceneSample>();
  for (const { left, right, midpoint } of disagreements) {
    if (midpoint === null) {
      removed.add(right);
    } else if (sceneSignature(midpoint.observation) === sceneSignature(left.observation)) {
      removed.add(right);
    } else if (sceneSignature(midpoint.observation) === sceneSignature(right.observation)) {
      removed.add(left);
    } else {
      removed.add(midpoint);
      removed.add(right);
    }
  }
  const timeline = samples
    .filter((sample) => !removed.has(sample))
    .sort(bySourceSeconds);
  for (const { left, right } of pairsNeedingChange(timeline, changes)) {
    changes.push(midpointChange(left, right, media.fps));
  }
  const sceneChanges = changes.map((change) => {
    const rightObservationIndex = timeline.findIndex((sample) =>
      sample.shotIndex === change.shotIndex && sample.observation.sourceSeconds >= change.sourceSeconds);
    if (rightObservationIndex < 0) {
      throw new Error(`Scene change at ${change.sourceSeconds}s has no retained observation after it in its shot.`);
    }
    return { shotIndex: change.shotIndex, sourceSeconds: change.sourceSeconds, rightObservationIndex };
  });
  const segments = smoothSceneHeads(buildSceneSegments(shots, timeline.map((sample) => sample.observation), sceneChanges));
  const track: SceneTrack = {
    version: 1,
    analyzedAt: nowIso(),
    frame: { width: media.width, height: media.height },
    segments,
  };
  assertTrackPostconditions(track, media);
  return track;
}

async function observeSamples(input: {
  config: AppConfig;
  scene: CreatorSceneConfig;
  media: SourceMedia;
  framesDir: string;
  firstIndex: number;
  seconds: readonly number[];
}): Promise<SampleOutcome[]> {
  const frames = await runWithConcurrency(input.seconds, 2, async (seconds, index): Promise<{ imagePath: string } | { error: unknown }> => {
    const imagePath = join(input.framesDir, `${input.firstIndex + index}_${Math.round(seconds * 1000)}.jpg`);
    try {
      await extractSceneFrame({ videoPath: input.media.videoPath, seconds, outputPath: imagePath });
      return { imagePath };
    } catch (error) {
      logError('Scene frame extraction failed', error, { seconds });
      return { error };
    }
  });
  return runWithConcurrency(input.seconds, SCENE_VISION_CONCURRENCY, async (seconds, index): Promise<SampleOutcome> => {
    const frame = frames[index]!;
    if ('error' in frame) {
      return frame;
    }
    try {
      const response = await requestSceneVision(input.config, input.scene, frame.imagePath);
      return { observation: observationFromResponse(seconds, response, input.media), imagePath: frame.imagePath };
    } catch (error) {
      logError('Scene sample failed', error, { seconds });
      return { error };
    }
  });
}

function selectCameraCandidates(input: {
  peaks: readonly ScdetScore[];
  shots: readonly SceneShot[];
  takenSeconds: readonly number[];
}): CameraCandidate[] {
  const taken = [...input.takenSeconds];
  const candidates: CameraCandidate[] = [];
  const strongestFirst = [...input.peaks].sort((left, right) => right.score - left.score || left.sourceSeconds - right.sourceSeconds);
  for (const { sourceSeconds: peakSeconds } of strongestFirst) {
    if (candidates.length === SCENE_CAMERA_CANDIDATE_LIMIT) {
      break;
    }
    const shotIndex = input.shots.findIndex((shot) =>
      peakSeconds - shot.startSeconds > SCENE_CHANGE_MARGIN_SECONDS
      && shot.endSeconds - peakSeconds > SCENE_CHANGE_MARGIN_SECONDS);
    if (shotIndex < 0 || taken.some((seconds) => Math.abs(seconds - peakSeconds) <= SCENE_CHANGE_MARGIN_SECONDS)) {
      continue;
    }
    const sampleSeconds = peakSeconds + SCENE_CHANGE_SAMPLE_DELAY_SECONDS;
    candidates.push({ shotIndex, peakSeconds, sampleSeconds });
    taken.push(sampleSeconds);
  }
  return candidates;
}

async function scanCameraChanges(input: {
  videoPath: string;
  media: SourceMedia;
  camera: NormRect;
  framesDir: string;
  clusterId: number;
}): Promise<ScdetScore[]> {
  const region = toEvenPxRect(normToPx(input.camera, input.media.width, input.media.height));
  if (Math.min(region.w, region.h) < SCENE_CAMERA_MIN_SIDE_PX) {
    return [];
  }
  const fileName = `camera-${input.clusterId}.txt`;
  await runProcess('ffmpeg', [
    '-nostdin', '-hide_banner', '-v', 'error',
    '-i', resolve(input.videoPath),
    '-an',
    '-vf', `fps=${SCENE_DETECT_FPS},crop=${region.w}:${region.h}:${region.x}:${region.y},scale='min(${SCENE_DETECT_WIDTH},iw)':-2,scdet=threshold=${SCENE_CAMERA_THRESHOLD},metadata=mode=print:file=${fileName}:key=lavfi.scd.score`,
    '-f', 'null', '-',
  ], { cwd: input.framesDir, timeoutMs: SCENE_SCAN_TIMEOUT_MS });
  const scores = parseScdetScores(await readFile(join(input.framesDir, fileName), 'utf8'), 0);
  return scorePeaks(scores, SCENE_CAMERA_THRESHOLD, input.media.fps);
}

function scorePeaks(scores: readonly ScdetScore[], threshold: number, fps: number): ScdetScore[] {
  const peaks: ScdetScore[] = [];
  let run: ScdetScore | null = null;
  for (const score of scores) {
    if (score.score >= threshold) {
      if (run === null || score.score > run.score) {
        run = score;
      }
      continue;
    }
    if (run !== null) {
      peaks.push({ sourceSeconds: roundToFrame(run.sourceSeconds, fps), score: run.score });
      run = null;
    }
  }
  if (run !== null) {
    peaks.push({ sourceSeconds: roundToFrame(run.sourceSeconds, fps), score: run.score });
  }
  return peaks;
}

async function refineClusterCameras(clusters: readonly CameraCluster[], imagePaths: readonly string[]): Promise<Map<number, NormRect>> {
  const cameras = new Map<number, NormRect>();
  for (const cluster of clusters) {
    if (isFullFrameCamera(cluster.camera)) {
      continue;
    }
    const frames: GreyFrame[] = [];
    for (const memberIndex of evenlySpacedMemberIndices(cluster.memberIndices, CAMERA_EDGE_MAX_FRAMES)) {
      frames.push(await decodeGreyFrame(imagePaths[memberIndex]!));
    }
    for (const frame of frames) {
      if (frame.width !== frames[0]!.width || frame.height !== frames[0]!.height) {
        throw new Error('Frames within a cluster must have equal dimensions.');
      }
    }
    cameras.set(cluster.id, refineCameraEdges(cluster.camera, frames));
  }
  return cameras;
}

async function attachSample(registry: CameraRegistry, sample: { shotIndex: number; imagePath: string; observation: SceneObservation }): Promise<SceneSample> {
  const cameraClusterId = await cameraClusterIdFor(registry, sample);
  const observation = snapCameraClusters([{ ...sample.observation, cameraClusterId }], registry.cameras)[0]!;
  return { shotIndex: sample.shotIndex, imagePath: sample.imagePath, observation };
}

async function cameraClusterIdFor(registry: CameraRegistry, sample: { imagePath: string; observation: SceneObservation }): Promise<number | null> {
  const host = sample.observation.host;
  if (host === null) {
    return null;
  }
  if (isFullFrameCamera(host.camera)) {
    return -1;
  }
  for (const [clusterId, camera] of registry.cameras) {
    if (rectIoU(camera, host.camera) >= CAMERA_CLUSTER_IOU) {
      return clusterId;
    }
  }
  const clusterId = registry.nextClusterId;
  registry.nextClusterId += 1;
  registry.cameras.set(clusterId, refineCameraEdges(host.camera, [await decodeGreyFrame(sample.imagePath)]));
  return clusterId;
}

function bySourceSeconds(left: SceneSample, right: SceneSample): number {
  return left.observation.sourceSeconds - right.observation.sourceSeconds;
}

function pairsNeedingChange(samples: readonly SceneSample[], changes: readonly { sourceSeconds: number }[]): Array<{ left: SceneSample; right: SceneSample }> {
  const pairs: Array<{ left: SceneSample; right: SceneSample }> = [];
  for (let index = 1; index < samples.length; index += 1) {
    const left = samples[index - 1]!;
    const right = samples[index]!;
    if (left.shotIndex !== right.shotIndex || sceneSignature(left.observation) === sceneSignature(right.observation)) {
      continue;
    }
    const crossedByChange = changes.some((change) =>
      change.sourceSeconds > left.observation.sourceSeconds && change.sourceSeconds <= right.observation.sourceSeconds);
    if (!crossedByChange) {
      pairs.push({ left, right });
    }
  }
  return pairs;
}

function midpointChange(left: SceneSample, right: SceneSample, fps: number): { shotIndex: number; sourceSeconds: number } {
  return {
    shotIndex: right.shotIndex,
    sourceSeconds: roundToFrame((left.observation.sourceSeconds + right.observation.sourceSeconds) / 2, fps),
  };
}

async function requestSceneVision(config: AppConfig, scene: CreatorSceneConfig, imagePath: string): Promise<SceneVisionResponse> {
  return requestStructuredJson<SceneVisionResponse>(config, {
    title: 'scene_layout',
    system: SCENE_SYSTEM_PROMPT,
    userText: `Apresentador deste canal: ${scene.hostDescription}\nOrientações adicionais: ${scene.hints === null ? 'Nenhuma.' : scene.hints}\nAnalise este quadro.`,
    images: [{ mimeType: 'image/jpeg', base64: await readFile(imagePath, 'base64') }],
    model: config.OPENROUTER_VISION_MODEL,
    temperature: SCENE_VISION_TEMPERATURE,
    responseFormat: { name: 'scene_layout', schema: SCENE_VISION_JSON_SCHEMA },
    parse: (value: unknown) => SceneVisionResponseSchema.parse(value),
    signal: AbortSignal.timeout(SCENE_VISION_TIMEOUT_MS),
  });
}

async function extractSceneFrame(input: { videoPath: string; seconds: number; outputPath: string }): Promise<void> {
  await runProcess('ffmpeg', [
    '-y', '-nostdin',
    '-ss', String(input.seconds),
    '-i', input.videoPath,
    '-frames:v', '1',
    '-vf', `scale=${SCENE_FRAME_WIDTH}:-2`,
    '-q:v', '3',
    input.outputPath,
  ], { timeoutMs: SCENE_EXTRACT_TIMEOUT_MS });
}

async function decodeGreyFrame(imagePath: string): Promise<GreyFrame> {
  const { data, info } = await sharp(imagePath).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 1) {
    throw new Error(`Expected single-channel greyscale pixels in ${imagePath}, got ${info.channels} channels.`);
  }
  return { width: info.width, height: info.height, data };
}

async function frameDifference(leftPath: string, rightPath: string): Promise<number> {
  const [left, right] = await Promise.all([diffThumbnail(leftPath), diffThumbnail(rightPath)]);
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += Math.abs(left[index]! - right[index]!);
  }
  return total / (left.length * 255);
}

function diffThumbnail(imagePath: string): Promise<Buffer> {
  return sharp(imagePath).greyscale().resize(SCENE_DIFF_THUMB_WIDTH, SCENE_DIFF_THUMB_HEIGHT, { fit: 'fill' }).raw().toBuffer();
}

function observationFromResponse(sourceSeconds: number, response: SceneVisionResponse, media: SourceMedia): SceneObservation {
  const host = response.host_visible
    ? { camera: visionBoxToRect(response.host_camera_box), head: visionBoxToRect(response.host_head_box) }
    : null;
  const contentBox = visionBoxToRect(response.content_box);
  const content = response.content_visible && response.content_kind !== 'none'
    ? {
      box: contentBox,
      kind: response.content_kind,
      vertical: contentBox.w * media.width < SCENE_CONTENT_VERTICAL_RATIO * contentBox.h * media.height,
      subject: visionBoxToRect(response.subject_box),
    }
    : null;
  if (host !== null && !rectContains(host.camera, host.head)) {
    throw new Error('Model placed the host head box outside the host camera box.');
  }
  if (content !== null && !rectContains(content.box, content.subject)) {
    throw new Error('Model placed the content subject box outside the content box.');
  }
  return { sourceSeconds, host, content, overlays: response.overlay_boxes.map((box) => visionBoxToRect(box)) };
}

function visionBoxToRect(box: [number, number, number, number]): NormRect {
  const [ymin, xmin, ymax, xmax] = box;
  return { x: xmin / 1000, y: ymin / 1000, w: (xmax - xmin) / 1000, h: (ymax - ymin) / 1000 };
}

function cameraUnion(a: NormRect | null, b: NormRect | null): NormRect {
  if (a === null) {
    return b ?? { x: 0, y: 0, w: 1, h: 1 };
  }
  if (b === null) {
    return a;
  }
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

function assertTrackPostconditions(track: SceneTrack, media: SourceMedia): void {
  if (track.frame.width !== media.width || track.frame.height !== media.height) {
    throw new Error(`Scene track frame ${track.frame.width}x${track.frame.height} does not match media ${media.width}x${media.height}.`);
  }
  if (track.segments.length === 0) {
    throw new Error('Scene track has no segments.');
  }
  if (track.segments[0]!.startSeconds !== 0 || track.segments[track.segments.length - 1]!.endSeconds !== media.durationSeconds) {
    throw new Error('Scene track must start at zero and end at the source duration.');
  }
  let previousEnd: number | null = null;
  for (const segment of track.segments) {
    assertSegmentPostconditions(segment, previousEnd);
    previousEnd = segment.endSeconds;
  }
}

function assertSegmentPostconditions(segment: SceneSegment, previousEnd: number | null): void {
  const range = `[${segment.startSeconds}, ${segment.endSeconds})`;
  if (!(segment.endSeconds > segment.startSeconds)) {
    throw new Error(`Scene segment ${range} is empty.`);
  }
  if (previousEnd !== null && Math.abs(segment.startSeconds - previousEnd) > SCENE_EPSILON) {
    throw new Error(`Scene segment ${range} is not adjacent to the previous segment ending at ${previousEnd}.`);
  }
  if (segment.host === null && segment.content === null) {
    throw new Error(`Scene segment ${range} has neither host nor content.`);
  }
  if (segment.host !== null && !rectContains(segment.host.camera, segment.host.head)) {
    throw new Error(`Scene segment ${range} has a host head outside its camera.`);
  }
  if (segment.content !== null && !rectContains(segment.content.box, segment.content.subject)) {
    throw new Error(`Scene segment ${range} has a content subject outside its content box.`);
  }
}

async function runWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next;
        next += 1;
        try {
          results[index] = await worker(items[index]!, index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return results;
}
