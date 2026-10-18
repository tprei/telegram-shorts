import { z } from 'zod';
import type { ShortEdit } from './edit.js';
import type { LayoutProfile, NormRect } from './layout.js';

export type ShortVideoPlatform = 'instagram' | 'tiktok' | 'youtube_shorts';

export const SHORT_VIDEO_PLATFORMS: readonly ShortVideoPlatform[] = ['instagram', 'tiktok', 'youtube_shorts'];

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
  startWord: number;
  endWord: number;
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

export interface SourceMedia {
  videoPath: string;
  audioPath: string;
  thumbnailPath: string | null;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
}

export type JobStatus = 'queued' | 'downloading' | 'transcribing' | 'awaiting_speaker' | 'planning' | 'ready' | 'failed';

export type QueueTaskKind = 'process_source' | 'analyze_host' | 'plan_shorts' | 'analyze_crops' | 'export_short' | 'publish_short_video' | 'check_publication';

export type QueueLane = 'ingest' | 'output';

export const QUEUE_LANES: Record<QueueLane, readonly QueueTaskKind[]> = {
  ingest: ['process_source', 'analyze_host', 'plan_shorts', 'analyze_crops'],
  output: ['export_short', 'publish_short_video', 'check_publication'],
};

export interface QueueTaskPayloads {
  process_source: Record<string, never>;
  analyze_host: Record<string, never>;
  plan_shorts: Record<string, never>;
  analyze_crops: { shortId: string };
  export_short: { exportId: string };
  publish_short_video: { publicationId: string };
  check_publication: { publicationId: string };
}

export interface QueueTask {
  id: string;
  jobId: string;
  kind: QueueTaskKind;
  status: 'queued' | 'running' | 'done' | 'failed';
  payload: Record<string, unknown>;
  createdAt: string;
  availableAt: string | null;
  startedAt: string | null;
  error: string | null;
}

export interface HostFraming {
  headBox: NormRect;
}

