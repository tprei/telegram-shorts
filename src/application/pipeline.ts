import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { createInitialEdit, keptWordIndices, normalizeSceneEdit, replaceAutoCrops, type CropKeyframe, type ShortEdit } from '../domain/edit.js';
import { publicationStartedAt, QUEUE_LANES, type ExportRecord, type HostFraming, type JobRecord, type PublicationRecord, type PublicationStatus, type PublishingAccount, type QueueLane, type QueueTask, type SceneSegment, type SceneTrack, type ShortRecord, type SourceMedia, type TranscriptWord } from '../domain/model.js';
import { computeSourceClips, buildTimeline, type SourceClip } from '../domain/timeline.js';
import { buildSentences, detectStrongSpeakers } from '../domain/policies.js';
import { contentPanelOf, hostPanelOf, type ContentPanel } from '../domain/layout.js';
import { blockContinuesPrevious, blockOnScreenSeconds, buildPlannedShorts, diagnoseCandidatePlan, fallbackSemanticBlocks, materializeSemanticBlocks, semanticBlocksAreUsable, type PlanningPace } from '../domain/semantic.js';
import { pickPublishingProfile, type CreatorProfileRepository } from '../infra/creator-profile-loader.js';
import { buildPublishMessage } from '../infra/mallary.js';
import { extractFrame, renderCoverImage, renderShortExport } from '../infra/render.js';
import { transcribeSource } from '../infra/transcript.js';
import { analyzeContentCrops, detectHostHead, type AnalyzeContentCropsFunction } from '../infra/vision.js';
import { documentCropSpans } from '../domain/scene.js';
import { analyzeScenes, type AnalyzeScenesFunction } from '../infra/scenes.js';
import { downloadSource } from '../infra/youtube.js';
import type { AppConfig } from '../infra/env.js';
import { CHECK_PUBLISH_DELAY_MS, CHECK_WINDOW_MS, ShortsStore } from '../infra/db.js';
import { ShortVideoPublishError, isTransientCheckError, isTransientNetworkError, type RemotePublicationState, type ShortVideoPublishProvider, type ShortVideoPublishResult } from '../infra/instagram-publisher.js';
import { createId, describeError, logError, nowIso } from '../infra/util.js';
import type { OpenRouterClient } from '../infra/openrouter.js';
import { mallaryCooldownKey, availabilityForPublishingProfile, platformLabel } from './platforms.js';

const EmptyPayloadSchema = z.strictObject({});
const AnalyzeCropsPayloadSchema = z.strictObject({ shortId: z.string().min(1) });
const ExportShortPayloadSchema = z.strictObject({ exportId: z.string().min(1) });
const PublishShortVideoPayloadSchema = z.strictObject({ publicationId: z.string().min(1) });
const CheckPublicationPayloadSchema = z.strictObject({ publicationId: z.string().min(1) });

const CHECK_RETRY_DELAY_MS = 20_000;
const CHECK_UNCONFIRMED_DELAY_MS = 10 * 60 * 1000;
const CHECK_DEADLINE_MS = 60 * 60 * 1000;
const MAX_STORED_ERROR_LENGTH = 2000;

const PRESERVED_PUBLICATION_STATUSES: readonly PublicationStatus[] = ['submitted', 'published', 'unconfirmed', 'scheduled', 'cancelled'];

class PublicationCheckRetry extends Error {
  constructor(readonly availableAt: string, readonly reason: string) {
    super(reason);
    this.name = 'PublicationCheckRetry';
  }
}

