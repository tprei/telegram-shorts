import type { HookBandStyle, LayoutProfile } from '@domain/layout.js';
import type { CaptionCue, Timeline, TimelineClip, TimelineEndCard, TimelineHook, TimelinePanelPlacement } from '@domain/timeline.js';
import { containForeground } from '../../../src/domain/composition.js';
import { HOST_BLUR_DARKEN, HOST_BLUR_SIGMA_PX } from '../../../src/domain/timeline.js';
import { parseHexColor } from '../../../src/domain/text.js';

export interface RgbaColorChannels {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function rgbaCss(color: RgbaColorChannels): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
}

export function drawBackground(ctx: CanvasRenderingContext2D, layout: LayoutProfile): void {
  ctx.fillStyle = rgbaCss(parseHexColor(layout.background));
  ctx.fillRect(0, 0, layout.canvas.width, layout.canvas.height);
}

export function drawClipPanels(ctx: CanvasRenderingContext2D, clip: TimelineClip, video: CanvasImageSource): void {
  for (const panel of clip.panels) {
    if (panel.fill === 'contain') {
      drawContainedPanel(ctx, panel, video);
      continue;
    }
    ctx.drawImage(
      video,
      panel.source.x,
      panel.source.y,
      panel.source.w,
      panel.source.h,
      panel.canvas.x,
      panel.canvas.y,
      panel.canvas.w,
      panel.canvas.h,
    );
  }
}

function drawContainedPanel(ctx: CanvasRenderingContext2D, panel: TimelinePanelPlacement, video: CanvasImageSource): void {
  const cropAspect = panel.source.w / panel.source.h;
  const panelAspect = panel.canvas.w / panel.canvas.h;
  const coverWidth = cropAspect > panelAspect ? panel.canvas.h * cropAspect : panel.canvas.w;
  const coverHeight = cropAspect > panelAspect ? panel.canvas.h : panel.canvas.w / cropAspect;
  const foreground = containForeground(panel.source, panel.canvas);
  const overscan = HOST_BLUR_SIGMA_PX;
  ctx.save();
  ctx.beginPath();
  ctx.rect(panel.canvas.x, panel.canvas.y, panel.canvas.w, panel.canvas.h);
  ctx.clip();
  ctx.filter = `blur(${HOST_BLUR_SIGMA_PX}px) brightness(${HOST_BLUR_DARKEN})`;
  ctx.drawImage(
    video,
    panel.source.x,
    panel.source.y,
    panel.source.w,
    panel.source.h,
    panel.canvas.x + (panel.canvas.w - coverWidth) / 2 - overscan,
    panel.canvas.y + (panel.canvas.h - coverHeight) / 2 - overscan,
    coverWidth + overscan * 2,
    coverHeight + overscan * 2,
  );
  ctx.filter = 'none';
  ctx.drawImage(
    video,
    panel.source.x,
    panel.source.y,
    panel.source.w,
    panel.source.h,
    foreground.x,
    foreground.y,
    foreground.w,
    foreground.h,
  );
  ctx.restore();
}

