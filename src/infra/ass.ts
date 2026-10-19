import type { CaptionStyle, LayoutProfile } from '../domain/layout.js';
import type { CaptionCue, Timeline, TimelineEndCard } from '../domain/timeline.js';
import { parseHexColor } from '../domain/text.js';

export function buildExportAss(input: { timeline: Timeline; layout: LayoutProfile }): string {
  const { timeline, layout } = input;
  const width = timeline.canvas.width;
  const height = timeline.canvas.height;
  const fontScale = layout.font.assSizeScale;
  const spanEnd = assTime(timeline.durationSeconds);
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  ];
  if (layout.hookBand) {
    lines.push(`Style: Band,Arial,16,${assColor(layout.hookBand.background)},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`);
    lines.push(`Style: Hook,${layout.font.family},${Math.round((timeline.hook?.sizePx ?? layout.hookBand.sizePx) * fontScale)},${assColor(layout.hookBand.textColor)},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`);
  }
  lines.push(
    `Style: Caption,${layout.font.family},${Math.round(layout.captions.sizePx * fontScale)},${assColor(layout.captions.textColor)},&H000000FF,${assColor(layout.captions.outlineColor)},${assColor(layout.captions.outlineColor)},0,0,0,0,100,100,0,0,1,${layout.captions.outlinePx},${layout.captions.shadowPx},5,0,0,0,1`,
  );
  lines.push('', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');
  if (timeline.hook && layout.hookBand) {
    const band = timeline.hook.canvas;
    lines.push(
      `Dialogue: 0,0:00:00.00,${spanEnd},Band,,0,0,0,,{\\an7\\pos(0,0)\\p1}m ${band.x} ${band.y} l ${band.x + band.w} ${band.y} l ${band.x + band.w} ${band.y + band.h} l ${band.x} ${band.y + band.h}{\\p0}`,
    );
    const centerX = band.x + band.w / 2;
    const centerY = timeline.hook.textCenterY;
    const lineHeight = 1.12 * timeline.hook.sizePx;
    timeline.hook.lines.forEach((line, index) => {
      const y = Math.round((centerY + (index - (timeline.hook!.lines.length - 1) / 2) * lineHeight) * 100) / 100;
      lines.push(`Dialogue: 1,0:00:00.00,${spanEnd},Hook,,0,0,0,,{\\an5\\pos(${centerX},${y})}${escapeAssText(line)}`);
    });
  }
  for (const cue of timeline.cues) {
    const words = cue.lines.flat();
    const posY = Math.round(cue.centerY * height);
    for (const [index, word] of words.entries()) {
      const start = index === 0 ? cue.outputStart : word.outputStart;
      const stop = index === words.length - 1 ? cue.outputEnd : words[index + 1]!.outputStart;
      const text = captionEventText(cue, index, layout.captions);
      const posX = Math.round(width / 2);
      lines.push(`Dialogue: 2,${assTime(start)},${assTime(stop)},Caption,,0,0,0,,{\\an5\\pos(${posX},${posY})}${text}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function buildEndCardAss(input: { endCard: TimelineEndCard; layout: LayoutProfile }): string {
  const { endCard, layout } = input;
  const fontScale = layout.font.assSizeScale;
  const spanEnd = assTime(endCard.durationSeconds);
  const titleSize = Math.round(endCard.titleLines[0]!.sizePx * fontScale);
  const linkSize = Math.round(endCard.link.sizePx * fontScale);
  const outline = endCard.textOutlinePx;
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${layout.canvas.width}`,
    `PlayResY: ${layout.canvas.height}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: EndTitle,${layout.font.family},${titleSize},${assColor('#FFFFFF')},&H000000FF,${assColor(endCard.textOutlineColor)},&H00000000,0,0,0,0,100,100,0,0,1,${outline},0,5,0,0,0,1`,
    `Style: EndLink,${layout.font.family},${linkSize},${assColor('#FFFFFF')},&H000000FF,${assColor(endCard.textOutlineColor)},&H00000000,0,0,0,0,100,100,0,0,1,${outline},0,5,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const line of endCard.titleLines) {
    lines.push(`Dialogue: 0,0:00:00.00,${spanEnd},EndTitle,,0,0,0,,{\\an5\\pos(${line.centerX},${line.centerY})}${escapeAssText(line.text)}`);
  }
  lines.push(`Dialogue: 0,0:00:00.00,${spanEnd},EndLink,,0,0,0,,{\\an5\\pos(${endCard.link.centerX},${endCard.link.centerY})}${escapeAssText(endCard.link.text)}`);
  return `${lines.join('\n')}\n`;
}

function captionEventText(cue: CaptionCue, activeIndex: number, style: CaptionStyle): string {
  let index = 0;
  return cue.lines
    .map((line) =>
      line
        .map((word) => {
          const escaped = escapeAssText(word.text);
          const rendered =
            index === activeIndex
              ? `{\\c${assColor(style.highlightColor)}&}${escaped}{\\c${assColor(style.textColor)}&}`
              : escaped;
          index += 1;
          return rendered;
        })
        .join(' '),
    )
    .join('\\N');
}

function assColor(hex: string): string {
  const color = parseHexColor(hex);
  const alpha = Math.round((1 - color.a) * 255);
  const byte = (value: number): string => value.toString(16).toUpperCase().padStart(2, '0');
  return `&H${byte(alpha)}${byte(color.b)}${byte(color.g)}${byte(color.r)}`;
}

function escapeAssText(value: string): string {
  return value.replace(/[\\{}]/g, (match) => (match === '\\' ? '\\\u2060' : `\\${match}`));
}

function assTime(seconds: number): string {
  const centiseconds = Math.round(Math.max(0, seconds) * 100);
  const fraction = centiseconds % 100;
  const totalSeconds = Math.floor(centiseconds / 100);
  const wholeSeconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${hours}:${pad(minutes)}:${pad(wholeSeconds)}.${pad(fraction)}`;
}
