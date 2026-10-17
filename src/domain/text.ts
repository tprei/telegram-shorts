import type { HookBandStyle } from './layout.js';

export function formatCaptionWord(text: string, uppercase: boolean): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return uppercase ? collapsed.toLocaleUpperCase('pt-BR') : collapsed;
}

export function wrapWords(words: string[], maxCharsPerLine: number): number[][] {
  const lines: number[][] = [];
  let current: number[] = [];
  let currentLength = 0;
  for (const [index, word] of words.entries()) {
    const nextLength = current.length === 0 ? word.length : currentLength + 1 + word.length;
    if (current.length > 0 && nextLength > maxCharsPerLine) {
      lines.push(current);
      current = [index];
      currentLength = word.length;
      continue;
    }
    current.push(index);
    currentLength = nextLength;
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

export function wrapHook(text: string, style: HookBandStyle): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter((word) => word.length > 0);
  const formatted = style.uppercase ? words.map((word) => word.toLocaleUpperCase('pt-BR')) : words;
  return wrapWords(formatted, style.maxCharsPerLine).map((line) => line.map((index) => formatted[index]).join(' '));
}

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseHexColor(hex: string): RgbaColor {
  const match = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex);
  if (!match) {
    throw new Error(`Invalid color "${hex}"; expected #RRGGBB or #RRGGBBAA.`);
  }
  const rgb = match[1]!;
  return {
    r: Number.parseInt(rgb.slice(0, 2), 16),
    g: Number.parseInt(rgb.slice(2, 4), 16),
    b: Number.parseInt(rgb.slice(4, 6), 16),
    a: match[2] ? Number.parseInt(match[2], 16) / 255 : 1,
  };
}
