import { z } from 'zod';

export type JobStatus =
  | 'queued'
  | 'acquiring_source'
  | 'transcribing'
  | 'awaiting_speaker_confirmation'
  | 'planning_candidates'
  | 'rendering_drafts'
  | 'awaiting_review'
  | 'applying_revision'
  | 'rendering_final'
  | 'final_uploading'
  | 'completed'
  | 'failed';

export type QueueTaskKind =
  | 'process_source'
  | 'plan_candidates'
  | 'render_draft'
  | 'apply_revision'
  | 'render_final'
  | 'publish_instagram';

export type TranscriptProvider = 'deepgram' | 'scribe';

export interface TranscriptWord {
  id: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
  speakerId: string;
  confidence: number | null;
}

export interface TranscriptSentence {
  id: string;
  index: number;
  speakerId: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface SpeakerSample {
  speakerId: string;
  totalSeconds: number;
  sampleSentences: TranscriptSentence[];
}

export type SemanticBlockKind = 'hook' | 'setup' | 'turn' | 'explain' | 'evidence' | 'payoff';

export interface SemanticBlock {
  id: string;
  kind: SemanticBlockKind;
  summary: string;
  startSentenceId: string;
  endSentenceId: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface CandidateSegment {
  id: string;
  startSentenceId: string;
  endSentenceId: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface CandidateArcStep {
  kind: SemanticBlockKind;
  label: string;
  blockIds: string[];
  startSeconds: number;
  endSeconds: number;
}

export interface CandidateArc {
  thesis: string;
  steps: CandidateArcStep[];
}

export interface Candidate {
  id: string;
  rank: number;
  title: string;
  summary: string;
  hook: string;
  payoff: string;
  rationale: string;
  durationSeconds: number;
  seamCount: number;
  risk: 'low' | 'medium' | 'high';
  segments: CandidateSegment[];
  arc: CandidateArc | null;
  arcPreviewPath: string | null;
  playbackSpeed: number;
  previewEndCard: boolean;
  draftReady: boolean;
  rejected: boolean;
}

export interface CandidateVersion {
  id: string;
  jobId: string;
  number: number;
  parentId: string | null;
  source: 'initial' | 'revision';
  createdAt: string;
  candidates: Candidate[];
}

export interface RenderArtifact {
  id: string;
  jobId: string;
  candidateId: string;
  candidateVersionId: string;
  kind: 'draft' | 'final';
  profile: 'draft' | 'final';
  status: 'queued' | 'rendering' | 'ready' | 'sent' | 'failed';
  artifactPath: string;
  subtitlePath: string;
  sizeBytes: number;
  sha256: string;
  telegramMessageId: number | null;
  createdAt: string;
}

export interface MessageBindings {
  overviewMessageId: number | null;
  speakerPromptMessageId: number | null;
}

export interface JobRecord {
  id: string;
  sourceUrl: string;
  sourceTitle: string | null;
  status: JobStatus;
  operatorChatId: string;
  operatorUserId: string;
  transcriptProvider: TranscriptProvider;
  sourceVideoPath: string | null;
  sourceAudioPath: string | null;
  sourceThumbnailPath: string | null;
  transcriptPath: string | null;
  sentencesPath: string | null;
  semanticBlocksPath: string | null;
  transcriptWords: TranscriptWord[];
  transcriptSentences: TranscriptSentence[];
  semanticBlocks: SemanticBlock[];
  chosenSpeakerId: string | null;
  strongSpeakers: SpeakerSample[];
  currentCandidateVersionId: string | null;
  approvedRenderId: string | null;
  finalRenderId: string | null;
  messages: MessageBindings;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingReplyContext {
  chatId: string;
  jobId: string;
  candidateId: string;
  candidateVersionId: string;
  anchorMessageId: number;
  kind: 'revision';
}

export interface QueueTask {
  id: string;
  jobId: string;
  kind: QueueTaskKind;
  status: 'queued' | 'running' | 'done' | 'failed';
  payload: Record<string, unknown>;
  createdAt: string;
  startedAt: string | null;
  error: string | null;
}

export const SemanticBlockKindSchema = z.enum(['hook', 'setup', 'turn', 'explain', 'evidence', 'payoff']);

export const SemanticBlockResponseSchema = z.strictObject({
  id: z.string().min(1),
  kind: SemanticBlockKindSchema,
  summary: z.string().min(1),
  start_sentence_id: z.string().min(1),
  end_sentence_id: z.string().min(1),
});

export const SemanticBlockResponseSetSchema = z.strictObject({
  blocks: z.array(SemanticBlockResponseSchema).min(1),
});

export type SemanticBlockResponseSet = z.infer<typeof SemanticBlockResponseSetSchema>;

export const PlannedCandidateStepSchema = z.strictObject({
  kind: SemanticBlockKindSchema,
  label: z.string().min(1),
  block_ids: z.array(z.string().min(1)).min(1),
});

const PlannedCandidateLikeSchema = z.strictObject({
  opportunity_id: z.string().min(1).optional(),
  title: z.string().min(1),
  summary: z.string().min(1),
  hook: z.string().min(1),
  payoff: z.string().min(1),
  rationale: z.string().min(1),
  thesis: z.string().min(1),
  risk: z.enum(['low', 'medium', 'high']),
  block_ids: z.array(z.string().min(1)).min(2),
  steps: z.array(PlannedCandidateStepSchema).min(2),
});

export const PlannedCandidateResponseSchema = z.strictObject({
  candidates: z.array(PlannedCandidateLikeSchema).max(5),
});

export type PlannedCandidateResponse = z.infer<typeof PlannedCandidateResponseSchema>;

export const OpportunityPlanResponseSchema = z.strictObject({
  opportunities: z.array(PlannedCandidateLikeSchema.extend({
    id: z.string().min(1),
    viewer_promise: z.string().min(1),
    tension: z.string().min(1),
    why_this_short: z.string().min(1),
  })).min(1).max(8),
});

export type OpportunityPlanResponse = z.infer<typeof OpportunityPlanResponseSchema>;

export const RevisionIntentSchema = z.strictObject({
  actions: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('retitle'), title: z.string().min(1) }),
    z.strictObject({ kind: z.literal('caption_cleanup') }),
    z.strictObject({ kind: z.literal('trim_start'), seconds: z.number().positive() }),
    z.strictObject({ kind: z.literal('trim_end'), seconds: z.number().positive() }),
    z.strictObject({ kind: z.literal('extend_start'), seconds: z.number().positive() }),
    z.strictObject({ kind: z.literal('extend_end'), seconds: z.number().positive() }),
    z.strictObject({ kind: z.literal('insert_span'), query: z.string().min(1) }),
    z.strictObject({ kind: z.literal('reorder_candidate'), rank: z.number().int().min(1).max(5) }),
    z.strictObject({ kind: z.literal('set_speed'), speed: z.number().positive().max(1.5) }),
    z.strictObject({ kind: z.literal('enable_preview_end_card') }),
    z.strictObject({ kind: z.literal('disable_preview_end_card') }),
  ])).min(1),
  summary: z.string().min(1),
});