export interface ShortsPipelineDeps {
  config: AppConfig;
  store: ShortsStore;
  openRouter: OpenRouterClient;
  profiles: CreatorProfileRepository;
  publisher: ShortVideoPublishProvider | null;
  analyzeScenes: AnalyzeScenesFunction;
  analyzeContentCrops: AnalyzeContentCropsFunction;
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
    if (task.kind === 'analyze_host') {
      EmptyPayloadSchema.parse(task.payload);
      await this.analyzeHost(task);
      return;
    }
    if (task.kind === 'analyze_scenes') {
      EmptyPayloadSchema.parse(task.payload);
      await this.analyzeScenesTask(task);
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
    if (task.kind === 'check_publication') {
      const { publicationId } = CheckPublicationPayloadSchema.parse(task.payload);
      await this.checkPublication(publicationId);
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
    if (job.layoutProfileSnapshot.strategy === 'fixed') {
      if (hostPanelOf(job.layoutProfileSnapshot)) {
        this.deps.store.enqueueTask(job.id, 'analyze_host', {});
      }
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
    } else {
      job.sceneAnalysis = 'queued';
      job.sceneAnalysisError = null;
      if (job.strongSpeakers.length > 1 && !job.chosenSpeakerId) {
        job.status = 'awaiting_speaker';
        job.updatedAt = nowIso();
        this.deps.store.updateJob(job);
        if (!this.deps.store.hasActiveTask(job.id, 'analyze_scenes')) {
          this.deps.store.enqueueTask(job.id, 'analyze_scenes', {});
        }
        return;
      }
      job.chosenSpeakerId ??= job.strongSpeakers[0]?.speakerId ?? words[0]?.speakerId ?? null;
      job.status = 'planning';
      job.updatedAt = nowIso();
      this.deps.store.updateJob(job);
      this.deps.store.enqueueTask(job.id, 'plan_shorts', {});
      if (!this.deps.store.hasActiveTask(job.id, 'analyze_scenes')) {
        this.deps.store.enqueueTask(job.id, 'analyze_scenes', {});
      }
    }
  }
  private async analyzeHost(task: QueueTask): Promise<void> {
    const job = this.requireJob(task.jobId);
    const panel = hostPanelOf(job.layoutProfileSnapshot);
    if (!panel) {
      throw new Error(`Layout for job ${job.id} has no host panel for host head detection.`);
    }
    const media = this.requireMedia(job);
    let framing: HostFraming | null = null;
    let failure: unknown = null;
    try {
      const headBox = await detectHostHead({
        config: this.deps.config,
        videoPath: media.videoPath,
        source: { width: media.width, height: media.height },
        panel,
        durationSeconds: media.durationSeconds,
        workDir: await this.ensureJobDir(job.id),
      });
      framing = { headBox };
    } catch (error) {
      failure = error;
      logError('Host head detection failed', error, { jobId: job.id });
    }
    const current = this.requireJob(task.jobId);
    if (framing !== null) {
      current.hostFraming = framing;
      current.hostFramingAnalyzedAt = nowIso();
    } else if (!isTransientNetworkError(failure)) {
      current.hostFramingAnalyzedAt = nowIso();
    }
    this.deps.store.updateJob(current);
  }
  private async analyzeScenesTask(task: QueueTask): Promise<void> {
    const initialJob = this.requireJob(task.jobId);
    if (initialJob.layoutProfileSnapshot.strategy !== 'scenes') {
      throw new Error(`Job ${initialJob.id} does not have a scenes layout profile.`);
    }
    const sceneConfig = initialJob.creatorProfileSnapshot.render.scene;
    if (!sceneConfig) {
      throw new Error(`Job ${initialJob.id} has no scene configuration.`);
    }
    const media = this.requireMedia(initialJob);

    const runningJob = this.requireJob(task.jobId);
    runningJob.sceneAnalysis = 'running';
    runningJob.sceneAnalysisError = null;
    runningJob.updatedAt = nowIso();
    this.deps.store.updateJob(runningJob);

    let newTrack: SceneTrack;
    try {
      newTrack = await this.deps.analyzeScenes({
        config: this.deps.config,
        media,
        scene: sceneConfig,
        workDir: await this.ensureJobDir(initialJob.id),
      });
    } catch (error) {
      logError('Scene analysis failed', error, { jobId: initialJob.id });
      throw error;
    }

    const existingShorts = this.deps.store.listShortsForJob(initialJob.id);
    const normalizedShortEdits: Array<{ original: ShortRecord; nextEdit: ShortEdit }> = [];
    try {
      for (const short of existingShorts) {
        const withoutAutoCrops = replaceAutoCrops(short.edit, []);
        const nextEdit = normalizeSceneEdit(withoutAutoCrops, initialJob.layoutProfileSnapshot, newTrack);
        normalizedShortEdits.push({ original: short, nextEdit });
      }
    } catch (error) {
      logError('Scene re-analysis edit conflict', error, { jobId: initialJob.id });
      throw new Error(`Scene re-analysis caused edit conflict: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const { original, nextEdit } of normalizedShortEdits) {
      if (JSON.stringify(original.edit) !== JSON.stringify(nextEdit)) {
        this.deps.store.updateShort({
          ...original,
          edit: nextEdit,
          editRevision: original.editRevision + 1,
          updatedAt: nowIso(),
        });
      }
    }

    const successJob = this.requireJob(task.jobId);
    successJob.sceneTrack = newTrack;
    successJob.sceneAnalysis = 'done';
    successJob.sceneAnalysisError = null;
    successJob.updatedAt = nowIso();
    this.deps.store.updateJob(successJob);

    for (const { original } of normalizedShortEdits) {
      const current = this.deps.store.getShort(original.id);
      if (!current) {
        throw new Error(`Short ${original.id} disappeared while completing scene analysis.`);
      }
      const clips = computeSourceClips(current.edit, successJob.transcriptWords, media.durationSeconds);
      const docSpans = documentCropSpans({
        clips,
        words: successJob.transcriptWords,
        segments: newTrack.segments,
      });
      if (docSpans.length > 0) {
        if (!this.deps.store.hasActiveTask(successJob.id, 'analyze_crops', original.id)) {
          current.cropAnalysis = 'queued';
          current.cropAnalysisError = null;
          current.updatedAt = nowIso();
          this.deps.store.updateShort(current);
          this.deps.store.enqueueTask(successJob.id, 'analyze_crops', { shortId: original.id });
        }
      } else {
        current.cropAnalysis = 'none';
        current.cropAnalysisError = null;
        current.updatedAt = nowIso();
        this.deps.store.updateShort(current);
      }
    }
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
    const pace: PlanningPace = { speed: job.creatorProfileSnapshot.render.defaultSpeed, words, sourceDurationSeconds: this.requireMedia(job).durationSeconds };
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
    const blockPayload = blocks.map((block, index) => ({
      id: block.id,
      kind: block.kind,
      summary: block.summary,
      start_seconds: block.startSeconds,
      on_screen_seconds: blockOnScreenSeconds(block, sentences, pace),
      continues_previous: blockContinuesPrevious(blocks, index, sentences),
      text: block.text,
    }));
    let opportunities = await this.deps.openRouter.findOpportunities({ title: job.sourceTitle, blocks: blockPayload, speed: pace.speed });
    let plan = await this.deps.openRouter.planCandidates({ title: job.sourceTitle, blocks: blockPayload, opportunities: opportunities.opportunities, speed: pace.speed });
    let diagnostics = diagnoseCandidatePlan(sentences, blocks, plan, pace);
    let planned = buildPlannedShorts({ sentences, blocks, plan, pace });
    if (planned.length === 0) {
      opportunities = await this.deps.openRouter.repairOpportunityPlan({
        title: job.sourceTitle,
        blocks: blockPayload,
        opportunities: opportunities.opportunities,
        diagnostics,
        speed: pace.speed,
      });
      plan = await this.deps.openRouter.planCandidates({ title: job.sourceTitle, blocks: blockPayload, opportunities: opportunities.opportunities, speed: pace.speed });
      diagnostics = diagnoseCandidatePlan(sentences, blocks, plan, pace);
      planned = buildPlannedShorts({ sentences, blocks, plan, pace });
    }
    if (planned.length === 0) {
      const summary = diagnostics.map((entry) => `#${entry.index + 1} ${entry.title}: ${entry.reasons.join('; ') || 'no diagnostic reason'}`).join(' | ');
      throw new Error(`No valid short candidates were produced. ${summary}`);
    }
    const isScenes = layout.strategy === 'scenes';
    const contentPanel = contentPanelOf(layout);
    const existing = this.deps.store.listShortsForJob(job.id);
    let nextRank = existing.reduce((max, short) => Math.max(max, short.rank), 0);
    for (const item of planned) {
      const edit = createInitialEdit({ ranges: item.ranges, words, speed: pace.speed, hookText: item.hookText });
      const kept = keptWordIndices(edit, words.length);
      if (overlapsExistingShort(kept, existing, words.length)) {
        continue;
      }
      nextRank += 1;
      let shouldEnqueueCrops = false;
      let initialCropStatus: 'none' | 'queued' = 'none';

      if (isScenes) {
        if (job.sceneAnalysis === 'done' && job.sceneTrack) {
          const clips = computeSourceClips(edit, words, this.requireMedia(job).durationSeconds);
          const docSpans = documentCropSpans({ clips, words, segments: job.sceneTrack.segments });
          if (docSpans.length > 0) {
            initialCropStatus = 'queued';
            shouldEnqueueCrops = true;
          } else {
            initialCropStatus = 'none';
          }
        } else {
          initialCropStatus = 'queued';
          shouldEnqueueCrops = false;
        }
      } else {
        if (contentPanel) {
          initialCropStatus = 'queued';
          shouldEnqueueCrops = true;
        } else {
          initialCropStatus = 'none';
        }
      }

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
        cropAnalysis: initialCropStatus,
        cropAnalysisError: null,
        publishCopy: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      this.deps.store.createShort(short);
      existing.push(short);
      if (shouldEnqueueCrops) {
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
    const layout = job.layoutProfileSnapshot;
    const media = this.requireMedia(job);
    short.cropAnalysis = 'running';
    short.updatedAt = nowIso();
    this.deps.store.updateShort(short);
    const clips = computeSourceClips(short.edit, job.transcriptWords, media.durationSeconds);
    let keyframes: CropKeyframe[];

    if (layout.strategy === 'fixed') {
      const panel = contentPanelOf(layout);
      if (!panel) {
        throw new Error(`Layout for job ${job.id} has no content panel for crop analysis.`);
      }
      const spans = buildCropAnalysisSpans(short.edit, clips, job.transcriptWords);
      keyframes = await this.deps.analyzeContentCrops({
        config: this.deps.config,
        videoPath: media.videoPath,
        source: { width: media.width, height: media.height },
        panel,
        spans,
        words: job.transcriptWords,
        workDir: join(await this.ensureJobDir(job.id), 'crops'),
        maxSamples: 16,
      });
    } else {
      if (!job.sceneTrack) {
        throw new Error(`Job ${job.id} has no scene track for crop analysis.`);
      }
      const docSpans = documentCropSpans({
        clips,
        words: job.transcriptWords,
        segments: job.sceneTrack.segments,
      });
      if (docSpans.length === 0) {
        const settled = this.requireShort(shortId);
        settled.cropAnalysis = 'none';
        settled.cropAnalysisError = null;
        settled.updatedAt = nowIso();
        this.deps.store.updateShort(settled);
        return;
      }
      const segmentGroups = new Map<SceneSegment, Array<{ startSeconds: number; endSeconds: number; text: string }>>();
      for (const span of docSpans) {
        let group = segmentGroups.get(span.segment);
        if (!group) {
          group = [];
          segmentGroups.set(span.segment, group);
        }
        group.push({ startSeconds: span.startSeconds, endSeconds: span.endSeconds, text: span.text });
      }
      const groups = Array.from(segmentGroups.entries());
      const budgets = new Array<number>(groups.length).fill(0);
      for (let i = 0; i < 16; i++) {
        budgets[i % groups.length] += 1;
      }
      const cropsWorkDir = join(await this.ensureJobDir(job.id), 'crops');
      const allKeyframes: CropKeyframe[] = [];
      for (let i = 0; i < groups.length; i++) {
        const budget = budgets[i];
        if (budget === 0) {
          continue;
        }
        const [segment, groupSpans] = groups[i];
        if (!segment.content) {
          continue;
        }
        const transientPanel: ContentPanel = {
          id: 'content',
          role: 'content',
          sourceRect: segment.content.box,
          canvasRect: { x: 0, y: 0, w: 1, h: 1 },
        };
        const groupKeyframes = await this.deps.analyzeContentCrops({
          config: this.deps.config,
          videoPath: media.videoPath,
          source: { width: media.width, height: media.height },
          panel: transientPanel,
          spans: groupSpans,
          words: job.transcriptWords,
          workDir: cropsWorkDir,
          maxSamples: budget,
        });
        for (const kf of groupKeyframes) {
          allKeyframes.push({
            sourceSeconds: kf.sourceSeconds,
            origin: kf.origin,
            focus: {
              x: Math.max(0, Math.min(1, (kf.focus.x - segment.content.box.x) / segment.content.box.w)),
              y: Math.max(0, Math.min(1, (kf.focus.y - segment.content.box.y) / segment.content.box.h)),
              w: Math.max(0.001, Math.min(1, kf.focus.w / segment.content.box.w)),
              h: Math.max(0.001, Math.min(1, kf.focus.h / segment.content.box.h)),
            },
          });
        }
      }
      allKeyframes.sort((a, b) => a.sourceSeconds - b.sourceSeconds);
      keyframes = allKeyframes;
    }
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
      layout: record.layoutProfileSnapshot,
      source: { width: media.width, height: media.height, durationSeconds: media.durationSeconds },
      hostFraming: record.hostFraming,
      sceneTrack: record.sceneTrack,
    });
    const workDir = join(await this.ensureJobDir(job.id), 'exports', record.id);
    const result = await renderShortExport({
      timeline,
      layout: record.layoutProfileSnapshot,
      sourceVideoPath: media.videoPath,
      workDir,
      fontsDir: this.deps.config.fontsDir,
      endCardThumbnailPath: media.thumbnailPath,
    });
    const coverPath = await this.tryRenderExportCover(job, media, record, workDir);
    record.status = 'ready';
    record.artifactPath = result.artifactPath;
    record.coverPath = coverPath;
    record.sizeBytes = result.sizeBytes;
    record.durationSeconds = result.durationSeconds;
    record.error = null;
    record.updatedAt = nowIso();
    this.deps.store.updateExport(record);
  }

  private async tryRenderExportCover(job: JobRecord, media: SourceMedia, record: ExportRecord, workDir: string): Promise<string | null> {
    try {
      return await this.renderExportCover(job, media, record, workDir);
    } catch (error) {
      logError('Cover render failed; continuing without a cover', error, { exportId: record.id, jobId: job.id });
      return null;
    }
  }

  private async renderExportCover(job: JobRecord, media: SourceMedia, record: ExportRecord, workDir: string): Promise<string> {
    let imagePath = media.thumbnailPath;
    if (imagePath === null) {
      const firstClip = computeSourceClips(record.edit, job.transcriptWords, media.durationSeconds)[0];
      if (firstClip === undefined) {
        throw new Error(`Export ${record.id} has no clips to take a cover frame from.`);
      }
      const clipLength = firstClip.sourceEnd - firstClip.sourceStart;
      imagePath = join(workDir, 'cover-source.jpg');
      await extractFrame({
        videoPath: media.videoPath,
        seconds: firstClip.sourceStart + Math.min(2, Math.max(0.3, clipLength / 3)),
        width: media.width,
        outputPath: imagePath,
      });
    }
    const coverPath = join(workDir, 'cover.jpg');
    await renderCoverImage({ imagePath, outputPath: coverPath, width: record.layoutProfileSnapshot.canvas.width, height: record.layoutProfileSnapshot.canvas.height });
    return coverPath;
  }

  private async publishShortVideo(publicationId: string): Promise<void> {
    let publication = this.requirePublication(publicationId);
    if (publication.status === 'published' || publication.status === 'failed' || publication.status === 'submitted' || publication.status === 'unconfirmed' || publication.status === 'scheduled' || publication.status === 'cancelled') {
      return;
    }
    const exportRecord = this.deps.store.getExport(publication.exportId);
    if (!exportRecord || exportRecord.status !== 'ready' || !exportRecord.artifactPath) {
      throw new Error(`Export ${publication.exportId} is not ready for publishing.`);
    }
    const short = this.requireShort(publication.shortId);
    const job = this.requireJob(publication.jobId);
    const manifest = await this.deps.profiles.getManifest();
    const resolved = pickPublishingProfile(manifest, job.creatorProfileId);
    if (!resolved?.profile || !resolved.profile.enabled) {
      throw new Error(`Creator profile ${job.creatorProfileId} is disabled or missing.`);
    }
    if (!resolved.account) {
      throw new Error('No publishing account is assigned to this creator.');
    }
    if (!resolved.account.mallaryProfileId) {
      throw new Error('Account not connected in Mallary');
    }
    const account = resolved.account;
    if (!this.deps.publisher || !this.deps.publisher.canPublish({ account, platform: publication.platform, scheduled: publication.scheduledFor !== null })) {
      throw new Error(`No provider configured for ${publication.platform}.`);
    }
    const availability = availabilityForPublishingProfile({
      profile: resolved.profile,
      account,
      missingReason: `Creator profile ${job.creatorProfileId} no longer exists.`,
      publisher: this.deps.publisher,
      config: this.deps.config,
    });
    const reloaded = this.deps.store.getPublication(publicationId);
    if (reloaded === null) {
      throw new Error(`Publication not found: ${publicationId}`);
    }
    if (reloaded.status === 'cancelled') {
      return;
    }
    publication = reloaded;
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
      coverPath = exportRecord.coverPath;
      if (coverPath === null) {
        coverPath = await this.tryRenderExportCover(job, this.requireMedia(job), exportRecord, dirname(exportRecord.artifactPath));
        if (coverPath !== null) {
          const current = this.deps.store.getExport(exportRecord.id);
          if (current) {
            current.coverPath = coverPath;
            current.updatedAt = nowIso();
            this.deps.store.updateExport(current);
          }
        }
      }
    }
    let result: ShortVideoPublishResult;
    try {
      result = await this.deps.publisher.publishShortVideo({
        account,
        platform: publication.platform,
        filePath: exportRecord.artifactPath,
        message: buildPublishMessage(copy),
        title: publication.platform === 'youtube_shorts' ? short.title : null,
        idempotencyKey: `shorts-${publication.platform}-${exportRecord.id}-${publication.id}`,
        scheduledAt: publication.scheduledFor,
        thumbnailPath: coverPath,
        commentsUnderPost: publication.platform === 'instagram' && job.sourceUrl
          ? [`Vídeo completo: ${job.sourceUrl}`]
          : [],
      });
    } catch (error) {
      if (isTransientNetworkError(error)) {
        const target = publication.scheduledFor !== null ? "Mallary's queue" : platformLabel(publication.platform);
        const message = `${this.requirePublisher().name} may have received this post; check ${target} before reposting`;
        publication.status = 'unconfirmed';
        publication.error = message;
        publication.updatedAt = nowIso();
        this.deps.store.updatePublication(publication);
        this.deps.store.appendAction(job.id, 'short_video_unconfirmed', {
          publicationId: publication.id,
          platform: publication.platform,
          provider: null,
          error: message,
        });
        return;
      }
      throw error;
    }
    if (result.jobs.length === 0) {
      const message = publication.scheduledFor !== null
        ? "Mallary accepted the scheduled post but returned no id to track; check Mallary's queue before scheduling it again."
        : `${result.provider} accepted the post but returned no id to track; check ${platformLabel(publication.platform)} before reposting.`;
      publication.status = 'unconfirmed';
      publication.provider = result.provider;
      publication.batchId = result.batchId;
      publication.error = message;
      publication.updatedAt = nowIso();
      this.deps.store.updatePublication(publication);
      this.deps.store.appendAction(job.id, 'short_video_unconfirmed', {
        publicationId: publication.id,
        platform: publication.platform,
        provider: result.provider,
        error: message,
      });
      return;
    }
    if (publication.scheduledFor !== null) {
      publication.status = 'scheduled';
      publication.provider = result.provider;
      publication.batchId = result.batchId;
      publication.remoteJobs = result.jobs;
      publication.submittedAt = nowIso();
      publication.error = null;
      publication.updatedAt = nowIso();
      this.deps.store.updatePublication(publication);
      this.deps.store.enqueueTask(job.id, 'check_publication', { publicationId: publication.id }, {
        availableAt: new Date(Date.parse(publication.scheduledFor) + CHECK_PUBLISH_DELAY_MS).toISOString(),
      });
      this.deps.store.appendAction(job.id, 'short_video_scheduled', {
        publicationId: publication.id,
        platform: publication.platform,
        provider: result.provider,
        batchId: result.batchId,
        jobs: result.jobs,
        scheduledFor: publication.scheduledFor,
        forced: publication.forced,
      });
      return;
    }
    publication.status = 'submitted';
    publication.provider = result.provider;
    publication.batchId = result.batchId;
    publication.remoteJobs = result.jobs;
    publication.submittedAt = nowIso();
    publication.error = null;
    publication.updatedAt = nowIso();
    this.deps.store.updatePublication(publication);
    this.deps.store.enqueueTask(job.id, 'check_publication', { publicationId: publication.id }, {
      availableAt: new Date(Date.now() + CHECK_PUBLISH_DELAY_MS).toISOString(),
    });
    this.deps.store.appendAction(job.id, 'short_video_submitted', {
      publicationId: publication.id,
      platform: publication.platform,
      provider: result.provider,
      batchId: result.batchId,
      jobs: result.jobs,
      forced: publication.forced,
    });
  }

  private async checkPublication(publicationId: string): Promise<void> {
    let publication = this.requirePublication(publicationId);
    if (publication.status !== 'submitted' && publication.status !== 'unconfirmed' && publication.status !== 'scheduled') {
      return;
    }
    if (publication.status === 'unconfirmed' && !this.insideCheckWindowAt(publication, Date.now())) {
      return;
    }
    if (!publication.provider || publication.submittedAt === null) {
      this.markUnconfirmed(publication, `No provider result was recorded to check; check ${platformLabel(publication.platform)} before reposting.`);
      return;
    }
    const remoteJob = publication.remoteJobs[0];
    if (!remoteJob) {
      this.markUnconfirmed(publication, `${publication.provider} accepted the post but returned no id to track; check ${platformLabel(publication.platform)} before reposting.`);
      return;
    }
    let waitingForScheduledTimeMs: number | null = null;
    if (publication.status === 'scheduled' && publication.scheduledFor !== null) {
      const scheduledForMs = Date.parse(publication.scheduledFor);
      if (Date.now() < scheduledForMs) {
        waitingForScheduledTimeMs = scheduledForMs;
      } else {
        publication.status = 'submitted';
        publication.updatedAt = nowIso();
        this.deps.store.updatePublication(publication);
      }
    }
    let state: RemotePublicationState;
    try {
      state = await this.requirePublisher().checkPublication({
        provider: publication.provider,
        platform: publication.platform,
        remoteJobId: remoteJob.jobId,
      });
    } catch (error) {
      logError('Publication check failed', error, { publicationId: publication.id, provider: publication.provider, remoteJobId: remoteJob.jobId });
      if (this.deps.store.getPublication(publicationId)?.status === 'cancelled') {
        return;
      }
      if (waitingForScheduledTimeMs !== null) {
        throw new PublicationCheckRetry(new Date(waitingForScheduledTimeMs + CHECK_PUBLISH_DELAY_MS).toISOString(), describeError(error));
      }
      if (!isTransientCheckError(error)) {
        if (publication.status === 'submitted') {
          this.markUnconfirmed(publication, describeError(error));
        }
        return;
      }
      this.deferCheck(publication, describeError(error));
      return;
    }
    const reloaded = this.deps.store.getPublication(publicationId);
    if (reloaded === null || reloaded.status === 'cancelled') {
      return;
    }
    if (waitingForScheduledTimeMs !== null) {
      if (state.status === 'failed') {
        this.failPublication(reloaded, state.error ?? `No final result from ${reloaded.provider}; check ${platformLabel(reloaded.platform)} before reposting.`);
        return;
      }
      throw new PublicationCheckRetry(new Date(waitingForScheduledTimeMs + CHECK_PUBLISH_DELAY_MS).toISOString(), `Waiting for the scheduled time at ${reloaded.scheduledFor}.`);
    }
    publication = reloaded;
    if (state.status === 'live') {
      publication.status = 'published';
      publication.remoteUrl = state.url;
      publication.error = null;
      publication.updatedAt = nowIso();
      this.deps.store.updatePublication(publication);
      this.deps.store.appendAction(publication.jobId, 'short_video_published', {
        publicationId: publication.id,
        platform: publication.platform,
        provider: publication.provider,
        remoteUrl: state.url,
      });
      return;
    }
    if (state.status === 'failed') {
      this.failPublication(publication, state.error ?? `No final result from ${publication.provider}; check ${platformLabel(publication.platform)} before reposting.`);
      return;
    }
    this.deferCheck(publication, `Waiting for ${publication.provider} to report a final result for ${platformLabel(publication.platform)}.`);
  }

  private deferCheck(publication: PublicationRecord, reason: string): void {
    const now = Date.now();
    const startedAtMs = Date.parse(publicationStartedAt(publication) ?? nowIso());
    if (publication.status === 'submitted' && now < startedAtMs + CHECK_DEADLINE_MS) {
      throw new PublicationCheckRetry(new Date(now + CHECK_RETRY_DELAY_MS).toISOString(), reason);
    }
    if (publication.status === 'submitted') {
      this.markUnconfirmed(publication, `No final result from ${publication.provider} after 60 minutes; check ${platformLabel(publication.platform)} before reposting.`);
    }
    if (this.insideCheckWindowAt(publication, now)) {
      throw new PublicationCheckRetry(new Date(now + CHECK_UNCONFIRMED_DELAY_MS).toISOString(), reason);
    }
  }

  private insideCheckWindowAt(publication: PublicationRecord, nowMs: number): boolean {
    const startedAt = publicationStartedAt(publication);
    return startedAt !== null && nowMs < Date.parse(startedAt) + CHECK_WINDOW_MS;
  }

  private markUnconfirmed(publication: PublicationRecord, message: string): void {
    if (publication.status !== 'submitted') {
      return;
    }
    publication.status = 'unconfirmed';
    publication.error = message;
    publication.updatedAt = nowIso();
    this.deps.store.updatePublication(publication);
    this.deps.store.appendAction(publication.jobId, 'short_video_unconfirmed', {
      publicationId: publication.id,
      platform: publication.platform,
      provider: publication.provider,
      error: message,
    });
  }

  private failPublication(publication: PublicationRecord, message: string): void {
    publication.status = 'failed';
    publication.error = message;
    publication.updatedAt = nowIso();
    this.deps.store.updatePublication(publication);
    this.deps.store.appendAction(publication.jobId, 'short_video_publish_failed', {
      publicationId: publication.id,
      platform: publication.platform,
      provider: publication.provider,
      error: message,
    });
  }

  private requirePublisher(): ShortVideoPublishProvider {
    if (!this.deps.publisher) {
      throw new Error('No publish provider is configured.');
    }
    return this.deps.publisher;
  }

  private handleTaskFailure(task: QueueTask, error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const storedError = message.slice(0, MAX_STORED_ERROR_LENGTH);
    if (task.kind === 'check_publication') {
      if (error instanceof PublicationCheckRetry) {
        this.deps.store.rescheduleTask(task, error.availableAt, error.reason);
        return true;
      }
      this.deps.store.failTask(task, storedError);
      return true;
    }
    if (task.kind === 'publish_short_video') {
      const { publicationId } = PublishShortVideoPayloadSchema.parse(task.payload);
      const publication = this.deps.store.getPublication(publicationId);
      if (error instanceof ShortVideoPublishError && error.provider === 'mallary' && error.retryAfterSeconds !== null) {
        const availableAt = new Date(Date.now() + error.retryAfterSeconds * 1000).toISOString();
        if (publication && !PRESERVED_PUBLICATION_STATUSES.includes(publication.status)) {
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
      if (publication && !PRESERVED_PUBLICATION_STATUSES.includes(publication.status)) {
        publication.status = 'failed';
        publication.error = message;
        publication.updatedAt = nowIso();
        this.deps.store.updatePublication(publication);
      }
      this.deps.store.failTask(task, storedError);
      this.deps.store.appendAction(task.jobId, 'short_video_publish_failed', { publicationId, error: message });
      return true;
    }
    this.deps.store.failTask(task, storedError);
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
    if (task.kind === 'analyze_host') {
      return true;
    }
    if (task.kind === 'analyze_scenes') {
      const job = this.deps.store.getJob(task.jobId);
      if (job) {
        job.sceneAnalysis = 'failed';
        job.sceneAnalysisError = storedError;
        job.updatedAt = nowIso();
        this.deps.store.updateJob(job);
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
