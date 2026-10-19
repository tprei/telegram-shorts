import type { Composition, HostPanel, LayoutProfile, NormRect, PanelFill, PxRect, ScenesLayoutProfile } from './layout.js';
import type { SceneSegment } from './model.js';
import { hostSourceCrop, normToPx, toEvenPxRect, type Rect } from './geometry.js';
import { hostUsable, isFullFrameCamera, rectContains, rectIntersectionArea, SCENE_EPSILON } from './scene.js';

export const STACK_SPLITS: readonly number[] = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65];
export const CONTENT_GRID_STEPS = 24;
export const CONTENT_SCALE_STEPS = 13;
export const CONTAIN_EXPANSION_STEPS = 5;
export const EXCLUSION_OVERLAP_RESOLUTION = 0.01;
export const CONTENT_MAX_ZOOM = 2.5;
export const WIDE_SUBJECT_ASPECT_MULTIPLIER = 1.6;
export const FLASH_OUTPUT_SECONDS = 0.5;
export const SPLIT_COST_EPSILON = 1e-9;

export interface CompositionSource {
  width: number;
  height: number;
}

export interface ContentWindow {
  source: PxRect;
  fill: PanelFill;
  displayedWidthPx: number;
  displayedFocusWidthPx: number;
  subjectCutShare: number;
}

export interface CompositionSpan {
  segment: SceneSegment;
  composition: Composition;
  focus: NormRect | null;
  outputSeconds: number;
  zoom: number;
}

export interface CompositionPlacement {
  panelId: string;
  role: 'content' | 'host';
  source: PxRect;
  canvas: PxRect;
  fill: PanelFill;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rectArea(rect: Rect): number {
  return rect.w * rect.h;
}

function intersectRects(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right - x <= 0 || bottom - y <= 0) {
    return null;
  }
  return { x, y, w: right - x, h: bottom - y };
}

function disjointExclusions(exclusions: readonly Rect[]): Rect[] {
  const edges = [...new Set(exclusions.flatMap((rect) => [rect.x, rect.x + rect.w]))].sort((left, right) => left - right);
  const pieces: Rect[] = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const left = edges[index]!;
    const right = edges[index + 1]!;
    if (right - left <= SCENE_EPSILON) {
      continue;
    }
    const intervals: Array<[number, number]> = [];
    for (const rect of exclusions) {
      if (rect.x <= left + SCENE_EPSILON && rect.x + rect.w >= right - SCENE_EPSILON) {
        intervals.push([rect.y, rect.y + rect.h]);
      }
    }
    intervals.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const interval of intervals) {
      const previous = merged[merged.length - 1];
      if (previous !== undefined && interval[0] <= previous[1] + SCENE_EPSILON) {
        previous[1] = Math.max(previous[1], interval[1]);
        continue;
      }
      merged.push([interval[0], interval[1]]);
    }
    for (const [top, bottom] of merged) {
      if (bottom - top > SCENE_EPSILON) {
        pieces.push({ x: left, y: top, w: right - left, h: bottom - top });
      }
    }
  }
  return pieces;
}

export function contentFocus(segment: SceneSegment, localFocus: NormRect | null): NormRect {
  if (segment.content === null) {
    throw new Error('Scene segment has no content.');
  }
  if (localFocus === null) {
    return segment.content.subject;
  }
  const box = segment.content.box;
  return {
    x: box.x + localFocus.x * box.w,
    y: box.y + localFocus.y * box.h,
    w: localFocus.w * box.w,
    h: localFocus.h * box.h,
  };
}

interface WindowCandidate {
  rect: Rect;
  bucket: number;
  area: number;
  distance: number;
  contained: boolean;
}

function candidateImproves(next: WindowCandidate, best: WindowCandidate): boolean {
  if (next.bucket !== best.bucket) {
    return next.bucket < best.bucket;
  }
  if (next.area !== best.area) {
    return next.area > best.area;
  }
  if (next.distance !== best.distance) {
    return next.distance < best.distance;
  }
  if (next.rect.y !== best.rect.y) {
    return next.rect.y < best.rect.y;
  }
  return next.rect.x < best.rect.x;
}

function samplePositions(low: number, high: number, steps: number): number[] {
  if (high - low <= SCENE_EPSILON) {
    return [low];
  }
  const positions: number[] = [];
  for (let index = 0; index < steps; index += 1) {
    positions.push(low + ((high - low) * index) / (steps - 1));
  }
  return positions;
}

