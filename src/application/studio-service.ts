import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  addRange,
  createInitialEdit,
  extendEndBySeconds,
  extendStartBySeconds,
  keptText,
  keptWordIndices,
  normalizeEdit,
  normalizeSceneEdit,
  setWordsRemoved,
  trimEndBySeconds,
  trimStartBySeconds,
  type ShortEdit,
  type WordRange,
} from '../domain/edit.js';
import { exportMatchesShort } from '../domain/autopilot.js';
import { computeSourceClips, outputDurationSeconds } from '../domain/timeline.js';
import { sentenceText } from '../domain/policies.js';
import {
  IN_FLIGHT_PUBLICATION_STATUSES,
  POSTED_OR_UNKNOWN_PUBLICATION_STATUSES,
  type CreatorProfileManifest,
  type ExportRecord,
  type JobRecord,
  type JobSummaryRecord,
  type PublicationRecord,
  type PublishingAccount,
  type SceneAnalysisStatus,
  type SceneTrack,
  type ShortRecord,
  type ShortVideoPlatform,
  type SourceMedia,
  type TranscriptSentence,
} from '../domain/model.js';
import { contentPanelOf, hostPanelOf } from '../domain/layout.js';
import { documentCropSpans, freezeSceneTrack } from '../domain/scene.js';
import {
  accountSlotProblem,
  accountTakenSlots,
  SCHEDULE_LIMITS,
  scheduledAtProblem,
  zonedDateParts,
  zonedTimeToUtc,
} from '../domain/schedule.js';
import type { RevisionIntent } from '../domain/model.js';
import {
  MEDIA_ROUTES,
  type ChooseSpeakerRequest,
  type CreateJobRequest,
  type CreateManualShortRequest,
  type CorrectWordRequest,
  type CreatorDto,
  type ExportDto,
  type HookSuggestionsDto,
  type JobDetailDto,
  type JobMediaDto,
  type JobSummaryDto,
  type PlatformAvailabilityDto,
  type PublicationDto,
  type PublishingAccountDto,
  type PublishRequest,
  type ReviseRequest,
  type ReviseResultDto,
  type SaveEditRequest,
  type SceneAnalysisDto,
  type SetDefaultCreatorRequest,
  type SetShortStatusRequest,
  type ShortDetailDto,
  type ShortSummaryDto,
  type SpeakerSampleDto,
  type ScheduledPostDto,
  type TranscriptDto,
  type UpdatePublishCopyRequest,
  type UpdateShortMetaRequest,
  type StudioApi,
} from '../studio/api-types.js';
import { StudioError } from './errors.js';
import type { StudioMediaResolver } from './studio-media.js';
import {
  activeMallaryCooldownUntil,
  availabilityForPublishingProfile,
  platformLabel,
} from './platforms.js';
import { pickPublishingProfile, type CreatorProfileRepository } from '../infra/creator-profile-loader.js';
import type { AppConfig } from '../infra/env.js';
import { ShortsStore } from '../infra/db.js';
import { extractFrame } from '../infra/render.js';
import { assertPublicYouTubeUrl } from '../infra/youtube.js';
import { ShortVideoPublishError, type ShortVideoPublishProvider } from '../infra/instagram-publisher.js';
import { clamp, createId, nowIso } from '../infra/util.js';
import type { OpenRouterClient } from '../infra/openrouter.js';

const DEFAULT_CREATOR_SETTING_KEY = 'studio.defaultCreatorId';

export interface StudioServiceDeps {
  config: AppConfig;
  store: ShortsStore;
  openRouter: OpenRouterClient;
  profiles: CreatorProfileRepository;
  publisher: ShortVideoPublishProvider | null;
}

export class StudioService implements StudioApi, StudioMediaResolver {
  private readonly frameRenders = new Map<string, Promise<string>>();

  constructor(private readonly deps: StudioServiceDeps) {}

  async listCreators(): Promise<CreatorDto[]> {
    const [creators, resolved] = await Promise.all([
      this.deps.profiles.getEnabledCreatorProfiles(),
      this.deps.profiles.resolveCreatorProfile({ studioDefaultId: this.studioDefaultCreatorId() }),
    ]);
    return creators.map((creator) => ({
      id: creator.id,
      displayName: creator.displayName,
      isDefault: creator.id === resolved.profile.id,
      accountId: creator.accountId,
    }));
  }

  async setDefaultCreator(request: SetDefaultCreatorRequest): Promise<CreatorDto[]> {
    const creator = await this.deps.profiles.getCreatorProfileById(request.creatorId);
    if (!creator || !creator.enabled) {
      throw new StudioError('invalid', `Unknown creator: ${request.creatorId}`);
    }
    this.deps.store.setSetting(DEFAULT_CREATOR_SETTING_KEY, creator.id);
    return this.listCreators();
  }

  listJobs(): JobSummaryDto[] {
    return this.deps.store.listJobSummaries().map((job) => this.jobSummary(job));
  }

