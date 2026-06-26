import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { LayoutProfile } from '../domain/model.js';

const RectSchema = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().positive().max(1),
  h: z.number().positive().max(1),
});

const LayoutProfileSchema = z.strictObject({
  version: z.literal(1),
  creatorId: z.string().min(1),
  layoutId: z.string().min(1),
  regions: z.array(z.strictObject({
    id: z.string().min(1),
    sourceRect: RectSchema,
    canvasRect: RectSchema,
    fit: z.enum(['cover', 'contain']),
  })).min(1),
  subtitleSafeArea: RectSchema,
});

export async function loadLayoutProfile(path: string | undefined, rootDir: string): Promise<LayoutProfile | null> {
  if (!path) {
    return null;
  }
  const absolutePath = resolve(rootDir, path);
  const payload = JSON.parse(await readFile(absolutePath, 'utf-8'));
  return LayoutProfileSchema.parse(payload);
}

export function buildLayoutFilter(profile: LayoutProfile, width: number, height: number, durationSeconds: number): string {
  const parts = [`color=c=black:s=${width}x${height}:d=${durationSeconds.toFixed(3)}[bg]`];
  let current = 'bg';
  for (const [index, region] of profile.regions.entries()) {
    const input = `r${index}v`;
    const output = `layout${index}`;
    const regionWidth = even(Math.round(region.canvasRect.w * width));
    const regionHeight = even(Math.round(region.canvasRect.h * height));
    const x = Math.round(region.canvasRect.x * width);
    const y = Math.round(region.canvasRect.y * height);
    parts.push(`[0:v]crop='iw*${region.sourceRect.w}':'ih*${region.sourceRect.h}':'iw*${region.sourceRect.x}':'ih*${region.sourceRect.y}'${scaleFilter(region.fit, regionWidth, regionHeight)}[${input}]`);
    parts.push(`[${current}][${input}]overlay=${x}:${y}[${output}]`);
    current = output;
  }
  parts.push(`[${current}]copy[vout]`);
  return parts.join(';');
}

function scaleFilter(fit: 'cover' | 'contain', width: number, height: number): string {
  if (fit === 'contain') {
    return `,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
  }
  return `,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
}

function even(value: number): number {
  return value % 2 === 0 ? value : value + 1;
}
