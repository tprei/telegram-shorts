import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { addRange, createInitialEdit, extendEndBySeconds, extendStartBySeconds, keptText, keptWordIndices, normalizeEdit, setWordsRemoved, trimEndBySeconds, trimStartBySeconds, type ShortEdit, type WordRange } from '../domain/edit.js';
import { outputDurationSeconds } from '../domain/timeline.js';
import { sentenceText } from '../domain/policies.js';
import { IN_FLIGHT_PUBLICATION_STATUSES, POSTED_OR_UNKNOWN_PUBLICATION_STATUSES, type ExportRecord, type JobRecord, type JobSummaryRecord, type PublicationRecord, type ShortRecord, type ShortVideoPlatform, type SourceMedia } from '../domain/model.js';
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
  type PublishRequest,
  type ReviseRequest,
  type ReviseResultDto,
  type SaveEditRequest,
  type SetDefaultCreatorRequest,
  type SetShortStatusRequest,
  type ShortDetailDto,
  type ShortSummaryDto,
  type SpeakerSampleDto,
  type TranscriptDto,
  type UpdatePublishCopyRequest,
  type UpdateShortMetaRequest,
  type StudioApi,
} from '../studio/api-types.js';
import { StudioError } from './errors.js';
import type { StudioMediaResolver } from './studio-media.js';
import { activeMallaryCooldownUntil, platformAvailability, platformAvailabilityFromSnapshot, platformLabel } from './platforms.js';
import type { CreatorProfileRepository } from '../infra/creator-profile-loader.js';
import type { AppConfig } from '../infra/env.js';
import { ShortsStore } from '../infra/db.js';
import { extractFrame } from '../infra/render.js';
import { assertPublicYouTubeUrl } from '../infra/youtube.js';
import type { ShortVideoPublishProvider } from '../infra/instagram-publisher.js';
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
    return creators.map((creator) => ({ id: creator.id, displayName: creator.displayName, isDefault: creator.id === resolved.profile.id }));
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
    if (!job.layoutProfileSnapshot.panels.some((panel) => panel.role === 'host')) {
      throw new StudioError('invalid', 'This layout has no host panel to analyze.');
    }
    job.hostFramingAnalyzedAt = null;
    job.updatedAt = nowIso();
    this.deps.store.updateJob(job);
    this.deps.store.enqueueTask(job.id, 'analyze_host', {});
    return this.getJob(job.id);
  }

  createManualShort(jobId: string, request: CreateManualShortRequest): ShortDetailDto {
    const job = this.requireJob(jobId);
    if (job.status !== 'ready') {
      throw new StudioError('conflict', 'Job must be ready before adding shorts.');
    }
    const words = job.transcriptWords;
    if (words.length === 0 || request.range.endWord >= words.length) {
      throw new StudioError('invalid', 'Range is outside the transcript.');
    }
    const layout = job.layoutProfileSnapshot;
    const edit = createInitialEdit({ ranges: [request.range], words, speed: layout.defaultSpeed, hookText: '' });
    const kept = keptWordIndices(edit, words.length);
    const titleIndices = kept.length > 0
      ? kept
      : Array.from({ length: request.range.endWord - request.range.startWord + 1 }, (_, offset) => request.range.startWord + offset);
    const title = request.title ?? `${titleIndices.slice(0, 8).map((index) => words[index].text).join(' ')}…`;
    const existing = this.deps.store.listShortsForJob(job.id);
    const rank = existing.reduce((max, short) => Math.max(max, short.rank), 0) + 1;
    const hasContentPanel = layout.panels.some((panel) => panel.role === 'content');
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
      cropAnalysis: hasContentPanel ? 'queued' : 'none',
      cropAnalysisError: null,
      publishCopy: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.deps.store.createShort(short);
    if (hasContentPanel) {
      this.deps.store.enqueueTask(job.id, 'analyze_crops', { shortId: short.id });
    }
    return this.shortDetail(job, short, platformAvailabilityFromSnapshot(job, this.deps.publisher, this.deps.config));
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
    edit = normalizeEdit(edit, words.length);
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
    current.status = request.status;
    current.updatedAt = nowIso();
    this.deps.store.updateShort(current);
    return this.shortDetailWithAvailability(job, current);
  }

  async analyzeCrops(shortId: string): Promise<ShortDetailDto> {
    const short = this.requireShort(shortId);
    const job = this.requireJob(short.jobId);
    const hasContentPanel = job.layoutProfileSnapshot.panels.some((panel) => panel.role === 'content');
    if (!hasContentPanel) {
      throw new StudioError('invalid', 'This layout has no screen-share panel to analyze.');
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
    const reusable = this.deps.store
      .listExportsForShort(short.id)
      .find((record) => this.exportIsCurrent(record, short, job) && (record.status === 'queued' || record.status === 'rendering' || record.status === 'ready'));
    if (reusable) {
      return this.shortDetailWithAvailability(job, short);
    }
    const record: ExportRecord = {
      id: createId('export'),
      jobId: job.id,
      shortId: short.id,
      editRevision: short.editRevision,
      transcriptRevision: job.transcriptRevision,
      edit: short.edit,
      title: short.title,
      hostFraming: job.hostFraming,
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
    const availability = await platformAvailability(job, this.deps.publisher, this.deps.config, this.deps.profiles);
    const unavailable = request.platforms
      .map((platform) => availability.find((entry) => entry.platform === platform))
      .filter((entry): entry is PlatformAvailabilityDto => entry !== undefined && !entry.available);
    if (unavailable.length > 0) {
      throw new StudioError('invalid', unavailable.map((entry) => entry.reason).join(' '));
    }
    const attemptsByShort = this.deps.store.listPublicationsForShort(exportRecord.shortId);
    const planned: Array<{ platform: ShortVideoPlatform; existing: PublicationRecord | null }> = [];
    for (const platform of request.platforms) {
      const attempts = attemptsByShort.filter((entry) => entry.platform === platform);
      const inFlight = attempts.find((entry) => IN_FLIGHT_PUBLICATION_STATUSES.includes(entry.status));
      const posted = attempts.find((entry) => POSTED_OR_UNKNOWN_PUBLICATION_STATUSES.includes(entry.status));
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
        planned.push({ platform, existing: sameExportInFlight });
        continue;
      }
      if (inFlight) {
        throw new StudioError('conflict', `${platformLabel(platform)} has an attempt still in flight on another export; use Force repost once it settles.`);
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
      });
      results.push(this.publicationDto(publication));
    }
    return results;
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

  private exportIsCurrent(record: ExportRecord, short: ShortRecord, job: JobRecord): boolean {
    return record.editRevision === short.editRevision
      && record.title === short.title
      && record.transcriptRevision === job.transcriptRevision
      && JSON.stringify(record.hostFraming) === JSON.stringify(job.hostFraming);
  }

  private exportDto(record: ExportRecord, short: ShortRecord, job: JobRecord): ExportDto {
    return {
      id: record.id,
      shortId: record.shortId,
      editRevision: record.editRevision,
      current: this.exportIsCurrent(record, short, job),
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
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private shortDetailWithAvailability(job: JobRecord, short: ShortRecord): Promise<ShortDetailDto> {
    return platformAvailability(job, this.deps.publisher, this.deps.config, this.deps.profiles).then((platforms) => this.shortDetail(job, short, platforms));
  }

  private shortDetail(job: JobRecord, short: ShortRecord, platforms: PlatformAvailabilityDto[]): ShortDetailDto {
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
        fontUrl: MEDIA_ROUTES.font(basename(job.layoutProfileSnapshot.font.file)),
      },
      exports: this.deps.store.listExportsForShort(short.id).map((record) => this.exportDto(record, short, job)),
      publications: this.deps.store.listPublicationsForShort(short.id).map((record) => this.publicationDto(record)),
      platforms,
    };
  }
}