export function drawHookBand(
  ctx: CanvasRenderingContext2D,
  input: { style: HookBandStyle; hook: TimelineHook; fontFamily: string },
): void {
  const { style, hook, fontFamily } = input;
  ctx.save();
  ctx.fillStyle = rgbaCss(parseHexColor(style.background));
  ctx.fillRect(hook.canvas.x, hook.canvas.y, hook.canvas.w, hook.canvas.h);
  ctx.font = `${hook.sizePx}px "${fontFamily}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = rgbaCss(parseHexColor(style.textColor));
  const lineHeight = 1.12 * hook.sizePx;
  const centerX = hook.canvas.x + hook.canvas.w / 2;
  const centerY = hook.textCenterY;
  for (const [lineIndex, line] of hook.lines.entries()) {
    const y = centerY + (lineIndex - (hook.lines.length - 1) / 2) * lineHeight;
    ctx.fillText(line, centerX, y);
  }
  ctx.restore();
}

export function drawCaptions(
  ctx: CanvasRenderingContext2D,
  layout: LayoutProfile,
  cue: CaptionCue,
  activeWordIndex: number | null,
): void {
  const style = layout.captions;
  const textColor = rgbaCss(parseHexColor(style.textColor));
  const highlightColor = rgbaCss(parseHexColor(style.highlightColor));
  const outlineColor = rgbaCss(parseHexColor(style.outlineColor));
  ctx.save();
  ctx.font = `${style.sizePx}px "${layout.font.family}"`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2 * style.outlinePx;
  ctx.strokeStyle = outlineColor;
  const spaceWidth = ctx.measureText(' ').width;
  const centerY = cue.centerY * layout.canvas.height;
  const lineHeight = 1.12 * style.sizePx;
  let flatIndex = 0;
  for (const [lineIndex, line] of cue.lines.entries()) {
    const wordWidths = line.map((word) => ctx.measureText(word.text).width);
    const lineWidth = wordWidths.reduce((sum, width) => sum + width, 0) + spaceWidth * (line.length - 1);
    let x = (layout.canvas.width - lineWidth) / 2;
    const y = centerY + (lineIndex - (cue.lines.length - 1) / 2) * lineHeight;
    for (const [wordIndex, word] of line.entries()) {
      ctx.shadowColor = outlineColor;
      ctx.shadowOffsetX = style.shadowPx;
      ctx.shadowOffsetY = style.shadowPx;
      ctx.strokeText(word.text, x, y);
      ctx.shadowColor = 'rgba(0, 0, 0, 0)';
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.fillStyle = flatIndex === activeWordIndex ? highlightColor : textColor;
      ctx.fillText(word.text, x, y);
      x += wordWidths[wordIndex] + spaceWidth;
      flatIndex += 1;
    }
  }
  ctx.restore();
}

export function drawEndCard(
  ctx: CanvasRenderingContext2D,
  layout: LayoutProfile,
  input: { background: HTMLVideoElement; endCard: TimelineEndCard; thumbnail: HTMLImageElement | null },
): void {
  const width = layout.canvas.width;
  const height = layout.canvas.height;
  const endCard = input.endCard;
  const video = input.background;
  ctx.save();
  ctx.filter = `blur(24px) brightness(${endCard.darkenFactor})`;
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
    const drawWidth = video.videoWidth * scale;
    const drawHeight = video.videoHeight * scale;
    ctx.drawImage(video, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  }
  ctx.restore();
  const thumbnail = input.thumbnail;
  if (thumbnail !== null && thumbnail.naturalWidth > 0 && thumbnail.naturalHeight > 0) {
    const thumbnailWidth = endCard.thumbnail.widthPx;
    const thumbnailHeight = Math.round((thumbnailWidth * thumbnail.naturalHeight) / thumbnail.naturalWidth);
    ctx.drawImage(
      thumbnail,
      endCard.thumbnail.centerX - thumbnailWidth / 2,
      endCard.thumbnail.centerY - thumbnailHeight / 2,
      thumbnailWidth,
      thumbnailHeight,
    );
  }
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = endCard.textOutlineColor;
  ctx.lineWidth = 2 * endCard.textOutlinePx;
  ctx.fillStyle = '#FFFFFF';
  for (const line of [...endCard.titleLines, endCard.link]) {
    ctx.font = `${line.sizePx}px "${layout.font.family}"`;
    ctx.strokeText(line.text, line.centerX, line.centerY);
    ctx.fillText(line.text, line.centerX, line.centerY);
  }
  ctx.restore();
}

export interface FrameDrawInput {
  layout: LayoutProfile;
  timeline: Timeline;
  clip: TimelineClip | null;
  video: HTMLVideoElement | null;
  videoReady: boolean;
  cue: CaptionCue | null;
  activeWordIndex: number | null;
  endCard: { thumbnail: HTMLImageElement | null } | null;
}

export function drawTimelineFrame(ctx: CanvasRenderingContext2D, input: FrameDrawInput): void {
  const { layout, timeline } = input;
  drawBackground(ctx, layout);
  if (input.endCard !== null) {
    if (timeline.endCard !== null && input.video !== null && input.videoReady) {
      drawEndCard(ctx, layout, {
        background: input.video,
        endCard: timeline.endCard,
        thumbnail: input.endCard.thumbnail,
      });
    }
    return;
  }
  if (input.clip !== null && input.video !== null && input.videoReady) {
    drawClipPanels(ctx, input.clip, input.video);
  }
  if (timeline.hook !== null && layout.hookBand !== null) {
    drawHookBand(ctx, { style: layout.hookBand, hook: timeline.hook, fontFamily: layout.font.family });
  }
  if (input.cue !== null) {
    drawCaptions(ctx, layout, input.cue, input.activeWordIndex);
  }
}
