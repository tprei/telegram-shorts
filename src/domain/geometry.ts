import type { ContentPanel, HostPanel, LayoutPanel, NormRect, PxRect } from './layout.js';

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

export function hostSourceCrop(
  panel: HostPanel,
  zoom: number,
  source: { width: number; height: number },
  aspect: number,
): PxRect {
  const bounds = normToPx(panel.sourceRect, source.width, source.height);
  const anchorX = bounds.x + panel.anchor.x * bounds.w;
  const anchorY = bounds.y + panel.anchor.y * bounds.h;
  let baseW: number;
  let baseH: number;
  if (bounds.w / bounds.h > aspect) {
    baseH = bounds.h;
    baseW = baseH * aspect;
  } else {
    baseW = bounds.w;
    baseH = baseW / aspect;
  }
  const baseX = clamp(anchorX - baseW / 2, bounds.x, bounds.x + bounds.w - baseW);
  const baseY = clamp(anchorY - baseH / 2, bounds.y, bounds.y + bounds.h - baseH);
  const zoomW = baseW / zoom;
  const zoomH = baseH / zoom;
  const relativeX = (anchorX - baseX) / baseW;
  const relativeY = (anchorY - baseY) / baseH;
  return toEvenPxRect({
    x: clamp(anchorX - relativeX * zoomW, bounds.x, bounds.x + bounds.w - zoomW),
    y: clamp(anchorY - relativeY * zoomH, bounds.y, bounds.y + bounds.h - zoomH),
    w: zoomW,
    h: zoomH,
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
