import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { createInitialEdit, keptWordIndices, replaceAutoCrops, type ShortEdit } from '../domain/edit.js';
import { QUEUE_LANES, type JobRecord, type PublicationRecord, type QueueLane, type QueueTask, type ShortRecord, type SourceMedia, type TranscriptWord } from '../domain/model.js';
import { computeSourceClips, buildTimeline, type SourceClip } from '../domain/timeline.js';
import { buildSentences, detectStrongSpeakers } from '../domain/policies.js';
import type { ContentPanel, LayoutProfile } from '../domain/layout.js';
import { buildPlannedShorts, diagnoseCandidatePlan, fallbackSemanticBlocks, materializeSemanticBlocks, semanticBlocksAreUsable } from '../domain/semantic.js';
import type { CreatorProfileRepository } from '../infra/creator-profile-loader.js';
import { buildPublishMessage } from '../infra/mallary.js';
import { extractFrame, renderShortExport } from '../infra/render.js';
import { transcribeSource } from '../infra/transcript.js';
import { analyzeContentCrops } from '../infra/vision.js';
import { downloadSource } from '../infra/youtube.js';
import type { AppConfig } from '../infra/env.js';
import { ShortsStore } from '../infra/db.js';
import { ShortVideoPublishError, type ShortVideoPublishProvider } from '../infra/instagram-publisher.js';
import { createId, logError, nowIso } from '../infra/util.js';
import type { OpenRouterClient } from '../infra/openrouter.js';
import { mallaryCooldownKey, platformAvailability } from './platforms.js';

const EmptyPayloadSchema = z.strictObject({});
const AnalyzeCropsPayloadSchema = z.strictObject({ shortId: z.string().min(1) });
const ExportShortPayloadSchema = z.strictObject({ exportId: z.string().min(1) });
const PublishShortVideoPayloadSchema = z.strictObject({ publicationId: z.string().min(1) });

export interface ShortsPipelineDeps {
  config: AppConfig;
  store: ShortsStore;
  openRouter: OpenRouterClient;
  profiles: CreatorProfileRepository;
  publisher: ShortVideoPublishProvider | null;
}

export class ShortsPipeline {
  constructor(private readonly deps: ShortsPipelineDeps) {}

  async runNext(lane: QueueLane): Promise<boolean> {
    const task = this.deps.store.claimNextTask(QUEUE_LANES[lane]);
    if (!task) {
      return false;
    }
    try {
      await this.runTask(task);
      this.deps.store.completeTask(task);
      return true;
    } catch (error) {
      return this.handleTaskFailure(task, error);
    }
  }

  private async runTask(task: QueueTask): Promise<void> {
    if (task.kind === 'process_source') {
      EmptyPayloadSchema.parse(task.payload);
      await this.processSource(task);
      return;
    }
    if (task.kind === 'plan_shorts') {
      EmptyPayloadSchema.parse(task.payload);
      await this.planShorts(task);
      return;
    }
    if (task.kind === 'analyze_crops') {
      const { shortId } = AnalyzeCropsPayloadSchema.parse(task.payload);
      await this.analyzeCrops(shortId);
      return;
    }
    if (task.kind === 'export_short') {
      const { exportId } = ExportShortPayloadSchema.parse(task.payload);
      await this.exportShort(exportId);
      return;
    }
    const { publicationId } = PublishShortVideoPayloadSchema.parse(task.payload);
    await this.publishShortVideo(publicationId);
  }

