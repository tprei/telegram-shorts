import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Autopilot } from '../src/application/autopilot.js';
import { StudioService } from '../src/application/studio-service.js';
import { StudioError } from '../src/application/errors.js';
import { createInitialEdit, type ShortEdit, type WordRange } from '../src/domain/edit.js';
import { buildSentences } from '../src/domain/policies.js';
import type { LayoutProfile } from '../src/domain/layout.js';
import { zonedDateParts, zonedTimeToUtc, type PostingSchedule } from '../src/domain/schedule.js';
import type { AutopilotVideoRecord, CreatorProfile, ExportRecord, JobRecord, PublicationRecord, PublishingAccount, ShortRecord, TranscriptWord } from '../src/domain/model.js';
import { ShortsStore } from '../src/infra/db.js';
import type { AppConfig } from '../src/infra/env.js';
import { CreatorProfileRepository } from '../src/infra/creator-profile-loader.js';
import type { OpenRouterClient } from '../src/infra/openrouter.js';
import type { ChannelUpload } from '../src/infra/youtube.js';
import type { ShortVideoPublishProvider } from '../src/infra/instagram-publisher.js';
import { nowIso } from '../src/infra/util.js';

const HOUR_MS = 3_600_000;

const SCHEDULE: PostingSchedule = { timeZone: 'America/Sao_Paulo', slots: ['12:00', '19:00', '21:00'] };

const ACCOUNT_A: PublishingAccount = {
  id: 'account_a',
  displayName: 'Account A',
  schedule: SCHEDULE,
  platforms: ['instagram', 'tiktok', 'youtube_shorts'],
  mallaryProfileId: 'mallary_a',
  buffer: true,
};

const AUTOPILOT_CONFIG = {
  channelUrl: 'https://www.youtube.com/@filipe_boni/videos',
  shortsPerVideo: 2,
  platforms: ['instagram', 'tiktok'] as const,
  reviewWindowHours: 3,
  bookingHorizonHours: 24,
  maxShortAgeHours: 48,
  minVideoSeconds: 480,
};

const CREATOR: CreatorProfile = {
  id: 'creator_a',
  displayName: 'Creator A',
  enabled: true,
  accountId: 'account_a',
  render: {
    layoutPath: 'layouts/creator_a.json',
    layoutId: 'center-speaker-vertical-v2',
    defaultSpeed: 1,
    scene: null,
  },
  autopilot: AUTOPILOT_CONFIG,
};

function transcriptWords(): TranscriptWord[] {
  const texts = 'a regra do jogo mudou quando ninguem estava prestando atencao'.split(' ');
  return texts.map((text, index) => ({
    id: `w_${String(index + 1).padStart(6, '0')}`,
    text,
    startSeconds: index * 0.6,
    endSeconds: index * 0.6 + 0.5,
    speakerId: 'speaker_0',
    confidence: 0.99,
  }));
}

function layoutJson(creatorId: string) {
  return {
    version: 3,
    strategy: 'fixed',
    layoutId: 'center-speaker-vertical-v2',
    canvas: { width: 1080, height: 1920, fps: 30 },
    background: '#101010',
    font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
    panels: [{
      id: 'speaker',
      role: 'host',
      sourceRect: { x: 0.342, y: 0, w: 0.316, h: 1 },
      canvasRect: { x: 0, y: 0, w: 1, h: 1 },
      anchor: { x: 0.5, y: 0.4 },
    }],
    hookBand: null,
    captions: {
      sizePx: 64,
      textColor: '#FFFFFF',
      highlightColor: '#FFD400',
      outlineColor: '#000000',
      outlinePx: 6,
      shadowPx: 2,
      uppercase: true,
      maxWordsPerCue: 4,
      maxCharsPerLine: 16,
      maxLines: 2,
      centerY: 0.72,
    },
    safeArea: { top: 0.135, bottom: 0.17, side: 0.055 },
  };
}

function testConfig(rootDir: string): AppConfig {
  return {
    SHORTS_TRANSCRIPT_PROVIDER: 'deepgram',
    SHORTS_PUBLISH_PROVIDERS: 'mallary,buffer',
    SHORTS_DB_PATH: join(rootDir, 'shorts.sqlite'),
    SHORTS_ARTIFACTS_DIR: join(rootDir, 'artifacts'),
    MALLARY_AI_API_TOKEN: 'test-token',
    BUFFER_API_KEY: 'buffer-key',
    BUFFER_TIKTOK_CHANNEL_ID: 'tiktok-channel',
    rootDir,
    dbPath: join(rootDir, 'shorts.sqlite'),
    artifactsDir: join(rootDir, 'artifacts'),
    fontsDir: join(rootDir, 'assets', 'fonts'),
    webDistDir: join(rootDir, 'web', 'dist'),
  } as AppConfig;
}