export function documentPanelInset(layout: ScenesLayoutProfile, panel: PxRect): PxRect | null {
  if (layout.safeArea.side <= 0) {
    return null;
  }
  const width = layout.canvas.width;
  if (panel.x > 0 || panel.x + panel.w < width) {
    return null;
  }
  return { x: layout.safeArea.side * width, y: panel.y, w: width - 2 * layout.safeArea.side * width, h: panel.h };
}

export function contentWindow(input: { segment: SceneSegment; focus: NormRect | null; source: CompositionSource; canvas: PxRect; inset: PxRect | null }): ContentWindow {
  if (input.segment.content === null) {
    throw new Error('Scene segment has no content.');
  }
  const content = input.segment.content;
  const bounds = normToPx(content.box, input.source.width, input.source.height);
  const focus = normToPx(input.focus ?? content.subject, input.source.width, input.source.height);
  const subject = normToPx(content.subject, input.source.width, input.source.height);
  const windowRect = input.inset ?? input.canvas;
  const aspect = windowRect.w / windowRect.h;
  const exclusions: Rect[] = [];
  for (const overlay of input.segment.overlays) {
    const clipped = intersectRects(normToPx(overlay, input.source.width, input.source.height), bounds);
    if (clipped !== null) {
      exclusions.push(clipped);
    }
  }
  if (input.segment.host !== null && !isFullFrameCamera(input.segment.host.camera) && rectContains(bounds, input.segment.host.camera)) {
    exclusions.push(normToPx(input.segment.host.camera, input.source.width, input.source.height));
  }
  const pieces = disjointExclusions(exclusions);
  const evaluate = (rect: Rect, contained: boolean): WindowCandidate => {
    let covered = 0;
    for (const piece of pieces) {
      const intersection = intersectRects(rect, piece);
      if (intersection !== null) {
        covered += rectArea(intersection);
      }
    }
    const area = rectArea(rect);
    const focusCenterX = focus.x + focus.w / 2;
    const focusCenterY = focus.y + focus.h / 2;
    const centerX = rect.x + rect.w / 2;
    const centerY = rect.y + rect.h / 2;
    return {
      rect,
      bucket: area > 0 ? Math.round(covered / area / EXCLUSION_OVERLAP_RESOLUTION) : 0,
      area,
      distance: (centerX - focusCenterX) ** 2 + (centerY - focusCenterY) ** 2,
      contained,
    };
  };
  const maxWidth = Math.min(bounds.w, bounds.h * aspect);
  const minWidth = Math.max(focus.w, focus.h * aspect, maxWidth / CONTENT_MAX_ZOOM);
  const wideSubject = content.kind !== 'document' && subject.w / subject.h > WIDE_SUBJECT_ASPECT_MULTIPLIER * aspect;
  let best: WindowCandidate | null = null;
  if (minWidth <= maxWidth && !wideSubject) {
    for (let scale = 0; scale < CONTENT_SCALE_STEPS; scale += 1) {
      const width = maxWidth - ((maxWidth - minWidth) * scale) / (CONTENT_SCALE_STEPS - 1);
      const height = width / aspect;
      const minX = Math.max(bounds.x, focus.x + focus.w - width);
      const maxX = Math.min(bounds.x + bounds.w - width, focus.x);
      const minY = Math.max(bounds.y, focus.y + focus.h - height);
      const maxY = Math.min(bounds.y + bounds.h - height, focus.y);
      if (minX > maxX || minY > maxY) {
        continue;
      }
      for (const x of samplePositions(minX, maxX, CONTENT_GRID_STEPS)) {
        for (const y of samplePositions(minY, maxY, CONTENT_GRID_STEPS)) {
          const candidate = evaluate({ x, y, w: width, h: height }, false);
          if (best === null || candidateImproves(candidate, best)) {
            best = candidate;
          }
        }
      }
    }
  }
  if (best === null) {
    const focusAspect = focus.w / focus.h;
    const targetWidth = focusAspect > aspect ? focus.w : Math.min(bounds.w, focus.h * aspect);
    const targetHeight = focusAspect > aspect ? Math.min(bounds.h, focus.w / aspect) : focus.h;
    for (let step = 0; step < CONTAIN_EXPANSION_STEPS; step += 1) {
      const fraction = step / (CONTAIN_EXPANSION_STEPS - 1);
      const width = focus.w + (targetWidth - focus.w) * fraction;
      const height = focus.h + (targetHeight - focus.h) * fraction;
      const x = clampNumber(focus.x + focus.w / 2 - width / 2, bounds.x, bounds.x + bounds.w - width);
      const y = clampNumber(focus.y + focus.h / 2 - height / 2, bounds.y, bounds.y + bounds.h - height);
      const candidate = evaluate({ x, y, w: width, h: height }, true);
      if (best === null || candidateImproves(candidate, best)) {
        best = candidate;
      }
    }
  }
  if (best === null) {
    throw new Error('No content window candidate was produced for this focus.');
  }
  const selected = best.rect;
  const source: PxRect = {
    x: Math.max(0, Math.floor(selected.x / 2) * 2),
    y: Math.max(0, Math.floor(selected.y / 2) * 2),
    w: 0,
    h: 0,
  };
  source.w = Math.min(input.source.width - source.x, Math.ceil((selected.x + selected.w) / 2) * 2 - source.x);
  source.h = Math.min(input.source.height - source.y, Math.ceil((selected.y + selected.h) / 2) * 2 - source.y);
  source.w = Math.max(2, source.w);
  source.h = Math.max(2, source.h);
  const canvasAspect = input.canvas.w / input.canvas.h;
  const contained = best.contained || input.inset !== null;
  const displayedWidthPx = contained
    ? (source.w / source.h >= canvasAspect ? input.canvas.w : input.canvas.h * (source.w / source.h))
    : input.canvas.w;
  const scale = displayedWidthPx / source.w;
  const subjectArea = rectArea(subject);
  const subjectIntersection = intersectRects(subject, source);
  return {
    source,
    fill: contained ? 'contain' : 'cover',
    displayedWidthPx,
    displayedFocusWidthPx: focus.w * scale,
    subjectCutShare: subjectArea > 0 && subjectIntersection !== null
      ? clampNumber(1 - rectArea(subjectIntersection) / subjectArea, 0, 1)
      : subjectArea > 0 ? 1 : 0,
  };
}