  private async processSource(task: QueueTask): Promise<void> {
    const job = this.requireJob(task.jobId);
    job.status = 'downloading';
    job.progress = 'Downloading video';
    job.updatedAt = nowIso();
    this.deps.store.updateJob(job);
    const jobDir = await this.ensureJobDir(job.id);
    const { title, media } = await downloadSource(jobDir, job.sourceUrl, {
      cookiesPath: this.deps.config.SHORTS_YTDLP_COOKIES_PATH ? resolve(this.deps.config.rootDir, this.deps.config.SHORTS_YTDLP_COOKIES_PATH) : undefined,
      cookiesFromBrowser: this.deps.config.SHORTS_YTDLP_COOKIES_FROM_BROWSER,
      jsRuntime: this.deps.config.SHORTS_YTDLP_JS_RUNTIME,
    });
    job.status = 'transcribing';
    job.progress = null;
    job.sourceTitle = title;
    job.media = media;
    job.updatedAt = nowIso();
    this.deps.store.updateJob(job);
    const words = await transcribeSource(this.deps.config, media.audioPath);
    job.transcriptWords = words;
    await writeFile(join(jobDir, 'transcript.words.json'), `${JSON.stringify(words, null, 2)}\n`, 'utf-8');
    job.strongSpeakers = detectStrongSpeakers(words);
    if (job.strongSpeakers.length > 1 && !job.chosenSpeakerId) {
      job.status = 'awaiting_speaker';
      job.updatedAt = nowIso();
      this.deps.store.updateJob(job);
      return;
    }
    job.chosenSpeakerId ??= job.strongSpeakers[0]?.speakerId ?? words[0]?.speakerId ?? null;
    job.status = 'planning';
    job.updatedAt = nowIso();
    this.deps.store.updateJob(job);
    this.deps.store.enqueueTask(job.id, 'plan_shorts', {});
  }

