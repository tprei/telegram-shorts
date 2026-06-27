import { Candidate, CandidateArc, CandidateArcStep, CandidateSegment, CandidateVersion, OpportunityPlanResponse, PlannedCandidateResponse, SemanticBlock, SemanticBlockKind, SemanticBlockResponseSet, TranscriptSentence } from './model.js';
import { createId, nowIso } from '../infra/util.js';

const MIN_DURATION_SECONDS = 40;
const MAX_DURATION_SECONDS = 220;

export function fallbackSemanticBlocks(sentences: TranscriptSentence[]): SemanticBlock[] {
  const blocks: SemanticBlock[] = [];
  let startIndex = 0;
  while (startIndex < sentences.length) {
    let endIndex = startIndex;
    let duration = 0;
    while (endIndex < sentences.length) {
      const first = sentences[startIndex];
      const current = sentences[endIndex];
      const next = sentences[endIndex + 1];
      if (!first || !current) {
        break;
      }
      duration = current.endSeconds - first.startSeconds;
      if (duration >= 12 || endIndex - startIndex >= 2) {
        if (endsStrongly(current.text) || duration >= 16) {
          break;
        }
      }
      if (next && startsTurn(next.text) && endIndex >= startIndex) {
        break;
      }
      endIndex += 1;
      if (endIndex >= sentences.length) {
        endIndex = sentences.length - 1;
        break;
      }
    }
    const span = sentences.slice(startIndex, endIndex + 1);
    const text = span.map((sentence) => sentence.text).join(' ');
    blocks.push({
      id: `b_${String(blocks.length + 1).padStart(3, '0')}`,
      kind: inferFallbackKind(text, blocks.length),
      summary: summarize(text, 120),
      startSentenceId: span[0]!.id,
      endSentenceId: span[span.length - 1]!.id,
      startSeconds: span[0]!.startSeconds,
      endSeconds: span[span.length - 1]!.endSeconds,
      text,
    });
    startIndex = endIndex + 1;
  }
  return blocks;
}

export function materializeSemanticBlocks(sentences: TranscriptSentence[], response: SemanticBlockResponseSet): SemanticBlock[] {
  const byId = new Map(sentences.map((sentence) => [sentence.id, sentence]));
  const blocks: SemanticBlock[] = [];
  let lastEndIndex = -1;
  for (const block of response.blocks) {
    const start = byId.get(block.start_sentence_id);
    const end = byId.get(block.end_sentence_id);
    if (!start || !end || start.index > end.index || start.index <= lastEndIndex) {
      continue;
    }
    const span = sentences.slice(start.index, end.index + 1);
    if (span.length === 0) {
      continue;
    }
    const text = span.map((sentence) => sentence.text).join(' ');
    blocks.push({
      id: block.id,
      kind: block.kind,
      summary: block.summary.trim(),
      startSentenceId: start.id,
      endSentenceId: end.id,
      startSeconds: start.startSeconds,
      endSeconds: end.endSeconds,
      text,
    });
    lastEndIndex = end.index;
  }
  return blocks.length > 0 ? blocks : fallbackSemanticBlocks(sentences);
}

export function semanticBlocksAreUsable(blocks: SemanticBlock[]): boolean {
  if (blocks.length < 8) {
    return false;
  }
  const kinds = new Set(blocks.map((block) => block.kind));
  const longBlocks = blocks.filter((block) => block.endSeconds - block.startSeconds > 40).length;
  return kinds.size >= 3 && longBlocks <= Math.floor(blocks.length / 4);
}

export function opportunityPlanToCandidatePlan(plan: OpportunityPlanResponse): PlannedCandidateResponse {
  return {
    candidates: plan.opportunities.map((opportunity) => ({
      title: opportunity.title,
      summary: opportunity.summary,
      hook: opportunity.hook,
      payoff: opportunity.payoff,
      rationale: opportunity.rationale,
      thesis: opportunity.thesis,
      risk: opportunity.risk,
      block_ids: opportunity.block_ids,
      steps: opportunity.steps,
    })),
  };
}

