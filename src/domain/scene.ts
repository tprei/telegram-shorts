import type { Composition, NormRect } from './layout.js';
import type { SceneContent, SceneHost, SceneSegment, SceneTrack, TranscriptWord } from './model.js';

export const SCENE_MIN_SHOT_SECONDS = 0.5;
export const SCENE_SAMPLE_LEAD_SECONDS = 0.6;
export const SCENE_SAMPLE_INTERVAL_SECONDS = 12;
export const CAMERA_CLUSTER_IOU = 0.7;
export const CAMERA_FULL_FRAME_EDGE_TOLERANCE = 0.02;
export const CAMERA_EDGE_RADIUS_SHARE = 0.012;
export const CAMERA_EDGE_PEAK_RATIO = 2;
export const CAMERA_EDGE_MAX_FRAMES = 8;
export const HOST_OCCLUSION_MAX_SHARE = 0.2;
export const HEAD_SMOOTHING_IOU = 0.5;
export const SCENE_EPSILON = 1e-6;

export interface SceneShot {
  startSeconds: number;
  endSeconds: number;
}

export interface SceneObservation {
  sourceSeconds: number;
  host: SceneHost | null;
  content: SceneContent | null;
  overlays: NormRect[];
}

export interface CameraCluster {
  id: number;
  camera: NormRect;
  memberIndices: number[];
}

export interface ClusteredObservation extends SceneObservation {
  cameraClusterId: number | null;
}

export interface ClusteredSceneSegment extends SceneSegment {
  cameraClusterId: number | null;
}

export interface GreyFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

export type CameraEdge = 'left' | 'right' | 'top' | 'bottom';