export interface JobRecord {
  id: string;
  sourceUrl: string;
  sourceTitle: string | null;
  status: JobStatus;
  progress: string | null;
  creatorProfileId: string;
  creatorProfileSnapshot: CreatorProfile;
  layoutProfileSnapshot: LayoutProfile;
  transcriptProvider: TranscriptProvider;
  media: SourceMedia | null;
  transcriptWords: TranscriptWord[];
  transcriptSentences: TranscriptSentence[];
  transcriptRevision: number;
  semanticBlocks: SemanticBlock[];
  strongSpeakers: SpeakerSample[];
  chosenSpeakerId: string | null;
  hostFraming: HostFraming | null;
  hostFramingAnalyzedAt: string | null;
  failedTaskKind: QueueTaskKind | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ShortStatus = 'active' | 'rejected';

export type JobSummaryRecord = Omit<JobRecord, 'transcriptWords' | 'transcriptSentences' | 'semanticBlocks'>;

export type CropAnalysisStatus = 'none' | 'queued' | 'running' | 'done' | 'failed';

export interface PublishCopy {
  line1: string;
  line2: string;
  hashtags: string[];
}

export interface ShortRecord {
  id: string;
  jobId: string;
  rank: number;
  origin: 'planner' | 'manual';
  title: string;
  summary: string;
  rationale: string;
  hook: string;
  payoff: string;
  risk: 'low' | 'medium' | 'high';
  arc: CandidateArc | null;
  status: ShortStatus;
  edit: ShortEdit;
  editRevision: number;
  cropAnalysis: CropAnalysisStatus;
  cropAnalysisError: string | null;
  publishCopy: PublishCopy | null;
  createdAt: string;
  updatedAt: string;
}

export type ExportStatus = 'queued' | 'rendering' | 'ready' | 'failed';

export interface ExportRecord {
  id: string;
  jobId: string;
  shortId: string;
  editRevision: number;
  transcriptRevision: number;
  edit: ShortEdit;
  title: string;
  hostFraming: HostFraming | null;
  status: ExportStatus;
  artifactPath: string | null;
  coverPath: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PublicationStatus = 'queued' | 'publishing' | 'submitted' | 'scheduled' | 'published' | 'unconfirmed' | 'deferred' | 'failed' | 'cancelled';

export const IN_FLIGHT_PUBLICATION_STATUSES: readonly PublicationStatus[] = ['queued', 'publishing', 'submitted', 'scheduled', 'deferred'];

export const POSTED_OR_UNKNOWN_PUBLICATION_STATUSES: readonly PublicationStatus[] = ['published', 'unconfirmed'];

export interface PublicationRecord {
  id: string;
  jobId: string;
  shortId: string;
  exportId: string;
  platform: ShortVideoPlatform;
  status: PublicationStatus;
  forced: boolean;
  provider: string | null;
  batchId: string | null;
  remoteJobs: Array<{ platform: string; jobId: string }>;
  remoteUrl: string | null;
  submittedAt: string | null;
  scheduledFor: string | null;
  error: string | null;
  availableAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function publicationStartedAt(publication: PublicationRecord): string | null {
  return publication.scheduledFor ?? publication.submittedAt;
}

export type CreatorPublishMode = 'disabled' | 'global';

export interface CreatorPlatformPublishConfig {
  mode: CreatorPublishMode;
}

export interface CreatorPublishConfig {
  instagram?: CreatorPlatformPublishConfig;
  tiktok?: CreatorPlatformPublishConfig;
  youtube_shorts?: CreatorPlatformPublishConfig;
}

export interface CreatorRenderConfig {
  layoutPath: string;
  layoutId: string;
}

export interface PostingSchedule {
  timeZone: string;
  slots: string[];
}

export interface CreatorAutopilotConfig {
  channelUrl: string;
  shortsPerVideo: number;
  platforms: ShortVideoPlatform[];
  reviewWindowHours: number;
  bookingHorizonHours: number;
  maxShortAgeHours: number;
  minVideoSeconds: number;
}

export interface CreatorProfile {
  id: string;
  displayName: string;
  enabled: boolean;
  description?: string;
  render: CreatorRenderConfig;
  publish?: CreatorPublishConfig;
  schedule: PostingSchedule;
  autopilot?: CreatorAutopilotConfig;
}

export type AutopilotVideoStatus = 'baseline' | 'tracked';

export interface AutopilotVideoRecord {
  creatorId: string;
  videoId: string;
  title: string | null;
  status: AutopilotVideoStatus;
  jobId: string | null;
  detectedAt: string;
  retries: number;
  lastRetryAt: string | null;
}

export type AutopilotShortState = 'waiting' | 'exporting' | 'ready' | 'booked' | 'skipped' | 'expired';

export interface CreatorProfileManifest {
  version: 2;
  defaultCreatorId?: string;
  creators: CreatorProfile[];
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
  hook_text: z.string().min(1).max(90),
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

export const RevisionActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('retitle'), title: z.string().min(1) }),
  z.strictObject({ kind: z.literal('set_hook'), text: z.string().min(1).max(90) }),
  z.strictObject({ kind: z.literal('trim_start'), seconds: z.number().positive() }),
  z.strictObject({ kind: z.literal('trim_end'), seconds: z.number().positive() }),
  z.strictObject({ kind: z.literal('extend_start'), seconds: z.number().positive() }),
  z.strictObject({ kind: z.literal('extend_end'), seconds: z.number().positive() }),
  z.strictObject({ kind: z.literal('insert_span'), query: z.string().min(1) }),
  z.strictObject({ kind: z.literal('remove_span'), query: z.string().min(1) }),
  z.strictObject({ kind: z.literal('set_speed'), speed: z.number().min(1).max(1.5) }),
  z.strictObject({ kind: z.literal('enable_end_card') }),
  z.strictObject({ kind: z.literal('disable_end_card') }),
]);

export type RevisionAction = z.infer<typeof RevisionActionSchema>;

export const RevisionIntentSchema = z.strictObject({
  actions: z.array(RevisionActionSchema).min(1),
  summary: z.string().min(1),
});

export type RevisionIntent = z.infer<typeof RevisionIntentSchema>;

export const TranscriptSpanLocateSchema = z.strictObject({
  start_sentence_id: z.string().min(1),
  end_sentence_id: z.string().min(1),
  why: z.string().min(1),
});

export type TranscriptSpanLocate = z.infer<typeof TranscriptSpanLocateSchema>;

export const PublishCopyResponseSchema = z.strictObject({
  line_1: z.string().min(1).max(180),
  line_2: z.string().min(1).max(180),
  hashtags: z.array(z.string().min(2).max(40)).min(3).max(6),
});

export type PublishCopyResponse = z.infer<typeof PublishCopyResponseSchema>;

export const HookSuggestionsResponseSchema = z.strictObject({
  options: z.array(z.string().min(1).max(90)).length(3),
});

export type HookSuggestionsResponse = z.infer<typeof HookSuggestionsResponseSchema>;

export const CropFocusResponseSchema = z.strictObject({
  box_2d: z.tuple([
    z.number().int().min(0).max(1000),
    z.number().int().min(0).max(1000),
    z.number().int().min(0).max(1000),
    z.number().int().min(0).max(1000),
  ]),
  reason: z.string().min(1),
}).refine(({ box_2d: [ymin, xmin, ymax, xmax] }) => ymin < ymax && xmin < xmax, { message: 'box_2d must have ymin < ymax and xmin < xmax' });

export type CropFocusResponse = z.infer<typeof CropFocusResponseSchema>;
