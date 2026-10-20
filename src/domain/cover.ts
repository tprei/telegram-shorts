import { normToPx, toEvenPxRect, type Rect } from './geometry.js';
import { hostPanelOf, type LayoutProfile, type NormRect, type PxRect } from './layout.js';
import type { HostFraming, SceneTrack } from './model.js';
import { hostUsable, SCENE_EPSILON } from './scene.js';

export interface CoverFrameChoice {
  sourceSeconds: number;
  crop: PxRect;
  portrait: boolean;
}

const PORTRAIT_ASPECT = 0.8;
const HEAD_MIN_HEIGHT_SHARE = 0.42;
const HEAD_VERTICAL_BIAS = 0.3;
const COVER_MAX_SECONDS = 2;
const COVER_MIN_SECONDS = 0.3;

export function chooseCoverFrame(input: {
  clips: readonly { sourceStart: number; sourceEnd: number }[];
  layout: LayoutProfile;
  sceneTrack: SceneTrack | null;
  hostFraming: HostFraming | null;
  source: { width: number; height: number };
}): CoverFrameChoice {
  if (input.clips.length === 0) {
    throw new Error('Cover frame requires at least one retained clip.');
  }
  const host = hostFrame(input);
  if (host === null) {
    return {
      sourceSeconds: coverSeconds(input.clips[0]!),
      crop: { x: 0, y: 0, w: input.source.width, h: input.source.height },
      portrait: false,
    };
  }
  const head = normToPx(host.head, input.source.width, input.source.height);
  const bounds = normToPx(host.bounds, input.source.width, input.source.height);
  return {
    sourceSeconds: host.sourceSeconds,
    crop: portraitHeadCrop(head, bounds),
    portrait: true,
  };
}

interface HostFrame {
  sourceSeconds: number;
  head: NormRect;
  bounds: NormRect;
}

function hostFrame(input: {
  clips: readonly { sourceStart: number; sourceEnd: number }[];
  layout: LayoutProfile;
  sceneTrack: SceneTrack | null;
  hostFraming: HostFraming | null;
}): HostFrame | null {
  if (input.layout.strategy === 'scenes') {
    return sceneHostFrame(input.clips, input.sceneTrack);
  }
  const hostPanel = hostPanelOf(input.layout);
  if (hostPanel === null || input.hostFraming === null) {
    return null;
  }
  return {
    sourceSeconds: coverSeconds(input.clips[0]!),
    head: input.hostFraming.headBox,
    bounds: hostPanel.sourceRect,
  };
}

function sceneHostFrame(clips: readonly { sourceStart: number; sourceEnd: number }[], sceneTrack: SceneTrack | null): HostFrame | null {
  if (sceneTrack === null) {
    return null;
  }
  for (const clip of clips) {
    for (const segment of sceneTrack.segments) {
      if (segment.host === null || !hostUsable(segment)) {
        continue;
      }
      const start = Math.max(clip.sourceStart, segment.startSeconds);
      const end = Math.min(clip.sourceEnd, segment.endSeconds);
      if (end - start <= SCENE_EPSILON) {
        continue;
      }
      return {
        sourceSeconds: start + (end - start) / 2,
        head: segment.host.head,
        bounds: segment.host.camera,
      };
    }
  }
  return null;
}

function coverSeconds(clip: { sourceStart: number; sourceEnd: number }): number {
  const length = clip.sourceEnd - clip.sourceStart;
  return clip.sourceStart + Math.min(COVER_MAX_SECONDS, Math.max(COVER_MIN_SECONDS, length / 3));
}

function portraitHeadCrop(head: Rect, bounds: Rect): PxRect {
  let height = Math.min(bounds.h, head.h / HEAD_MIN_HEIGHT_SHARE);
  let width = height * PORTRAIT_ASPECT;
  if (width > bounds.w) {
    width = bounds.w;
    height = width / PORTRAIT_ASPECT;
  }
  const x = Math.min(Math.max(head.x + head.w / 2 - width / 2, bounds.x), bounds.x + bounds.w - width);
  const y = Math.min(Math.max(head.y - HEAD_VERTICAL_BIAS * (height - head.h), bounds.y), bounds.y + bounds.h - height);
  return toEvenPxRect({ x, y, w: width, h: height });
}
