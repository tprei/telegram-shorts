import { Candidate, CandidateSegment, CandidateVersion, RevisionIntent, SpeakerSample, TranscriptSentence, TranscriptWord } from './model.js';

interface ContiguousCandidatePlanItem {
  title: string;
  summary: string;
  hook: string;
  payoff: string;
  rationale: string;
  risk: 'low' | 'medium' | 'high';
  segments: Array<{
    start_sentence_id: string;
    end_sentence_id: string;
    why: string;
  }>;
}
import { createId, nowIso } from '../infra/util.js';

const HARD_MIN_DURATION_SECONDS = 40;
const HARD_MAX_DURATION_SECONDS = 220;

export function buildSentences(words: TranscriptWord[], chosenSpeakerId?: string): TranscriptSentence[] {
  const filtered = chosenSpeakerId
    ? words.filter((word) => word.speakerId === chosenSpeakerId)
    : words;
  const ordered = filtered
    .slice()
    .sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);
  const sentences: TranscriptSentence[] = [];
  let current: TranscriptWord[] = [];
  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const text = normalizeSentenceText(current.map((word) => word.text).join(' '));
    if (text.length > 0) {
      sentences.push({
        id: `s_${String(sentences.length + 1).padStart(4, '0')}`,
        index: sentences.length,
        speakerId: current[0].speakerId,
        startSeconds: current[0].startSeconds,
        endSeconds: current[current.length - 1].endSeconds,
        text,
      });
    }
    current = [];
  };
  for (let index = 0; index < ordered.length; index += 1) {
    const word = ordered[index];
    const next = ordered[index + 1];
    if (current.length > 0) {
      const previous = current[current.length - 1];
      if (previous.speakerId !== word.speakerId || word.startSeconds - previous.endSeconds > 0.9) {
        flush();
      }
    }
    current.push(word);
    const gapToNext = next ? next.startSeconds - word.endSeconds : 0;
    const duration = current[current.length - 1].endSeconds - current[0].startSeconds;
    const terminal = endsSentence(word.text);
    if (!next || terminal || gapToNext > 0.75 || (duration > 18 && gapToNext > 0.25)) {
      flush();
    }
  }
  flush();
  return sentences;
}

export function detectStrongSpeakers(words: TranscriptWord[]): SpeakerSample[] {
  const buckets = new Map<string, { totalSeconds: number }>();
  for (const word of words) {
    const current = buckets.get(word.speakerId) ?? { totalSeconds: 0 };
    current.totalSeconds += Math.max(0, word.endSeconds - word.startSeconds);
    buckets.set(word.speakerId, current);
  }
  const totalSpeech = [...buckets.values()].reduce((sum, value) => sum + value.totalSeconds, 0);
  const threshold = Math.max(12, totalSpeech * 0.18);
  const sentences = buildSentences(words);
  return [...buckets.entries()]
    .filter(([, value]) => value.totalSeconds >= threshold)
    .sort((left, right) => right[1].totalSeconds - left[1].totalSeconds)
    .map(([speakerId, value]) => ({
      speakerId,
      totalSeconds: roundSeconds(value.totalSeconds),
      sampleSentences: sentences.filter((sentence) => sentence.speakerId === speakerId).slice(0, 3),
    }));
}