export interface CandidatePlanDiagnostic {
  index: number;
  title: string;
  blockIds: string[];
  durationSeconds: number | null;
  reasons: string[];
}

export function diagnoseCandidatePlan(sentences: TranscriptSentence[], blocks: SemanticBlock[], plan: PlannedCandidateResponse): CandidatePlanDiagnostic[] {
  return plan.candidates.map((candidate, index) => diagnoseCandidateFromBlocks(sentences, blocks, candidate, index));
}

export function buildCandidateVersionFromBlocks(jobId: string, versionNumber: number, parentId: string | null, source: 'initial' | 'revision', sentences: TranscriptSentence[], blocks: SemanticBlock[], plan: PlannedCandidateResponse): CandidateVersion {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const raw of plan.candidates) {
    const candidate = validateCandidateFromBlocks(sentences, blocks, raw, candidates.length + 1);
    if (!candidate) {
      continue;
    }
    const signature = candidate.segments.map((segment) => `${segment.startSentenceId}:${segment.endSentenceId}`).join('|');
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    candidates.push(candidate);
    if (candidates.length >= 5) {
      break;
    }
  }
  return {
    id: createId('cv'),
    jobId,
    number: versionNumber,
    parentId,
    source,
    createdAt: nowIso(),
    candidates,
  };
}

function diagnoseCandidateFromBlocks(sentences: TranscriptSentence[], blocks: SemanticBlock[], raw: PlannedCandidateResponse['candidates'][number], index: number): CandidatePlanDiagnostic {
  const byBlockId = new Map(blocks.map((block) => [block.id, block]));
  const reasons: string[] = [];
  const missingBlockIds = raw.block_ids.filter((id) => !byBlockId.has(id));
  const dedupedBlockIds = raw.block_ids.filter((id, blockIndex, values) => values.indexOf(id) === blockIndex);
  if (raw.block_ids.length < 2) {
    reasons.push('uses fewer than 2 blocks');
  }
  if (missingBlockIds.length > 0) {
    reasons.push(`references missing blocks: ${missingBlockIds.join(', ')}`);
  }
  if (dedupedBlockIds.length !== raw.block_ids.length) {
    reasons.push('references duplicate blocks');
  }
  const selectedBlocks = dedupedBlockIds.map((id) => byBlockId.get(id)).filter((value): value is SemanticBlock => Boolean(value));
  if (selectedBlocks.length < 2) {
    reasons.push('fewer than 2 valid blocks after resolving IDs');
  }
  const orderedBlocks = selectedBlocks.slice().sort((left, right) => left.startSeconds - right.startSeconds);
  if (!sameOrder(selectedBlocks, orderedBlocks)) {
    reasons.push('blocks are not in chronological order');
  }
  const segments = mergeBlocksIntoSegments(orderedBlocks, sentences);
  if (segments.length === 0) {
    reasons.push('blocks could not be converted into renderable segments');
  }
  const durationSeconds = segments.length > 0 ? roundSeconds(segments.reduce((sum, segment) => sum + (segment.endSeconds - segment.startSeconds), 0)) : null;
  if (durationSeconds !== null && durationSeconds < MIN_DURATION_SECONDS) {
    reasons.push(`duration ${durationSeconds}s is below minimum ${MIN_DURATION_SECONDS}s`);
  }
  if (durationSeconds !== null && durationSeconds > MAX_DURATION_SECONDS) {
    reasons.push(`duration ${durationSeconds}s exceeds maximum ${MAX_DURATION_SECONDS}s`);
  }
  if (selectedBlocks.length >= 2) {
    const resolvedSteps = resolveCandidateArcSteps(orderedBlocks, raw.steps);
    const structure = evaluateAuthoredShortStructure(resolvedSteps.length > 0 ? resolvedSteps : deriveArcFromBlocks(orderedBlocks), orderedBlocks);
    reasons.push(...structure.reasons);
  }
  return {
    index,
    title: raw.title,
    blockIds: raw.block_ids,
    durationSeconds,
    reasons,
  };
}