  private async planShorts(task: QueueTask): Promise<void> {
    const job = this.requireJob(task.jobId);
    const words = job.transcriptWords;
    const chosenSpeakerId = job.chosenSpeakerId ?? job.strongSpeakers[0]?.speakerId ?? words[0]?.speakerId ?? null;
    job.chosenSpeakerId = chosenSpeakerId;
    const sentences = buildSentences(words, chosenSpeakerId ?? undefined);
    if (sentences.length === 0) {
      throw new Error('Transcript did not produce any usable host sentences.');
    }
    job.transcriptSentences = sentences;
    const layout = job.layoutProfileSnapshot;
    const speed = layout.defaultSpeed;
    let blocks = fallbackSemanticBlocks(sentences);
    try {
      const response = await this.deps.openRouter.buildSemanticBlocks({ title: job.sourceTitle, sentences });
      const proposed = materializeSemanticBlocks(sentences, response);
      if (semanticBlocksAreUsable(proposed)) {
        blocks = proposed;
      }
    } catch (error) {
      logError('Semantic block building failed; using fallback segmentation', error, { jobId: job.id });
    }
    job.semanticBlocks = blocks;
    this.deps.store.updateJob(job);
    const blockPayload = blocks.map((block) => ({
      id: block.id,
      kind: block.kind,
      summary: block.summary,
      start_seconds: block.startSeconds,
      end_seconds: block.endSeconds,
      text: block.text,
    }));
    let opportunities = await this.deps.openRouter.findOpportunities({ title: job.sourceTitle, blocks: blockPayload });
    let plan = await this.deps.openRouter.planCandidates({ title: job.sourceTitle, blocks: blockPayload, opportunities: opportunities.opportunities });
    let diagnostics = diagnoseCandidatePlan(sentences, blocks, plan, speed);
    let planned = buildPlannedShorts({ sentences, blocks, plan, speed });
    if (planned.length === 0) {
      opportunities = await this.deps.openRouter.repairOpportunityPlan({
        title: job.sourceTitle,
        blocks: blockPayload,
        opportunities: opportunities.opportunities,
        diagnostics,
      });
      plan = await this.deps.openRouter.planCandidates({ title: job.sourceTitle, blocks: blockPayload, opportunities: opportunities.opportunities });
      diagnostics = diagnoseCandidatePlan(sentences, blocks, plan, speed);
      planned = buildPlannedShorts({ sentences, blocks, plan, speed });
    }
    if (planned.length === 0) {
      const summary = diagnostics.map((entry) => `#${entry.index + 1} ${entry.title}: ${entry.reasons.join('; ') || 'no diagnostic reason'}`).join(' | ');
      throw new Error(`No valid short candidates were produced. ${summary}`);
    }
    const contentPanel = contentPanelOf(layout);
    const existing = this.deps.store.listShortsForJob(job.id);
    let nextRank = existing.reduce((max, short) => Math.max(max, short.rank), 0);
    for (const item of planned) {
      const edit = createInitialEdit({ ranges: item.ranges, words, speed, hookText: item.hookText });
      const kept = keptWordIndices(edit, words.length);
      if (overlapsExistingShort(kept, existing, words.length)) {
        continue;
      }
      nextRank += 1;
      const short: ShortRecord = {
        id: createId('short'),
        jobId: job.id,
        rank: nextRank,
        origin: 'planner',
        title: item.title,
        summary: item.summary,
        rationale: item.rationale,
        hook: item.hook,
        payoff: item.payoff,
        risk: item.risk,
        arc: item.arc,
        status: 'active',
        edit,
        editRevision: 1,
        cropAnalysis: contentPanel ? 'queued' : 'none',
        cropAnalysisError: null,
        publishCopy: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      this.deps.store.createShort(short);
      existing.push(short);
      if (contentPanel) {
        this.deps.store.enqueueTask(job.id, 'analyze_crops', { shortId: short.id });
      }
    }
    job.status = 'ready';
    job.progress = null;
    job.error = null;
    job.failedTaskKind = null;
    job.updatedAt = nowIso();
    this.deps.store.updateJob(job);
  }

  private async analyzeCrops(shortId: string): Promise<void> {
    const short = this.requireShort(shortId);
    const job = this.requireJob(short.jobId);
    const panel = contentPanelOf(job.layoutProfileSnapshot);
    if (!panel) {
      throw new Error(`Layout for job ${job.id} has no content panel for crop analysis.`);
    }
    const media = this.requireMedia(job);
    short.cropAnalysis = 'running';
    short.updatedAt = nowIso();
    this.deps.store.updateShort(short);
    const clips = computeSourceClips(short.edit, job.transcriptWords, media.durationSeconds);
    const spans = buildCropAnalysisSpans(short.edit, clips, job.transcriptWords);
    const keyframes = await analyzeContentCrops({
      config: this.deps.config,
      videoPath: media.videoPath,
      source: { width: media.width, height: media.height },
      panel,
      spans,
      words: job.transcriptWords,
      workDir: join(await this.ensureJobDir(job.id), 'crops'),
    });
    const current = this.requireShort(shortId);
    const next: ShortRecord = {
      ...current,
      edit: replaceAutoCrops(current.edit, keyframes),
      editRevision: current.editRevision + 1,
      cropAnalysis: 'done',
      cropAnalysisError: null,
      updatedAt: nowIso(),
    };
    if (this.deps.store.updateShortIfRevision(next, current.editRevision)) {
      return;
    }
    const latest = this.requireShort(shortId);
    const retried: ShortRecord = {
      ...latest,
      edit: replaceAutoCrops(latest.edit, keyframes),
      editRevision: latest.editRevision + 1,
      cropAnalysis: 'done',
      cropAnalysisError: null,
      updatedAt: nowIso(),
    };
    if (this.deps.store.updateShortIfRevision(retried, latest.editRevision)) {
      return;
    }
    const settled = this.requireShort(shortId);
    settled.cropAnalysis = 'done';
    settled.cropAnalysisError = null;
    settled.updatedAt = nowIso();
    this.deps.store.updateShort(settled);
  }

  private async exportShort(exportId: string): Promise<void> {
    const record = this.deps.store.getExport(exportId);
    if (!record) {
      throw new Error(`Export not found: ${exportId}`);
    }
    if (record.status === 'ready') {
      return;
    }
    const job = this.requireJob(record.jobId);
    const media = this.requireMedia(job);
    record.status = 'rendering';
    record.error = null;
    record.updatedAt = nowIso();
    this.deps.store.updateExport(record);
    const timeline = buildTimeline({
      edit: record.edit,
      title: record.title,
      words: job.transcriptWords,
      layout: job.layoutProfileSnapshot,
      source: { width: media.width, height: media.height, durationSeconds: media.durationSeconds },
    });
    const result = await renderShortExport({
      timeline,
      layout: job.layoutProfileSnapshot,
      sourceVideoPath: media.videoPath,
      workDir: join(await this.ensureJobDir(job.id), 'exports', record.id),
      fontsDir: this.deps.config.fontsDir,
      endCardThumbnailPath: media.thumbnailPath,
    });
    record.status = 'ready';
    record.artifactPath = result.artifactPath;
    record.sizeBytes = result.sizeBytes;
    record.durationSeconds = result.durationSeconds;
    record.error = null;
    record.updatedAt = nowIso();
    this.deps.store.updateExport(record);
  }

  private async publishShortVideo(publicationId: string): Promise<void> {
    const publication = this.requirePublication(publicationId);
    if (publication.status === 'published' || publication.status === 'failed') {
      return;
    }
    const exportRecord = this.deps.store.getExport(publication.exportId);
    if (!exportRecord || exportRecord.status !== 'ready' || !exportRecord.artifactPath) {
      throw new Error(`Export ${publication.exportId} is not ready for publishing.`);
    }
    const short = this.requireShort(publication.shortId);
    const job = this.requireJob(publication.jobId);
    if (!this.deps.publisher || !this.deps.publisher.supports(publication.platform)) {
      throw new Error(`No provider configured for ${publication.platform}.`);
    }
    const availability = await platformAvailability(job, this.deps.publisher, this.deps.config, this.deps.profiles);
    const platformAvailabilityEntry = availability.find((entry) => entry.platform === publication.platform);
    if (!platformAvailabilityEntry?.available) {
      const reason = platformAvailabilityEntry?.reason ?? `No provider configured for ${publication.platform}.`;
      publication.status = 'failed';
      publication.error = reason;
      publication.updatedAt = nowIso();
      this.deps.store.updatePublication(publication);
      this.deps.store.appendAction(job.id, 'short_video_publish_failed', { publicationId: publication.id, error: reason });
      return;
    }
    publication.status = 'publishing';
    publication.error = null;
    publication.updatedAt = nowIso();
    this.deps.store.updatePublication(publication);
    let copy = short.publishCopy;
    if (!copy) {
      const response = await this.deps.openRouter.writePublishCopy({
        title: short.title,
        summary: short.summary,
        hook: short.edit.hook.text,
        payoff: short.payoff,
        rationale: short.rationale,
        quotes: [],
      });
      const current = this.requireShort(publication.shortId);
      copy = { line1: response.line_1, line2: response.line_2, hashtags: response.hashtags };
      current.publishCopy = copy;
      current.updatedAt = nowIso();
      this.deps.store.updateShort(current);
    }
    let coverPath: string | null = null;
    if (publication.platform === 'instagram') {
      coverPath = `${exportRecord.artifactPath}.cover.jpg`;
      await extractFrame({ videoPath: exportRecord.artifactPath, seconds: 0.6, width: 1080, outputPath: coverPath });
    }
    const result = await this.deps.publisher.publishShortVideo({
      platform: publication.platform,
      filePath: exportRecord.artifactPath,
      message: buildPublishMessage(copy),
      title: publication.platform === 'youtube_shorts' ? short.title : null,
      idempotencyKey: publication.forced
        ? `shorts-${publication.platform}-${exportRecord.id}-${publication.id}`
        : `shorts-${publication.platform}-${exportRecord.id}`,
      thumbnailPath: coverPath,
      commentsUnderPost: publication.platform === 'instagram' && job.sourceUrl
        ? [`Vídeo completo: ${job.sourceUrl}`]
        : [],
    });
    publication.status = 'published';
    publication.provider = result.provider;
    publication.batchId = result.batchId;
    publication.remoteJobs = result.jobs;
    publication.error = null;
    publication.updatedAt = nowIso();
    this.deps.store.updatePublication(publication);
    this.deps.store.appendAction(job.id, 'short_video_published', {
      publicationId: publication.id,
      platform: publication.platform,
      provider: result.provider,
      batchId: result.batchId,
      jobs: result.jobs,
      forced: publication.forced,
    });
  }

  private handleTaskFailure(task: QueueTask, error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (task.kind === 'publish_short_video') {
      const { publicationId } = PublishShortVideoPayloadSchema.parse(task.payload);
      const publication = this.deps.store.getPublication(publicationId);
      if (error instanceof ShortVideoPublishError && error.provider === 'mallary' && error.retryAfterSeconds !== null) {
        const availableAt = new Date(Date.now() + error.retryAfterSeconds * 1000).toISOString();
        if (publication) {
          publication.status = 'deferred';
          publication.availableAt = availableAt;
          publication.error = message;
          publication.updatedAt = nowIso();
          this.deps.store.updatePublication(publication);
          this.deps.store.setSetting(mallaryCooldownKey(publication.platform), availableAt);
        }
        this.deps.store.rescheduleTask(task, availableAt, message);
        this.deps.store.appendAction(task.jobId, 'short_video_publish_deferred', {
          publicationId,
          platform: publication?.platform ?? null,
          provider: error.provider,
          retryAfterSeconds: error.retryAfterSeconds,
          availableAt,
          error: message,
        });
        return true;
      }
      if (publication) {
        publication.status = 'failed';
        publication.error = message;
        publication.updatedAt = nowIso();
        this.deps.store.updatePublication(publication);
      }
      this.deps.store.failTask(task, message);
      this.deps.store.appendAction(task.jobId, 'short_video_publish_failed', { publicationId, error: message });
      return true;
    }
    this.deps.store.failTask(task, message);
    if (task.kind === 'process_source' || task.kind === 'plan_shorts') {
      const job = this.deps.store.getJob(task.jobId);
      if (job) {
        const keepsShorts = task.kind === 'plan_shorts' && this.deps.store.listShortsForJob(job.id).some((short) => short.status === 'active');
        job.status = keepsShorts ? 'ready' : 'failed';
        job.progress = null;
        job.error = message;
        job.failedTaskKind = task.kind;
        job.updatedAt = nowIso();
        this.deps.store.updateJob(job);
      }
      return true;
    }
    if (task.kind === 'analyze_crops') {
      const { shortId } = AnalyzeCropsPayloadSchema.parse(task.payload);
      const short = this.deps.store.getShort(shortId);
      if (short) {
        short.cropAnalysis = 'failed';
        short.cropAnalysisError = message;
        short.updatedAt = nowIso();
        this.deps.store.updateShort(short);
      }
      return true;
    }
    const { exportId } = ExportShortPayloadSchema.parse(task.payload);
    const record = this.deps.store.getExport(exportId);
    if (record) {
      record.status = 'failed';
      record.error = message;
      record.updatedAt = nowIso();
      this.deps.store.updateExport(record);
    }
    return true;
  }

  private requireJob(jobId: string): JobRecord {
    const job = this.deps.store.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    return job;
  }

  private requireShort(shortId: string): ShortRecord {
    const short = this.deps.store.getShort(shortId);
    if (!short) {
      throw new Error(`Short not found: ${shortId}`);
    }
    return short;
  }

  private requirePublication(publicationId: string): PublicationRecord {
    const publication = this.deps.store.getPublication(publicationId);
    if (!publication) {
      throw new Error(`Publication not found: ${publicationId}`);
    }
    return publication;
  }

  private requireMedia(job: JobRecord): SourceMedia {
    if (!job.media) {
      throw new Error(`Job ${job.id} has no source media yet.`);
    }
    return job.media;
  }

  private async ensureJobDir(jobId: string): Promise<string> {
    const path = resolve(this.deps.config.artifactsDir, jobId);
    await mkdir(path, { recursive: true });
    return path;
  }
}

function contentPanelOf(layout: LayoutProfile): ContentPanel | null {
  const panel = layout.panels.find((entry): entry is ContentPanel => entry.role === 'content');
  return panel ?? null;
}

function overlapsExistingShort(kept: number[], existing: ShortRecord[], wordCount: number): boolean {
  if (kept.length === 0) {
    return false;
  }
  for (const short of existing) {
    const existingKept = new Set(keptWordIndices(short.edit, wordCount));
    let shared = 0;
    for (const index of kept) {
      if (existingKept.has(index)) {
        shared += 1;
      }
    }
    if (shared / kept.length >= 0.6) {
      return true;
    }
  }
  return false;
}

function buildCropAnalysisSpans(edit: ShortEdit, clips: SourceClip[], words: TranscriptWord[]): Array<{ startSeconds: number; endSeconds: number; text: string }> {
  const kept = new Set(keptWordIndices(edit, words.length));
  const spans: Array<{ startSeconds: number; endSeconds: number; text: string }> = [];
  for (const range of [...edit.ranges].sort((left, right) => left.startWord - right.startWord)) {
    const rangeClips = clips.filter((clip) => clip.firstWord >= range.startWord && clip.firstWord <= range.endWord);
    if (rangeClips.length === 0) {
      continue;
    }
    const text = words
      .slice(range.startWord, range.endWord + 1)
      .map((word, offset) => ({ word, index: range.startWord + offset }))
      .filter((entry) => kept.has(entry.index))
      .map((entry) => entry.word.text)
      .join(' ');
    spans.push({
      startSeconds: rangeClips[0].sourceStart,
      endSeconds: rangeClips[rangeClips.length - 1].sourceEnd,
      text,
    });
  }
  return spans;
}
