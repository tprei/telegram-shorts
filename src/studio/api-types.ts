import { z } from 'zod';
import { ShortEditSchema, WordRangeSchema, type ShortEdit } from '../domain/edit.js';
import type { LayoutProfile } from '../domain/layout.js';
import type {
  AutopilotShortState,
  CandidateArc,
  CropAnalysisStatus,
  ExportStatus,
  HostFraming,
  JobStatus,
  PostingSchedule,
  PublicationStatus,
  PublishCopy,
  ShortStatus,
  ShortVideoPlatform,
} from '../domain/model.js';

export interface CreatorDto {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export interface JobMediaDto {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  videoUrl: string;
}

export interface JobSummaryDto {
  id: string;
  sourceUrl: string;
  title: string | null;
  thumbnailUrl: string | null;
  status: JobStatus;
  progress: string | null;
  error: string | null;
  creator: { id: string; displayName: string };
  shortCounts: { active: number; rejected: number; exported: number };
  createdAt: string;
  updatedAt: string;
}

export interface SpeakerSampleDto {
  speakerId: string;
  totalSeconds: number;
  samples: Array<{ startSeconds: number; endSeconds: number; text: string }>;
}

export interface ExportDto {
  id: string;
  shortId: string;
  editRevision: number;
  current: boolean;
  status: ExportStatus;
  error: string | null;
  videoUrl: string | null;
  coverUrl: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShortSummaryDto {
  id: string;
  jobId: string;
  rank: number;
  origin: 'planner' | 'manual';
  title: string;
  summary: string;
  status: ShortStatus;
  durationSeconds: number;
  hookText: string;
  cropAnalysis: CropAnalysisStatus;
  latestExport: ExportDto | null;
  updatedAt: string;
}

export interface JobDetailDto extends JobSummaryDto {
  media: JobMediaDto | null;
  speakers: SpeakerSampleDto[];
  chosenSpeakerId: string | null;
  canRetry: boolean;
  shorts: ShortSummaryDto[];
}

export interface TranscriptWordDto {
  i: number;
  text: string;
  start: number;
  end: number;
  speakerId: string;
}

export interface TranscriptSentenceDto {
  id: string;
  startWord: number;
  endWord: number;
  text: string;
}

export interface TranscriptDto {
  words: TranscriptWordDto[];
  sentences: TranscriptSentenceDto[];
}

export interface PublicationDto {
  id: string;
  exportId: string;
  platform: ShortVideoPlatform;
  status: PublicationStatus;
  provider: string | null;
  url: string | null;
  error: string | null;
  forced: boolean;
  availableAt: string | null;
  submittedAt: string | null;
  scheduledFor: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformAvailabilityDto {
  platform: ShortVideoPlatform;
  available: boolean;
  reason: string | null;
  canSchedule: boolean;
}

export interface ScheduledPostDto {
  publicationId: string;
  jobId: string;
  shortId: string;
  shortTitle: string;
  platform: ShortVideoPlatform;
  status: PublicationStatus;
  scheduledFor: string;
  provider: string | null;
  timeZone: string;
}

export interface ShortDetailDto {
  short: ShortSummaryDto & {
    rationale: string;
    hook: string;
    payoff: string;
    risk: 'low' | 'medium' | 'high';
    arc: CandidateArc | null;
    edit: ShortEdit;
    editRevision: number;
    cropAnalysisError: string | null;
    publishCopy: PublishCopy | null;
  };
  job: {
    id: string;
    title: string | null;
    sourceUrl: string;
    thumbnailUrl: string | null;
    media: JobMediaDto;
    layout: LayoutProfile;
    hostFraming: HostFraming | null;
    fontUrl: string;
    schedule: PostingSchedule;
  };
  exports: ExportDto[];
  publications: PublicationDto[];
  platforms: PlatformAvailabilityDto[];
}

export interface ReviseResultDto {
  detail: ShortDetailDto;
  summary: string;
  warnings: string[];
}

export interface HookSuggestionsDto {
  options: string[];
}

export const CreateJobRequestSchema = z.strictObject({
  url: z.string().min(1),
  creatorId: z.string().min(1).optional(),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export const ChooseSpeakerRequestSchema = z.strictObject({
  speakerId: z.string().min(1),
});
export type ChooseSpeakerRequest = z.infer<typeof ChooseSpeakerRequestSchema>;

export const CorrectWordRequestSchema = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[^\n\r\t]*$/, 'Text must not contain line breaks or tabs'),
});
export type CorrectWordRequest = z.infer<typeof CorrectWordRequestSchema>;

export const SetDefaultCreatorRequestSchema = z.strictObject({
  creatorId: z.string().min(1),
});
export type SetDefaultCreatorRequest = z.infer<typeof SetDefaultCreatorRequestSchema>;

export const SaveEditRequestSchema = z.strictObject({
  edit: ShortEditSchema,
  baseRevision: z.number().int().min(0),
});
export type SaveEditRequest = z.infer<typeof SaveEditRequestSchema>;

export const ReviseRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(2000),
  baseRevision: z.number().int().min(0),
});
export type ReviseRequest = z.infer<typeof ReviseRequestSchema>;

export const UpdateShortMetaRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
});
export type UpdateShortMetaRequest = z.infer<typeof UpdateShortMetaRequestSchema>;

