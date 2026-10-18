import { z } from 'zod';
import {
  AUTOPILOT_MAX_JOB_RETRIES,
  AUTOPILOT_POLL_INTERVAL_MS,
  AUTOPILOT_RETRY_DELAY_MS,
  autopilotShortPlan,
  isAutopilotEligibleUpload,
  orderReadyShorts,
  type AutopilotShortPlan,
} from '../domain/autopilot.js';
import type { AutopilotVideoRecord, CreatorAutopilotConfig, CreatorProfile, JobRecord, ShortVideoPlatform } from '../domain/model.js';
import { freePostingSlots, SCHEDULE_LIMITS } from '../domain/schedule.js';
import type { AutopilotApi, AutopilotShortDto, AutopilotStatusDto, AutopilotVideoDto, SetAutopilotRequest } from '../studio/api-types.js';
import { StudioError } from './errors.js';
import type { StudioService } from './studio-service.js';
import type { CreatorProfileRepository } from '../infra/creator-profile-loader.js';
import type { ShortsStore } from '../infra/db.js';
import { youTubeVideoId, type ChannelUpload } from '../infra/youtube.js';
import { describeError, logError } from '../infra/util.js';

const AutopilotStateSchema = z.strictObject({
  enabled: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  lastCheckError: z.string().nullable(),
  checkRequested: z.boolean(),
});

type AutopilotState = z.infer<typeof AutopilotStateSchema>;

const HOUR_MS = 3_600_000;
const ACTION_BACKOFF_MS = 10 * 60_000;
const ACTION_MAX_FAILURES = 3;

type ActionName = 'copy' | 'export' | 'publish';

interface ActionFailure {
  count: number;
  nextAttemptAt: number;
  lastError: string;
}

type ReadyPlan = AutopilotShortPlan & { state: 'ready'; readyExportId: string };

interface TrackedEntry {
  video: AutopilotVideoRecord;
  job: JobRecord;
  plans: AutopilotShortPlan[];
}

export interface AutopilotDeps {
  store: ShortsStore;
  service: StudioService;
  profiles: CreatorProfileRepository;
  listUploads: (channelUrl: string, limit: number) => Promise<ChannelUpload[]>;
  now: () => Date;
}

export class Autopilot implements AutopilotApi {
  private readonly actionFailures = new Map<string, ActionFailure>();
  private readonly preconditionErrors = new Map<string, string>();

  constructor(private readonly deps: AutopilotDeps) {}

  async list(): Promise<AutopilotStatusDto[]> {
    const statuses: AutopilotStatusDto[] = [];
    for (const profile of await this.deps.profiles.getEnabledCreatorProfiles()) {
      if (!profile.autopilot) {
        continue;
      }
      statuses.push(this.status(profile, profile.autopilot));
    }
    return statuses;
  }

  async setEnabled(creatorId: string, request: SetAutopilotRequest): Promise<AutopilotStatusDto> {
    const { profile, config } = await this.requireAutopilotProfile(creatorId);
    this.updateState(creatorId, { enabled: request.enabled });
    return this.status(profile, config);
  }

  async checkNow(creatorId: string): Promise<AutopilotStatusDto> {
    const { profile, config } = await this.requireAutopilotProfile(creatorId);
    this.updateState(creatorId, { checkRequested: true });
    return this.status(profile, config);
  }

  async tick(): Promise<void> {
    for (const profile of await this.deps.profiles.getEnabledCreatorProfiles()) {
      if (!profile.autopilot || !this.readState(profile.id).enabled) {
        continue;
      }
      await this.tickCreator(profile, profile.autopilot);
    }
  }

  private async tickCreator(profile: CreatorProfile, config: CreatorAutopilotConfig): Promise<void> {
    await this.runStep(`Autopilot check failed for ${profile.id}`, () => this.checkChannel(profile, config));
    await this.runStep(`Autopilot retry failed for ${profile.id}`, () => this.retryFailedJobs(profile));
    if (!this.readState(profile.id).enabled) {
      return;
    }
    await this.runStep(`Autopilot prepare failed for ${profile.id}`, () => this.prepareShorts(profile, config));
    await this.runStep(`Autopilot booking failed for ${profile.id}`, () => this.bookReadyShorts(profile, config));
  }