function jobRecord(creator: CreatorProfile, rootDir: string, videoId: string, overrides: Partial<JobRecord> = {}): JobRecord {
  const words = transcriptWords();
  return {
    id: `job_${videoId}`,
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
    sourceTitle: `Video ${videoId}`,
    status: 'ready',
    progress: null,
    creatorProfileId: creator.id,
    creatorProfileSnapshot: creator,
    layoutProfileSnapshot: layoutJson(creator.id) as unknown as LayoutProfile,
    transcriptProvider: 'deepgram',
    media: {
      videoPath: join(rootDir, 'source.mp4'),
      audioPath: join(rootDir, 'source.m4a'),
      thumbnailPath: null,
      width: 1920,
      height: 1080,
      fps: 30,
      durationSeconds: words.length * 0.6,
    },
    transcriptWords: words,
    transcriptSentences: buildSentences(words),
    transcriptRevision: 0,
    semanticBlocks: [],
    strongSpeakers: [],
    chosenSpeakerId: 'speaker_0',
    hostFraming: null,
    hostFramingAnalyzedAt: nowIso(),
    sceneTrack: null,
    sceneAnalysis: 'none',
    sceneAnalysisError: null,
    failedTaskKind: null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  };
}

function fakePublisher(): ShortVideoPublishProvider {
  return {
    name: 'fake',
    supportedPlatforms: ['instagram', 'tiktok', 'youtube_shorts'],
    supportsScheduling: true,
    supports: () => true,
    canPublish: () => true,
    publishShortVideo: async () => {
      throw new Error('publisher must not be called from the autopilot tests');
    },
    checkPublication: async () => ({ status: 'pending', url: null, error: null }),
    cancelScheduled: async () => {
      throw new Error('publisher cancel must not be called from the autopilot tests');
    },
  };
}

interface TestContext {
  rootDir: string;
  store: ShortsStore;
  service: StudioService;
  autopilot: Autopilot;
  uploads: ChannelUpload[];
  uploadCalls: Array<{ channelUrl: string; limit: number }>;
  clock: () => Date;
  advanceMinutes: (minutes: number) => void;
  copyCalls: () => number;
  setGate: (gate: Promise<void>) => void;
  enteredCheck: () => Promise<void>;
}

async function makeContext(options: { accounts?: PublishingAccount[]; creators?: CreatorProfile[] } = {}): Promise<TestContext> {
  const rootDir = await mkdtemp(join(tmpdir(), 'autopilot-'));
  await mkdir(join(rootDir, 'layouts'), { recursive: true });
  const accounts = options.accounts ?? [ACCOUNT_A];
  const creators = options.creators ?? [CREATOR];
  for (const creator of creators) {
    await mkdir(join(rootDir, 'layouts'), { recursive: true });
    await writeFile(join(rootDir, creator.render.layoutPath), JSON.stringify(layoutJson(creator.id)));
  }
  await writeFile(join(rootDir, 'creator-profiles.json'), JSON.stringify({
    version: 3,
    defaultCreatorId: creators[0]?.id ?? 'creator_a',
    accounts,
    creators,
  }));
  const store = await ShortsStore.open(join(rootDir, 'shorts.sqlite'));
  const profiles = new CreatorProfileRepository({ rootDir, manifestPath: join(rootDir, 'creator-profiles.json') });
  const openRouter = {
    copyCalls: 0,
    async writePublishCopy() {
      this.copyCalls += 1;
      throw new Error('schema mismatch');
    },
  } as OpenRouterClient & { copyCalls: number };
  const service = new StudioService({
    config: testConfig(rootDir),
    store,
    openRouter,
    profiles,
    publisher: fakePublisher(),
  });
  const uploads: ChannelUpload[] = [];
  const uploadCalls: Array<{ channelUrl: string; limit: number }> = [];
  let current = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  let gate: Promise<void> = Promise.resolve();
  let entered = Promise.withResolvers<void>();
  const autopilot = new Autopilot({
    store,
    service,
    profiles,
    listUploads: async (channelUrl, limit) => {
      uploadCalls.push({ channelUrl, limit });
      entered.resolve();
      entered = Promise.withResolvers<void>();
      await gate;
      return uploads;
    },
    now: () => new Date(current),
  });
  return {
    rootDir,
    store,
    service,
    autopilot,
    uploads,
    uploadCalls,
    clock: () => new Date(current),
    advanceMinutes: (minutes) => {
      current += minutes * 60_000;
    },
    copyCalls: () => openRouter.copyCalls,
    setGate: (next) => {
      gate = next;
    },
    enteredCheck: () => entered.promise,
  };
}

async function cleanup(context: TestContext): Promise<void> {
  context.store.close();
  await rm(context.rootDir, { recursive: true, force: true });
}

function enableAutopilot(context: TestContext): Promise<unknown> {
  return context.autopilot.setEnabled(CREATOR.id, { enabled: true });
}

function upload(videoId: string, overrides: Partial<ChannelUpload> = {}): ChannelUpload {
  return { videoId, title: `Video ${videoId}`, durationSeconds: 900, liveStatus: null, ...overrides };
}