export interface SceneChange {
  shotIndex: number;
  sourceSeconds: number;
  rightObservationIndex: number;
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('Cannot take the median of an empty list.');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function medianEdges(rects: readonly NormRect[]): NormRect {
  if (rects.length === 0) {
    throw new Error('Cannot take the median of an empty list.');
  }
  const left = medianOf(rects.map((rect) => rect.x));
  const top = medianOf(rects.map((rect) => rect.y));
  const right = medianOf(rects.map((rect) => rect.x + rect.w));
  const bottom = medianOf(rects.map((rect) => rect.y + rect.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function rectContains(bounds: NormRect, inner: NormRect): boolean {
  return inner.x >= bounds.x - SCENE_EPSILON
    && inner.y >= bounds.y - SCENE_EPSILON
    && inner.x + inner.w <= bounds.x + bounds.w + SCENE_EPSILON
    && inner.y + inner.h <= bounds.y + bounds.h + SCENE_EPSILON;
}

export function rectIntersectionArea(a: NormRect, b: NormRect): number {
  const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

export function rectIoU(a: NormRect, b: NormRect): number {
  const intersection = rectIntersectionArea(a, b);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > SCENE_EPSILON ? intersection / union : 0;
}

export function isFullFrameCamera(camera: NormRect): boolean {
  return Math.abs(camera.x) <= CAMERA_FULL_FRAME_EDGE_TOLERANCE
    && Math.abs(camera.y) <= CAMERA_FULL_FRAME_EDGE_TOLERANCE
    && Math.abs(camera.x + camera.w - 1) <= CAMERA_FULL_FRAME_EDGE_TOLERANCE
    && Math.abs(camera.y + camera.h - 1) <= CAMERA_FULL_FRAME_EDGE_TOLERANCE;
}

export function buildSceneShots(cuts: readonly number[], durationSeconds: number, fps: number): SceneShot[] {
  if (!(durationSeconds > 0)) {
    throw new Error('Scene shots require a positive duration.');
  }
  if (!(fps > 0)) {
    throw new Error('Scene shots require a positive fps.');
  }
  const rounded = cuts
    .map((cut) => Math.round(cut * fps) / fps)
    .filter((cut) => cut > 0 && cut < durationSeconds)
    .sort((left, right) => left - right);
  const uniqueCuts: number[] = [];
  for (const cut of rounded) {
    const previous = uniqueCuts[uniqueCuts.length - 1];
    if (previous !== undefined && Math.abs(cut - previous) < SCENE_EPSILON) {
      continue;
    }
    uniqueCuts.push(cut);
  }
  const boundaries = [0, ...uniqueCuts, durationSeconds];
  const shots: SceneShot[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const shot: SceneShot = { startSeconds: boundaries[index]!, endSeconds: boundaries[index + 1]! };
    const previous = shots[shots.length - 1];
    if (previous === undefined) {
      shots.push(shot);
      continue;
    }
    const shotShort = shot.endSeconds - shot.startSeconds < SCENE_MIN_SHOT_SECONDS;
    const previousShort = previous.endSeconds - previous.startSeconds < SCENE_MIN_SHOT_SECONDS;
    if (shotShort || previousShort) {
      previous.endSeconds = shot.endSeconds;
      continue;
    }
    shots.push(shot);
  }
  return shots;
}

export function sceneSampleTimes(shot: SceneShot): number[] {
  const lead = Math.min(SCENE_SAMPLE_LEAD_SECONDS, 0.25 * (shot.endSeconds - shot.startSeconds));
  const times = [shot.startSeconds + lead];
  for (let offset = SCENE_SAMPLE_INTERVAL_SECONDS; ; offset += SCENE_SAMPLE_INTERVAL_SECONDS) {
    const time = shot.startSeconds + lead + offset;
    if (time >= shot.endSeconds) {
      return times;
    }
    times.push(time);
  }
}

export function clusterCameras(observations: readonly SceneObservation[]): { observations: ClusteredObservation[]; clusters: CameraCluster[] } {
  const clustered: ClusteredObservation[] = observations.map((observation) => ({
    ...observation,
    overlays: observation.overlays.map((overlay) => ({ ...overlay })),
    cameraClusterId: null,
  }));
  const clusters: CameraCluster[] = [];
  for (const observation of clustered) {
    if (observation.host === null) {
      continue;
    }
    const host = observation.host;
    if (isFullFrameCamera(host.camera)) {
      observation.cameraClusterId = -1;
      continue;
    }
    const existing = clusters.find((cluster) => rectIoU(cluster.camera, host.camera) >= CAMERA_CLUSTER_IOU);
    if (existing !== undefined) {
      existing.memberIndices.push(clustered.indexOf(observation));
      existing.camera = medianEdges(existing.memberIndices.map((member) => {
        const memberObservation = clustered[member];
        if (memberObservation === undefined || memberObservation.host === null) {
          throw new Error('Camera cluster member lost its host.');
        }
        return memberObservation.host.camera;
      }));
      observation.cameraClusterId = existing.id;
      continue;
    }
    clusters.push({ id: clusters.length, camera: { ...host.camera }, memberIndices: [clustered.indexOf(observation)] });
    observation.cameraClusterId = clusters.length - 1;
  }
  for (const cluster of clusters) {
    for (const member of cluster.memberIndices) {
      const memberObservation = clustered[member];
      if (memberObservation === undefined || memberObservation.host === null) {
        throw new Error('Camera cluster member lost its host.');
      }
      memberObservation.host.camera = { ...cluster.camera };
    }
  }
  return { observations: clustered, clusters };
}

export function evenlySpacedMemberIndices(memberIndices: readonly number[], maxFrames: number): number[] {
  if (memberIndices.length === 0) {
    return [];
  }
  const count = Math.min(maxFrames, memberIndices.length);
  if (count === 1) {
    return [memberIndices[0]!];
  }
  const picked: number[] = [];
  for (let index = 0; index < count; index += 1) {
    picked.push(memberIndices[Math.round((index * (memberIndices.length - 1)) / (count - 1))]!);
  }
  return picked;
}

export function meanEdgeGradient(frames: readonly GreyFrame[], camera: NormRect, edge: CameraEdge, positionPx: number): number {
  const horizontal = edge === 'top' || edge === 'bottom';
  let total = 0;
  for (const frame of frames) {
    let sum = 0;
    let count = 0;
    if (horizontal) {
      const from = Math.round(camera.x * frame.width);
      const to = Math.round((camera.x + camera.w) * frame.width);
      for (let x = from; x < to; x += 1) {
        sum += Math.abs(frame.data[positionPx * frame.width + x]! - frame.data[(positionPx - 1) * frame.width + x]!);
        count += 1;
      }
    } else {
      const from = Math.round(camera.y * frame.height);
      const to = Math.round((camera.y + camera.h) * frame.height);
      for (let y = from; y < to; y += 1) {
        sum += Math.abs(frame.data[y * frame.width + positionPx]! - frame.data[y * frame.width + positionPx - 1]!);
        count += 1;
      }
    }
    total += count > 0 ? sum / count : 0;
  }
  return frames.length > 0 ? total / frames.length : 0;
}

function edgePosition(camera: NormRect, edge: CameraEdge): number {
  if (edge === 'left') {
    return camera.x;
  }
  if (edge === 'right') {
    return camera.x + camera.w;
  }
  if (edge === 'top') {
    return camera.y;
  }
  return camera.y + camera.h;
}

function withEdge(camera: NormRect, edge: CameraEdge, value: number): NormRect {
  if (edge === 'left') {
    return { x: value, y: camera.y, w: camera.x + camera.w - value, h: camera.h };
  }
  if (edge === 'right') {
    return { x: camera.x, y: camera.y, w: value - camera.x, h: camera.h };
  }
  if (edge === 'top') {
    return { x: camera.x, y: value, w: camera.w, h: camera.y + camera.h - value };
  }
  return { x: camera.x, y: camera.y, w: camera.w, h: value - camera.y };
}

export function refineCameraEdges(camera: NormRect, frames: readonly GreyFrame[]): NormRect {
  const result = { ...camera };
  if (frames.length === 0) {
    return result;
  }
  const reference = frames[0]!;
  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    const horizontal = edge === 'top' || edge === 'bottom';
    const dimension = horizontal ? reference.height : reference.width;
    const position = edgePosition(camera, edge);
    if (position <= SCENE_EPSILON || position >= 1 - SCENE_EPSILON) {
      continue;
    }
    const predicted = Math.round(position * dimension);
    const radius = Math.round(CAMERA_EDGE_RADIUS_SHARE * dimension);
    const scores: number[] = [];
    let peak: { p: number; score: number } | null = null;
    for (let p = Math.max(1, predicted - radius); p <= Math.min(dimension - 1, predicted + radius); p += 1) {
      const score = meanEdgeGradient(frames, camera, edge, p);
      scores.push(score);
      const closer = Math.abs(p - predicted) < Math.abs((peak?.p ?? p) - predicted);
      if (peak === null || score > peak.score || (score === peak.score && closer)) {
        peak = { p, score };
      }
    }
    if (peak === null || !(peak.score > 0) || peak.score < CAMERA_EDGE_PEAK_RATIO * medianOf(scores)) {
      continue;
    }
    const candidate = withEdge(camera, edge, peak.p / dimension);
    if (candidate.w <= 0 || candidate.h <= 0) {
      continue;
    }
    result.x = candidate.x;
    result.y = candidate.y;
    result.w = candidate.w;
    result.h = candidate.h;
  }
  return result;
}

export function snapCameraClusters(observations: readonly ClusteredObservation[], cameras: ReadonlyMap<number, NormRect>): ClusteredObservation[] {
  return observations.map((observation) => {
    if (observation.cameraClusterId === null) {
      return { ...observation, overlays: [...observation.overlays] };
    }
    const camera = cameras.get(observation.cameraClusterId);
    if (camera === undefined || observation.host === null) {
      return { ...observation, overlays: [...observation.overlays] };
    }
    return {
      ...observation,
      host: { camera: { ...camera }, head: { ...observation.host.head } },
      overlays: observation.overlays.map((overlay) => ({ ...overlay })),
    };
  });
}

export function sceneSignature(observation: ClusteredObservation): string {
  const host = observation.host === null ? 'hostabsent' : `host${observation.cameraClusterId}`;
  const content = observation.content === null ? 'contentabsent' : observation.content.vertical ? 'contentvertical' : 'contentlandscape';
  return `${host}:${content}`;
}

function observationsForShot(shots: readonly SceneShot[], byShot: ClusteredObservation[][], shotIndex: number): ClusteredObservation[] {
  const own = byShot[shotIndex]!;
  if (own.length > 0) {
    return own;
  }
  for (let previous = shotIndex - 1; previous >= 0; previous -= 1) {
    const group = byShot[previous]!;
    if (group.length > 0) {
      return [{ ...group[group.length - 1]!, sourceSeconds: shots[shotIndex]!.startSeconds }];
    }
  }
  for (let next = shotIndex + 1; next < shots.length; next += 1) {
    const group = byShot[next]!;
    if (group.length > 0) {
      return [{ ...group[0]!, sourceSeconds: shots[shotIndex]!.startSeconds }];
    }
  }
  return [];
}

export function buildSceneSegments(shots: readonly SceneShot[], observations: readonly ClusteredObservation[], changes: readonly SceneChange[]): ClusteredSceneSegment[] {
  const byShot: ClusteredObservation[][] = shots.map(() => []);
  for (const observation of observations) {
    const shotIndex = shots.findIndex((shot) => observation.sourceSeconds >= shot.startSeconds && observation.sourceSeconds < shot.endSeconds);
    if (shotIndex >= 0) {
      byShot[shotIndex]!.push(observation);
    }
  }
  const segments: ClusteredSceneSegment[] = [];
  for (let shotIndex = 0; shotIndex < shots.length; shotIndex += 1) {
    const shot = shots[shotIndex]!;
    const shotObservations = observationsForShot(shots, byShot, shotIndex);
    if (shotObservations.length === 0) {
      throw new Error('Scene segments require at least one successful observation.');
    }
    const shotChanges = changes
      .filter((change) => change.shotIndex === shotIndex)
      .sort((left, right) => left.sourceSeconds - right.sourceSeconds);
    const boundaries = [shot.startSeconds, ...shotChanges.map((change) => change.sourceSeconds), shot.endSeconds];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const start = boundaries[index]!;
      const end = boundaries[index + 1]!;
      const change = index > 0 ? shotChanges[index - 1] : undefined;
      const designated = change !== undefined ? observations[change.rightObservationIndex]! : shotObservations[0]!;
      const signature = sceneSignature(designated);
      const midpoint = start + (end - start) / 2;
      let chosen = designated;
      for (const observation of shotObservations) {
        if (observation.sourceSeconds > midpoint) {
          break;
        }
        if (observation.sourceSeconds < start || sceneSignature(observation) !== signature) {
          continue;
        }
        chosen = observation;
      }
      segments.push({
        startSeconds: start,
        endSeconds: end,
        host: chosen.host,
        content: chosen.content,
        overlays: [...chosen.overlays],
        cameraClusterId: chosen.cameraClusterId,
      });
    }
  }
  return segments;
}

export function smoothSceneHeads(segments: readonly ClusteredSceneSegment[]): SceneSegment[] {
  const result: SceneSegment[] = [];
  let run: Array<{ segment: ClusteredSceneSegment; host: SceneHost }> = [];
  const flush = (): void => {
    if (run.length === 0) {
      return;
    }
    const median = medianEdges(run.map((entry) => entry.host.head));
    for (const { segment, host } of run) {
      const camera = host.camera;
      const left = Math.max(median.x, camera.x);
      const top = Math.max(median.y, camera.y);
      const right = Math.min(median.x + median.w, camera.x + camera.w);
      const bottom = Math.min(median.y + median.h, camera.y + camera.h);
      result.push({
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        host: { camera, head: { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) } },
        content: segment.content,
        overlays: segment.overlays,
      });
    }
    run = [];
  };
  for (const segment of segments) {
    if (segment.host === null || segment.cameraClusterId === null) {
      flush();
      result.push({
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        host: null,
        content: segment.content,
        overlays: segment.overlays,
      });
      continue;
    }
    const previous = run[run.length - 1];
    if (previous !== undefined && (previous.segment.cameraClusterId !== segment.cameraClusterId || rectIoU(previous.host.head, segment.host!.head) < HEAD_SMOOTHING_IOU)) {
      flush();
    }
    run.push({ segment, host: segment.host });
  }
  flush();
  return result;
}

export function hostUsable(segment: SceneSegment): boolean {
  if (segment.host === null) {
    return false;
  }
  if (segment.content === null) {
    return true;
  }
  if (!isFullFrameCamera(segment.host.camera)) {
    return true;
  }
  const headArea = segment.host.head.w * segment.host.head.h;
  const overlap = rectIntersectionArea(segment.content.box, segment.host.head);
  return overlap <= HOST_OCCLUSION_MAX_SHARE * headArea + SCENE_EPSILON;
}

export function allowedCompositions(segment: SceneSegment): Composition[] {
  const usable = hostUsable(segment);
  const allowed: Composition[] = [];
  if (usable && segment.content !== null) {
    allowed.push('stack');
  }
  if (usable) {
    allowed.push('host');
  }
  if (segment.content !== null) {
    allowed.push('content');
  }
  return allowed;
}

export function defaultComposition(segment: SceneSegment): Composition {
  if (segment.host === null && segment.content === null) {
    throw new Error('Scene segment has neither host nor content.');
  }
  if (segment.content === null) {
    return 'host';
  }
  if (segment.host === null || !hostUsable(segment) || (segment.content.vertical && segment.content.kind !== 'document')) {
    return 'content';
  }
  if (isFullFrameCamera(segment.host.camera) && segment.content.kind !== 'document') {
    return 'host';
  }
  return 'stack';
}

export function sceneAt(track: SceneTrack, sourceSeconds: number): SceneSegment | null {
  for (const segment of track.segments) {
    if (sourceSeconds >= segment.startSeconds && sourceSeconds < segment.endSeconds) {
      return segment;
    }
  }
  const last = track.segments[track.segments.length - 1];
  if (last !== undefined && sourceSeconds === last.endSeconds) {
    return last;
  }
  return null;
}

export function freezeSceneTrack(track: SceneTrack, spans: readonly { sourceStart: number; sourceEnd: number }[]): SceneTrack {
  const segments = track.segments
    .filter((segment) => spans.some((span) => Math.min(segment.endSeconds, span.sourceEnd) - Math.max(segment.startSeconds, span.sourceStart) > SCENE_EPSILON))
    .map((segment) => ({
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      host: segment.host === null ? null : { camera: { ...segment.host.camera }, head: { ...segment.host.head } },
      content: segment.content === null ? null : {
        box: { ...segment.content.box },
        kind: segment.content.kind,
        vertical: segment.content.vertical,
        subject: { ...segment.content.subject },
      },
      overlays: segment.overlays.map((overlay) => ({ ...overlay })),
    }));
  return {
    version: track.version,
    analyzedAt: track.analyzedAt,
    frame: { width: track.frame.width, height: track.frame.height },
    segments,
  };
}

export function documentCropSpans(input: {
  clips: readonly { sourceStart: number; sourceEnd: number }[];
  words: readonly TranscriptWord[];
  segments: readonly SceneSegment[];
}): { segment: SceneSegment; startSeconds: number; endSeconds: number; text: string }[] {
  const spans: { segment: SceneSegment; startSeconds: number; endSeconds: number; text: string }[] = [];
  for (const segment of input.segments) {
    if (segment.content === null || segment.content.kind !== 'document') {
      continue;
    }
    for (const clip of input.clips) {
      const start = Math.max(segment.startSeconds, clip.sourceStart);
      const end = Math.min(segment.endSeconds, clip.sourceEnd);
      if (end - start <= 0) {
        continue;
      }
      const text = input.words
        .filter((word) => word.startSeconds < end && word.endSeconds > start)
        .map((word) => word.text)
        .join(' ');
      spans.push({ segment, startSeconds: start, endSeconds: end, text });
    }
  }
  return spans.sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);
}