export type RevisionIntent = z.infer<typeof RevisionIntentSchema>;

export const TranscriptSpanLocateSchema = z.strictObject({
  start_sentence_id: z.string().min(1),
  end_sentence_id: z.string().min(1),
  why: z.string().min(1),
});

export type TranscriptSpanLocate = z.infer<typeof TranscriptSpanLocateSchema>;

export const InstagramReelCopySchema = z.strictObject({
  line_1: z.string().min(1).max(180),
  line_2: z.string().min(1).max(180),
  hashtags: z.array(z.string().min(2).max(40)).min(3).max(6),
});

export type InstagramReelCopy = z.infer<typeof InstagramReelCopySchema>;

export interface LayoutRegion {
  id: string;
  sourceRect: { x: number; y: number; w: number; h: number };
  canvasRect: { x: number; y: number; w: number; h: number };
  fit: 'cover' | 'contain';
}

export interface SubtitleSafeArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutProfile {
  version: 1;
  creatorId: string;
  layoutId: string;
  regions: LayoutRegion[];
  subtitleSafeArea: SubtitleSafeArea;
}

export interface TelegramUpdateEnvelope {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat?: { id: number | string };
    from?: { id: number | string };
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number | string };
    message?: { message_id: number; chat?: { id: number | string } };
  };
}
