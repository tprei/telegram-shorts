import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { LayoutProfile } from '../domain/layout.js';

export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/, 'Expected #RRGGBB or #RRGGBBAA color');

const NormPointSchema = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

const RectSchema = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
})
  .refine((rect) => rect.x + rect.w <= 1, { message: 'x + w must be <= 1' })
  .refine((rect) => rect.y + rect.h <= 1, { message: 'y + h must be <= 1' });

const ContentPanelSchema = z.strictObject({
  id: z.string().min(1),
  role: z.literal('content'),
  sourceRect: RectSchema,
  canvasRect: RectSchema,
});

const HostPanelSchema = z.strictObject({
  id: z.string().min(1),
  role: z.literal('host'),
  sourceRect: RectSchema,
  canvasRect: RectSchema,
  anchor: NormPointSchema,
});

const PanelSchema = z.discriminatedUnion('role', [ContentPanelSchema, HostPanelSchema]);

const FontSchema = z.strictObject({
  family: z.string().min(1),
  file: z.string().min(1),
  assSizeScale: z.number().gt(0),
});

const HookBandSchema = z.strictObject({
  rect: RectSchema,
  background: HexColorSchema,
  textColor: HexColorSchema,
  sizePx: z.number().positive(),
  maxCharsPerLine: z.number().int().positive(),
  maxLines: z.number().int().positive(),
  uppercase: z.boolean(),
});

const CaptionStyleSchema = z.strictObject({
  sizePx: z.number().positive(),
  textColor: HexColorSchema,
  highlightColor: HexColorSchema,
  outlineColor: HexColorSchema,
  outlinePx: z.number().nonnegative(),
  shadowPx: z.number().nonnegative(),
  uppercase: z.boolean(),
  maxWordsPerCue: z.number().int().positive(),
  maxCharsPerLine: z.number().int().positive(),
  maxLines: z.number().int().positive(),
  centerY: z.number().min(0).max(1),
});

const SafeAreaSchema = z.strictObject({
  top: z.number().min(0).lt(0.3),
  bottom: z.number().min(0).lt(0.3),
  side: z.number().min(0).lt(0.3),
});

function hookBandClearsSafeArea(canvas: { height: number }, safeArea: { top: number }, hookBand: { rect: { y: number; h: number }; maxLines: number; sizePx: number }): boolean {
  return (hookBand.rect.y + hookBand.rect.h) * canvas.height - safeArea.top * canvas.height >= hookBand.maxLines * 1.12 * hookBand.sizePx;
}

const BaseLayoutShape = {
  version: z.literal(3),
  layoutId: z.string().min(1),
  canvas: z.strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
  }),
  background: HexColorSchema,
  font: FontSchema,
  captions: CaptionStyleSchema,
  safeArea: SafeAreaSchema,
};

const FixedLayoutSchema = z.strictObject({
  ...BaseLayoutShape,
  strategy: z.literal('fixed'),
  hookBand: HookBandSchema.nullable(),
  panels: z.array(PanelSchema).min(1),
}).refine(
  (layout) => layout.panels.filter((panel) => panel.role === 'content').length <= 1 && layout.panels.filter((panel) => panel.role === 'host').length <= 1,
  { message: 'At most one panel of each role' },
).refine(
  (layout) => layout.hookBand === null || hookBandClearsSafeArea(layout.canvas, layout.safeArea, layout.hookBand),
  { message: 'Hook band leaves no room for its text below the platform safe area.' },
);

const ScenesLayoutSchema = z.strictObject({
  ...BaseLayoutShape,
  strategy: z.literal('scenes'),
  hookBand: HookBandSchema,
  scene: z.strictObject({
    captionCenterY: z.strictObject({
      host: z.number().min(0).max(1),
      content: z.number().min(0).max(1),
    }),
  }),
}).refine(
  (layout) => layout.canvas.width === 1080 && layout.canvas.height === 1920 && layout.hookBand.rect.x === 0 && layout.hookBand.rect.y === 0 && layout.hookBand.rect.w === 1 && layout.hookBand.rect.h < 1,
  { message: 'Scenes requires a 1080x1920 canvas with a full-width top header' },
).refine(
  (layout) => hookBandClearsSafeArea(layout.canvas, layout.safeArea, layout.hookBand),
  { message: 'Hook band leaves no room for its text below the platform safe area.' },
);

const LayoutProfileSchema = z.discriminatedUnion('strategy', [FixedLayoutSchema, ScenesLayoutSchema]);

export async function loadLayoutProfile(path: string, rootDir: string): Promise<LayoutProfile> {
  const absolutePath = resolve(rootDir, path);
  const payload: unknown = JSON.parse(await readFile(absolutePath, 'utf-8'));
  return LayoutProfileSchema.parse(payload);
}