export function validateCandidateFromBlocks(sentences: TranscriptSentence[], blocks: SemanticBlock[], raw: PlannedCandidateResponse['candidates'][number], rank: number): Candidate | null {
  const diagnostic = diagnoseCandidateFromBlocks(sentences, blocks, raw, rank - 1);
  if (diagnostic.reasons.length > 0) {
    return null;
  }
  const byBlockId = new Map(blocks.map((block) => [block.id, block]));
  const dedupedBlockIds = raw.block_ids.filter((id, index, values) => values.indexOf(id) === index);
  const selectedBlocks = dedupedBlockIds.map((id) => byBlockId.get(id)).filter((value): value is SemanticBlock => Boolean(value));
  const orderedBlocks = selectedBlocks.slice().sort((left, right) => left.startSeconds - right.startSeconds);
  const segments = mergeBlocksIntoSegments(orderedBlocks, sentences);
  const durationSeconds = roundSeconds(segments.reduce((sum, segment) => sum + (segment.endSeconds - segment.startSeconds), 0));
  const arc = buildCandidateArc(raw.thesis, orderedBlocks, raw.steps);
  return {
    id: createId('cand'),
    rank,
    title: raw.title.trim(),
    summary: raw.summary.trim(),
    hook: raw.hook.trim(),
    payoff: raw.payoff.trim(),
    rationale: raw.rationale.trim(),
    durationSeconds,
    seamCount: Math.max(0, segments.length - 1),
    risk: raw.risk,
    segments,
    arc,
    arcPreviewPath: null,
    playbackSpeed: 1,
    previewEndCard: false,
    draftReady: false,
    rejected: false,
  };
}