function seedReadyShort(store: ShortsStore, creator: CreatorProfile, rootDir: string, videoId: string, rank: number): { jobId: string; shortId: string; exportId: string } {
  const job = jobRecord(creator, rootDir, videoId);
  store.createJob(job);
  const words = job.transcriptWords;
  const range: WordRange = { startWord: 0, endWord: words.length - 1 };
  const edit: ShortEdit = createInitialEdit({ ranges: [range], words, speed: 1, hookText: 'A REGRA MUDOU' });
  const title = `Short ${videoId} ${rank}`;
  const short: ShortRecord = {
    id: `short_${videoId}_${rank}`,
    jobId: job.id,
    rank,
    origin: 'planner',
    title,
    summary: 'Resumo de teste',
    rationale: '',
    hook: '',
    payoff: '',
    risk: 'low',
    arc: null,
    status: 'active',
    edit,
    editRevision: 1,
    cropAnalysis: 'done',
    cropAnalysisError: null,
    publishCopy: { line1: 'Primeira linha', line2: 'Segunda linha', hashtags: ['#shorts'] },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.createShort(short);
  const exportRecord: ExportRecord = {
    id: `export_${videoId}_${rank}`,
    jobId: job.id,
    shortId: short.id,
    editRevision: 1,
    transcriptRevision: 0,
    edit,
    title,
    hostFraming: null,
    layoutProfileSnapshot: job.layoutProfileSnapshot,
    sceneTrack: null,
    status: 'ready',
    artifactPath: join(rootDir, `export_${videoId}_${rank}.mp4`),
    coverPath: null,
    sizeBytes: 1024,
    durationSeconds: 8,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.createExport(exportRecord);
  return { jobId: job.id, shortId: short.id, exportId: exportRecord.id };
}

function seedTrackedVideo(store: ShortsStore, videoId: string, jobId: string, detectedAt: Date, creatorId: string = CREATOR.id): AutopilotVideoRecord {
  const record: AutopilotVideoRecord = {
    creatorId,
    videoId,
    title: `Video ${videoId}`,
    status: 'tracked',
    jobId,
    detectedAt: detectedAt.toISOString(),
    retries: 0,
    lastRetryAt: null,
  };
  store.saveAutopilotVideo(record);
  return record;
}

function seedBlockPublication(store: ShortsStore, jobId: string, shortId: string, publicationId: string, scheduledFor: Date): PublicationRecord {
  const record: PublicationRecord = {
    id: publicationId,
    jobId,
    shortId,
    exportId: `export_block_${publicationId}`,
    platform: 'youtube_shorts',
    status: 'queued',
    forced: false,
    provider: null,
    batchId: null,
    remoteJobs: [],
    remoteUrl: null,
    submittedAt: null,
    scheduledFor: scheduledFor.toISOString(),
    error: null,
    availableAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.createPublication(record);
  return record;
}

function upcomingSlots(schedule: PostingSchedule, from: Date, to: Date, count: number): Date[] {
  const slots: Date[] = [];
  let cursor = from;
  for (let day = 0; day < 40 && slots.length < count; day += 1) {
    const parts = zonedDateParts(cursor, schedule.timeZone);
    for (const slot of schedule.slots) {
      const [hour, minute] = slot.split(':').map(Number);
      const instant = zonedTimeToUtc({ year: parts.year, month: parts.month, day: parts.day, hour, minute, timeZone: schedule.timeZone });
      if (instant.getTime() >= from.getTime() && instant.getTime() <= to.getTime()) {
        slots.push(instant);
        if (slots.length === count) {
          break;
        }
      }
    }
    cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12, 0, 0));
  }
  return slots;
}

function publicationsFor(store: ShortsStore, shortId: string): PublicationRecord[] {
  return store.listPublicationsForShort(shortId).filter((record) => !record.id.startsWith('pub_block_'));
}

test('the first check baselines only eligible uploads without creating jobs', async () => {
  const context = await makeContext();
  try {
    context.uploads.push(
      upload('longvid0001'),
      upload('shortvid001', { durationSeconds: 200 }),
      upload('premvid0001', { liveStatus: 'is_upcoming' }),
    );
    await enableAutopilot(context);
    await context.autopilot.tick();
    const videos = context.store.listAutopilotVideos(CREATOR.id);
    assert.equal(videos.length, 1);
    assert.equal(videos[0]?.videoId, 'longvid0001');
    assert.equal(videos[0]?.status, 'baseline');
    assert.equal(videos[0]?.jobId, null);
    assert.equal(context.store.getAutopilotVideo(CREATOR.id, 'shortvid001'), null);
    assert.equal(context.store.getAutopilotVideo(CREATOR.id, 'premvid0001'), null);
    assert.deepEqual(context.store.listJobSummaries(), []);
    assert.deepEqual(context.uploadCalls, [{ channelUrl: AUTOPILOT_CONFIG.channelUrl, limit: 15 }]);
    const [status] = await context.autopilot.list();
    assert.equal(status?.enabled, true);
    assert.equal(status?.checkRequested, false);
    assert.ok(status?.lastCheckedAt !== null);
    assert.equal(status?.lastCheckError, null);
  } finally {
    await cleanup(context);
  }
});

test('a new long upload creates exactly one job and a second tick creates no other', async () => {
  const context = await makeContext();
  try {
    context.uploads.push(upload('basevid0001'));
    await enableAutopilot(context);
    await context.autopilot.tick();
    context.uploads.unshift(upload('newvid00001'));
    await context.autopilot.tick();
    await context.autopilot.checkNow(CREATOR.id);
    await context.autopilot.tick();
    const jobs = context.store.listJobSummaries().filter((job) => job.sourceUrl === 'https://www.youtube.com/watch?v=newvid00001');
    assert.equal(jobs.length, 1);
    const video = context.store.getAutopilotVideo(CREATOR.id, 'newvid00001');
    assert.ok(video);
    assert.equal(video.status, 'tracked');
    assert.equal(video.jobId, jobs[0]?.id);
  } finally {
    await cleanup(context);
  }
});

test('an upload whose video already has a job links it instead of creating a new one', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyShort(context.store, CREATOR, context.rootDir, 'linkvid0001', 1);
    context.uploads.push(upload('basevid0001'));
    await enableAutopilot(context);
    await context.autopilot.tick();
    context.uploads.unshift(upload('linkvid0001'));
    await context.autopilot.checkNow(CREATOR.id);
    await context.autopilot.tick();
    assert.equal(context.store.listJobSummaries().length, 1);
    const video = context.store.getAutopilotVideo(CREATOR.id, 'linkvid0001');
    assert.ok(video);
    assert.equal(video.status, 'tracked');
    assert.equal(video.jobId, seeded.jobId);
  } finally {
    await cleanup(context);
  }
});