  async createJob(request: CreateJobRequest): Promise<JobSummaryDto> {
    try {
      assertPublicYouTubeUrl(request.url);
    } catch (error) {
      throw new StudioError('invalid', error instanceof Error ? error.message : String(error));
    }
    const resolved = await this.deps.profiles.resolveCreatorProfile({
      requestedId: request.creatorId,
      studioDefaultId: this.studioDefaultCreatorId(),
    });
    const job: JobRecord = {
      id: createId('job'),
      sourceUrl: request.url,
      sourceTitle: null,
      status: 'queued',
      progress: null,
      creatorProfileId: resolved.profile.id,
      creatorProfileSnapshot: resolved.profile,
      layoutProfileSnapshot: resolved.layout,
      transcriptProvider: this.deps.config.SHORTS_TRANSCRIPT_PROVIDER,
      media: null,
      transcriptWords: [],
      transcriptSentences: [],
      transcriptRevision: 0,
      semanticBlocks: [],
      strongSpeakers: [],
      chosenSpeakerId: null,
      hostFraming: null,
      hostFramingAnalyzedAt: null,
      sceneTrack: null,
      sceneAnalysis: 'none',
      sceneAnalysisError: null,
      failedTaskKind: null,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.deps.store.createJob(job);
    this.deps.store.enqueueTask(job.id, 'process_source', {});
    this.deps.store.appendAction(job.id, 'job_created', {
      url: job.sourceUrl,
      creatorProfileId: job.creatorProfileId,
      layoutId: resolved.layout.layoutId,
    });
    return this.jobSummary(job);
  }

  getJob(jobId: string): JobDetailDto {
    const job = this.requireJob(jobId);
    return {
      ...this.jobSummary(job),
      media: this.jobMedia(job),
      speakers: job.status === 'awaiting_speaker' ? this.speakerSamples(job) : [],
      chosenSpeakerId: job.chosenSpeakerId,
      canRetry: job.failedTaskKind !== null && (job.status === 'failed' || job.status === 'ready'),
      shorts: this.deps.store.listShortsForJob(job.id).map((short) => this.shortSummary(job, short)),
    };
  }

  retryJob(jobId: string): JobDetailDto {
    const job = this.requireJob(jobId);
    const failedTaskKind = job.failedTaskKind;
    if (!failedTaskKind || (job.status !== 'failed' && job.status !== 'ready')) {
      throw new StudioError('conflict', 'Job has no failed task to retry.');
    }
    job.status = failedTaskKind === 'process_source' ? 'downloading' : 'planning';
    job.progress = null;
    job.error = null;
    job.failedTaskKind = null;
    job.updatedAt = nowIso();
    this.deps.store.updateJob(job);
    this.deps.store.enqueueTask(job.id, failedTaskKind, {});
    return this.getJob(job.id);
  }

  getTranscript(jobId: string): TranscriptDto {
    const job = this.requireJob(jobId);
    return {
      words: job.transcriptWords.map((word, index) => ({
        i: index,
        text: word.text,
        start: word.startSeconds,
        end: word.endSeconds,
        speakerId: word.speakerId,
      })),
      sentences: job.transcriptSentences.map((sentence) => ({
        id: sentence.id,
        startWord: sentence.startWord,
        endWord: sentence.endWord,
        text: sentence.text,
      })),
    };
  }

  correctWord(jobId: string, wordIndex: number, request: CorrectWordRequest): TranscriptDto {
    const job = this.requireJob(jobId);
    if (job.status !== 'ready') {
      throw new StudioError('conflict', 'Job must be ready to correct words; planning rewrites the transcript.');
    }
    if (!Number.isInteger(wordIndex) || wordIndex < 0 || wordIndex >= job.transcriptWords.length) {
      throw new StudioError('invalid', `Word index ${wordIndex} is outside the transcript.`);
    }
    const word = job.transcriptWords[wordIndex];
    if (word.text === request.text) {
      return this.getTranscript(jobId);
    }
    const from = word.text;
    word.text = request.text;
    const sentence = job.transcriptSentences.find((entry) => wordIndex >= entry.startWord && wordIndex <= entry.endWord);
    if (sentence) {
      sentence.text = sentenceText(job.transcriptWords, sentence);
    }
    job.transcriptRevision += 1;
    job.updatedAt = nowIso();
    this.deps.store.updateJob(job);
    this.deps.store.appendAction(job.id, 'word_corrected', { wordIndex, from, to: request.text });
    return this.getTranscript(jobId);
  }

  chooseSpeaker(jobId: string, request: ChooseSpeakerRequest): JobDetailDto {
    const job = this.requireJob(jobId);
    if (job.status !== 'awaiting_speaker') {
      throw new StudioError('conflict', 'Job is not waiting for a speaker choice.');
    }
    if (!job.strongSpeakers.some((speaker) => speaker.speakerId === request.speakerId)) {
      throw new StudioError('invalid', `Unknown speaker: ${request.speakerId}`);
    }
    job.chosenSpeakerId = request.speakerId;
    job.status = 'planning';
    job.updatedAt = nowIso();
    this.deps.store.updateJob(job);
    this.deps.store.enqueueTask(job.id, 'plan_shorts', {});
    return this.getJob(job.id);
  }

  async autoChooseSpeaker(jobId: string): Promise<JobDetailDto> {
    const job = this.requireJob(jobId);
    if (job.status !== 'awaiting_speaker') {
      throw new StudioError('conflict', 'Job is not waiting for a speaker choice.');
    }
    const choice = await this.deps.openRouter.identifyHostSpeaker({
      creatorName: job.creatorProfileSnapshot.displayName,
      hostDescription: job.creatorProfileSnapshot.render.scene?.hostDescription ?? null,
      videoTitle: job.sourceTitle,
      speakers: job.strongSpeakers.map((speaker) => ({
        speakerId: speaker.speakerId,
        totalSeconds: speaker.totalSeconds,
        samples: spreadSpeakerSamples(speaker.sampleSentences),
      })),
    });
    const current = this.requireJob(jobId);
    if (current.status !== 'awaiting_speaker') {
      return this.getJob(jobId);
    }
    const detail = this.chooseSpeaker(jobId, { speakerId: choice.speakerId });
    this.deps.store.appendAction(job.id, 'autopilot_speaker_chosen', {
      speakerId: choice.speakerId,
      reason: choice.reason,
    });
    return detail;
  }

  replan(jobId: string): JobDetailDto {
    const job = this.requireJob(jobId);
    if (job.status !== 'ready') {
      throw new StudioError('conflict', 'Job must be ready to replan.');
    }
    job.status = 'planning';
    job.error = null;
    job.failedTaskKind = null;
    job.updatedAt = nowIso();
    this.deps.store.updateJob(job);
    this.deps.store.enqueueTask(job.id, 'plan_shorts', {});
    return this.getJob(job.id);
  }

  analyzeHostFraming(jobId: string): JobDetailDto {
    const job = this.requireJob(jobId);
    if (job.status !== 'ready') {
      throw new StudioError('conflict', 'Job must be ready to analyze host framing.');
    }
    if (job.layoutProfileSnapshot.strategy === 'scenes') {
      throw new StudioError('invalid', 'Scenes layouts do not use host panel framing.');
    }
    const hostPanel = hostPanelOf(job.layoutProfileSnapshot);
    if (!hostPanel) {
      throw new StudioError('invalid', 'This layout has no host panel to analyze.');
    }
    job.hostFramingAnalyzedAt = null;
    job.updatedAt = nowIso();
    this.deps.store.updateJob(job);
    this.deps.store.enqueueTask(job.id, 'analyze_host', {});
    return this.getJob(job.id);
  }

  analyzeScenes(jobId: string): JobDetailDto {
    const job = this.requireJob(jobId);
    if (job.status !== 'ready') {
      throw new StudioError('conflict', 'Job must be ready to analyze scenes.');
    }
    if (!job.media) {
      throw new StudioError('conflict', 'Job has no media to analyze.');
    }
    if (job.layoutProfileSnapshot.strategy !== 'scenes') {
      throw new StudioError('invalid', 'This layout does not use scene analysis.');
    }
    if (job.sceneAnalysis === 'queued' || job.sceneAnalysis === 'running') {
      return this.getJob(job.id);
    }
    job.sceneAnalysis = 'queued';
    job.sceneAnalysisError = null;
    job.updatedAt = nowIso();
    this.deps.store.updateJob(job);
    this.deps.store.enqueueTask(job.id, 'analyze_scenes', {});
    return this.getJob(job.id);
  }

  async createManualShort(jobId: string, request: CreateManualShortRequest): Promise<ShortDetailDto> {
    const job = this.requireJob(jobId);
    if (job.status !== 'ready') {
      throw new StudioError('conflict', 'Job must be ready before adding shorts.');
    }
    const words = job.transcriptWords;
    if (words.length === 0 || request.range.endWord >= words.length) {
      throw new StudioError('invalid', 'Range is outside the transcript.');
    }
    const media = this.requireMedia(job);
    const layout = job.layoutProfileSnapshot;
    const speed = job.creatorProfileSnapshot.render.defaultSpeed;
    let edit = createInitialEdit({ ranges: [request.range], words, speed, hookText: '' });
    edit = normalizeSceneEdit(edit, layout, job.sceneTrack);
    const kept = keptWordIndices(edit, words.length);
    const titleIndices = kept.length > 0
      ? kept
      : Array.from({ length: request.range.endWord - request.range.startWord + 1 }, (_, offset) => request.range.startWord + offset);
    const title = request.title ?? `${titleIndices.slice(0, 8).map((index) => words[index].text).join(' ')}…`;
    const existing = this.deps.store.listShortsForJob(job.id);
    const rank = existing.reduce((max, short) => Math.max(max, short.rank), 0) + 1;
    let shouldEnqueueCrops = false;
    let initialCropStatus: 'none' | 'queued' = 'none';
    if (layout.strategy === 'scenes') {
      if (job.sceneAnalysis === 'done' && job.sceneTrack) {
        const clips = computeSourceClips(edit, words, media.durationSeconds);
        const spans = documentCropSpans({ clips, words, segments: job.sceneTrack.segments });
        if (spans.length > 0) {
          shouldEnqueueCrops = true;
          initialCropStatus = 'queued';
        }
      }
    } else {
      const contentPanel = contentPanelOf(layout);
      if (contentPanel) {
        shouldEnqueueCrops = true;
        initialCropStatus = 'queued';
      }
    }
    const short: ShortRecord = {
      id: createId('short'),
      jobId: job.id,
      rank,
      origin: 'manual',
      title,
      summary: '',
      rationale: '',
      hook: '',
      payoff: '',
      risk: 'low',
      arc: null,
      status: 'active',
      edit,
      editRevision: 1,
      cropAnalysis: initialCropStatus,
      cropAnalysisError: null,
      publishCopy: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.deps.store.createShort(short);
    if (shouldEnqueueCrops) {
      this.deps.store.enqueueTask(job.id, 'analyze_crops', { shortId: short.id });
    }
    return this.shortDetailWithAvailability(job, short);
  }

  async getShort(shortId: string): Promise<ShortDetailDto> {
    const short = this.requireShort(shortId);
    const job = this.requireJob(short.jobId);
    return this.shortDetailWithAvailability(job, short);
  }

  async saveEdit(shortId: string, request: SaveEditRequest): Promise<ShortDetailDto> {
    const short = this.requireShort(shortId);
    const job = this.requireJob(short.jobId);
    this.assertCurrentRevision(short, request.baseRevision);
    let edit: ShortEdit;
    try {
      edit = normalizeEdit(request.edit, job.transcriptWords.length);
      edit = normalizeSceneEdit(edit, job.layoutProfileSnapshot, job.sceneTrack);
    } catch (error) {
      throw new StudioError('invalid', error instanceof Error ? error.message : String(error));
    }
    const updated: ShortRecord = { ...short, edit, editRevision: short.editRevision + 1, updatedAt: nowIso() };
    if (!this.deps.store.updateShortIfRevision(updated, request.baseRevision)) {
      throw this.conflictError(shortId);
    }
    return this.shortDetailWithAvailability(job, updated);
  }

  async revise(shortId: string, request: ReviseRequest): Promise<ReviseResultDto> {
    const short = this.requireShort(shortId);
    const job = this.requireJob(short.jobId);
    this.assertCurrentRevision(short, request.baseRevision);
    const words = job.transcriptWords;
    let intent: RevisionIntent;
    try {
      intent = await this.deps.openRouter.parseRevision({
        title: job.sourceTitle ?? short.title,
        hookText: short.edit.hook.text,
        durationSeconds: outputDurationSeconds(short.edit, words, job.media?.durationSeconds ?? 0),
        segments: job.transcriptSentences.map((sentence) => ({
          start_seconds: sentence.startSeconds,
          end_seconds: sentence.endSeconds,
          text: sentence.text,
        })),
        message: request.message,
      });
    } catch (error) {
      throw new StudioError('unavailable', `Revision parsing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const current = this.requireShort(shortId);
    if (current.editRevision !== request.baseRevision) {
      throw this.conflictError(shortId);
    }
    const warnings: string[] = [];
    let edit = current.edit;
    let title = current.title;
    let applied = 0;
    for (const action of intent.actions) {
      try {
        if (action.kind === 'retitle') {
          title = action.title;
        } else if (action.kind === 'set_hook') {
          edit = { ...edit, hook: { enabled: true, text: action.text } };
        } else if (action.kind === 'trim_start') {
          edit = trimStartBySeconds(edit, words, action.seconds);
        } else if (action.kind === 'trim_end') {
          edit = trimEndBySeconds(edit, words, action.seconds);
        } else if (action.kind === 'extend_start') {
          edit = extendStartBySeconds(edit, words, action.seconds);
        } else if (action.kind === 'extend_end') {
          edit = extendEndBySeconds(edit, words, action.seconds);
        } else if (action.kind === 'insert_span') {
          const range = await this.locateSpanRange(action.query, job);
          edit = addRange(edit, range, words.length);
        } else if (action.kind === 'remove_span') {
          const range = await this.locateSpanRange(action.query, job);
          edit = setWordsRemoved(edit, range.startWord, range.endWord, true, words.length);
        } else if (action.kind === 'set_speed') {
          edit = { ...edit, speed: action.speed };
        } else if (action.kind === 'enable_end_card') {
          edit = { ...edit, endCard: { enabled: true } };
        } else {
          edit = { ...edit, endCard: { enabled: false } };
        }
        applied += 1;
      } catch (error) {
        warnings.push(`"${action.kind}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (applied === 0) {
      throw new StudioError('invalid', `No revision actions could be applied. ${warnings.join(' ')}`);
    }
    try {
      edit = normalizeEdit(edit, words.length);
      edit = normalizeSceneEdit(edit, job.layoutProfileSnapshot, job.sceneTrack);
    } catch (error) {
      throw new StudioError('invalid', error instanceof Error ? error.message : String(error));
    }
    const revised: ShortRecord = { ...current, edit, title, editRevision: current.editRevision + 1, updatedAt: nowIso() };
    if (!this.deps.store.updateShortIfRevision(revised, request.baseRevision)) {
      throw this.conflictError(shortId);
    }
    this.deps.store.appendAction(job.id, 'short_revised', {
      shortId: revised.id,
      summary: intent.summary,
      appliedActionKinds: intent.actions.map((action) => action.kind),
      warnings,
    });
    return {
      detail: await this.shortDetailWithAvailability(job, revised),
      summary: intent.summary,
      warnings,
    };
  }

  async suggestHooks(shortId: string): Promise<HookSuggestionsDto> {
    const short = this.requireShort(shortId);
    const job = this.requireJob(short.jobId);
    const options = await this.deps.openRouter.suggestHooks({
      title: job.sourceTitle ?? short.title,
      summary: short.summary,
      transcriptText: keptText(short.edit, job.transcriptWords),
      current: short.edit.hook.text,
    });
    return { options };
  }

  async updateShortMeta(shortId: string, request: UpdateShortMetaRequest): Promise<ShortDetailDto> {
    const current = this.requireShort(shortId);
    const job = this.requireJob(current.jobId);
    current.title = request.title;
    current.updatedAt = nowIso();
    this.deps.store.updateShort(current);
    return this.shortDetailWithAvailability(job, current);
  }

  async setShortStatus(shortId: string, request: SetShortStatusRequest): Promise<ShortDetailDto> {
    const current = this.requireShort(shortId);
    const job = this.requireJob(current.jobId);
    if (request.status === 'rejected') {
      for (const publication of this.deps.store.listPublicationsForShort(shortId)) {
        const cancellable = publication.scheduledFor !== null
          && (publication.status === 'scheduled' || publication.status === 'queued' || publication.status === 'deferred');
        if (cancellable) {
          await this.cancelPublication(publication.id);
        }
      }
    }
    const latest = this.requireShort(shortId);
    latest.status = request.status;
    latest.updatedAt = nowIso();
    this.deps.store.updateShort(latest);
    return this.shortDetailWithAvailability(job, latest);
  }

  async analyzeCrops(shortId: string): Promise<ShortDetailDto> {
    const short = this.requireShort(shortId);
    const job = this.requireJob(short.jobId);
    if (job.layoutProfileSnapshot.strategy === 'scenes') {
      if (job.sceneAnalysis === 'queued' || job.sceneAnalysis === 'running') {
        throw new StudioError('conflict', 'Scene analysis is still running.');
      }
      if (job.sceneAnalysis === 'failed') {
        throw new StudioError('conflict', job.sceneAnalysisError ?? 'Scene analysis failed.');
      }
      if (job.sceneAnalysis !== 'done' || !job.sceneTrack) {
        throw new StudioError('conflict', 'Scene analysis must be complete before analyzing crops.');
      }
      const media = this.requireMedia(job);
      const clips = computeSourceClips(short.edit, job.transcriptWords, media.durationSeconds);
      const spans = documentCropSpans({ clips, words: job.transcriptWords, segments: job.sceneTrack.segments });
      if (spans.length === 0) {
        throw new StudioError('invalid', 'This short has no document scenes to analyze crops for.');
      }
    } else {
      const contentPanel = contentPanelOf(job.layoutProfileSnapshot);
      if (!contentPanel) {
        throw new StudioError('invalid', 'This layout has no screen-share panel to analyze.');
      }
    }
    if (short.cropAnalysis === 'queued' || short.cropAnalysis === 'running') {
      return this.shortDetailWithAvailability(job, short);
    }
    short.cropAnalysis = 'queued';
    short.cropAnalysisError = null;
    short.updatedAt = nowIso();
    this.deps.store.updateShort(short);
    this.deps.store.enqueueTask(job.id, 'analyze_crops', { shortId: short.id });
    return this.shortDetailWithAvailability(job, short);
  }

  async exportShort(shortId: string): Promise<ShortDetailDto> {
    const short = this.requireShort(shortId);
    const job = this.requireJob(short.jobId);
    if (keptWordIndices(short.edit, job.transcriptWords.length).length === 0) {
      throw new StudioError('invalid', 'Nothing to export: every word is cut');
    }
    if (job.layoutProfileSnapshot.strategy === 'scenes') {
      if (job.sceneAnalysis === 'queued' || job.sceneAnalysis === 'running') {
        throw new StudioError('conflict', 'Scene analysis is still running.');
      }
      if (job.sceneAnalysis === 'failed') {
        throw new StudioError('conflict', job.sceneAnalysisError ?? 'Scene analysis failed.');
      }
      if (job.sceneAnalysis !== 'done' || !job.sceneTrack) {
        throw new StudioError('conflict', 'Scene analysis must be complete before exporting.');
      }
    }
    if (short.cropAnalysis === 'queued' || short.cropAnalysis === 'running') {
      throw new StudioError('conflict', 'Crop analysis is still running for this short.');
    }
    const reusable = this.deps.store
      .listExportsForShort(short.id)
      .find((record) => exportMatchesShort(record, short, job) && (record.status === 'queued' || record.status === 'rendering' || record.status === 'ready'));
    if (reusable) {
      return this.shortDetailWithAvailability(job, short);
    }
    const media = this.requireMedia(job);
    const clips = computeSourceClips(short.edit, job.transcriptWords, media.durationSeconds);
    const frozenSceneTrack = job.layoutProfileSnapshot.strategy === 'scenes' && job.sceneTrack
      ? freezeSceneTrack(job.sceneTrack, clips)
      : null;
    const record: ExportRecord = {
      id: createId('export'),
      jobId: job.id,
      shortId: short.id,
      editRevision: short.editRevision,
      transcriptRevision: job.transcriptRevision,
      edit: short.edit,
      title: short.title,
      hostFraming: job.hostFraming,
      layoutProfileSnapshot: job.layoutProfileSnapshot,
      sceneTrack: frozenSceneTrack,
      status: 'queued',
      artifactPath: null,
      coverPath: null,
      sizeBytes: null,
      durationSeconds: null,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.deps.store.createExport(record);
    this.deps.store.enqueueTask(job.id, 'export_short', { exportId: record.id });
    return this.shortDetailWithAvailability(job, short);
  }

  async generatePublishCopy(shortId: string): Promise<ShortDetailDto> {
    const short = this.requireShort(shortId);
    const job = this.requireJob(short.jobId);
    const response = await this.deps.openRouter.writePublishCopy({
      title: job.sourceTitle ?? short.title,
      summary: short.summary,
      hook: short.edit.hook.text,
      payoff: short.payoff,
      rationale: short.rationale,
      quotes: [],
    });
    const current = this.requireShort(shortId);
    current.publishCopy = { line1: response.line_1, line2: response.line_2, hashtags: response.hashtags };
    current.updatedAt = nowIso();
    this.deps.store.updateShort(current);
    return this.shortDetailWithAvailability(job, current);
  }

  async updatePublishCopy(shortId: string, request: UpdatePublishCopyRequest): Promise<ShortDetailDto> {
    const short = this.requireShort(shortId);
    const job = this.requireJob(short.jobId);
    short.publishCopy = request.copy;
    short.updatedAt = nowIso();
    this.deps.store.updateShort(short);
    return this.shortDetailWithAvailability(job, short);
  }

  async publish(exportId: string, request: PublishRequest): Promise<PublicationDto[]> {
    const exportRecord = this.deps.store.getExport(exportId);
    if (!exportRecord) {
      throw new StudioError('not_found', `Export not found: ${exportId}`);
    }
    if (exportRecord.status !== 'ready') {
      throw new StudioError('conflict', `Export is ${exportRecord.status}; publishing needs a ready render.`);
    }
    const job = this.requireJob(exportRecord.jobId);
    const manifest = await this.deps.profiles.getManifest();
    const resolved = pickPublishingProfile(manifest, job.creatorProfileId);
    if (!resolved.profile) {
      throw new StudioError('invalid', `Unknown creator: ${job.creatorProfileId}`);
    }
    const account = resolved.account;
    if (!account) {
      throw new StudioError('invalid', 'No publishing account is assigned to this creator.');
    }
    if (account.mallaryProfileId === null) {
      throw new StudioError('invalid', 'Account not connected in Mallary');
    }
    if (request.scheduledAt !== null) {
      const problem = scheduledAtProblem(new Date(request.scheduledAt), new Date());
      if (problem !== null) {
        throw new StudioError('invalid', problem);
      }
    }
    const availability = availabilityForPublishingProfile({
      profile: resolved.profile,
      account,
      missingReason: 'No publishing account is assigned to this creator.',
      publisher: this.deps.publisher,
      config: this.deps.config,
    });
    const unavailable = request.platforms
      .map((platform) => availability.find((entry) => entry.platform === platform))
      .filter((entry): entry is PlatformAvailabilityDto => entry !== undefined && !entry.available);
    if (unavailable.length > 0) {
      throw new StudioError('invalid', unavailable.map((entry) => entry.reason).join(' '));
    }
    if (request.scheduledAt !== null) {
      const unschedulable = request.platforms
        .map((platform) => availability.find((entry) => entry.platform === platform))
        .filter((entry): entry is PlatformAvailabilityDto => entry !== undefined && entry.available && !entry.canSchedule)
        .map((entry) => `Scheduling is not available for ${platformLabel(entry.platform)}.`);
      if (unschedulable.length > 0) {
        throw new StudioError('invalid', unschedulable.join(' '));
      }
    }
    if (request.scheduledAt !== null) {
      const scheduledDate = new Date(request.scheduledAt);
      const taken = this.takenSlots(account, manifest, scheduledDate, exportRecord.shortId);
      this.assertManualSpacing(account, taken, scheduledDate);
    }
    const attemptsByShort = this.deps.store.listPublicationsForShort(exportRecord.shortId);
    const planned: Array<{ platform: ShortVideoPlatform; existing: PublicationRecord | null }> = [];
    for (const platform of request.platforms) {
      const attempts = attemptsByShort.filter((entry) => entry.platform === platform);
      const inFlight = attempts.find((entry) => IN_FLIGHT_PUBLICATION_STATUSES.includes(entry.status));
      const posted = attempts.find((entry) => POSTED_OR_UNKNOWN_PUBLICATION_STATUSES.includes(entry.status));
      const requestedScheduledFor = request.scheduledAt === null ? null : new Date(request.scheduledAt).toISOString();
      if (request.force) {
        if (inFlight) {
          throw new StudioError('conflict', `Cannot force repost to ${platformLabel(platform)} while an attempt is still in flight.`);
        }
        if (!posted) {
          throw new StudioError('conflict', `Force repost needs an existing live or unconfirmed ${platformLabel(platform)} post; nothing was posted for this short.`);
        }
        planned.push({ platform, existing: null });
        continue;
      }
      const sameExportInFlight = attempts.find((entry) => entry.exportId === exportRecord.id && IN_FLIGHT_PUBLICATION_STATUSES.includes(entry.status));
      if (sameExportInFlight) {
        if (sameExportInFlight.scheduledFor !== requestedScheduledFor) {
          throw new StudioError('conflict', sameExportInFlight.scheduledFor !== null
            ? `${platformLabel(platform)} already has a post for this export scheduled for ${sameExportInFlight.scheduledFor}. Cancel it first.`
            : `${platformLabel(platform)} is already posting this export.`);
        }
        planned.push({ platform, existing: sameExportInFlight });
        continue;
      }
      if (inFlight) {
        throw new StudioError('conflict', inFlight.scheduledFor !== null
          ? `${platformLabel(platform)} has a scheduled post on another export; cancel it first.`
          : `${platformLabel(platform)} has an attempt still in flight on another export; use Force repost once it settles.`);
      }
      if (posted) {
        throw new StudioError('conflict', posted.status === 'published'
          ? `${platformLabel(platform)} is already live for this short; use Force repost to post it again.`
          : `${platformLabel(platform)} has an unconfirmed attempt; check ${platformLabel(platform)}, then use Force repost.`);
      }
      planned.push({ platform, existing: null });
    }
    const results: PublicationDto[] = [];
    for (const { platform, existing } of planned) {
      if (existing) {
        results.push(this.publicationDto(existing));
        continue;
      }
      const cooldownUntil = activeMallaryCooldownUntil(this.deps.config, this.deps.store, platform);
      const scheduledFor = request.scheduledAt === null ? null : new Date(request.scheduledAt).toISOString();
      const publication: PublicationRecord = {
        id: createId('pub'),
        jobId: exportRecord.jobId,
        shortId: exportRecord.shortId,
        exportId: exportRecord.id,
        platform,
        status: cooldownUntil ? 'deferred' : 'queued',
        forced: request.force,
        provider: null,
        batchId: null,
        remoteJobs: [],
        remoteUrl: null,
        submittedAt: null,
        scheduledFor,
        error: null,
        availableAt: cooldownUntil,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      this.deps.store.createPublication(publication);
      this.deps.store.enqueueTask(job.id, 'publish_short_video', { publicationId: publication.id }, { availableAt: cooldownUntil });
      this.deps.store.appendAction(job.id, 'short_video_publish_queued', {
        publicationId: publication.id,
        platform,
        forced: request.force,
        availableAt: cooldownUntil,
        scheduledFor,
      });
      results.push(this.publicationDto(publication));
    }
    return results;
  }

  async listScheduledPosts(): Promise<ScheduledPostDto[]> {
    const manifest = await this.deps.profiles.getManifest();
    const creatorToAccount = new Map(manifest.creators.map((c) => [c.id, c.accountId]));
    const accountMap = new Map(manifest.accounts.map((a) => [a.id, a]));
    return this.deps.store.listUpcomingScheduledPublications().map((record) => {
      const short = this.requireShort(record.shortId);
      const job = this.requireJob(record.jobId);
      const scheduledFor = record.scheduledFor;
      if (scheduledFor === null) {
        throw new StudioError('conflict', `Scheduled publication ${record.id} has no scheduled time.`);
      }
      const accountId = creatorToAccount.get(job.creatorProfileId);
      if (!accountId) {
        throw new StudioError('conflict', `Creator ${job.creatorProfileId} has no assigned account for scheduled publication.`);
      }
      const account = accountMap.get(accountId);
      if (!account) {
        throw new StudioError('conflict', `Account ${accountId} not found in manifest.`);
      }
      return {
        publicationId: record.id,
        jobId: record.jobId,
        shortId: record.shortId,
        shortTitle: short.title,
        platform: record.platform,
        status: record.status,
        scheduledFor,
        provider: record.provider,
        accountId: account.id,
        timeZone: account.schedule.timeZone,
      };
    });
  }

  async cancelPublication(publicationId: string): Promise<ShortDetailDto> {
    const publication = this.requirePublication(publicationId);
    if (publication.scheduledFor === null) {
      throw new StudioError('conflict', 'Only scheduled posts can be cancelled.');
    }
    const short = this.requireShort(publication.shortId);
    const job = this.requireJob(publication.jobId);
    if (publication.status === 'queued' || publication.status === 'deferred') {
      publication.status = 'cancelled';
      publication.error = null;
      publication.updatedAt = nowIso();
      this.deps.store.updatePublication(publication);
    } else if (publication.status === 'publishing') {
      throw new StudioError('conflict', 'Uploading right now. Try again in a minute.');
    } else if (publication.status === 'scheduled') {
      const remoteJobId = publication.remoteJobs[0]?.jobId ?? '';
      try {
        await this.requirePublisher().cancelScheduled({ provider: publication.provider ?? '', platform: publication.platform, remoteJobId });
      } catch (error) {
        if (error instanceof ShortVideoPublishError) {
          throw new StudioError('conflict', error.message);
        }
        throw error;
      }
      publication.status = 'cancelled';
      publication.error = null;
      publication.updatedAt = nowIso();
      this.deps.store.updatePublication(publication);
    } else {
      throw new StudioError('conflict', 'This post can no longer be cancelled.');
    }
    this.deps.store.appendAction(job.id, 'short_video_schedule_cancelled', {
      publicationId: publication.id,
      platform: publication.platform,
      scheduledFor: publication.scheduledFor,
    });
    return this.shortDetailWithAvailability(job, short);
  }

  private requirePublication(publicationId: string): PublicationRecord {
    const publication = this.deps.store.getPublication(publicationId);
    if (!publication) {
      throw new StudioError('not_found', `Publication not found: ${publicationId}`);
    }
    return publication;
  }

  private assertManualSpacing(account: PublishingAccount, taken: readonly Date[], scheduledAt: Date): void {
    const problem = accountSlotProblem({ account, at: scheduledAt, taken });
    if (problem === 'daily_cap') {
      throw new StudioError('conflict', 'This account already has its daily posting limit scheduled for that day.');
    }
    if (problem === 'spacing') {
      const spacingMs = SCHEDULE_LIMITS.slotSpacingMinutes * 60_000;
      const conflicting = taken.find((slot) => Math.abs(slot.getTime() - scheduledAt.getTime()) < spacingMs) ?? scheduledAt;
      const timeZone = account.schedule.timeZone;
      const city = timeZone.split('/').pop()?.replace(/_/g, ' ') ?? timeZone;
      throw new StudioError('conflict', `Another post is scheduled for ${this.zoneClock(conflicting, timeZone)} (${city} time). Pick a time at least 2 h away.`);
    }
  }

  private zoneClock(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(date);
    const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
    const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
    return `${hour}:${minute}`;
  }

  private accountPublications(accountId: string, manifest: CreatorProfileManifest): PublicationRecord[] {
    const creatorIds = new Set(manifest.creators.filter((creator) => creator.accountId === accountId).map((creator) => creator.id));
    const publications: PublicationRecord[] = [];
    for (const job of this.deps.store.listJobSummaries()) {
      if (!creatorIds.has(job.creatorProfileId)) {
        continue;
      }
      for (const short of this.deps.store.listShortsForJob(job.id)) {
        publications.push(...this.deps.store.listPublicationsForShort(short.id));
      }
    }
    return publications;
  }

  private takenSlots(account: PublishingAccount, manifest: CreatorProfileManifest, from: Date, excludeShortId: string | null): Date[] {
    const creatorToAccount = new Map(manifest.creators.map((creator) => [creator.id, creator.accountId]));
    const jobs = this.deps.store.listJobSummaries().map((job) => ({
      id: job.id,
      accountId: creatorToAccount.get(job.creatorProfileId) ?? null,
    }));
    const parts = zonedDateParts(from, account.schedule.timeZone);
    const dayStart = zonedTimeToUtc({
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: 0,
      minute: 0,
      timeZone: account.schedule.timeZone,
    });
    const fromWithLead = new Date(dayStart.getTime() - SCHEDULE_LIMITS.slotSpacingMinutes * 60_000);
    return accountTakenSlots({
      accountId: account.id,
      jobs,
      publications: this.accountPublications(account.id, manifest),
      from: fromWithLead,
      excludeShortId,
    });
  }

  private requirePublisher(): ShortVideoPublishProvider {
    if (!this.deps.publisher) {
      throw new StudioError('conflict', 'No publish provider is configured.');
    }
    return this.deps.publisher;
  }

  sourceVideoPath(jobId: string): string {
    const job = this.requireJob(jobId);
    if (!job.media) {
      throw new StudioError('not_found', `Job has no source media yet: ${jobId}`);
    }
    return job.media.videoPath;
  }

  thumbnailPath(jobId: string): string {
    const job = this.requireJob(jobId);
    if (!job.media?.thumbnailPath) {
      throw new StudioError('not_found', `Job has no thumbnail: ${jobId}`);
    }
    return job.media.thumbnailPath;
  }

  async framePath(jobId: string, seconds: number, width: number): Promise<string> {
    const job = this.requireJob(jobId);
    const media = this.requireMedia(job);
    if (seconds < 0 || seconds > media.durationSeconds) {
      throw new StudioError('invalid', `Frame time ${seconds}s is outside the media duration of ${media.durationSeconds}s.`);
    }
    const frameWidth = clamp(Math.round(width), 160, 1920);
    const outputPath = join(this.deps.config.artifactsDir, job.id, 'frames', `${Math.round(seconds * 1000)}_${frameWidth}.jpg`);
    if (!existsSync(outputPath)) {
      let pending = this.frameRenders.get(outputPath);
      if (!pending) {
        pending = this.renderFrame(jobId, seconds, frameWidth, outputPath).finally(() => {
          this.frameRenders.delete(outputPath);
        });
        this.frameRenders.set(outputPath, pending);
      }
      await pending;
    }
    return outputPath;
  }

  private async renderFrame(jobId: string, seconds: number, width: number, outputPath: string): Promise<string> {
    const media = this.requireMedia(this.requireJob(jobId));
    const tempPath = `${outputPath}.tmp-${createId('frame')}.jpg`;
    try {
      await extractFrame({ videoPath: media.videoPath, seconds, width, outputPath: tempPath });
      await rename(tempPath, outputPath);
    } catch (error) {
      if (existsSync(tempPath)) {
        await rm(tempPath, { force: true });
      }
      throw error;
    }
    return outputPath;
  }

  exportVideoPath(exportId: string): string {
    const record = this.deps.store.getExport(exportId);
    if (!record?.artifactPath) {
      throw new StudioError('not_found', `Export has no video yet: ${exportId}`);
    }
    return record.artifactPath;
  }

  exportCoverPath(exportId: string): string {
    const record = this.deps.store.getExport(exportId);
    if (!record?.coverPath) {
      throw new StudioError('not_found', `Export has no cover yet: ${exportId}`);
    }
    return record.coverPath;
  }

  private studioDefaultCreatorId(): string | null {
    return this.deps.store.getSetting(DEFAULT_CREATOR_SETTING_KEY);
  }

  private assertCurrentRevision(short: ShortRecord, baseRevision: number): void {
    if (baseRevision !== short.editRevision) {
      throw new StudioError('conflict', `Edit changed meanwhile (current revision ${short.editRevision}).`);
    }
  }

  private conflictError(shortId: string): StudioError {
    const current = this.requireShort(shortId);
    return new StudioError('conflict', `Edit changed meanwhile (current revision ${current.editRevision}).`);
  }

  private async locateSpanRange(query: string, job: JobRecord): Promise<WordRange> {
    const located = await this.deps.openRouter.locateTranscriptSpan({ query, sentences: job.transcriptSentences });
    const start = job.transcriptSentences.find((sentence) => sentence.id === located.start_sentence_id);
    const end = job.transcriptSentences.find((sentence) => sentence.id === located.end_sentence_id);
    if (!start || !end) {
      throw new Error(`Transcript span for "${query}" is not part of this video.`);
    }
    return {
      startWord: Math.min(start.startWord, end.startWord),
      endWord: Math.max(start.endWord, end.endWord),
    };
  }

  private requireJob(jobId: string): JobRecord {
    const job = this.deps.store.getJob(jobId);
    if (!job) {
      throw new StudioError('not_found', `Job not found: ${jobId}`);
    }
    return job;
  }

  private requireShort(shortId: string): ShortRecord {
    const short = this.deps.store.getShort(shortId);
    if (!short) {
      throw new StudioError('not_found', `Short not found: ${shortId}`);
    }
    return short;
  }

  private requireMedia(job: JobRecord): SourceMedia {
    if (!job.media) {
      throw new StudioError('not_found', `Job has no source media yet: ${job.id}`);
    }
    return job.media;
  }

  private jobSummary(job: JobSummaryRecord): JobSummaryDto {
    const shorts = this.deps.store.listShortsForJob(job.id);
    let exported = 0;
    for (const short of shorts) {
      if (this.deps.store.listExportsForShort(short.id).length > 0) {
        exported += 1;
      }
    }
    return {
      id: job.id,
      sourceUrl: job.sourceUrl,
      title: job.sourceTitle,
      thumbnailUrl: job.media?.thumbnailPath ? MEDIA_ROUTES.thumbnail(job.id) : null,
      status: job.status,
      progress: job.progress,
      error: job.error,
      creator: { id: job.creatorProfileSnapshot.id, displayName: job.creatorProfileSnapshot.displayName },
      shortCounts: {
        active: shorts.filter((short) => short.status === 'active').length,
        rejected: shorts.filter((short) => short.status === 'rejected').length,
        exported,
      },
      sceneAnalysis: {
        status: job.sceneAnalysis,
        error: job.sceneAnalysisError,
      },
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private jobMedia(job: JobRecord): JobMediaDto | null {
    if (!job.media) {
      return null;
    }
    return {
      width: job.media.width,
      height: job.media.height,
      fps: job.media.fps,
      durationSeconds: job.media.durationSeconds,
      videoUrl: MEDIA_ROUTES.source(job.id),
    };
  }

  private speakerSamples(job: JobRecord): SpeakerSampleDto[] {
    return job.strongSpeakers.map((speaker) => ({
      speakerId: speaker.speakerId,
      totalSeconds: speaker.totalSeconds,
      samples: speaker.sampleSentences.map((sentence) => ({
        startSeconds: sentence.startSeconds,
        endSeconds: sentence.endSeconds,
        text: sentence.text,
      })),
    }));
  }

  private shortSummary(job: JobRecord, short: ShortRecord): ShortSummaryDto {
    const latestExport = this.deps.store.listExportsForShort(short.id)[0] ?? null;
    return {
      id: short.id,
      jobId: short.jobId,
      rank: short.rank,
      origin: short.origin,
      title: short.title,
      summary: short.summary,
      status: short.status,
      durationSeconds: outputDurationSeconds(short.edit, job.transcriptWords, job.media?.durationSeconds ?? 0),
      hookText: short.edit.hook.text,
      cropAnalysis: short.cropAnalysis,
      latestExport: latestExport ? this.exportDto(latestExport, short, job) : null,
      updatedAt: short.updatedAt,
    };
  }

  private exportDto(record: ExportRecord, short: ShortRecord, job: JobRecord): ExportDto {
    return {
      id: record.id,
      shortId: record.shortId,
      editRevision: record.editRevision,
      current: exportMatchesShort(record, short, job),
      status: record.status,
      error: record.error,
      videoUrl: record.status === 'ready' && record.artifactPath ? MEDIA_ROUTES.export(record.id) : null,
      coverUrl: record.coverPath ? MEDIA_ROUTES.exportCover(record.id) : null,
      sizeBytes: record.sizeBytes,
      durationSeconds: record.durationSeconds,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private publicationDto(record: PublicationRecord): PublicationDto {
    return {
      id: record.id,
      exportId: record.exportId,
      platform: record.platform,
      status: record.status,
      provider: record.provider,
      url: record.remoteUrl,
      error: record.error,
      forced: record.forced,
      availableAt: record.availableAt,
      submittedAt: record.submittedAt,
      scheduledFor: record.scheduledFor,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private async shortDetailWithAvailability(job: JobRecord, short: ShortRecord): Promise<ShortDetailDto> {
    const manifest = await this.deps.profiles.getManifest();
    const profile = manifest.creators.find((creator) => creator.id === job.creatorProfileId) ?? null;
    const account = profile?.accountId
      ? manifest.accounts.find((acc) => acc.id === profile.accountId) ?? null
      : null;
    const platforms = availabilityForPublishingProfile({
      profile,
      account,
      missingReason: 'No publishing account is assigned to this creator.',
      publisher: this.deps.publisher,
      config: this.deps.config,
    });
    const taken = account
      ? this.takenSlots(account, manifest, new Date(), short.id)
      : [];
    return this.shortDetail(job, short, platforms, account, taken);
  }

  private shortDetail(
    job: JobRecord,
    short: ShortRecord,
    platforms: PlatformAvailabilityDto[],
    account: PublishingAccount | null,
    takenSlots: readonly Date[],
  ): ShortDetailDto {
    const media = this.jobMedia(job);
    if (!media) {
      throw new StudioError('not_found', `Job has no source media yet: ${job.id}`);
    }
    return {
      short: {
        ...this.shortSummary(job, short),
        rationale: short.rationale,
        hook: short.hook,
        payoff: short.payoff,
        risk: short.risk,
        arc: short.arc,
        edit: short.edit,
        editRevision: short.editRevision,
        cropAnalysisError: short.cropAnalysisError,
        publishCopy: short.publishCopy,
      },
      job: {
        id: job.id,
        title: job.sourceTitle,
        sourceUrl: job.sourceUrl,
        thumbnailUrl: job.media?.thumbnailPath ? MEDIA_ROUTES.thumbnail(job.id) : null,
        media,
        layout: job.layoutProfileSnapshot,
        hostFraming: job.hostFraming,
        sceneTrack: job.sceneTrack,
        sceneAnalysis: {
          status: job.sceneAnalysis,
          error: job.sceneAnalysisError,
        },
        fontUrl: MEDIA_ROUTES.font(basename(job.layoutProfileSnapshot.font.file)),
        account: account ? this.accountDto(account) : null,
        takenSlots: takenSlots.map((d) => d.toISOString()),
      },
      exports: this.deps.store.listExportsForShort(short.id).map((record) => this.exportDto(record, short, job)),
      publications: this.deps.store.listPublicationsForShort(short.id).map((record) => this.publicationDto(record)),
      platforms,
    };
  }

  private accountDto(account: PublishingAccount): PublishingAccountDto {
    return {
      id: account.id,
      displayName: account.displayName,
      schedule: account.schedule,
      platforms: account.platforms,
      connected: account.mallaryProfileId !== null,
    };
  }
}

const HOST_SPEAKER_MAX_SAMPLES = 6;

function spreadSpeakerSamples(sentences: TranscriptSentence[]): string[] {
  if (sentences.length <= HOST_SPEAKER_MAX_SAMPLES) {
    return sentences.map((sentence) => sentence.text);
  }
  const indexes = new Set<number>();
  for (let slot = 0; slot < HOST_SPEAKER_MAX_SAMPLES; slot += 1) {
    indexes.add(Math.round((slot * (sentences.length - 1)) / (HOST_SPEAKER_MAX_SAMPLES - 1)));
  }
  return [...indexes].sort((a, b) => a - b).map((index) => sentences[index].text);
}
