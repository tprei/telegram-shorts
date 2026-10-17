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

export interface LayoutProfile {
  version: 2;
  creatorId: string;
  layoutId: string;
  canvas: LayoutCanvas;
  background: string;
  defaultSpeed: number;
  font: LayoutFont;
  panels: LayoutPanel[];
  hookBand: HookBandStyle | null;
  captions: CaptionStyle;
}