  private async runStep(context: string, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      logError(context, error);
    }
  }

  private async checkChannel(profile: CreatorProfile, config: CreatorAutopilotConfig): Promise<void> {
    const state = this.readState(profile.id);
    const now = this.deps.now();
    const due = state.checkRequested
      || state.lastCheckedAt === null
      || now.getTime() - Date.parse(state.lastCheckedAt) >= AUTOPILOT_POLL_INTERVAL_MS;
    if (!due) {
      return;
    }
    let mismatch: string | null = null;
    try {
      mismatch = await this.reconcileUploads(profile, config, now);
    } catch (error) {
      logError(`Autopilot channel check failed for ${profile.id}`, error);
      this.updateState(profile.id, {
        lastCheckedAt: now.toISOString(),
        lastCheckError: describeError(error),
        checkRequested: false,
      });
      return;
    }
    this.updateState(profile.id, {
      lastCheckedAt: now.toISOString(),
      lastCheckError: mismatch,
      checkRequested: false,
    });
  }

  private async reconcileUploads(profile: CreatorProfile, config: CreatorAutopilotConfig, now: Date): Promise<string | null> {
    const uploads = await this.deps.listUploads(config.channelUrl, 15);
    const known = this.deps.store.listAutopilotVideos(profile.id);
    if (known.length === 0) {
      for (const upload of uploads) {
        if (!isAutopilotEligibleUpload(upload, config)) {
          continue;
        }
        this.deps.store.saveAutopilotVideo({
          creatorId: profile.id,
          videoId: upload.videoId,
          title: upload.title,
          status: 'baseline',
          jobId: null,
          detectedAt: now.toISOString(),
          retries: 0,
          lastRetryAt: null,
        });
      }
      return null;
    }
    const knownIds = new Set(known.map((video) => video.videoId));
    if (!uploads.some((upload) => knownIds.has(upload.videoId))) {
      return "Couldn't find known videos in the channel listing";
    }
    const jobs = this.deps.store.listJobSummaries();
    for (const upload of uploads) {
      if (knownIds.has(upload.videoId)) {
        break;
      }
      if (!isAutopilotEligibleUpload(upload, config)) {
        continue;
      }
      try {
        const linked = jobs.find((job) => job.creatorProfileId === profile.id && youTubeVideoId(job.sourceUrl) === upload.videoId) ?? null;
        const jobId = linked?.id
          ?? (await this.deps.service.createJob({ url: `https://www.youtube.com/watch?v=${upload.videoId}`, creatorId: profile.id })).id;
        this.deps.store.saveAutopilotVideo({
          creatorId: profile.id,
          videoId: upload.videoId,
          title: upload.title,
          status: 'tracked',
          jobId,
          detectedAt: now.toISOString(),
          retries: 0,
          lastRetryAt: null,
        });
      } catch (error) {
        logError(`Autopilot tracking failed for ${upload.videoId}`, error);
      }
    }
    return null;
  }

  private async retryFailedJobs(profile: CreatorProfile): Promise<void> {
    const now = this.deps.now();
    for (const video of this.deps.store.listAutopilotVideos(profile.id)) {
      if (video.status !== 'tracked' || video.jobId === null) {
        continue;
      }
      const job = this.deps.store.getJob(video.jobId);
      if (!job || job.status !== 'failed') {
        continue;
      }
      const lastAttempt = video.lastRetryAt ?? video.detectedAt;
      if (video.retries >= AUTOPILOT_MAX_JOB_RETRIES || now.getTime() - Date.parse(lastAttempt) < AUTOPILOT_RETRY_DELAY_MS) {
        continue;
      }
      try {
        this.deps.service.retryJob(video.jobId);
      } catch (error) {
        logError(`Autopilot job retry failed for ${video.videoId}`, error);
      }
      this.deps.store.saveAutopilotVideo({ ...video, retries: video.retries + 1, lastRetryAt: now.toISOString() });
    }
  }

  private async prepareShorts(profile: CreatorProfile, config: CreatorAutopilotConfig): Promise<void> {
    const now = this.deps.now();
    for (const entry of this.trackedEntries(profile, config)) {
      for (const plan of entry.plans) {
        if (plan.state !== 'exporting') {
          continue;
        }
        if (plan.needsCopy && !this.actionBlocked(plan.short.id, 'copy', now)) {
          await this.runAction(plan.short.id, 'copy', () => this.deps.service.generatePublishCopy(plan.short.id), now);
        }
        if (plan.needsExport && !this.actionBlocked(plan.short.id, 'export', now)) {
          await this.runAction(plan.short.id, 'export', () => this.deps.service.exportShort(plan.short.id), now);
        }
      }
    }
  }

  private async runAction(shortId: string, action: 'copy' | 'export', run: () => Promise<unknown>, now: Date): Promise<void> {
    try {
      await run();
      this.actionFailures.delete(`${shortId}:${action}`);
    } catch (error) {
      logError(`Autopilot ${action} failed for ${shortId}`, error);
      this.recordActionFailure(shortId, action, error, now);
    }
  }

  private recordActionFailure(shortId: string, action: ActionName, error: unknown, now: Date): void {
    const previous = this.actionFailures.get(`${shortId}:${action}`);
    this.actionFailures.set(`${shortId}:${action}`, {
      count: (previous?.count ?? 0) + 1,
      nextAttemptAt: now.getTime() + ACTION_BACKOFF_MS,
      lastError: error instanceof StudioError ? error.message : describeError(error),
    });
  }

  private actionBlocked(shortId: string, action: ActionName, now: Date): boolean {
    const failure = this.actionFailures.get(`${shortId}:${action}`);
    if (failure === undefined) {
      return false;
    }
    return failure.count >= ACTION_MAX_FAILURES || failure.nextAttemptAt > now.getTime();
  }

  private async bookReadyShorts(profile: CreatorProfile, config: CreatorAutopilotConfig): Promise<void> {
    if (!this.readState(profile.id).enabled) {
      return;
    }
    const entries = this.trackedEntries(profile, config)
      .flatMap((entry) => entry.plans.map((plan) => ({ video: entry.video, plan })))
      .filter((entry): entry is { video: AutopilotVideoRecord; plan: ReadyPlan } => entry.plan.state === 'ready' && entry.plan.readyExportId !== null);
    const ordered = orderReadyShorts(entries);
    if (ordered.length === 0) {
      return;
    }
    const now = this.deps.now();
    const free = freePostingSlots({
      schedule: profile.schedule,
      from: new Date(now.getTime() + config.reviewWindowHours * HOUR_MS),
      to: new Date(now.getTime() + config.bookingHorizonHours * HOUR_MS),
      taken: this.takenSlots(profile.id, now),
    });
    const pairs = Math.min(ordered.length, free.length);
    for (let index = 0; index < pairs; index += 1) {
      if (!this.readState(profile.id).enabled) {
        return;
      }
      const { plan } = ordered[index];
      const readyExportId = plan.readyExportId;
      if (readyExportId === null || this.actionBlocked(plan.short.id, 'publish', now)) {
        continue;
      }
      const platforms = await this.schedulablePlatforms(plan, config);
      if (platforms.length === 0) {
        this.preconditionErrors.set(plan.short.id, 'No schedulable platform');
        continue;
      }
      try {
        await this.deps.service.publish(readyExportId, { platforms, force: false, scheduledAt: free[index].toISOString() });
        this.actionFailures.delete(`${plan.short.id}:publish`);
        this.preconditionErrors.delete(plan.short.id);
      } catch (error) {
        logError(`Autopilot booking failed for ${plan.short.id}`, error);
        this.recordActionFailure(plan.short.id, 'publish', error, now);
      }
    }
  }

  private async schedulablePlatforms(plan: AutopilotShortPlan, config: CreatorAutopilotConfig): Promise<ShortVideoPlatform[]> {
    const detail = await this.deps.service.getShort(plan.short.id);
    return config.platforms.filter((platform) => {
      const entry = detail.platforms.find((candidate) => candidate.platform === platform);
      return entry !== undefined && entry.available && entry.canSchedule;
    });
  }

  private takenSlots(creatorId: string, now: Date): Date[] {
    const earliest = now.getTime() - SCHEDULE_LIMITS.slotSpacingMinutes * 60_000;
    const startByShort = new Map<string, number>();
    for (const job of this.deps.store.listJobSummaries()) {
      if (job.creatorProfileId !== creatorId) {
        continue;
      }
      for (const short of this.deps.store.listShortsForJob(job.id)) {
        for (const publication of this.deps.store.listPublicationsForShort(short.id)) {
          if (publication.status === 'failed' || publication.status === 'cancelled') {
            continue;
          }
          const started = Date.parse(publication.scheduledFor ?? publication.submittedAt ?? publication.availableAt ?? publication.createdAt);
          if (Number.isNaN(started) || started < earliest) {
            continue;
          }
          const previous = startByShort.get(short.id);
          if (previous === undefined || started < previous) {
            startByShort.set(short.id, started);
          }
        }
      }
    }
    return [...startByShort.values()].map((started) => new Date(started));
  }

  private trackedEntries(profile: CreatorProfile, config: CreatorAutopilotConfig): TrackedEntry[] {
    const now = this.deps.now();
    const maxAgeMs = config.maxShortAgeHours * HOUR_MS;
    const entries: TrackedEntry[] = [];
    for (const video of this.deps.store.listAutopilotVideos(profile.id)) {
      if (video.status !== 'tracked' || now.getTime() - Date.parse(video.detectedAt) > maxAgeMs) {
        continue;
      }
      const job = video.jobId === null ? null : this.deps.store.getJob(video.jobId);
      if (!job) {
        continue;
      }
      entries.push({ video, job, plans: this.plan(video, job, config, now) });
    }
    return entries;
  }

  private plan(video: AutopilotVideoRecord, job: JobRecord, config: CreatorAutopilotConfig, now: Date): AutopilotShortPlan[] {
    const shorts = this.deps.store.listShortsForJob(job.id);
    return autopilotShortPlan({
      video,
      job,
      shorts,
      exports: shorts.flatMap((short) => this.deps.store.listExportsForShort(short.id)),
      publications: shorts.flatMap((short) => this.deps.store.listPublicationsForShort(short.id)),
      config,
      now,
      hasHostPanel: job.layoutProfileSnapshot.panels.some((panel) => panel.role === 'host'),
    });
  }

  private status(profile: CreatorProfile, config: CreatorAutopilotConfig): AutopilotStatusDto {
    const state = this.readState(profile.id);
    const videos: AutopilotVideoDto[] = [];
    for (const video of this.deps.store.listAutopilotVideos(profile.id).filter((entry) => entry.status === 'tracked').slice(0, 8)) {
      const job = video.jobId === null ? null : this.deps.store.getJob(video.jobId);
      videos.push({
        videoId: video.videoId,
        title: video.title,
        jobId: video.jobId,
        jobStatus: job?.status ?? null,
        detectedAt: video.detectedAt,
        shorts: job === null ? [] : this.plan(video, job, config, this.deps.now()).map((plan) => this.shortDto(plan)),
      });
    }
    return {
      creatorId: profile.id,
      displayName: profile.displayName,
      enabled: state.enabled,
      channelUrl: config.channelUrl,
      schedule: profile.schedule,
      shortsPerVideo: config.shortsPerVideo,
      platforms: config.platforms,
      reviewWindowHours: config.reviewWindowHours,
      lastCheckedAt: state.lastCheckedAt,
      lastCheckError: state.lastCheckError,
      checkRequested: state.checkRequested,
      videos,
    };
  }

  private shortDto(plan: AutopilotShortPlan): AutopilotShortDto {
    const gaveUp = this.gaveUpReason(plan);
    return {
      shortId: plan.short.id,
      rank: plan.short.rank,
      title: plan.short.title,
      state: gaveUp === null ? plan.state : 'skipped',
      scheduledFor: plan.scheduledFor,
      reason: gaveUp ?? plan.reason ?? this.preconditionErrors.get(plan.short.id) ?? this.lastActionError(plan),
    };
  }

  private pendingActions(plan: AutopilotShortPlan): ActionName[] {
    if (plan.state === 'exporting') {
      const actions: ActionName[] = [];
      if (plan.needsCopy) {
        actions.push('copy');
      }
      if (plan.needsExport) {
        actions.push('export');
      }
      return actions;
    }
    if (plan.state === 'ready') {
      return ['publish'];
    }
    return [];
  }

  private gaveUpReason(plan: AutopilotShortPlan): string | null {
    for (const action of this.pendingActions(plan)) {
      const failure = this.actionFailures.get(`${plan.short.id}:${action}`);
      if (failure !== undefined && failure.count >= ACTION_MAX_FAILURES) {
        return `Gave up after ${ACTION_MAX_FAILURES} failures: ${failure.lastError}`;
      }
    }
    return null;
  }

  private lastActionError(plan: AutopilotShortPlan): string | null {
    for (const action of this.pendingActions(plan)) {
      const failure = this.actionFailures.get(`${plan.short.id}:${action}`);
      if (failure !== undefined) {
        return failure.lastError;
      }
    }
    return null;
  }

  private async requireAutopilotProfile(creatorId: string): Promise<{ profile: CreatorProfile; config: CreatorAutopilotConfig }> {
    const profile = await this.deps.profiles.getCreatorProfileById(creatorId);
    if (!profile?.autopilot) {
      throw new StudioError('invalid', `Creator ${creatorId} has no autopilot configuration.`);
    }
    return { profile, config: profile.autopilot };
  }

  private readState(creatorId: string): AutopilotState {
    const raw = this.deps.store.getSetting(`autopilot:${creatorId}`);
    if (raw === null) {
      return { enabled: false, lastCheckedAt: null, lastCheckError: null, checkRequested: false };
    }
    return AutopilotStateSchema.parse(JSON.parse(raw));
  }

  private updateState(creatorId: string, patch: Partial<AutopilotState>): void {
    const next = { ...this.readState(creatorId), ...patch };
    this.deps.store.setSetting(`autopilot:${creatorId}`, JSON.stringify(next));
  }
}
