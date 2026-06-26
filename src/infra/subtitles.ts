import { Candidate, LayoutProfile, TranscriptWord } from '../domain/model.js';

interface CueWord {
  text: string;
  startSeconds: number;
  endSeconds: number;
  speakerId: string;
}

interface CueLineToken extends CueWord {
  lineIndex: number;
  occurrenceIndex: number;
}

interface Cue {
  startSeconds: number;
  endSeconds: number;
  tokens: CueLineToken[];
  lines: string[];
}

const DRAFT_FONT_SIZE = 24;
const FINAL_FONT_SIZE = 30;
const MAX_LINES = 2;
const MAX_LINE_CHARS = 14;
const MAX_CUE_SECONDS = 2.8;
const MAX_GAP_SECONDS = 0.7;

export function buildAssSubtitles(input: {
  candidate: Candidate;
  transcriptWords: TranscriptWord[];
  chosenSpeakerId?: string | null;
  profile: 'draft' | 'final';
  layoutProfile?: LayoutProfile | null;
  outputWidth: number;
  outputHeight: number;
}): string {
  const safeArea = input.layoutProfile?.subtitleSafeArea;
  const fontSize = input.profile === 'draft' ? DRAFT_FONT_SIZE : FINAL_FONT_SIZE;
  const marginL = safeArea ? Math.round(safeArea.x * input.outputWidth) : 56;
  const marginR = safeArea ? Math.round((1 - safeArea.x - safeArea.w) * input.outputWidth) : 56;
  const marginV = safeArea ? Math.round((1 - safeArea.y - safeArea.h) * input.outputHeight) : 88;
  const relevantWords = clipWordsForCandidate(input.candidate, input.transcriptWords, input.chosenSpeakerId);
  const cues = buildCues(relevantWords);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${input.outputWidth}
PlayResY: ${input.outputHeight}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H00000000,&H00101010,&H99000000,-1,0,0,0,100,100,0,0,3,3,0,2,${marginL},${marginR},${marginV},1
Style: Highlight,Arial,${fontSize},&H0038D9FF,&H00000000,&H00101010,&HCC111827,-1,0,0,0,100,100,0,0,3,3,0,2,${marginL},${marginR},${marginV},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;
  const lines = cues.flatMap((cue) => buildCueEvents(cue));
  return `${header}${lines.join('')}`;
}

function clipWordsForCandidate(candidate: Candidate, transcriptWords: TranscriptWord[], chosenSpeakerId?: string | null): CueWord[] {
  const words: CueWord[] = [];
  let offset = 0;
  const speed = Math.max(candidate.playbackSpeed ?? 1, 1);
  for (const segment of candidate.segments) {
    const selected = transcriptWords
      .filter((word) => (!chosenSpeakerId || word.speakerId === chosenSpeakerId))
      .filter((word) => word.endSeconds > segment.startSeconds && word.startSeconds < segment.endSeconds)
      .map((word) => ({
        text: cleanWord(word.text),
        startSeconds: offset + Math.max(0, word.startSeconds - segment.startSeconds) / speed,
        endSeconds: offset + Math.max(0.05, Math.min(segment.endSeconds, word.endSeconds) - segment.startSeconds) / speed,
        speakerId: word.speakerId,
      }))
      .filter((word) => word.text.length > 0 && word.endSeconds > word.startSeconds + 0.01);
    words.push(...selected);
    offset += (segment.endSeconds - segment.startSeconds) / speed;
  }
  return words;
}

function buildCues(words: CueWord[]): Cue[] {
  const cues: Cue[] = [];
  let current: CueWord[] = [];
  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const laidOut = layoutCue(current);
    if (laidOut.tokens.length > 0) {
      cues.push(laidOut);
    }
    current = [];
  };
  for (const word of words) {
    const previous = current.at(-1);
    if (previous) {
      const gap = word.startSeconds - previous.endSeconds;
      const duration = word.endSeconds - current[0]!.startSeconds;
      if (gap > MAX_GAP_SECONDS || duration > MAX_CUE_SECONDS || wouldOverflow([...current, word]) || endsStrongly(previous.text)) {
        flush();
      }
    }
    current.push(word);
  }
  flush();
  return cues;
}

function layoutCue(words: CueWord[]): Cue {
  const lines: string[] = [];
  const tokens: CueLineToken[] = [];
  let currentLine = '';
  let currentLineWords: CueWord[] = [];
  const pushLine = () => {
    if (currentLineWords.length === 0) {
      return;
    }
    lines.push(currentLine.trim());
    const lineIndex = lines.length - 1;
    const counts = new Map<string, number>();
    for (const word of currentLineWords) {
      const seen = counts.get(word.text) ?? 0;
      counts.set(word.text, seen + 1);
      tokens.push({ ...word, lineIndex, occurrenceIndex: seen });
    }
    currentLine = '';
    currentLineWords = [];
  };
  for (const word of words) {
    const next = currentLine.length === 0 ? word.text : `${currentLine} ${word.text}`;
    if (next.length > MAX_LINE_CHARS && currentLineWords.length > 0 && lines.length < MAX_LINES - 1) {
      pushLine();
    }
    currentLine = currentLine.length === 0 ? word.text : `${currentLine} ${word.text}`;
    currentLineWords.push(word);
  }
  pushLine();
  if (lines.length > MAX_LINES) {
    lines.splice(MAX_LINES);
  }
  const visibleTokens = tokens.filter((token) => token.lineIndex < MAX_LINES);
  return {
    startSeconds: visibleTokens[0]!.startSeconds,
    endSeconds: visibleTokens[visibleTokens.length - 1]!.endSeconds,
    tokens: visibleTokens,
    lines,
  };
}

function buildCueEvents(cue: Cue): string[] {
  const events: string[] = [];
  for (const token of cue.tokens) {
    const text = cue.lines
      .map((line, lineIndex) => lineIndex === token.lineIndex ? highlightWordInLine(line, token.text, token.occurrenceIndex) : line)
      .join('\\N');
    events.push(`Dialogue: 0,${formatAssTime(token.startSeconds)},${formatAssTime(token.endSeconds)},Default,,0,0,0,,${text}\n`);
  }
  return events;
}

function highlightWordInLine(line: string, word: string, occurrenceIndex: number): string {
  const pieces = line.split(' ');
  let seen = 0;
  const rendered = pieces.map((piece) => {
    if (piece !== word) {
      return escapeAss(piece);
    }
    if (seen === occurrenceIndex) {
      seen += 1;
      return `{\\rHighlight}${escapeAss(piece)}{\\rDefault}`;
    }
    seen += 1;
    return escapeAss(piece);
  });
  return rendered.join(' ');
}

function wouldOverflow(words: CueWord[]): boolean {
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current.length === 0 ? word.text : `${current} ${word.text}`;
    if (next.length > MAX_LINE_CHARS && current.length > 0) {
      lines.push(current);
      current = word.text;
      continue;
    }
    current = next;
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.length > MAX_LINES;
}

function cleanWord(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function endsStrongly(text: string): boolean {
  const value = text.trim();
  return value.endsWith('.') || value.endsWith('!') || value.endsWith('?') || value.endsWith('…');
}

function escapeAss(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}');
}

function formatAssTime(value: number): string {
  const centiseconds = Math.max(0, Math.round(value * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const seconds = Math.floor((centiseconds % 6000) / 100);
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