test('short and upcoming uploads are ignored until they become normal videos', async () => {
  const context = await makeContext();
  try {
    context.uploads.push(upload('basevid0001'));
    await enableAutopilot(context);
    await context.autopilot.tick();
    context.uploads.push(
      upload('shortvid001', { durationSeconds: 200 }),
      upload('premvid0001', { liveStatus: 'is_upcoming' }),
    );
    await context.autopilot.checkNow(CREATOR.id);
    await context.autopilot.tick();
    assert.equal(context.store.getAutopilotVideo(CREATOR.id, 'shortvid001'), null);
    assert.equal(context.store.getAutopilotVideo(CREATOR.id, 'premvid0001'), null);
    context.uploads.unshift(upload('premvid0001'));
    await context.autopilot.checkNow(CREATOR.id);
    await context.autopilot.tick();
    const video = context.store.getAutopilotVideo(CREATOR.id, 'premvid0001');
    assert.ok(video);
    assert.equal(video.status, 'tracked');
    assert.equal(context.store.getAutopilotVideo(CREATOR.id, 'shortvid001'), null);
  } finally {
    await cleanup(context);
  }
});

test('a disabled creator never calls listUploads', async () => {
  const context = await makeContext();
  try {
    context.uploads.push(upload('longvid0001'));
    await context.autopilot.tick();
    assert.deepEqual(context.uploadCalls, []);
    await enableAutopilot(context);
    await context.autopilot.tick();
    assert.equal(context.uploadCalls.length, 1);
  } finally {
    await cleanup(context);
  }
});

test('two ready shorts book 2 publications per platform at the first two free slots and a second tick books nothing new', async () => {
  const context = await makeContext();
  try {
    const first = seedReadyShort(context.store, CREATOR, context.rootDir, 'bookvid0001', 1);
    const second = seedReadyShort(context.store, CREATOR, context.rootDir, 'othervid001', 1);
    seedTrackedVideo(context.store, 'bookvid0001', first.jobId, new Date(context.clock().getTime() - 2 * HOUR_MS));
    seedTrackedVideo(context.store, 'othervid001', second.jobId, new Date(context.clock().getTime() - HOUR_MS));
    await enableAutopilot(context);
    await context.autopilot.tick();
    const expected = upcomingSlots(
      SCHEDULE,
      new Date(context.clock().getTime() + AUTOPILOT_CONFIG.reviewWindowHours * HOUR_MS),
      new Date(context.clock().getTime() + AUTOPILOT_CONFIG.bookingHorizonHours * HOUR_MS),
      2,
    );
    assert.equal(expected.length, 2);
    const firstPublications = publicationsFor(context.store, first.shortId);
    const secondPublications = publicationsFor(context.store, second.shortId);
    assert.equal(firstPublications.length, 2);
    assert.equal(secondPublications.length, 2);
    assert.deepEqual(firstPublications.map((record) => record.platform).sort(), ['instagram', 'tiktok']);
    assert.deepEqual(secondPublications.map((record) => record.platform).sort(), ['instagram', 'tiktok']);
    assert.ok(firstPublications.every((record) => record.scheduledFor === expected[1].toISOString()));
    assert.ok(secondPublications.every((record) => record.scheduledFor === expected[0].toISOString()));
    assert.equal(context.store.listJobSummaries().length, 2);
    await context.autopilot.tick();
    assert.equal(publicationsFor(context.store, first.shortId).length, 2);
    assert.equal(publicationsFor(context.store, second.shortId).length, 2);
  } finally {
    await cleanup(context);
  }
});

test('with one free slot and two videos the newer video rank-1 short gets it', async () => {
  const context = await makeContext();
  try {
    const older = seedReadyShort(context.store, CREATOR, context.rootDir, 'oldvid00001', 1);
    const newer = seedReadyShort(context.store, CREATOR, context.rootDir, 'newervid001', 1);
    seedTrackedVideo(context.store, 'oldvid00001', older.jobId, new Date(context.clock().getTime() - 3 * HOUR_MS));
    seedTrackedVideo(context.store, 'newervid001', newer.jobId, new Date(context.clock().getTime() - HOUR_MS));
    const from = new Date(context.clock().getTime() + AUTOPILOT_CONFIG.reviewWindowHours * HOUR_MS);
    const to = new Date(context.clock().getTime() + AUTOPILOT_CONFIG.bookingHorizonHours * HOUR_MS);
    const candidates = upcomingSlots(SCHEDULE, from, to, 5);
    assert.ok(candidates.length >= 2);
    for (const [index, slot] of candidates.slice(1).entries()) {
      seedBlockPublication(context.store, older.jobId, older.shortId, `pub_block_${index}`, slot);
    }
    await enableAutopilot(context);
    await context.autopilot.tick();
    const booked = publicationsFor(context.store, newer.shortId);
    assert.equal(booked.length, 2);
    assert.deepEqual(booked.map((record) => record.platform).sort(), ['instagram', 'tiktok']);
    assert.ok(booked.every((record) => record.scheduledFor === candidates[0].toISOString()));
    assert.equal(publicationsFor(context.store, older.shortId).length, 0);
  } finally {
    await cleanup(context);
  }
});