export const SetShortStatusRequestSchema = z.strictObject({
  status: z.enum(['active', 'rejected']),
});
export type SetShortStatusRequest = z.infer<typeof SetShortStatusRequestSchema>;

export const CreateManualShortRequestSchema = z.strictObject({
  range: WordRangeSchema,
  title: z.string().trim().min(1).max(200).optional(),
});
export type CreateManualShortRequest = z.infer<typeof CreateManualShortRequestSchema>;

export const UpdatePublishCopyRequestSchema = z.strictObject({
  copy: z.strictObject({
    line1: z.string().trim().min(1).max(180),
    line2: z.string().trim().min(1).max(180),
    hashtags: z.array(z.string().trim().min(2).max(40)).min(1).max(6),
  }),
});
export type UpdatePublishCopyRequest = z.infer<typeof UpdatePublishCopyRequestSchema>;

export const PublishRequestSchema = z.strictObject({
  platforms: z
    .array(z.enum(['instagram', 'tiktok', 'youtube_shorts']))
    .min(1)
    .refine((platforms) => new Set(platforms).size === platforms.length, { message: 'Platforms must not contain duplicates' }),
  force: z.boolean(),
  scheduledAt: z.iso.datetime({ offset: true }).nullable(),
});
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

export interface StudioApi {
  listCreators(): Promise<CreatorDto[]>;
  setDefaultCreator(request: SetDefaultCreatorRequest): Promise<CreatorDto[]>;
  listJobs(): JobSummaryDto[];
  createJob(request: CreateJobRequest): Promise<JobSummaryDto>;
  getJob(jobId: string): JobDetailDto;
  retryJob(jobId: string): JobDetailDto;
  getTranscript(jobId: string): TranscriptDto;
  correctWord(jobId: string, wordIndex: number, request: CorrectWordRequest): TranscriptDto;
  chooseSpeaker(jobId: string, request: ChooseSpeakerRequest): JobDetailDto;
  replan(jobId: string): JobDetailDto;
  analyzeHostFraming(jobId: string): JobDetailDto;
  createManualShort(jobId: string, request: CreateManualShortRequest): ShortDetailDto;
  getShort(shortId: string): Promise<ShortDetailDto>;
  saveEdit(shortId: string, request: SaveEditRequest): Promise<ShortDetailDto>;
  revise(shortId: string, request: ReviseRequest): Promise<ReviseResultDto>;
  suggestHooks(shortId: string): Promise<HookSuggestionsDto>;
  updateShortMeta(shortId: string, request: UpdateShortMetaRequest): Promise<ShortDetailDto>;
  setShortStatus(shortId: string, request: SetShortStatusRequest): Promise<ShortDetailDto>;
  analyzeCrops(shortId: string): Promise<ShortDetailDto>;
  exportShort(shortId: string): Promise<ShortDetailDto>;
  generatePublishCopy(shortId: string): Promise<ShortDetailDto>;
  updatePublishCopy(shortId: string, request: UpdatePublishCopyRequest): Promise<ShortDetailDto>;
  publish(exportId: string, request: PublishRequest): Promise<PublicationDto[]>;
  cancelPublication(publicationId: string): Promise<ShortDetailDto>;
  listScheduledPosts(): ScheduledPostDto[];
}

export interface AutopilotShortDto {
  shortId: string;
  rank: number;
  title: string;
  state: AutopilotShortState;
  scheduledFor: string | null;
  reason: string | null;
}

export interface AutopilotVideoDto {
  videoId: string;
  title: string | null;
  jobId: string | null;
  jobStatus: JobStatus | null;
  detectedAt: string;
  shorts: AutopilotShortDto[];
}

export interface AutopilotStatusDto {
  creatorId: string;
  displayName: string;
  enabled: boolean;
  channelUrl: string;
  schedule: PostingSchedule;
  shortsPerVideo: number;
  platforms: ShortVideoPlatform[];
  reviewWindowHours: number;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  checkRequested: boolean;
  videos: AutopilotVideoDto[];
}

export const SetAutopilotRequestSchema = z.strictObject({
  enabled: z.boolean(),
});
export type SetAutopilotRequest = z.infer<typeof SetAutopilotRequestSchema>;

export interface AutopilotApi {
  list(): Promise<AutopilotStatusDto[]>;
  setEnabled(creatorId: string, request: SetAutopilotRequest): Promise<AutopilotStatusDto>;
  checkNow(creatorId: string): Promise<AutopilotStatusDto>;
}

export const MEDIA_ROUTES = {
  source: (jobId: string) => `/media/jobs/${encodeURIComponent(jobId)}/source`,
  thumbnail: (jobId: string) => `/media/jobs/${encodeURIComponent(jobId)}/thumbnail`,
  frame: (jobId: string, seconds: number, width: number) => `/media/jobs/${encodeURIComponent(jobId)}/frame?t=${seconds.toFixed(3)}&w=${Math.round(width)}`,
  export: (exportId: string) => `/media/exports/${encodeURIComponent(exportId)}`,
  exportCover: (exportId: string) => `/media/exports/${encodeURIComponent(exportId)}/cover`,
  font: (fileName: string) => `/fonts/${encodeURIComponent(fileName)}`,
} as const;