export function buildCandidateVersion(jobId: string, versionNumber: number, parentId: string | null, source: 'initial' | 'revision', sentences: TranscriptSentence[], plan: { candidates: ContiguousCandidatePlanItem[] }): CandidateVersion {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const raw of plan.candidates) {
    const candidate = validateCandidate(sentences, raw, candidates.length + 1);
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

export function validateCandidate(sentences: TranscriptSentence[], raw: ContiguousCandidatePlanItem, rank: number): Candidate | null {
  const byId = new Map(sentences.map((sentence) => [sentence.id, sentence]));
  const segments: CandidateSegment[] = [];
  let previousEndIndex = -1;
  for (const rawSegment of raw.segments) {
    const start = byId.get(rawSegment.start_sentence_id);
    const end = byId.get(rawSegment.end_sentence_id);
    if (!start || !end || start.index > end.index || start.index <= previousEndIndex) {
      return null;
    }
    const spanSentences = sentences.slice(start.index, end.index + 1);
    if (spanSentences.length === 0) {
      return null;
    }
    segments.push({
      id: createId('seg'),
      startSentenceId: start.id,
      endSentenceId: end.id,
      startSeconds: start.startSeconds,
      endSeconds: end.endSeconds,
      text: spanSentences.map((sentence) => sentence.text).join(' '),
    });
    previousEndIndex = end.index;
  }
  const durationSeconds = roundSeconds(segments.reduce((sum, segment) => sum + (segment.endSeconds - segment.startSeconds), 0));
  if (durationSeconds < HARD_MIN_DURATION_SECONDS || durationSeconds > HARD_MAX_DURATION_SECONDS) {
    return null;
  }
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
    arc: null,
    arcPreviewPath: null,
    playbackSpeed: 1,
    previewEndCard: false,
    draftReady: false,
    rejected: false,
  };
}

export function markDraftReady(version: CandidateVersion, candidateId: string): CandidateVersion {
  return {
    ...version,
    candidates: version.candidates.map((candidate) => candidate.id === candidateId ? { ...candidate, draftReady: true } : candidate),
  };
}

export function rejectCandidate(version: CandidateVersion, candidateId: string): CandidateVersion {
  return rerankVersion({
    ...version,
    id: createId('cv'),
    number: version.number + 1,
    parentId: version.id,
    source: 'revision',
    createdAt: nowIso(),
    candidates: version.candidates.map((candidate) => ({
      ...candidate,
      rejected: candidate.id === candidateId ? true : candidate.rejected,
      draftReady: false,
      segments: candidate.segments.map((segment) => ({ ...segment })),
    })),
  });
}

export function applyRevision(version: CandidateVersion, candidateId: string, actions: RevisionIntent['actions'], sentences: TranscriptSentence[]): CandidateVersion {
  let candidates = version.candidates.map((candidate) => ({ ...candidate, segments: candidate.segments.map((segment) => ({ ...segment })), draftReady: false }));
  for (const action of actions) {
    if (action.kind === 'reorder_candidate') {
      candidates = reorderCandidate(candidates, candidateId, action.rank);
      continue;
    }
    const index = candidates.findIndex((candidate) => candidate.id === candidateId);
    if (index === -1) {
      continue;
    }
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    if (action.kind === 'retitle') {
      candidates[index] = { ...candidate, title: action.title.trim() };
      continue;
    }
    if (action.kind === 'caption_cleanup') {
      candidates[index] = { ...candidate };
      continue;
    }
    if (action.kind === 'set_speed') {
      candidates[index] = applyPlaybackSpeed(candidate, action.speed);
      continue;
    }
    if (action.kind === 'enable_preview_end_card') {
      candidates[index] = { ...candidate, previewEndCard: true, draftReady: false };
      continue;
    }
    if (action.kind === 'disable_preview_end_card') {
      candidates[index] = { ...candidate, previewEndCard: false, draftReady: false };
      continue;
    }
    if (action.kind === 'trim_start') {
      candidates[index] = recalcCandidate(trimEdge(candidate, sentences, 'start', action.seconds), sentences, candidate.rank) ?? candidate;
      continue;
    }
    if (action.kind === 'trim_end') {
      candidates[index] = recalcCandidate(trimEdge(candidate, sentences, 'end', action.seconds), sentences, candidate.rank) ?? candidate;
      continue;
    }
    if (action.kind === 'extend_start') {
      candidates[index] = recalcCandidate(extendEdge(candidate, sentences, 'start', action.seconds), sentences, candidate.rank) ?? candidate;
      continue;
    }
    if (action.kind === 'extend_end') {
      candidates[index] = recalcCandidate(extendEdge(candidate, sentences, 'end', action.seconds), sentences, candidate.rank) ?? candidate;
      continue;
    }
  }
  return rerankVersion({
    ...version,
    id: createId('cv'),
    number: version.number + 1,
    parentId: version.id,
    source: 'revision',
    createdAt: nowIso(),
    candidates,
  });
}