test('a failed job is retried after 30 minutes at most twice', async () => {
  const context = await makeContext();
  try {
    const job = jobRecord(CREATOR, context.rootDir, 'brokenvid01', { status: 'failed', failedTaskKind: 'process_source' });
    context.store.createJob(job);
    seedTrackedVideo(context.store, 'brokenvid01', job.id, context.clock());
    await enableAutopilot(context);
    await context.autopilot.tick();
    assert.equal(context.store.getAutopilotVideo(CREATOR.id, 'brokenvid01')?.retries, 0);
    let stored = context.store.getJob(job.id);
    assert.ok(stored);
    assert.equal(stored.status, 'failed');

    context.advanceMinutes(31);
    await context.autopilot.tick();
    let video = context.store.getAutopilotVideo(CREATOR.id, 'brokenvid01');
    assert.ok(video);
    assert.equal(video.retries, 1);
    assert.ok(video.lastRetryAt !== null);
    stored = context.store.getJob(job.id);
    assert.ok(stored);
    assert.equal(stored.status, 'downloading');
    context.store.updateJob({ ...stored, status: 'failed', failedTaskKind: 'process_source', updatedAt: nowIso() });

    context.advanceMinutes(31);
    await context.autopilot.tick();
    video = context.store.getAutopilotVideo(CREATOR.id, 'brokenvid01');
    assert.ok(video);
    assert.equal(video.retries, 2);
    stored = context.store.getJob(job.id);
    assert.ok(stored);
    assert.equal(stored.status, 'downloading');
    context.store.updateJob({ ...stored, status: 'failed', failedTaskKind: 'process_source', updatedAt: nowIso() });

    context.advanceMinutes(31);
    await context.autopilot.tick();
    video = context.store.getAutopilotVideo(CREATOR.id, 'brokenvid01');
    assert.ok(video);
    assert.equal(video.retries, 2);
    stored = context.store.getJob(job.id);
    assert.ok(stored);
    assert.equal(stored.status, 'failed');
  } finally {
    await cleanup(context);
  }
});

test('a throwing retryJob still counts as a retry', async () => {
  const context = await makeContext();
  try {
    const job = jobRecord(CREATOR, context.rootDir, 'vidnoft0001', { status: 'failed', failedTaskKind: null });
    context.store.createJob(job);
    seedTrackedVideo(context.store, 'vidnoft0001', job.id, context.clock());
    await enableAutopilot(context);
    await context.autopilot.tick();
    assert.equal(context.store.getAutopilotVideo(CREATOR.id, 'vidnoft0001')?.retries, 0);
    context.advanceMinutes(31);
    await context.autopilot.tick();
    const video = context.store.getAutopilotVideo(CREATOR.id, 'vidnoft0001');
    assert.equal(video?.retries, 1);
    assert.ok(video?.lastRetryAt !== null);
    assert.equal(context.store.getJob(job.id)?.status, 'failed');
  } finally {
    await cleanup(context);
  }
});

test('disabling autopilot while a check is in flight is not reverted', async () => {
  const context = await makeContext();
  try {
    context.uploads.push(upload('basevid0001'));
    await enableAutopilot(context);
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    context.setGate(gate);
    const ticking = context.autopilot.tick();
    await context.enteredCheck();
    const off = await context.autopilot.setEnabled(CREATOR.id, { enabled: false });
    assert.equal(off.enabled, false);
    release();
    await ticking;
    const [status] = await context.autopilot.list();
    assert.equal(status?.enabled, false);
    assert.equal(status?.lastCheckError, null);
  } finally {
    await cleanup(context);
  }
});

test('an old video sliding into the listing window does not become a job and unknown listings are reported', async () => {
  const context = await makeContext();
  try {
    for (let index = 1; index <= 15; index += 1) {
      context.uploads.push(upload(`vid${String(index).padStart(8, '0')}`));
    }
    await enableAutopilot(context);
    await context.autopilot.tick();
    assert.equal(context.store.listAutopilotVideos(CREATOR.id).length, 15);
    assert.equal(context.store.listJobSummaries().length, 0);
    context.uploads.splice(4, 1);
    context.uploads.push(upload('vid00000016'));
    await context.autopilot.checkNow(CREATOR.id);
    await context.autopilot.tick();
    assert.equal(context.store.listJobSummaries().length, 0);
    assert.equal(context.store.getAutopilotVideo(CREATOR.id, 'vid00000016'), null);
    context.uploads.splice(0, context.uploads.length, upload('freshvid001'), upload('freshvid002'));
    await context.autopilot.checkNow(CREATOR.id);
    await context.autopilot.tick();
    const [status] = await context.autopilot.list();
    assert.equal(status?.lastCheckError, "Couldn't find known videos in the channel listing");
    assert.equal(context.store.getAutopilotVideo(CREATOR.id, 'freshvid001'), null);
    assert.equal(context.store.listJobSummaries().length, 0);
  } finally {
    await cleanup(context);
  }
});

