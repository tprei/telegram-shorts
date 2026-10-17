import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { LayoutProfile } from '../domain/layout.js';

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/, 'Expected #RRGGBB or #RRGGBBAA color');

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

const LayoutProfileSchema = z.strictObject({
  version: z.literal(2),
  creatorId: z.string().min(1),
  layoutId: z.string().min(1),
  canvas: z.strictObject({
    width: z.number().positive(),
    height: z.number().positive(),
    fps: z.number().positive(),
  }),
  background: HexColorSchema,
  defaultSpeed: z.number().min(1).max(1.5),
  font: z.strictObject({
    family: z.string().min(1),
    file: z.string().min(1),
    assSizeScale: z.number().gt(0),
  }),
  panels: z.array(PanelSchema).min(1),
  hookBand: z.strictObject({
    rect: RectSchema,
    background: HexColorSchema,
    textColor: HexColorSchema,
    sizePx: z.number().positive(),
    maxCharsPerLine: z.number().int().positive(),
    maxLines: z.number().int().positive(),
    uppercase: z.boolean(),
  }).nullable(),
  captions: z.strictObject({
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
  }),
})
  .refine((layout) => layout.panels.filter((panel) => panel.role === 'content').length <= 1, {
    message: 'At most one content panel is allowed',
    path: ['panels'],
  })
  .refine((layout) => layout.panels.filter((panel) => panel.role === 'host').length <= 1, {
    message: 'At most one host panel is allowed',
    path: ['panels'],
  });

export async function loadLayoutProfile(path: string, rootDir: string): Promise<LayoutProfile> {
  const absolutePath = resolve(rootDir, path);
  const payload: unknown = JSON.parse(await readFile(absolutePath, 'utf-8'));
  return LayoutProfileSchema.parse(payload);
}