export function applyResolvedInsert(version: CandidateVersion, candidateId: string, startSentenceId: string, endSentenceId: string, sentences: TranscriptSentence[]): CandidateVersion {
  const candidates = version.candidates.map((candidate) => {
    if (candidate.id !== candidateId) {
      return { ...candidate, segments: candidate.segments.map((segment) => ({ ...segment })), draftReady: false };
    }
    const inserted = insertSpan(candidate, sentences, startSentenceId, endSentenceId);
    return recalcCandidate(inserted, sentences, candidate.rank) ?? { ...candidate, draftReady: false };
  });
  return rerankVersion({
    ...version,
    id: createId('cv'),
    number: version.number + 1,
    parentId: version.id,
    source: 'revision',
    createdAt: nowIso(),
    candidates,
  });
}

function trimEdge(candidate: Candidate, sentences: TranscriptSentence[], edge: 'start' | 'end', seconds: number): Candidate {
  const segments = candidate.segments.map((segment) => ({ ...segment }));
  if (segments.length === 0) {
    return candidate;
  }
  const byId = new Map(sentences.map((sentence) => [sentence.id, sentence]));
  let remaining = seconds;
  while (remaining > 0) {
    const target = edge === 'start' ? segments[0] : segments[segments.length - 1];
    if (!target) {
      break;
    }
    const ids = sentenceIdsForSegment(target, sentences);
    if (ids.length <= 1) {
      break;
    }
    if (edge === 'start') {
      const sentence = byId.get(ids[0]);
      const next = ids[1];
      if (!sentence || !next) {
        break;
      }
      remaining -= sentence.endSeconds - sentence.startSeconds;
      target.startSentenceId = next;
    } else {
      const sentence = byId.get(ids[ids.length - 1]);
      const next = ids[ids.length - 2];
      if (!sentence || !next) {
        break;
      }
      remaining -= sentence.endSeconds - sentence.startSeconds;
      target.endSentenceId = next;
    }
  }
  return { ...candidate, segments, draftReady: false };
}

function extendEdge(candidate: Candidate, sentences: TranscriptSentence[], edge: 'start' | 'end', seconds: number): Candidate {
  const segments = candidate.segments.map((segment) => ({ ...segment }));
  const byIndex = new Map(sentences.map((sentence) => [sentence.id, sentence.index]));
  let remaining = seconds;
  while (remaining > 0) {
    const target = edge === 'start' ? segments[0] : segments[segments.length - 1];
    if (!target) {
      break;
    }
    const startIndex = byIndex.get(target.startSentenceId);
    const endIndex = byIndex.get(target.endSentenceId);
    if (edge === 'start') {
      if (startIndex === undefined || startIndex <= 0) {
        break;
      }
      const previous = sentences[startIndex - 1];
      if (!previous) {
        break;
      }
      remaining -= previous.endSeconds - previous.startSeconds;
      target.startSentenceId = previous.id;
    } else {
      if (endIndex === undefined || endIndex >= sentences.length - 1) {
        break;
      }
      const next = sentences[endIndex + 1];
      if (!next) {
        break;
      }
      remaining -= next.endSeconds - next.startSeconds;
      target.endSentenceId = next.id;
    }
  }
  return { ...candidate, segments, draftReady: false };
}