test('rejecting a booked short cancels its posts and books no replacement', async () => {
  const context = await makeContext();
  try {
    await enableAutopilot(context);
    await context.autopilot.tick();
    const seeded = seedReadyShort(context.store, CREATOR, context.rootDir, 'vidrej00001', 1);
    const baseShort = context.store.getShort(seeded.shortId);
    assert.ok(baseShort);
    const baseExport = context.store.listExportsForShort(seeded.shortId)[0];
    assert.ok(baseExport);
    for (const rank of [2, 3]) {
      context.store.createShort({ ...baseShort, id: `short_rej_${rank}`, rank, title: `Short rej ${rank}` });
      context.store.createExport({ ...baseExport, id: `export_rej_${rank}`, shortId: `short_rej_${rank}`, title: `Short rej ${rank}` });
    }
    seedTrackedVideo(context.store, 'vidrej00001', seeded.jobId, context.clock());
    await context.autopilot.tick();
    assert.equal(publicationsFor(context.store, seeded.shortId).length, 2);
    assert.equal(publicationsFor(context.store, 'short_rej_2').length, 2);
    await context.service.setShortStatus(seeded.shortId, { status: 'rejected' });
    assert.ok(publicationsFor(context.store, seeded.shortId).every((record) => record.status === 'cancelled'));
    await context.autopilot.tick();
    assert.equal(publicationsFor(context.store, 'short_rej_3').length, 0);
    assert.equal(publicationsFor(context.store, 'short_rej_2').filter((record) => record.status !== 'cancelled').length, 2);
  } finally {
    await cleanup(context);
  }
});

test('a failing copy generation backs off and gives up after three failures', async () => {
  const context = await makeContext();
  try {
    await enableAutopilot(context);
    await context.autopilot.tick();
    const seeded = seedReadyShort(context.store, CREATOR, context.rootDir, 'vidcopy0001', 1);
    const short = context.store.getShort(seeded.shortId);
    assert.ok(short);
    context.store.updateShort({ ...short, publishCopy: null });
    seedTrackedVideo(context.store, 'vidcopy0001', seeded.jobId, context.clock());
    await context.autopilot.tick();
    assert.equal(context.copyCalls(), 1);
    context.advanceMinutes(5);
    await context.autopilot.tick();
    assert.equal(context.copyCalls(), 1);
    context.advanceMinutes(6);
    await context.autopilot.tick();
    assert.equal(context.copyCalls(), 2);
    context.advanceMinutes(10);
    await context.autopilot.tick();
    assert.equal(context.copyCalls(), 3);
    context.advanceMinutes(10);
    await context.autopilot.tick();
    assert.equal(context.copyCalls(), 3);
    const [status] = await context.autopilot.list();
    const entry = status?.videos[0]?.shorts[0];
    assert.equal(entry?.state, 'skipped');
    assert.equal(entry?.reason, 'Gave up after 3 failures: Error: schema mismatch');
  } finally {
    await cleanup(context);
  }
});

test('a failed Check now waits for the normal interval before retrying', async () => {
  const context = await makeContext();
  try {
    context.uploads.push(upload('basevid0001'));
    await enableAutopilot(context);
    await context.autopilot.tick();
    await context.autopilot.checkNow(CREATOR.id);
    const failing: Promise<void> = Promise.reject(new Error('yt-dlp: Sign in to confirm you are not a bot'));
    failing.catch(() => {});
    context.setGate(failing);
    const before = context.uploadCalls.length;
    for (let index = 0; index < 5; index += 1) {
      await context.autopilot.tick();
      context.advanceMinutes(1);
    }
    assert.equal(context.uploadCalls.length - before, 1);
    const [status] = await context.autopilot.list();
    assert.match(status?.lastCheckError ?? '', /yt-dlp/);
    context.setGate(Promise.resolve());
  } finally {
    await cleanup(context);
  }
});

test('a scheduled publish conflicts with a nearby scheduled post of another short', async () => {
  const context = await makeContext();
  try {
    const first = seedReadyShort(context.store, CREATOR, context.rootDir, 'vidman00001', 1);
    const second = seedReadyShort(context.store, CREATOR, context.rootDir, 'vidman00002', 1);
    const third = seedReadyShort(context.store, CREATOR, context.rootDir, 'vidman00003', 1);
    const taken = upcomingSlots(SCHEDULE, new Date(context.clock().getTime() + 3 * HOUR_MS), new Date(context.clock().getTime() + 48 * HOUR_MS), 1)[0];
    assert.ok(taken);
    seedBlockPublication(context.store, first.jobId, first.shortId, 'pub_manual', taken);
    const conflictAt = new Date(taken.getTime() + 60 * 60_000);
    const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
    const parts = clock.formatToParts(taken);
    const hour = parts.find((part) => part.type === 'hour')?.value;
    const minute = parts.find((part) => part.type === 'minute')?.value;
    await assert.rejects(
      context.service.publish(second.exportId, { platforms: ['instagram'], force: false, scheduledAt: conflictAt.toISOString() }),
      (error: unknown) => error instanceof StudioError
        && error.code === 'conflict'
        && error.message === `Another post is scheduled for ${hour}:${minute} (Sao Paulo time). Pick a time at least 2 h away.`,
    );
    const far = new Date(taken.getTime() + 3 * HOUR_MS);
    const booked = await context.service.publish(second.exportId, { platforms: ['instagram'], force: false, scheduledAt: far.toISOString() });
    assert.equal(booked.length, 1);
    assert.equal(booked[0]?.scheduledFor, far.toISOString());
    const immediate = await context.service.publish(third.exportId, { platforms: ['instagram'], force: false, scheduledAt: null });
    assert.equal(immediate.length, 1);
    assert.equal(immediate[0]?.scheduledFor, null);
  } finally {
    await cleanup(context);
  }
});