export function buildArcPreviewSvg(candidate: Candidate): string {
  const steps = candidate.arc?.steps ?? [];
  const width = 1080;
  const headerHeight = 220;
  const stepHeight = 180;
  const gap = 26;
  const totalHeight = headerHeight + Math.max(1, steps.length) * (stepHeight + gap) + 80;
  const cards = steps.map((step, index) => {
    const top = headerHeight + index * (stepHeight + gap);
    return `
      <rect x="60" y="${top}" width="960" height="${stepHeight}" rx="28" fill="#111827" stroke="#374151" stroke-width="3" />
      <text x="96" y="${top + 50}" fill="#f9fafb" font-size="38" font-weight="700">${escapeXml(`${index + 1}. ${step.kind.toUpperCase()}`)}</text>
      <text x="96" y="${top + 96}" fill="#d1d5db" font-size="30">${escapeXml(summarize(step.label, 70))}</text>
      <text x="96" y="${top + 140}" fill="#9ca3af" font-size="26">${formatSeconds(step.startSeconds)}-${formatSeconds(step.endSeconds)}</text>
      ${index < steps.length - 1 ? `<line x1="540" y1="${top + stepHeight}" x2="540" y2="${top + stepHeight + gap}" stroke="#facc15" stroke-width="8" stroke-linecap="round" />` : ''}
    `;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">
    <rect width="100%" height="100%" fill="#030712" />
    <text x="60" y="72" fill="#f9fafb" font-size="48" font-weight="700">${escapeXml(candidate.title)}</text>
    <text x="60" y="122" fill="#d1d5db" font-size="32">${escapeXml(summarize(candidate.summary, 110))}</text>
    <text x="60" y="170" fill="#9ca3af" font-size="28">${formatSeconds(candidate.durationSeconds)} · costuras ${candidate.seamCount} · risco ${candidate.risk}</text>
    ${cards}
  </svg>`;
}

function buildCandidateArc(thesis: string, blocks: SemanticBlock[], steps: PlannedCandidateResponse['candidates'][number]['steps']): CandidateArc {
  const resolvedSteps = resolveCandidateArcSteps(blocks, steps);
  const normalizedSteps = evaluateAuthoredShortStructure(resolvedSteps, blocks).reasons.length === 0 ? resolvedSteps : deriveArcFromBlocks(blocks);
  return { thesis, steps: normalizedSteps };
}

function resolveCandidateArcSteps(blocks: SemanticBlock[], steps: PlannedCandidateResponse['candidates'][number]['steps']): CandidateArcStep[] {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const resolvedSteps: CandidateArcStep[] = [];
  for (const step of steps) {
    const stepBlocks = step.block_ids.map((id) => byId.get(id)).filter((value): value is SemanticBlock => Boolean(value));
    if (stepBlocks.length === 0) {
      continue;
    }
    const ordered = stepBlocks.slice().sort((left, right) => left.startSeconds - right.startSeconds);
    resolvedSteps.push({
      kind: step.kind,
      label: meaningfulStepLabel(step.label, ordered),
      blockIds: ordered.map((block) => block.id),
      startSeconds: ordered[0]!.startSeconds,
      endSeconds: ordered[ordered.length - 1]!.endSeconds,
    });
  }
  return resolvedSteps;
}

function evaluateAuthoredShortStructure(steps: CandidateArcStep[], blocks: SemanticBlock[]): { reasons: string[] } {
  const reasons: string[] = [];
  const stepKinds = new Set(steps.map((step) => step.kind));
  const blockKinds = new Set(blocks.map((block) => block.kind));
  const firstBlock = blocks[0] ?? null;
  const lastBlock = blocks[blocks.length - 1] ?? null;
  const hasOpening = stepKinds.has('hook') || stepKinds.has('setup') || firstBlock?.kind === 'hook' || firstBlock?.kind === 'setup' || firstBlock?.kind === 'turn';
  const hasDevelopment = stepKinds.has('turn') || stepKinds.has('explain') || stepKinds.has('evidence') || blockKinds.has('turn') || blockKinds.has('explain') || blockKinds.has('evidence') || blocks.length >= 3;
  const hasEnding = stepKinds.has('payoff') || blockKinds.has('payoff') || Boolean(lastBlock && lastBlock.kind !== 'hook' && lastBlock.kind !== 'setup' && endsStrongly(lastBlock.text) && !looksLikeOutro(lastBlock.text));
  if (!hasOpening) {
    reasons.push('short lacks a usable opening/hook');
  }
  if (!hasDevelopment) {
    reasons.push('short lacks enough development to sustain the thesis');
  }
  if (!hasEnding) {
    reasons.push('short does not land on a usable payoff/conclusion');
  }
  return { reasons };
}

function mergeBlocksIntoSegments(blocks: SemanticBlock[], sentences: TranscriptSentence[]): CandidateSegment[] {
  const byId = new Map(sentences.map((sentence) => [sentence.id, sentence]));
  const segments: CandidateSegment[] = [];
  let current: CandidateSegment | null = null;
  for (const block of blocks) {
    const start = byId.get(block.startSentenceId);
    const end = byId.get(block.endSentenceId);
    if (!start || !end) {
      continue;
    }
    if (!current) {
      current = {
        id: createId('seg'),
        startSentenceId: start.id,
        endSentenceId: end.id,
        startSeconds: start.startSeconds,
        endSeconds: end.endSeconds,
        text: block.text,
      };
      continue;
    }
    const currentEnd = byId.get(current.endSentenceId);
    if (currentEnd && currentEnd.index + 1 === start.index && start.startSeconds - currentEnd.endSeconds <= 1.2) {
      current.endSentenceId = end.id;
      current.endSeconds = end.endSeconds;
      current.text = `${current.text} ${block.text}`.trim();
      continue;
    }
    segments.push(current);
    current = {
      id: createId('seg'),
      startSentenceId: start.id,
      endSentenceId: end.id,
      startSeconds: start.startSeconds,
      endSeconds: end.endSeconds,
      text: block.text,
    };
  }
  if (current) {
    segments.push(current);
  }
  return segments;
}

function sameOrder<T>(left: T[], right: T[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function deriveArcFromBlocks(blocks: SemanticBlock[]): CandidateArcStep[] {
  if (blocks.length === 0) {
    return [];
  }
  const hook = blocks.find((block) => block.kind === 'hook') ?? blocks[0]!;
  const turn = blocks.find((block) => block.kind === 'turn') ?? blocks[Math.min(1, blocks.length - 1)]!;
  const evidenceBlocks = blocks.filter((block) => block.kind === 'explain' || block.kind === 'evidence');
  const evidence = evidenceBlocks.length > 0 ? evidenceBlocks : blocks.slice(Math.max(0, blocks.indexOf(turn) + 1), Math.min(blocks.length, blocks.indexOf(turn) + 3));
  const payoff = [...blocks].reverse().find((block) => block.kind === 'payoff') ?? blocks[blocks.length - 1]!;
  const steps: CandidateArcStep[] = [
    toArcStep('hook', summarizeBlocks([hook]), [hook]),
    toArcStep('turn', summarizeBlocks([turn]), [turn]),
  ];
  if (evidence.length > 0) {
    steps.push(toArcStep(evidence.some((block) => block.kind === 'evidence') ? 'evidence' : 'explain', summarizeBlocks(evidence), evidence));
  }
  steps.push(toArcStep('payoff', summarizeBlocks([payoff]), [payoff]));
  return dedupeArcSteps(steps);
}

function toArcStep(kind: SemanticBlockKind, label: string, blocks: SemanticBlock[]): CandidateArcStep {
  const ordered = blocks.slice().sort((left, right) => left.startSeconds - right.startSeconds);
  return {
    kind,
    label,
    blockIds: ordered.map((block) => block.id),
    startSeconds: ordered[0]!.startSeconds,
    endSeconds: ordered[ordered.length - 1]!.endSeconds,
  };
}

function meaningfulStepLabel(label: string, blocks: SemanticBlock[]): string {
  const trimmed = label.trim();
  if (trimmed.length >= 18 && !/^Abertura$|^Virada$|^Desenvolvimento$|^Payoff$/i.test(trimmed)) {
    return trimmed;
  }
  return summarizeBlocks(blocks);
}

function summarizeBlocks(blocks: SemanticBlock[]): string {
  return summarize(blocks.map((block) => block.summary).join(' • '), 80);
}

function dedupeArcSteps(steps: CandidateArcStep[]): CandidateArcStep[] {
  const seen = new Set<string>();
  const output: CandidateArcStep[] = [];
  for (const step of steps) {
    const key = step.blockIds.join('|');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(step);
  }
  return output;
}

function inferFallbackKind(text: string, index: number): SemanticBlockKind {
  const normalized = text.toLowerCase();
  if (index === 0) {
    return 'hook';
  }
  if (normalized.includes('na verdade') || normalized.includes('só que') || normalized.includes('mas')) {
    return 'turn';
  }
  if (normalized.includes('porque') || normalized.includes('isso vai') || normalized.includes('então')) {
    return 'explain';
  }
  if (normalized.includes('por exemplo') || normalized.includes('como') || normalized.includes('caso')) {
    return 'evidence';
  }
  if (normalized.includes('e agora eu quero saber') || normalized.includes('então é isso') || normalized.includes('ou seja')) {
    return 'payoff';
  }
  return 'setup';
}

function startsTurn(text: string): boolean {
  const value = text.trim().toLowerCase();
  return value.startsWith('mas ') || value.startsWith('mas,') || value.startsWith('só que') || value.startsWith('na verdade') || value.startsWith('porém');
}

function endsStrongly(text: string): boolean {
  const value = text.trim();
  return value.endsWith('.') || value.endsWith('!') || value.endsWith('?') || value.endsWith('…');
}

function looksLikeOutro(text: string): boolean {
  const value = text.trim().toLowerCase();
  return value.includes('deixa o like')
    || value.includes('se inscrever no canal')
    || value.includes('próximo vídeo')
    || value.includes('área de membros')
    || value.includes('considere se tornar membro')
    || value.includes('grande abraço');
}

function summarize(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatSeconds(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
