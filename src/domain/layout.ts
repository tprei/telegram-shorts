export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NormPoint {
  x: number;
  y: number;
}

export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutFont {
  family: string;
  file: string;
  assSizeScale: number;
}

export interface ContentPanel {
  id: string;
  role: 'content';
  sourceRect: NormRect;
  canvasRect: NormRect;
}

export interface HostPanel {
  id: string;
  role: 'host';
  sourceRect: NormRect;
  canvasRect: NormRect;
  anchor: NormPoint;
}

export type LayoutPanel = ContentPanel | HostPanel;

export interface HookBandStyle {
  rect: NormRect;
  background: string;
  textColor: string;
  sizePx: number;
  maxCharsPerLine: number;
  maxLines: number;
  uppercase: boolean;
}

export interface CaptionStyle {
  sizePx: number;
  textColor: string;
  highlightColor: string;
  outlineColor: string;
  outlinePx: number;
  shadowPx: number;
  uppercase: boolean;
  maxWordsPerCue: number;
  maxCharsPerLine: number;
  maxLines: number;
  centerY: number;
}

export interface LayoutCanvas {
  width: number;
  height: number;
  fps: number;
}

export type Composition = 'stack' | 'host' | 'content';

export type PanelFill = 'cover' | 'contain';

export interface LayoutBase {
  version: 3;
  layoutId: string;
  canvas: LayoutCanvas;
  background: string;
  font: LayoutFont;
  hookBand: HookBandStyle | null;
  captions: CaptionStyle;
  safeArea: { top: number; bottom: number; side: number };
}

export interface FixedLayoutProfile extends LayoutBase {
  strategy: 'fixed';
  panels: LayoutPanel[];
}

export interface ScenesLayoutProfile extends LayoutBase {
  strategy: 'scenes';
  hookBand: HookBandStyle;
  scene: { captionCenterY: { host: number; content: number } };
}

export type LayoutProfile = FixedLayoutProfile | ScenesLayoutProfile;

export function contentPanelOf(layout: LayoutProfile): ContentPanel | null {
  if (layout.strategy !== 'fixed') {
    return null;
  }
  return layout.panels.find((entry): entry is ContentPanel => entry.role === 'content') ?? null;
}

export function hostPanelOf(layout: LayoutProfile): HostPanel | null {
  if (layout.strategy !== 'fixed') {
    return null;
  }
  return layout.panels.find((entry): entry is HostPanel => entry.role === 'host') ?? null;
}