test('two creators on Mix share slots and Boni books independently', async () => {
  const mixAccount: PublishingAccount = {
    id: 'mix',
    displayName: 'Mix',
    schedule: SCHEDULE,
    platforms: ['instagram', 'tiktok'],
    mallaryProfileId: 'mix_mallary_id',
    buffer: false,
  };
  const boniAccount: PublishingAccount = {
    id: 'cortes_do_boni',
    displayName: 'Cortes do Boni',
    schedule: SCHEDULE,
    platforms: ['instagram', 'tiktok', 'youtube_shorts'],
    mallaryProfileId: 'boni_mallary_id',
    buffer: true,
  };
  const creatorMix1: CreatorProfile = {
    id: 'creator_mix_1',
    displayName: 'Creator Mix 1',
    enabled: true,
    accountId: 'mix',
    render: { layoutPath: 'layouts/mix_1.json', layoutId: 'center-speaker-vertical-v2', defaultSpeed: 1, scene: null },
    autopilot: { ...AUTOPILOT_CONFIG, channelUrl: 'https://www.youtube.com/@mix1/videos' },
  };
  const creatorMix2: CreatorProfile = {
    id: 'creator_mix_2',
    displayName: 'Creator Mix 2',
    enabled: true,
    accountId: 'mix',
    render: { layoutPath: 'layouts/mix_2.json', layoutId: 'center-speaker-vertical-v2', defaultSpeed: 1, scene: null },
    autopilot: { ...AUTOPILOT_CONFIG, channelUrl: 'https://www.youtube.com/@mix2/videos' },
  };
  const creatorBoni: CreatorProfile = {
    id: 'creator_boni',
    displayName: 'Creator Boni',
    enabled: true,
    accountId: 'cortes_do_boni',
    render: { layoutPath: 'layouts/boni.json', layoutId: 'center-speaker-vertical-v2', defaultSpeed: 1, scene: null },
    autopilot: { ...AUTOPILOT_CONFIG, channelUrl: 'https://www.youtube.com/@boni/videos' },
  };

  const context = await makeContext({
    accounts: [mixAccount, boniAccount],
    creators: [creatorMix1, creatorMix2, creatorBoni],
  });

  try {
    const mix1Short1 = seedReadyShort(context.store, creatorMix1, context.rootDir, 'm1_vid1', 1);
    const mix1Short2 = seedReadyShort(context.store, creatorMix1, context.rootDir, 'm1_vid2', 1);
    const mix2Short1 = seedReadyShort(context.store, creatorMix2, context.rootDir, 'm2_vid1', 1);
    const mix2Short2 = seedReadyShort(context.store, creatorMix2, context.rootDir, 'm2_vid2', 1);
    const boniShort1 = seedReadyShort(context.store, creatorBoni, context.rootDir, 'b_vid1', 1);
    const boniShort2 = seedReadyShort(context.store, creatorBoni, context.rootDir, 'b_vid2', 1);

    seedTrackedVideo(context.store, 'm1_vid1', mix1Short1.jobId, new Date(context.clock().getTime() - 2 * HOUR_MS), creatorMix1.id);
    seedTrackedVideo(context.store, 'm1_vid2', mix1Short2.jobId, new Date(context.clock().getTime() - HOUR_MS), creatorMix1.id);
    seedTrackedVideo(context.store, 'm2_vid1', mix2Short1.jobId, new Date(context.clock().getTime() - 2 * HOUR_MS), creatorMix2.id);
    seedTrackedVideo(context.store, 'm2_vid2', mix2Short2.jobId, new Date(context.clock().getTime() - HOUR_MS), creatorMix2.id);
    seedTrackedVideo(context.store, 'b_vid1', boniShort1.jobId, new Date(context.clock().getTime() - 2 * HOUR_MS), creatorBoni.id);
    seedTrackedVideo(context.store, 'b_vid2', boniShort2.jobId, new Date(context.clock().getTime() - HOUR_MS), creatorBoni.id);

    await context.autopilot.setEnabled(creatorMix1.id, { enabled: true });
    await context.autopilot.setEnabled(creatorMix2.id, { enabled: true });
    await context.autopilot.setEnabled(creatorBoni.id, { enabled: true });

    await context.autopilot.tick();

    const expected = upcomingSlots(
      SCHEDULE,
      new Date(context.clock().getTime() + AUTOPILOT_CONFIG.reviewWindowHours * HOUR_MS),
      new Date(context.clock().getTime() + AUTOPILOT_CONFIG.bookingHorizonHours * HOUR_MS),
      4,
    );

    const boniPubs1 = publicationsFor(context.store, boniShort1.shortId);
    const boniPubs2 = publicationsFor(context.store, boniShort2.shortId);
    assert.ok(boniPubs1.length > 0);
    assert.ok(boniPubs2.length > 0);
    const boniSlots = [...boniPubs1, ...boniPubs2].map((p) => p.scheduledFor);
    assert.ok(boniSlots.includes(expected[0]?.toISOString()));
    assert.ok(boniSlots.includes(expected[1]?.toISOString()));

    const m1Pubs1 = publicationsFor(context.store, mix1Short1.shortId);
    const m1Pubs2 = publicationsFor(context.store, mix1Short2.shortId);
    const m2Pubs1 = publicationsFor(context.store, mix2Short1.shortId);
    const m2Pubs2 = publicationsFor(context.store, mix2Short2.shortId);

    const mixBookedSlots = [
      ...m1Pubs1.map((p) => p.scheduledFor),
      ...m1Pubs2.map((p) => p.scheduledFor),
      ...m2Pubs1.map((p) => p.scheduledFor),
      ...m2Pubs2.map((p) => p.scheduledFor),
    ].filter((s): s is string => s !== null);

    assert.ok(new Set(mixBookedSlots).size >= 2);
    const m1Slots = new Set([...m1Pubs1, ...m1Pubs2].map((p) => p.scheduledFor));
    const m2Slots = new Set([...m2Pubs1, ...m2Pubs2].map((p) => p.scheduledFor));
    for (const slot of m1Slots) {
      assert.equal(m2Slots.has(slot), false);
    }
  } finally {
    await cleanup(context);
  }
});