export function hostWindow(input: { segment: SceneSegment; source: CompositionSource; canvas: PxRect; zoom: number }): { source: PxRect; fill: PanelFill } {
  const host = input.segment.host;
  if (!hostUsable(input.segment) || host === null) {
    throw new Error('Scene segment has no usable host.');
  }
  const panel: HostPanel = {
    id: 'host',
    role: 'host',
    sourceRect: host.camera,
    canvasRect: { x: 0, y: 0, w: 1, h: 1 },
    anchor: { x: 0.5, y: 0.42 },
  };
  const crop = hostSourceCrop(panel, input.zoom, input.source, input.canvas.w / input.canvas.h, host.head);
  return { source: crop.source, fill: crop.fill };
}

function stageRect(layout: ScenesLayoutProfile): PxRect {
  const band = toEvenPxRect(normToPx(layout.hookBand.rect, layout.canvas.width, layout.canvas.height));
  const stageTop = band.y + band.h;
  return { x: 0, y: stageTop, w: layout.canvas.width, h: layout.canvas.height - stageTop };
}

function stackCanvases(layout: ScenesLayoutProfile, split: number): { content: PxRect; host: PxRect } {
  const stage = stageRect(layout);
  const contentHeight = 2 * Math.round((stage.h * split) / 2);
  return {
    content: { x: stage.x, y: stage.y, w: stage.w, h: contentHeight },
    host: { x: stage.x, y: stage.y + contentHeight, w: stage.w, h: stage.h - contentHeight },
  };
}

function documentInsetFor(layout: ScenesLayoutProfile, panel: PxRect, segment: SceneSegment): PxRect | null {
  return segment.content !== null && segment.content.kind === 'document' ? documentPanelInset(layout, panel) : null;
}

export function compositionPanels(input: {
  segment: SceneSegment;
  composition: Composition;
  focus: NormRect | null;
  source: CompositionSource;
  layout: ScenesLayoutProfile;
  split: number;
  zoom: number;
}): CompositionPlacement[] {
  if (input.composition === 'host') {
    const stage = stageRect(input.layout);
    const host = hostWindow({ segment: input.segment, source: input.source, canvas: stage, zoom: input.zoom });
    return [{ panelId: 'host', role: 'host', source: host.source, canvas: stage, fill: host.fill }];
  }
  if (input.composition === 'content') {
    const stage = stageRect(input.layout);
    const content = contentWindow({ segment: input.segment, focus: input.focus, source: input.source, canvas: stage, inset: documentInsetFor(input.layout, stage, input.segment) });
    return [{ panelId: 'content', role: 'content', source: content.source, canvas: stage, fill: content.fill }];
  }
  const canvases = stackCanvases(input.layout, input.split);
  const content = contentWindow({ segment: input.segment, focus: input.focus, source: input.source, canvas: canvases.content, inset: documentInsetFor(input.layout, canvases.content, input.segment) });
  const host = hostWindow({ segment: input.segment, source: input.source, canvas: canvases.host, zoom: input.zoom });
  return [
    { panelId: 'content', role: 'content', source: content.source, canvas: canvases.content, fill: content.fill },
    { panelId: 'host', role: 'host', source: host.source, canvas: canvases.host, fill: host.fill },
  ];
}