function insertSpan(candidate: Candidate, sentences: TranscriptSentence[], startSentenceId: string, endSentenceId: string): Candidate {
  const byId = new Map(sentences.map((sentence) => [sentence.id, sentence]));
  const start = byId.get(startSentenceId);
  const end = byId.get(endSentenceId);
  if (!start || !end || start.index > end.index) {
    return { ...candidate, draftReady: false };
  }
  const nextSegments = candidate.segments.map((segment) => ({ ...segment }));
  const inserted: CandidateSegment = {
    id: createId('seg'),
    startSentenceId,
    endSentenceId,
    startSeconds: start.startSeconds,
    endSeconds: end.endSeconds,
    text: sentences.slice(start.index, end.index + 1).map((sentence) => sentence.text).join(' '),
  };
  if (nextSegments.some((segment) => segment.startSentenceId === startSentenceId && segment.endSentenceId === endSentenceId)) {
    return { ...candidate, arc: null, arcPreviewPath: null, draftReady: false };
  }
  nextSegments.push(inserted);
  nextSegments.sort((left, right) => left.startSeconds - right.startSeconds);
  return { ...candidate, segments: nextSegments, arc: null, arcPreviewPath: null, draftReady: false };
}

function applyPlaybackSpeed(candidate: Candidate, speed: number): Candidate {
  const rawDuration = candidate.segments.reduce((sum, segment) => sum + (segment.endSeconds - segment.startSeconds), 0);
  return {
    ...candidate,
    playbackSpeed: speed,
    durationSeconds: roundSeconds(rawDuration / speed),
    draftReady: false,
  };
}

function recalcCandidate(candidate: Candidate, sentences: TranscriptSentence[], rank: number): Candidate | null {
  const reconstructed = validateCandidate(sentences, {
    title: candidate.title,
    summary: candidate.summary,
    hook: candidate.hook,
    payoff: candidate.payoff,
    rationale: candidate.rationale,
    thesis: candidate.summary,
    risk: candidate.risk,
    block_ids: candidate.segments.map((segment) => segment.id),
    steps: [
      { kind: 'setup', label: candidate.summary, block_ids: candidate.segments.map((segment) => segment.id) },
      { kind: 'payoff', label: candidate.payoff, block_ids: candidate.segments.map((segment) => segment.id) },
    ],
    segments: candidate.segments.map((segment) => ({
      start_sentence_id: segment.startSentenceId,
      end_sentence_id: segment.endSentenceId,
      why: candidate.rationale,
    })),
  } as ContiguousCandidatePlanItem, rank);
  if (!reconstructed) {
    return null;
  }
  return {
    ...reconstructed,
    id: candidate.id,
    rejected: candidate.rejected,
    playbackSpeed: candidate.playbackSpeed,
    previewEndCard: candidate.previewEndCard,
    durationSeconds: roundSeconds((reconstructed.segments.reduce((sum, segment) => sum + (segment.endSeconds - segment.startSeconds), 0)) / Math.max(candidate.playbackSpeed, 1)),
    draftReady: false,
  };
}

function reorderCandidate(candidates: Candidate[], candidateId: string, rank: number): Candidate[] {
  const sorted = candidates.slice().sort((left, right) => left.rank - right.rank);
  const index = sorted.findIndex((candidate) => candidate.id === candidateId);
  if (index === -1) {
    return candidates;
  }
  const [target] = sorted.splice(index, 1);
  if (!target) {
    return candidates;
  }
  sorted.splice(Math.max(0, Math.min(rank - 1, sorted.length)), 0, target);
  return sorted.map((candidate, candidateIndex) => ({ ...candidate, rank: candidateIndex + 1, arc: null, arcPreviewPath: null, draftReady: false }));
}

function rerankVersion(version: CandidateVersion): CandidateVersion {
  const candidates = version.candidates
    .slice()
    .sort((left, right) => left.rank - right.rank)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  return { ...version, candidates };
}

function sentenceIdsForSegment(segment: CandidateSegment, sentences: TranscriptSentence[]): string[] {
  const start = sentences.find((sentence) => sentence.id === segment.startSentenceId);
  const end = sentences.find((sentence) => sentence.id === segment.endSentenceId);
  if (!start || !end || start.index > end.index) {
    return [];
  }
  return sentences.slice(start.index, end.index + 1).map((sentence) => sentence.id);
}

function endsSentence(text: string): boolean {
  const value = text.trim();
  return value.endsWith('.') || value.endsWith('!') || value.endsWith('?') || value.endsWith('…');
}

function normalizeSentenceText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