test('unconnected account keeps new autopilots off and reports connection reason', async () => {
  const unconnectedAccount: PublishingAccount = {
    id: 'mix_unconnected',
    displayName: 'Mix Unconnected',
    schedule: SCHEDULE,
    platforms: ['instagram', 'tiktok'],
    mallaryProfileId: null,
    buffer: false,
  };
  const mixCreator: CreatorProfile = {
    id: 'creator_mix_unconn',
    displayName: 'Mix Creator',
    enabled: true,
    accountId: 'mix_unconnected',
    render: { layoutPath: 'layouts/mix_unconn.json', layoutId: 'center-speaker-vertical-v2', defaultSpeed: 1, scene: null },
    autopilot: AUTOPILOT_CONFIG,
  };

  const context = await makeContext({
    accounts: [unconnectedAccount],
    creators: [mixCreator],
  });

  try {
    const statuses = await context.autopilot.list();
    const mixStatus = statuses.find((s) => s.creatorId === mixCreator.id);
    assert.ok(mixStatus);
    assert.equal(mixStatus.accountConnected, false);
    assert.equal(mixStatus.reason, 'Account not connected in Mallary');
    assert.equal(mixStatus.enabled, false);

    await assert.rejects(
      context.autopilot.setEnabled(mixCreator.id, { enabled: true }),
      (error: unknown) => error instanceof StudioError
        && error.code === 'invalid'
        && error.message === 'Account not connected in Mallary',
    );

    context.uploads.push(upload('mixvid0001'));
    await context.autopilot.tick();

    assert.equal(context.uploadCalls.length, 0);
    assert.equal(context.store.listJobSummaries().length, 0);
    assert.equal(context.store.listAutopilotVideos(mixCreator.id).length, 0);
  } finally {
    await cleanup(context);
  }
});

test('capacity is rechecked after manual bookings during autopilot awaits', async () => {
  const context = await makeContext({ creators: [{ ...CREATOR, autopilot: { ...AUTOPILOT_CONFIG, bookingHorizonHours: 72 } }] });
  try {
    const raceCreator: CreatorProfile = { ...CREATOR, autopilot: { ...AUTOPILOT_CONFIG, bookingHorizonHours: 72 } };
    const first = seedReadyShort(context.store, raceCreator, context.rootDir, 'racevid0001', 1);
    const second = seedReadyShort(context.store, raceCreator, context.rootDir, 'racevid0002', 1);
    const manual = seedReadyShort(context.store, raceCreator, context.rootDir, 'racevid0003', 1);
    seedTrackedVideo(context.store, 'racevid0001', first.jobId, new Date(context.clock().getTime() - 2 * HOUR_MS));
    seedTrackedVideo(context.store, 'racevid0002', second.jobId, new Date(context.clock().getTime() - HOUR_MS));

    const from = new Date(context.clock().getTime() + AUTOPILOT_CONFIG.reviewWindowHours * HOUR_MS);
    const to = new Date(context.clock().getTime() + 72 * HOUR_MS);
    const slots = upcomingSlots(SCHEDULE, from, to, 3);
    assert.ok(slots.length >= 3);

    const originalPublish = context.service.publish.bind(context.service);
    let publishCount = 0;
    context.service.publish = async (exportId, input) => {
      publishCount += 1;
      if (publishCount === 1) {
        seedBlockPublication(context.store, manual.jobId, manual.shortId, 'pub_manual_intervene', slots[1]);
      }
      return originalPublish(exportId, input);
    };

    await enableAutopilot(context);
    await context.autopilot.tick();

    const firstPubs = publicationsFor(context.store, first.shortId);
    const secondPubs = publicationsFor(context.store, second.shortId);
    assert.ok(firstPubs.length > 0);
    assert.ok(secondPubs.length > 0);

    assert.equal(secondPubs[0]?.scheduledFor, slots[0].toISOString());
    assert.equal(firstPubs[0]?.scheduledFor, slots[2].toISOString());
  } finally {
    await cleanup(context);
  }
});