function spanCost(span: CompositionSpan, split: number, layout: ScenesLayoutProfile, source: CompositionSource): number {
  if (span.segment.content === null) {
    throw new Error('Scene segment has no content.');
  }
  const canvases = stackCanvases(layout, split);
  const content = contentWindow({ segment: span.segment, focus: span.focus, source, canvas: canvases.content, inset: documentInsetFor(layout, canvases.content, span.segment) });
  const host = hostWindow({ segment: span.segment, source, canvas: canvases.host, zoom: span.zoom });
  const focus = normToPx(span.focus ?? span.segment.content.subject, source.width, source.height);
  const legibility = (content.displayedFocusWidthPx / focus.w) * (source.height / 1080) / 0.5625;
  const contained = content.fill === 'contain';
  const contentCost = span.segment.content.kind === 'document'
    ? 2 * Math.max(0, 1 - legibility) ** 2 + (contained ? 0.3 * (1 - content.displayedWidthPx / 1080) : 0)
    : (contained ? 0.5 * (1 - content.displayedWidthPx / 1080) : 0) + 2 * content.subjectCutShare;
  const hostShare = canvases.host.h / (canvases.content.h + canvases.host.h);
  const upscale = canvases.host.h / (host.source.h * (1080 / source.height));
  const hostCost = 2 * Math.max(0, (0.38 - hostShare) / 0.38) ** 2 + 0.5 * Math.max(0, upscale - 2.2) ** 2;
  return contentCost + hostCost;
}

export function chooseStackSplit(input: { spans: readonly CompositionSpan[]; layout: ScenesLayoutProfile; source: CompositionSource }): number {
  const stackSpans = input.spans.filter((span) => span.composition === 'stack');
  const weight = stackSpans.reduce((total, span) => total + span.outputSeconds, 0);
  if (!(weight > 0)) {
    return 0.5;
  }
  let bestSplit = STACK_SPLITS[0]!;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const split of STACK_SPLITS) {
    let total = 0;
    for (const span of stackSpans) {
      total += spanCost(span, split, input.layout, input.source) * span.outputSeconds;
    }
    const mean = total / weight;
    const improves = mean < bestCost - SPLIT_COST_EPSILON
      || (Math.abs(mean - bestCost) <= SPLIT_COST_EPSILON && Math.abs(split - 0.5) < Math.abs(bestSplit - 0.5));
    if (improves) {
      bestCost = Math.min(bestCost, mean);
      bestSplit = split;
    }
  }
  return bestSplit;
}

export function captionY(layout: LayoutProfile, composition: Composition | null, split: number | null): number {
  if (layout.strategy === 'fixed') {
    return layout.captions.centerY;
  }
  if (composition === 'host') {
    return layout.scene.captionCenterY.host;
  }
  if (composition === 'content') {
    return layout.scene.captionCenterY.content;
  }
  if (composition === 'stack') {
    if (split === null) {
      throw new Error('Stack caption position requires a split.');
    }
    const canvases = stackCanvases(layout, split);
    return (canvases.content.y + canvases.content.h) / layout.canvas.height;
  }
  throw new Error('Caption position requires a composition.');
}

export function containForeground(source: PxRect, canvas: PxRect): PxRect {
  const sourceAspect = source.w / source.h;
  const canvasAspect = canvas.w / canvas.h;
  let width: number;
  let height: number;
  if (sourceAspect <= canvasAspect) {
    height = canvas.h;
    width = Math.max(2, 2 * Math.floor((canvas.h * sourceAspect) / 2));
  } else {
    width = canvas.w;
    height = Math.max(2, 2 * Math.floor((canvas.w / sourceAspect) / 2));
  }
  return {
    x: canvas.x + Math.round((canvas.w - width) / 2),
    y: canvas.y + Math.round((canvas.h - height) / 2),
    w: width,
    h: height,
  };
}
