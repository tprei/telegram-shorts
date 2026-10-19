import type { ContentPanel, HostPanel, LayoutPanel, NormRect, PanelFill, PxRect } from './layout.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_CONTENT_ZOOM = 2.5;

export function normToPx(rect: NormRect, width: number, height: number): Rect {
  return { x: rect.x * width, y: rect.y * height, w: rect.w * width, h: rect.h * height };
}

export function toEvenPxRect(rect: Rect): PxRect {
  return {
    x: Math.floor(rect.x / 2) * 2,
    y: Math.floor(rect.y / 2) * 2,
    w: Math.max(2, Math.floor(rect.w / 2) * 2),
    h: Math.max(2, Math.floor(rect.h / 2) * 2),
  };
}

export function fitRectToAspect(focus: Rect, aspect: number, bounds: Rect, minWidth: number): Rect {
  let w = focus.w;
  let h = focus.h;
  if (w / h < aspect) {
    w = h * aspect;
  } else {
    h = w / aspect;
  }
  if (w < minWidth) {
    w = minWidth;
    h = w / aspect;
  }
  if (w > bounds.w) {
    w = bounds.w;
    h = w / aspect;
  }
  if (h > bounds.h) {
    h = bounds.h;
    w = h * aspect;
  }
  return {
    x: clamp(focus.x + focus.w / 2 - w / 2, bounds.x, bounds.x + bounds.w - w),
    y: clamp(focus.y + focus.h / 2 - h / 2, bounds.y, bounds.y + bounds.h - h),
    w,
    h,
  };
}

export function panelCanvasRect(panel: LayoutPanel, canvas: { width: number; height: number }): PxRect {
  return toEvenPxRect(normToPx(panel.canvasRect, canvas.width, canvas.height));
}

export function contentSourceCrop(
  panel: ContentPanel,
  focus: NormRect | null,
  source: { width: number; height: number },
  aspect: number,
): PxRect {
  const bounds = normToPx(panel.sourceRect, source.width, source.height);
  const focusRect = focus ? normToPx(focus, source.width, source.height) : bounds;
  const minWidth = bounds.w / MAX_CONTENT_ZOOM;
  return toEvenPxRect(fitRectToAspect(focusRect, aspect, bounds, minWidth));
}

export interface HostSourceCrop {
  source: PxRect;
  fill: PanelFill;
}

export const HOST_HEAD_FILL = 0.62;
export const HOST_HEAD_MAX_FILL = 0.9;
export const HOST_HEADROOM_SHARE = 0.35;

function coverSize(bounds: Rect, aspect: number): Rect {
  if (bounds.w / bounds.h > aspect) {
    return { x: bounds.x, y: bounds.y, w: bounds.h * aspect, h: bounds.h };
  }
  return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.w / aspect };
}

export function hostSourceCrop(
  panel: HostPanel,
  zoom: number,
  source: { width: number; height: number },
  aspect: number,
  headBox: NormRect | null,
): HostSourceCrop {
  const bounds = normToPx(panel.sourceRect, source.width, source.height);
  const base = coverSize(bounds, aspect);
  if (headBox === null) {
    const anchorX = bounds.x + panel.anchor.x * bounds.w;
    const anchorY = bounds.y + panel.anchor.y * bounds.h;
    const baseX = clamp(anchorX - base.w / 2, bounds.x, bounds.x + bounds.w - base.w);
    const baseY = clamp(anchorY - base.h / 2, bounds.y, bounds.y + bounds.h - base.h);
    const zoomW = base.w / zoom;
    const zoomH = base.h / zoom;
    const relativeX = (anchorX - baseX) / base.w;
    const relativeY = (anchorY - baseY) / base.h;
    return {
      source: toEvenPxRect({
        x: clamp(anchorX - relativeX * zoomW, bounds.x, bounds.x + bounds.w - zoomW),
        y: clamp(anchorY - relativeY * zoomH, bounds.y, bounds.y + bounds.h - zoomH),
        w: zoomW,
        h: zoomH,
      }),
      fill: 'cover',
    };
  }
  const head = normToPx(headBox, source.width, source.height);
  let height: number;
  let width: number;
  if (head.h <= base.h) {
    height = Math.min(base.h, Math.max(base.h / zoom, head.h / HOST_HEAD_MAX_FILL));
    width = height * aspect;
  } else {
    height = Math.min(bounds.h, Math.max(head.h / HOST_HEAD_FILL / zoom, head.h / HOST_HEAD_MAX_FILL));
    width = Math.min(bounds.w, height * aspect);
  }
  const fill: PanelFill = width < height * aspect - 1 ? 'contain' : 'cover';
  return {
    source: toEvenPxRect({
      x: clamp(head.x + head.w / 2 - width / 2, bounds.x, bounds.x + bounds.w - width),
      y: clamp(head.y - HOST_HEADROOM_SHARE * (height - head.h), bounds.y, bounds.y + bounds.h - height),
      w: width,
      h: height,
    }),
    fill,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
