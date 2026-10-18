import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { StudioService } from '../src/application/studio-service.js';
import { ShortsPipeline } from '../src/application/pipeline.js';
import { StudioError } from '../src/application/errors.js';
import { mallaryCooldownKey } from '../src/application/platforms.js';
import { createInitialEdit, type ShortEdit, type WordRange } from '../src/domain/edit.js';
import { buildSentences } from '../src/domain/policies.js';
import type { LayoutProfile } from '../src/domain/layout.js';
import { QUEUE_LANES, type AutopilotVideoRecord, type CreatorProfile, type ExportRecord, type JobRecord, type JobSummaryRecord, type PublicationRecord, type PublishCopyResponse, type RevisionIntent, type ShortRecord, type TranscriptWord } from '../src/domain/model.js';
import { acquireStudioLock } from '../src/infra/studio-lock.js';
import { ShortsStore } from '../src/infra/db.js';
import { runProcess } from '../src/infra/process.js';
import type { AppConfig } from '../src/infra/env.js';
import { CreatorProfileRepository } from '../src/infra/creator-profile-loader.js';
import type { OpenRouterClient } from '../src/infra/openrouter.js';
import type { ShortVideoCheckPublicationInput, ShortVideoPublishInput, ShortVideoPublishProvider, ShortVideoPublishResult, RemotePublicationState } from '../src/infra/instagram-publisher.js';
import { ShortVideoPublishError } from '../src/infra/instagram-publisher.js';
import { boxToSourceFocus } from '../src/infra/vision.js';
import { nowIso } from '../src/infra/util.js';

const CREATOR_A: CreatorProfile = {
  id: 'creator_a',
  displayName: 'Creator A',
  enabled: true,
  render: { layoutPath: 'layouts/creator_a.json', layoutId: 'center-speaker-vertical-v2' },
  publish: {
    instagram: { mode: 'global' },
    tiktok: { mode: 'global' },
    youtube_shorts: { mode: 'global' },
  },
  schedule: { timeZone: 'America/Sao_Paulo', slots: ['12:00', '19:00', '21:00'] },
};

const CREATOR_B: CreatorProfile = {
  id: 'creator_b',
  displayName: 'Creator B',
  enabled: true,
  render: { layoutPath: 'layouts/creator_b.json', layoutId: 'center-speaker-vertical-v2' },
  publish: {
    instagram: { mode: 'disabled' },
    tiktok: { mode: 'disabled' },
    youtube_shorts: { mode: 'disabled' },
  },
  schedule: { timeZone: 'America/Sao_Paulo', slots: ['12:00', '19:00', '21:00'] },
};

interface TestContext {
  rootDir: string;
  dbPath: string;
  config: AppConfig;
  openRouter: OpenRouterClient;
  store: ShortsStore;
  service: StudioService;
}

async function makeContext(
  openRouter: OpenRouterClient = {} as OpenRouterClient,
  publisher: ShortVideoPublishProvider | null = fakePublisher(),
  configOverrides: Record<string, unknown> = {},
): Promise<TestContext> {
  const rootDir = await mkdtemp(join(tmpdir(), 'studio-service-'));
  await mkdir(join(rootDir, 'layouts'), { recursive: true });
  await writeFile(join(rootDir, 'layouts', 'creator_a.json'), JSON.stringify(layoutJson('creator_a')));
  await writeFile(join(rootDir, 'layouts', 'creator_b.json'), JSON.stringify(layoutJson('creator_b')));
  await writeFile(join(rootDir, 'creator-profiles.json'), JSON.stringify({
    version: 2,
    defaultCreatorId: 'creator_a',
    creators: [CREATOR_A, CREATOR_B],
  }));
  const store = await ShortsStore.open(join(rootDir, 'shorts.sqlite'));
  const profiles = new CreatorProfileRepository({ rootDir, manifestPath: join(rootDir, 'creator-profiles.json') });
  const config = { ...testConfig(rootDir), ...configOverrides } as AppConfig;
  const service = new StudioService({
    config,
    store,
    openRouter,
    profiles,
    publisher,
  });
  return { rootDir, dbPath: join(rootDir, 'shorts.sqlite'), config, openRouter, store, service };
}

async function cleanup(context: TestContext): Promise<void> {
  context.store.close();
  await rm(context.rootDir, { recursive: true, force: true });
}

function testConfig(rootDir: string): AppConfig {
  return {
    SHORTS_TRANSCRIPT_PROVIDER: 'deepgram',
    SHORTS_PUBLISH_PROVIDERS: 'mallary,buffer',
    SHORTS_DB_PATH: join(rootDir, 'shorts.sqlite'),
    SHORTS_ARTIFACTS_DIR: join(rootDir, 'artifacts'),
    MALLARY_AI_API_TOKEN: 'test-token',
    rootDir,
    dbPath: join(rootDir, 'shorts.sqlite'),
    artifactsDir: join(rootDir, 'artifacts'),
    fontsDir: join(rootDir, 'assets', 'fonts'),
    webDistDir: join(rootDir, 'web', 'dist'),
  } as AppConfig;
}

function fakePublisher(): ShortVideoPublishProvider {
  return {
    name: 'fake',
    supportedPlatforms: ['instagram', 'tiktok', 'youtube_shorts'],
    supportsScheduling: true,
    supports: () => true,
    publishShortVideo: async () => {
      throw new Error('publisher must not be called from the studio service');
    },
    cancelScheduled: async () => {
      throw new Error('publisher cancel must not be called from the studio service');
    },
  };
}

function layoutJson(creatorId: string) {
  return {
    version: 2,
    creatorId,
    layoutId: 'center-speaker-vertical-v2',
    canvas: { width: 1080, height: 1920, fps: 30 },
    background: '#101010',
    defaultSpeed: 1,
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
  };
}

function layoutSnapshot(creatorId: string): LayoutProfile {
  return layoutJson(creatorId) as unknown as LayoutProfile;
}

function transcriptWords(): TranscriptWord[] {
  const texts = 'a regra do jogo mudou quando ninguem estava prestando atencao no detalhe final'.split(' ');
  return texts.map((text, index) => ({
    id: `w_${String(index + 1).padStart(6, '0')}`,
    text,
    startSeconds: index * 0.6,
    endSeconds: index * 0.6 + 0.5,
    speakerId: 'speaker_0',
    confidence: 0.99,
  }));
}

interface SeededJob {
  jobId: string;
  shortId: string;
  edit: ShortEdit;
}

function seedReadyJob(store: ShortsStore, creator: CreatorProfile, rootDir: string, words: TranscriptWord[] = transcriptWords()): SeededJob {
  const range: WordRange = { startWord: 0, endWord: words.length - 1 };
  const edit = createInitialEdit({ ranges: [range], words, speed: 1, hookText: 'A REGRA MUDOU' });
  const job: JobRecord = {
    id: 'job_test',
    sourceUrl: 'https://youtube.com/watch?v=abc',
    sourceTitle: 'Video de teste',
    status: 'ready',
    progress: null,
    creatorProfileId: creator.id,
    creatorProfileSnapshot: creator,
    layoutProfileSnapshot: layoutSnapshot(creator.id),
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
    hostFramingAnalyzedAt: null,
    failedTaskKind: null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.createJob(job);
  const short: ShortRecord = {
    id: 'short_test',
    jobId: job.id,
    rank: 1,
    origin: 'manual',
    title: 'Short de teste',
    summary: 'Resumo de teste',
    rationale: '',
    hook: '',
    payoff: '',
    risk: 'low',
    arc: null,
    status: 'active',
    edit,
    editRevision: 1,
    cropAnalysis: 'none',
    cropAnalysisError: null,
    publishCopy: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.createShort(short);
  return { jobId: job.id, shortId: short.id, edit };
}

function seedReadyExport(store: ShortsStore, seeded: SeededJob, rootDir: string): ExportRecord {
  const record: ExportRecord = {
    id: 'export_test',
    jobId: seeded.jobId,
    shortId: seeded.shortId,
    editRevision: 1,
    transcriptRevision: 0,
    edit: seeded.edit,
    title: 'Short de teste',
    hostFraming: null,
    status: 'ready',
    artifactPath: join(rootDir, 'export.mp4'),
    sizeBytes: 1024,
    durationSeconds: 8,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.createExport(record);
  return record;
}

function autopilotVideo(videoId: string, overrides: Partial<AutopilotVideoRecord> = {}): AutopilotVideoRecord {
  return {
    creatorId: 'filipe_boni',
    videoId,
    title: `Video ${videoId}`,
    status: 'baseline',
    jobId: null,
    detectedAt: '2026-10-18T12:00:00.000Z',
    retries: 0,
    lastRetryAt: null,
    ...overrides,
  };
}

function isStudioErrorWithCode(code: StudioError['code']): (error: unknown) => boolean {
  return (error) => error instanceof StudioError && error.code === code;
}

interface RecordingPublisher {
  provider: ShortVideoPublishProvider;
  publishInputs: ShortVideoPublishInput[];
  checkInputs: ShortVideoCheckPublicationInput[];
  cancelInputs: ShortVideoCheckPublicationInput[];
}

function recordingPublisher(options: {
  result: ShortVideoPublishResult;
  checkState?: RemotePublicationState;
  checkError?: Error;
  cancelError?: Error;
}): RecordingPublisher {
  const publishInputs: ShortVideoPublishInput[] = [];
  const checkInputs: ShortVideoCheckPublicationInput[] = [];
  const cancelInputs: ShortVideoCheckPublicationInput[] = [];
  const provider: ShortVideoPublishProvider = {
    name: 'fake',
    supportedPlatforms: ['instagram', 'tiktok', 'youtube_shorts'],
    supportsScheduling: true,
    supports: () => true,
    publishShortVideo: async (input) => {
      publishInputs.push(input);
      return options.result;
    },
    checkPublication: async (input) => {
      checkInputs.push(input);
      if (options.checkError) {
        throw options.checkError;
      }
      return options.checkState ?? { status: 'pending', url: null, error: null };
    },
    cancelScheduled: async (input) => {
      cancelInputs.push(input);
      if (options.cancelError) {
        throw options.cancelError;
      }
    },
  };
  return { provider, publishInputs, checkInputs, cancelInputs };
}

function pipelineFor(context: TestContext, publisher: ShortVideoPublishProvider, openRouter: OpenRouterClient = context.openRouter): ShortsPipeline {
  return new ShortsPipeline({
    config: context.config,
    store: context.store,
    openRouter,
    profiles: new CreatorProfileRepository({ rootDir: context.rootDir, manifestPath: join(context.rootDir, 'creator-profiles.json') }),
    publisher,
  });
}

function copyWriter(): OpenRouterClient {
  return {
    writePublishCopy: async () => ({ line_1: 'Primeira linha', line_2: 'Segunda linha', hashtags: ['#um', '#dois', '#tres'] }),
  } as OpenRouterClient;
}

function bufferChannelConfig(): Record<string, unknown> {
  return { BUFFER_API_KEY: 'buffer-key', BUFFER_TIKTOK_CHANNEL_ID: 'tiktok-channel' };
}

function seedSubmittedPublication(store: ShortsStore, seeded: SeededJob, exportId: string, overrides: Partial<PublicationRecord> = {}): PublicationRecord {
  const publication: PublicationRecord = {
    id: 'pub_submitted',
    jobId: seeded.jobId,
    shortId: seeded.shortId,
    exportId,
    platform: 'tiktok',
    status: 'submitted',
    forced: false,
    provider: 'fake',
    batchId: 'batch_1',
    remoteJobs: [{ platform: 'tiktok', jobId: 'remote_job_1' }],
    remoteUrl: null,
    submittedAt: nowIso(),
    scheduledFor: null,
    error: null,
    availableAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  };
  store.createPublication(publication);
  return publication;
}

interface QueueTaskRow {
  kind: string;
  status: string;
  available_at: string | null;
  payload: object;
}

function queuedTasks(dbPath: string, kind: string): QueueTaskRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT kind, status, available_at, payload_json FROM queue_tasks WHERE kind = ? ORDER BY created_at ASC').all(kind).map((row) => {
      if (typeof row !== 'object' || row === null || !('kind' in row) || !('status' in row) || !('available_at' in row) || !('payload_json' in row)) {
        throw new Error('Unexpected queue task row shape');
      }
      const task: unknown = JSON.parse(String(row.payload_json));
      if (typeof task !== 'object' || task === null || !('payload' in task) || typeof task.payload !== 'object' || task.payload === null) {
        throw new Error('Unexpected queue task payload shape');
      }
      const payload: Record<string, unknown> = task.payload;
      return {
        kind: String(row.kind),
        status: String(row.status),
        available_at: typeof row.available_at === 'string' ? row.available_at : null,
        payload,
      };
    });
  } finally {
    db.close();
  }
}

function assertRescheduledInAboutSeconds(availableAt: string | null, expectedSeconds: number): void {
  assert.ok(availableAt);
  const delayMs = Date.parse(availableAt) - Date.now();
  assert.ok(delayMs > (expectedSeconds - 5) * 1000 && delayMs < (expectedSeconds + 5) * 1000, `expected ~${expectedSeconds}s delay, got ${delayMs}ms`);
}

function deadPid(): number {
  for (let pid = 4194304; pid > 1000; pid -= 1) {
    if (!existsSync(`/proc/${pid}`)) {
      return pid;
    }
  }
  throw new Error('no dead pid found');
}

function gatedRevisionOpenRouter(intent: RevisionIntent): { openRouter: OpenRouterClient; release: () => void } {
  let releaseParse: (intent: RevisionIntent) => void = () => {};
  const gate = new Promise<RevisionIntent>((resolve) => {
    releaseParse = resolve;
  });
  const openRouter = {
    parseRevision: async () => {
      await gate;
      return intent;
    },
  } as OpenRouterClient;
  return { openRouter, release: () => releaseParse(intent) };
}

test('creator precedence: requested creator beats studio default beats manifest default', async () => {
  const context = await makeContext();
  try {
    const initial = await context.service.listCreators();
    assert.equal(initial.find((creator) => creator.isDefault)?.id, 'creator_a');

    await context.service.setDefaultCreator({ creatorId: 'creator_b' });
    const switched = await context.service.listCreators();
    assert.equal(switched.find((creator) => creator.isDefault)?.id, 'creator_b');

    const requestedJob = await context.service.createJob({ url: 'https://youtube.com/watch?v=abc', creatorId: 'creator_a' });
    assert.equal(requestedJob.creator.id, 'creator_a');

    const studioDefaultJob = await context.service.createJob({ url: 'https://youtu.be/abc' });
    assert.equal(studioDefaultJob.creator.id, 'creator_b');
  } finally {
    await cleanup(context);
  }
});

test('saveEdit rejects a stale base revision and accepts the current one', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const detail = await context.service.getShort(seeded.shortId);
    await assert.rejects(
      context.service.saveEdit(seeded.shortId, { edit: detail.short.edit, baseRevision: 0 }),
      isStudioErrorWithCode('conflict'),
    );
    const saved = await context.service.saveEdit(seeded.shortId, { edit: detail.short.edit, baseRevision: 1 });
    assert.equal(saved.short.editRevision, 2);
  } finally {
    await cleanup(context);
  }
});

test('exportShort deduplicates per edit revision', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const first = await context.service.exportShort(seeded.shortId);
    const second = await context.service.exportShort(seeded.shortId);
    assert.equal(second.exports.length, 1);
    assert.equal(second.exports[0].id, first.exports[0].id);
    assert.equal(context.store.listExportsForShort(seeded.shortId).length, 1);

    const edited = await context.service.saveEdit(seeded.shortId, { edit: first.short.edit, baseRevision: 1 });
    const afterEdit = await context.service.exportShort(seeded.shortId);
    assert.equal(context.store.listExportsForShort(seeded.shortId).length, 2);
    assert.notEqual(afterEdit.exports[0].id, edited.exports[0].id);
    assert.equal(afterEdit.exports[0].editRevision, 2);
  } finally {
    await cleanup(context);
  }
});

test('correctWord updates the word and its sentence, bumps the revision, and ignores identical text', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const before = context.store.getJob(seeded.jobId);
    assert.ok(before);
    assert.equal(before.transcriptRevision, 0);
    const sentence = before.transcriptSentences.find((entry) => 3 >= entry.startWord && 3 <= entry.endWord);
    assert.ok(sentence);

    const corrected = context.service.correctWord(seeded.jobId, 3, { text: 'mes' });
    assert.equal(corrected.words[3].text, 'mes');
    const correctedSentence = corrected.sentences.find((entry) => entry.id === sentence.id);
    assert.ok(correctedSentence);
    assert.equal(correctedSentence.text, sentence.text.replace('jogo', 'mes'));

    const stored = context.store.getJob(seeded.jobId);
    assert.ok(stored);
    assert.equal(stored.transcriptRevision, 1);
    assert.equal(stored.transcriptWords[3].text, 'mes');
    assert.equal(stored.transcriptSentences.find((entry) => entry.id === sentence.id)?.text, correctedSentence.text);

    const unchanged = context.service.correctWord(seeded.jobId, 3, { text: 'mes' });
    assert.deepEqual(unchanged, corrected);
    assert.equal(context.store.getJob(seeded.jobId)?.transcriptRevision, 1);
  } finally {
    await cleanup(context);
  }
});

test('correctWord rebuilds the sentence text without an interleaved other-speaker word', async () => {
  const context = await makeContext();
  try {
    const words: TranscriptWord[] = [
      { id: 'w_000001', text: 'oi', startSeconds: 2.0, endSeconds: 2.5, speakerId: 'speaker_0', confidence: 0.99 },
      { id: 'w_000002', text: 'blá', startSeconds: 0.5, endSeconds: 1.0, speakerId: 'speaker_1', confidence: 0.99 },
      { id: 'w_000003', text: 'assunto.', startSeconds: 2.5, endSeconds: 3.0, speakerId: 'speaker_0', confidence: 0.99 },
    ];
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir, words);
    const corrected = context.service.correctWord(seeded.jobId, 0, { text: 'olá' });
    assert.equal(corrected.words[0].text, 'olá');
    assert.deepEqual(
      corrected.sentences.map((sentence) => [sentence.startWord, sentence.endWord, sentence.text]),
      [
        [1, 1, 'blá'],
        [0, 2, 'olá assunto.'],
      ],
    );
  } finally {
    await cleanup(context);
  }
});

test('correctWord conflicts while planning and rejects out-of-range indices', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const job = context.store.getJob(seeded.jobId);
    assert.ok(job);
    job.status = 'planning';
    context.store.updateJob(job);
    assert.throws(
      () => context.service.correctWord(seeded.jobId, 3, { text: 'mes' }),
      isStudioErrorWithCode('conflict'),
    );
    job.status = 'ready';
    context.store.updateJob(job);
    assert.throws(
      () => context.service.correctWord(seeded.jobId, job.transcriptWords.length, { text: 'mes' }),
      isStudioErrorWithCode('invalid'),
    );
    assert.throws(
      () => context.service.correctWord(seeded.jobId, -1, { text: 'mes' }),
      isStudioErrorWithCode('invalid'),
    );
  } finally {
    await cleanup(context);
  }
});

test('a correction invalidates exports created before it', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const first = await context.service.exportShort(seeded.shortId);
    assert.equal(context.store.listExportsForShort(seeded.shortId).length, 1);

    context.service.correctWord(seeded.jobId, 3, { text: 'mes' });
    const second = await context.service.exportShort(seeded.shortId);
    assert.equal(context.store.listExportsForShort(seeded.shortId).length, 2);
    assert.notEqual(second.exports[0].id, first.exports[0].id);

    const third = await context.service.exportShort(seeded.shortId);
    assert.equal(context.store.listExportsForShort(seeded.shortId).length, 2);
    assert.equal(third.exports[0].id, second.exports[0].id);
  } finally {
    await cleanup(context);
  }
});

test('a version-2 database migrates payloads to transcriptRevision 0 and unknown versions throw', async () => {
  const context = await makeContext();
  const dbPath = join(context.rootDir, 'shorts.sqlite');
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    seedReadyExport(context.store, seeded, context.rootDir);
    context.store.close();

    const legacy = new DatabaseSync(dbPath);
    legacy.exec("UPDATE jobs SET payload_json = json_remove(payload_json, '$.transcriptRevision')");
    legacy.exec("UPDATE exports SET payload_json = json_remove(payload_json, '$.transcriptRevision')");
    legacy.exec('PRAGMA user_version = 2');
    legacy.close();

    const migrated = await ShortsStore.open(dbPath);
    try {
      const job = migrated.getJob(seeded.jobId);
      assert.ok(job);
      assert.equal(job.transcriptRevision, 0);
      const record = migrated.getExport('export_test');
      assert.ok(record);
      assert.equal(record.transcriptRevision, 0);
    } finally {
      migrated.close();
    }

    const unknown = new DatabaseSync(dbPath);
    unknown.exec('PRAGMA user_version = 9');
    unknown.close();
    await assert.rejects(ShortsStore.open(dbPath), /Incompatible database/);
  } finally {
    await rm(context.rootDir, { recursive: true, force: true });
  }
});

test('publish returns the in-flight publication, conflicts once posted, and force reposts only after it settles', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const first = await context.service.publish(exportRecord.id, { platforms: ['instagram'], force: false, scheduledAt: null });
    assert.equal(first.length, 1);
    assert.equal(first[0].status, 'queued');

    const second = await context.service.publish(exportRecord.id, { platforms: ['instagram'], force: false, scheduledAt: null });
    assert.equal(second[0].id, first[0].id);
    assert.equal(context.store.listPublicationsForShort(seeded.shortId).length, 1);

    await assert.rejects(
      context.service.publish(exportRecord.id, { platforms: ['instagram'], force: true, scheduledAt: null }),
      isStudioErrorWithCode('conflict'),
    );

    const record = context.store.getPublication(first[0].id);
    assert.ok(record);
    record.status = 'published';
    context.store.updatePublication(record);

    await assert.rejects(
      context.service.publish(exportRecord.id, { platforms: ['instagram'], force: false, scheduledAt: null }),
      isStudioErrorWithCode('conflict'),
    );

    const forced = await context.service.publish(exportRecord.id, { platforms: ['instagram'], force: true, scheduledAt: null });
    assert.notEqual(forced[0].id, first[0].id);
    assert.equal(forced[0].forced, true);
    assert.equal(context.store.listPublicationsForShort(seeded.shortId).length, 2);
  } finally {
    await cleanup(context);
  }
});

test('publish is rejected for a render-only creator', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_B, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const detail = await context.service.getShort(seeded.shortId);
    assert.ok(detail.platforms.every((platform) => !platform.available && platform.reason !== null));
    await assert.rejects(
      context.service.publish(exportRecord.id, { platforms: ['instagram'], force: false, scheduledAt: null }),
      isStudioErrorWithCode('invalid'),
    );
  } finally {
    await cleanup(context);
  }
});

test('revise rejects with conflict when an autosave lands while parsing', async () => {
  const intent: RevisionIntent = { summary: 'Acelera o ritmo', actions: [{ kind: 'set_speed', speed: 1.25 }] };
  const { openRouter, release } = gatedRevisionOpenRouter(intent);
  const context = await makeContext(openRouter);
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const before = context.store.getShort(seeded.shortId);
    assert.ok(before);
    const pending = context.service.revise(seeded.shortId, { message: 'deixa mais rapido', baseRevision: 1 });
    const autosaved = await context.service.saveEdit(seeded.shortId, {
      edit: { ...before.edit, removedWords: [...before.edit.removedWords, 2] },
      baseRevision: 1,
    });
    assert.equal(autosaved.short.editRevision, 2);
    release();
    await assert.rejects(pending, isStudioErrorWithCode('conflict'));
    const stored = context.store.getShort(seeded.shortId);
    assert.ok(stored);
    assert.equal(stored.editRevision, 2);
    assert.equal(stored.edit.speed, 1);
    assert.ok(stored.edit.removedWords.includes(2));
  } finally {
    await cleanup(context);
  }
});

test('generatePublishCopy does not clobber a concurrent edit', async () => {
  let releaseCopy: () => void = () => {};
  const copyGate = new Promise<PublishCopyResponse>((resolve) => {
    releaseCopy = () => resolve({ line_1: 'linha um', line_2: 'linha dois', hashtags: ['#curioso'] });
  });
  const openRouter = { writePublishCopy: () => copyGate } as OpenRouterClient;
  const context = await makeContext(openRouter);
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const before = context.store.getShort(seeded.shortId);
    assert.ok(before);
    const pending = context.service.generatePublishCopy(seeded.shortId);
    const autosaved = await context.service.saveEdit(seeded.shortId, {
      edit: { ...before.edit, removedWords: [...before.edit.removedWords, 3] },
      baseRevision: 1,
    });
    assert.equal(autosaved.short.editRevision, 2);
    releaseCopy();
    const result = await pending;
    assert.ok(result.short.publishCopy);
    const stored = context.store.getShort(seeded.shortId);
    assert.ok(stored);
    assert.equal(stored.editRevision, 2);
    assert.ok(stored.edit.removedWords.includes(3));
    assert.deepEqual(stored.publishCopy, { line1: 'linha um', line2: 'linha dois', hashtags: ['#curioso'] });
  } finally {
    await cleanup(context);
  }
});

test('a failed replan keeps the job ready with its shorts and offers retry', async () => {
  const failingPlanner = {
    buildSemanticBlocks: async () => {
      throw new Error('blocks unavailable');
    },
    findOpportunities: async () => {
      throw new Error('OpenRouter response was empty (editorial-opportunity-planner, finish_reason length).');
    },
  } as unknown as OpenRouterClient;
  const context = await makeContext(failingPlanner);
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    context.service.replan(seeded.jobId);
    const pipeline = new ShortsPipeline({
      config: testConfig(context.rootDir),
      store: context.store,
      openRouter: failingPlanner,
      profiles: new CreatorProfileRepository({ rootDir: context.rootDir, manifestPath: join(context.rootDir, 'creator-profiles.json') }),
      publisher: null,
    });
    assert.equal(await pipeline.runNext('ingest'), true);
    const failed = context.service.getJob(seeded.jobId);
    assert.equal(failed.status, 'ready');
    assert.match(failed.error ?? '', /finish_reason length/);
    assert.equal(failed.canRetry, true);
    assert.equal(failed.shorts.length, 1);
    const retried = context.service.retryJob(seeded.jobId);
    assert.equal(retried.status, 'planning');
    assert.equal(retried.canRetry, false);
  } finally {
    await cleanup(context);
  }
});

test('planShorts runs at the layout snapshot speed and passes it to every planner call', async () => {
  const longWords: TranscriptWord[] = Array.from({ length: 60 }, (_, index) => ({
    id: `w_${String(index + 1).padStart(6, '0')}`,
    text: `palavra${index + 1}`,
    startSeconds: index * 0.6,
    endSeconds: index * 0.6 + 0.5,
    speakerId: 'speaker_0',
    confidence: 0.99,
  }));
  const plannerCalls: Array<{ method: string; speed: number; blocks: Array<Record<string, unknown>> }> = [];
  const planner = {
    buildSemanticBlocks: async () => ({ blocks: [] }),
    findOpportunities: async (input: { speed: number; blocks: Array<{ id: string }> }) => {
      plannerCalls.push({ method: 'findOpportunities', speed: input.speed, blocks: input.blocks });
      const blockIds = input.blocks.slice(0, 3).map((block) => block.id);
      return {
        opportunities: [{
          id: 'opp_1', title: 'Argumento', summary: 'Resumo', hook: 'Gancho', hook_text: 'MANCHETE', payoff: 'Payoff',
          rationale: 'Racional', thesis: 'Tese', viewer_promise: 'Promessa', tension: 'Tensão', why_this_short: 'Porque',
          risk: 'medium' as const, block_ids: blockIds,
          steps: [
            { kind: 'hook' as const, label: 'gancho', block_ids: [blockIds[0]!] },
            { kind: 'explain' as const, label: 'mecanismo', block_ids: [blockIds[1]!] },
            { kind: 'payoff' as const, label: 'aterrissagem', block_ids: [blockIds[2]!] },
          ],
        }],
      };
    },
    planCandidates: async (input: { speed: number; blocks: Array<{ id: string }> }) => {
      plannerCalls.push({ method: 'planCandidates', speed: input.speed, blocks: input.blocks });
      const blockIds = input.blocks.slice(0, 3).map((block) => block.id);
      return {
        candidates: [{
          opportunity_id: 'opp_1', title: 'Argumento', summary: 'Resumo', hook: 'Gancho', hook_text: 'MANCHETE',
          payoff: 'Payoff', rationale: 'Racional', thesis: 'Tese', risk: 'medium' as const, block_ids: blockIds,
          steps: [
            { kind: 'hook' as const, label: 'gancho', block_ids: [blockIds[0]!] },
            { kind: 'explain' as const, label: 'mecanismo', block_ids: [blockIds[1]!] },
            { kind: 'payoff' as const, label: 'aterrissagem', block_ids: [blockIds[2]!] },
          ],
        }],
      };
    },
  } as unknown as OpenRouterClient;
  const context = await makeContext(planner);
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir, longWords);
    context.service.replan(seeded.jobId);
    const pipeline = new ShortsPipeline({
      config: testConfig(context.rootDir),
      store: context.store,
      openRouter: planner,
      profiles: new CreatorProfileRepository({ rootDir: context.rootDir, manifestPath: join(context.rootDir, 'creator-profiles.json') }),
      publisher: null,
    });
    assert.equal(await pipeline.runNext('ingest'), true);
    const storedJob = context.store.getJob(seeded.jobId);
    assert.equal(storedJob?.status, 'ready');
    const expectedSpeed = storedJob!.layoutProfileSnapshot.defaultSpeed;
    const shorts = context.store.listShortsForJob(seeded.jobId);
    assert.equal(shorts.length, 1);
    assert.equal(shorts[0]?.edit.speed, expectedSpeed);
    assert.ok(plannerCalls.length >= 2);
    for (const call of plannerCalls) {
      assert.equal(call.speed, expectedSpeed);
      assert.ok(call.blocks.length > 0);
      for (const block of call.blocks) {
        assert.equal(typeof block.on_screen_seconds, 'number');
        assert.equal(typeof block.continues_previous, 'boolean');
      }
    }
  } finally {
    await cleanup(context);
  }
});

test('exportShort rejects when every word is cut', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const before = context.store.getShort(seeded.shortId);
    assert.ok(before);
    const wordCount = before.edit.ranges[0].endWord + 1;
    await context.service.saveEdit(seeded.shortId, {
      edit: { ...before.edit, removedWords: Array.from({ length: wordCount }, (_, index) => index) },
      baseRevision: 1,
    });
    await assert.rejects(context.service.exportShort(seeded.shortId), (error) => {
      assert.ok(error instanceof StudioError);
      assert.equal(error.code, 'invalid');
      assert.equal(error.message, 'Nothing to export: every word is cut');
      return true;
    });
  } finally {
    await cleanup(context);
  }
});

test('requeue marks interrupted publish tasks failed and requeues other work', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const publication: PublicationRecord = {
      id: 'pub_test',
      jobId: seeded.jobId,
      shortId: seeded.shortId,
      exportId: exportRecord.id,
      platform: 'instagram',
      status: 'publishing',
      forced: false,
      provider: null,
      batchId: null,
      remoteJobs: [],
      remoteUrl: null,
      submittedAt: null,
      scheduledFor: null,
      error: null,
      availableAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    context.store.createPublication(publication);
    context.store.enqueueTask(seeded.jobId, 'publish_short_video', { publicationId: publication.id });
    context.store.enqueueTask(seeded.jobId, 'export_short', { exportId: exportRecord.id });
    assert.ok(context.store.claimNextTask(QUEUE_LANES.output));
    assert.ok(context.store.claimNextTask(QUEUE_LANES.output));
    context.store.requeueRunningTasks();
    const interrupted = context.store.getPublication(publication.id);
    assert.ok(interrupted);
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.error, 'Interrupted while publishing; check the platform before reposting.');
    const reclaimable = context.store.claimNextTask(QUEUE_LANES.output);
    assert.ok(reclaimable);
    assert.notEqual(reclaimable.kind, 'publish_short_video');
    assert.equal(context.store.claimNextTask(QUEUE_LANES.output), null);
  } finally {
    await cleanup(context);
  }
});

test('a second startup holding no lock cannot requeue the first instance running tasks', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const publication: PublicationRecord = {
      id: 'pub_live',
      jobId: seeded.jobId,
      shortId: seeded.shortId,
      exportId: exportRecord.id,
      platform: 'tiktok',
      status: 'publishing',
      forced: false,
      provider: null,
      batchId: null,
      remoteJobs: [],
      remoteUrl: null,
      submittedAt: null,
      scheduledFor: null,
      error: null,
      availableAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    context.store.createPublication(publication);
    context.store.enqueueTask(seeded.jobId, 'publish_short_video', { publicationId: publication.id });
    assert.ok(context.store.claimNextTask(QUEUE_LANES.output));
    const lock = acquireStudioLock(join(context.rootDir, 'shorts.sqlite'));
    try {
      assert.throws(() => acquireStudioLock(join(context.rootDir, 'shorts.sqlite')), /already running/);
    } finally {
      lock.release();
    }
    const untouched = context.store.getPublication(publication.id);
    assert.ok(untouched);
    assert.equal(untouched.status, 'publishing');
    assert.equal(context.store.claimNextTask(QUEUE_LANES.output), null);
  } finally {
    await cleanup(context);
  }
});

test('a lock left by a dead process is reclaimed on startup', async () => {
  const context = await makeContext();
  try {
    const dbPath = join(context.rootDir, 'shorts.sqlite');
    await writeFile(`${dbPath}.lock`, `${deadPid()}\n`, 'utf-8');
    const lock = acquireStudioLock(dbPath);
    lock.release();
    assert.ok(acquireStudioLock(dbPath));
  } finally {
    await cleanup(context);
  }
});

const PUBLISH_RESULT: ShortVideoPublishResult = {
  provider: 'fake',
  platform: 'tiktok',
  status: 'queued',
  batchId: 'batch_1',
  jobs: [{ platform: 'tiktok', jobId: 'remote_job_1' }],
};

test('a successful publish marks the publication submitted and schedules a delayed status check', async () => {
  const context = await makeContext(copyWriter(), undefined, bufferChannelConfig());
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const recorded = recordingPublisher({ result: PUBLISH_RESULT });
    const pipeline = pipelineFor(context, recorded.provider);
    await context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: null });
    assert.equal(await pipeline.runNext('output'), true);
    assert.equal(await pipeline.runNext('output'), false);

    const publication = context.store.getPublication('pub_submitted') ?? (context.store.listPublicationsForShort(seeded.shortId)[0] ?? null);
    assert.ok(publication);
    assert.equal(publication.status, 'submitted');
    assert.equal(publication.provider, 'fake');
    assert.equal(publication.batchId, 'batch_1');
    assert.deepEqual(publication.remoteJobs, [{ platform: 'tiktok', jobId: 'remote_job_1' }]);
    assert.ok(publication.submittedAt);
    assert.equal(publication.remoteUrl, null);
    assert.equal(publication.error, null);

    const checks = queuedTasks(context.dbPath, 'check_publication');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'queued');
    assert.deepEqual(checks[0].payload, { publicationId: publication.id });
    assertRescheduledInAboutSeconds(checks[0].available_at, 15);
  } finally {
    await cleanup(context);
  }
});

test('the publication DTO exposes url, submittedAt, and forced', async () => {
  const context = await makeContext(copyWriter(), undefined, bufferChannelConfig());
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const recorded = recordingPublisher({ result: PUBLISH_RESULT, checkState: { status: 'live', url: 'https://www.tiktok.com/@creator/video/123', error: null } });
    const pipeline = pipelineFor(context, recorded.provider);
    const [queued] = await context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: null });
    assert.equal(queued.url, null);
    assert.equal(queued.submittedAt, null);
    assert.equal(queued.forced, false);
    await pipeline.runNext('output');
    const detail = await context.service.getShort(seeded.shortId);
    const submitted = detail.publications.find((entry) => entry.id === queued.id);
    assert.ok(submitted);
    assert.equal(submitted.status, 'submitted');
    assert.ok(submitted.submittedAt);
    assert.equal(submitted.url, null);
    assert.equal(submitted.forced, false);

    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: queued.id });
    assert.equal(await pipeline.runNext('output'), true);
    const confirmed = await context.service.getShort(seeded.shortId);
    const live = confirmed.publications.find((entry) => entry.id === queued.id);
    assert.ok(live);
    assert.equal(live.status, 'published');
    assert.equal(live.url, 'https://www.tiktok.com/@creator/video/123');
  } finally {
    await cleanup(context);
  }
});

test('a pending provider result keeps the publication submitted and reschedules the check', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const recorded = recordingPublisher({ result: PUBLISH_RESULT, checkState: { status: 'pending', url: null, error: null } });
    const pipeline = pipelineFor(context, recorded.provider);
    const publication = seedSubmittedPublication(context.store, seeded, exportRecord.id);
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: publication.id });
    assert.equal(await pipeline.runNext('output'), true);

    const still = context.store.getPublication(publication.id);
    assert.ok(still);
    assert.equal(still.status, 'submitted');
    const checks = queuedTasks(context.dbPath, 'check_publication');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'queued');
    assertRescheduledInAboutSeconds(checks[0].available_at, 20);
  } finally {
    await cleanup(context);
  }
});

test('a live provider result marks the publication published with the remote url', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const recorded = recordingPublisher({ result: PUBLISH_RESULT, checkState: { status: 'live', url: 'https://www.tiktok.com/@creator/video/9', error: null } });
    const pipeline = pipelineFor(context, recorded.provider);
    const publication = seedSubmittedPublication(context.store, seeded, exportRecord.id);
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: publication.id });
    assert.equal(await pipeline.runNext('output'), true);
    const done = context.store.getPublication(publication.id);
    assert.ok(done);
    assert.equal(done.status, 'published');
    assert.equal(done.remoteUrl, 'https://www.tiktok.com/@creator/video/9');
    assert.equal(done.error, null);
  } finally {
    await cleanup(context);
  }
});

test('a failed provider result fails the publication with the provider message', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const recorded = recordingPublisher({ result: PUBLISH_RESULT, checkState: { status: 'failed', url: null, error: 'Instagram authorization was lost.' } });
    const pipeline = pipelineFor(context, recorded.provider);
    const publication = seedSubmittedPublication(context.store, seeded, exportRecord.id);
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: publication.id });
    assert.equal(await pipeline.runNext('output'), true);
    const done = context.store.getPublication(publication.id);
    assert.ok(done);
    assert.equal(done.status, 'failed');
    assert.equal(done.error, 'Instagram authorization was lost.');
    assert.equal(done.remoteUrl, null);
  } finally {
    await cleanup(context);
  }
});

test('a network error during the check reschedules the task and keeps the publication submitted', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const recorded = recordingPublisher({ result: PUBLISH_RESULT, checkError: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    const pipeline = pipelineFor(context, recorded.provider);
    const publication = seedSubmittedPublication(context.store, seeded, exportRecord.id);
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: publication.id });
    assert.equal(await pipeline.runNext('output'), true);
    const still = context.store.getPublication(publication.id);
    assert.ok(still);
    assert.equal(still.status, 'submitted');
    const checks = queuedTasks(context.dbPath, 'check_publication');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'queued');
    assertRescheduledInAboutSeconds(checks[0].available_at, 20);
    assert.match(queuedTaskError(context.dbPath, 'check_publication'), /socket hang up/);
  } finally {
    await cleanup(context);
  }
});

function queuedTaskError(dbPath: string, kind: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT error FROM queue_tasks WHERE kind = ?').get(kind);
    if (typeof row !== 'object' || row === null || !('error' in row) || typeof row.error !== 'string') {
      return '';
    }
    return row.error;
  } finally {
    db.close();
  }
}

test('a publication still unresolved 60 minutes after submission becomes unconfirmed and keeps checking', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    let checkState: RemotePublicationState = { status: 'pending', url: null, error: null };
    const publisher: ShortVideoPublishProvider = {
      name: 'fake',
      supportedPlatforms: ['instagram', 'tiktok', 'youtube_shorts'],
      supportsScheduling: true,
      supports: () => true,
      publishShortVideo: async () => PUBLISH_RESULT,
      checkPublication: async () => checkState,
      cancelScheduled: async () => {},
    };
    const pipeline = pipelineFor(context, publisher);
    const publication = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      submittedAt: new Date(Date.now() - 61 * 60 * 1000).toISOString(),
    });
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: publication.id });
    assert.equal(await pipeline.runNext('output'), true);
    const unconfirmed = context.store.getPublication(publication.id);
    assert.ok(unconfirmed);
    assert.equal(unconfirmed.status, 'unconfirmed');
    assert.equal(unconfirmed.error, 'No final result from fake after 60 minutes; check TikTok before reposting.');
    const checks = queuedTasks(context.dbPath, 'check_publication');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'queued');
    assertRescheduledInAboutSeconds(checks[0].available_at, 600);

    checkState = { status: 'live', url: 'https://www.tiktok.com/@creator/video/77', error: null };
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: publication.id });
    assert.equal(await pipeline.runNext('output'), true);
    const confirmed = context.store.getPublication(publication.id);
    assert.ok(confirmed);
    assert.equal(confirmed.status, 'published');
    assert.equal(confirmed.remoteUrl, 'https://www.tiktok.com/@creator/video/77');
    assert.equal(confirmed.error, null);
  } finally {
    await cleanup(context);
  }
});

test('a pending check past the 24 hour window stops without rescheduling', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const recorded = recordingPublisher({ result: PUBLISH_RESULT, checkState: { status: 'pending', url: null, error: null } });
    const pipeline = pipelineFor(context, recorded.provider);
    const publication = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      status: 'unconfirmed',
      submittedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: publication.id });
    assert.equal(await pipeline.runNext('output'), true);
    const still = context.store.getPublication(publication.id);
    assert.ok(still);
    assert.equal(still.status, 'unconfirmed');
    assert.equal(queuedTasks(context.dbPath, 'check_publication').filter((task) => task.status === 'queued').length, 0);
  } finally {
    await cleanup(context);
  }
});

test('a permanent check error marks the publication unconfirmed and stops checking', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const recorded = recordingPublisher({
      result: PUBLISH_RESULT,
      checkError: new ShortVideoPublishError({ provider: 'fake', stage: 'discovery', message: 'Buffer request failed: 401', safeToFailover: false, httpStatus: 401 }),
    });
    const pipeline = pipelineFor(context, recorded.provider);
    const publication = seedSubmittedPublication(context.store, seeded, exportRecord.id);
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: publication.id });
    assert.equal(await pipeline.runNext('output'), true);
    const unconfirmed = context.store.getPublication(publication.id);
    assert.ok(unconfirmed);
    assert.equal(unconfirmed.status, 'unconfirmed');
    assert.match(unconfirmed.error ?? '', /Buffer request failed: 401/);
    assert.equal(queuedTasks(context.dbPath, 'check_publication').filter((task) => task.status === 'queued').length, 0);
  } finally {
    await cleanup(context);
  }
});

test('a transient server error after the deadline becomes unconfirmed but keeps rescheduling', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const recorded = recordingPublisher({
      result: PUBLISH_RESULT,
      checkError: new ShortVideoPublishError({ provider: 'fake', stage: 'discovery', message: 'Buffer request failed: 503', safeToFailover: false, httpStatus: 503 }),
    });
    const pipeline = pipelineFor(context, recorded.provider);
    const publication = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      submittedAt: new Date(Date.now() - 70 * 60 * 1000).toISOString(),
    });
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: publication.id });
    assert.equal(await pipeline.runNext('output'), true);
    const unconfirmed = context.store.getPublication(publication.id);
    assert.ok(unconfirmed);
    assert.equal(unconfirmed.status, 'unconfirmed');
    const checks = queuedTasks(context.dbPath, 'check_publication');
    assert.equal(checks.length, 1);
    assertRescheduledInAboutSeconds(checks[0].available_at, 600);
  } finally {
    await cleanup(context);
  }
});

test('checkPublication receives the provider name the publish result reported', async () => {
  const context = await makeContext(copyWriter(), undefined, bufferChannelConfig());
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const recorded = recordingPublisher({
      result: { ...PUBLISH_RESULT, provider: 'buffer' },
      checkState: { status: 'live', url: 'https://www.tiktok.com/@creator/video/5', error: null },
    });
    const pipeline = pipelineFor(context, recorded.provider);
    await context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: null });
    await pipeline.runNext('output');
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: seedPublicationIdFor(context, seeded) });
    assert.equal(await pipeline.runNext('output'), true);
    assert.deepEqual(recorded.checkInputs, [{ provider: 'buffer', platform: 'tiktok', remoteJobId: 'remote_job_1' }]);
  } finally {
    await cleanup(context);
  }
});

function seedPublicationIdFor(context: TestContext, seeded: SeededJob): string {
  const publication = context.store.listPublicationsForShort(seeded.shortId)[0];
  assert.ok(publication);
  return publication.id;
}

test('a publish result without remote job ids leaves the publication unconfirmed with the tracking message', async () => {
  const context = await makeContext(copyWriter(), undefined, bufferChannelConfig());
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const recorded = recordingPublisher({ result: { ...PUBLISH_RESULT, jobs: [] } });
    const pipeline = pipelineFor(context, recorded.provider);
    await context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: null });
    assert.equal(await pipeline.runNext('output'), true);
    const publication = context.store.listPublicationsForShort(seeded.shortId)[0];
    assert.ok(publication);
    assert.equal(publication.status, 'unconfirmed');
    assert.equal(publication.error, 'fake accepted the post but returned no id to track; check TikTok before reposting.');
    assert.equal(queuedTasks(context.dbPath, 'check_publication').length, 0);
  } finally {
    await cleanup(context);
  }
});

test('a normal publish returns the existing submitted publication instead of creating a new one', async () => {
  const context = await makeContext(undefined, undefined, bufferChannelConfig());
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    seedSubmittedPublication(context.store, seeded, exportRecord.id);
    const results = await context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: null });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'pub_submitted');
    assert.equal(results[0].status, 'submitted');
    assert.equal(context.store.listPublicationsForShort(seeded.shortId).length, 1);
    assert.equal(context.store.claimNextTask(QUEUE_LANES.output), null);
  } finally {
    await cleanup(context);
  }
});

test('v3 migration marks unverified published publications submitted and queues their checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-migrate-'));
  const dbPath = join(dir, 'shorts.sqlite');
  {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE publications (
        id TEXT PRIMARY KEY,
        export_id TEXT NOT NULL,
        short_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE queue_tasks (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        available_at TEXT,
        started_at TEXT,
        error TEXT,
        payload_json TEXT NOT NULL
      );
      PRAGMA user_version = 3;
    `);
    const insert = db.prepare('INSERT INTO publications(id, export_id, short_id, platform, status, created_at, payload_json) VALUES(?, ?, ?, ?, ?, ?, ?)');
    insert.run('pub_remote', 'export_test', 'short_test', 'tiktok', 'published', '2026-10-16T10:00:00.000Z', JSON.stringify({
      id: 'pub_remote',
      jobId: 'job_test',
      status: 'published',
      remoteJobs: [{ platform: 'tiktok', jobId: 'remote_1' }],
    }));
    insert.run('pub_remote2', 'export_test', 'short_test', 'instagram', 'published', '2026-10-16T10:02:00.000Z', JSON.stringify({
      id: 'pub_remote2',
      jobId: 'job_test',
      status: 'published',
      remoteJobs: [{ platform: 'instagram', jobId: 'remote_2' }],
    }));
    insert.run('pub_nolinks', 'export_test', 'short_test', 'instagram', 'published', '2026-10-16T10:05:00.000Z', JSON.stringify({
      id: 'pub_nolinks',
      jobId: 'job_test',
      status: 'published',
      remoteJobs: [],
    }));
    insert.run('pub_queued', 'export_test', 'short_test', 'youtube_shorts', 'queued', '2026-10-16T10:10:00.000Z', JSON.stringify({
      id: 'pub_queued',
      jobId: 'job_test',
      status: 'queued',
      remoteJobs: [],
    }));
    db.close();
  }
  const store = await ShortsStore.open(dbPath);
  try {
    const verified = store.getPublication('pub_remote');
    assert.ok(verified);
    assert.equal(verified.status, 'submitted');
    assert.ok(verified.submittedAt);
    assert.equal(verified.remoteUrl, null);
    assert.equal(verified.scheduledFor, null);

    const unverified = store.getPublication('pub_nolinks');
    assert.ok(unverified);
    assert.equal(unverified.status, 'published');
    assert.equal(unverified.submittedAt, null);
    assert.equal(unverified.remoteUrl, null);

    const queued = store.getPublication('pub_queued');
    assert.ok(queued);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.submittedAt, null);
    assert.equal(queued.remoteUrl, null);

    const verified2 = store.getPublication('pub_remote2');
    assert.ok(verified2);
    assert.equal(verified2.status, 'submitted');
    assert.equal(verified2.submittedAt, verified.submittedAt);

    const checks = queuedTasks(dbPath, 'check_publication').filter((task) => task.status === 'queued');
    assert.equal(checks.length, 2);
    const targets = checks.map((task) => String(task.payload.publicationId));
    assert.deepEqual(targets, ['pub_remote', 'pub_remote2']);
    const firstAvailableAt = checks[0].available_at ? Date.parse(checks[0].available_at) : Number.NaN;
    const secondAvailableAt = checks[1].available_at ? Date.parse(checks[1].available_at) : Number.NaN;
    assert.ok(Math.abs(secondAvailableAt - firstAvailableAt - 10_000) < 2_000, `stagger ${secondAvailableAt - firstAvailableAt}ms`);
  } finally {
    store.close();
  }
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('PRAGMA user_version').get();
    if (typeof row !== 'object' || row === null || !('user_version' in row) || typeof row.user_version !== 'number') {
      throw new Error('Database did not report a user_version');
    }
    assert.equal(row.user_version, 7);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a normal publish conflicts with an in-flight attempt on another export and with posted or unconfirmed attempts', async () => {
  const context = await makeContext(undefined, undefined, bufferChannelConfig());
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportA = seedReadyExport(context.store, seeded, context.rootDir);
    const submitted = seedSubmittedPublication(context.store, seeded, exportA.id);
    const exportB: ExportRecord = {
      ...exportA,
      id: 'export_b',
      createdAt: new Date(Date.parse(exportA.createdAt) + 1000).toISOString(),
      updatedAt: new Date(Date.parse(exportA.updatedAt) + 1000).toISOString(),
    };
    context.store.createExport(exportB);

    await assert.rejects(
      context.service.publish(exportB.id, { platforms: ['tiktok'], force: false, scheduledAt: null }),
      (error: unknown) => {
        assert.ok(error instanceof StudioError);
        assert.equal(error.code, 'conflict');
        assert.match(error.message, /another export/);
        return true;
      },
    );

    submitted.status = 'published';
    context.store.updatePublication(submitted);
    await assert.rejects(
      context.service.publish(exportB.id, { platforms: ['tiktok'], force: false, scheduledAt: null }),
      (error: unknown) => {
        assert.ok(error instanceof StudioError);
        assert.equal(error.code, 'conflict');
        assert.match(error.message, /Force repost/);
        return true;
      },
    );

    submitted.status = 'unconfirmed';
    submitted.error = 'No final result from fake after 60 minutes; check TikTok before reposting.';
    context.store.updatePublication(submitted);
    await assert.rejects(
      context.service.publish(exportB.id, { platforms: ['tiktok'], force: false, scheduledAt: null }),
      (error: unknown) => {
        assert.ok(error instanceof StudioError);
        assert.equal(error.code, 'conflict');
        assert.match(error.message, /unconfirmed/);
        return true;
      },
    );

    submitted.status = 'failed';
    submitted.error = 'Instagram authorization was lost.';
    context.store.updatePublication(submitted);
    const created = await context.service.publish(exportB.id, { platforms: ['tiktok'], force: false, scheduledAt: null });
    assert.equal(created.length, 1);
    assert.notEqual(created[0].id, submitted.id);
  } finally {
    await cleanup(context);
  }
});

test('force repost requires a posted or unconfirmed attempt and rejects in-flight attempts', async () => {
  const context = await makeContext(undefined, undefined, bufferChannelConfig());
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);

    await assert.rejects(
      context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: true, scheduledAt: null }),
      (error: unknown) => {
        assert.ok(error instanceof StudioError);
        assert.equal(error.code, 'conflict');
        assert.match(error.message, /nothing was posted/);
        return true;
      },
    );

    const unconfirmed = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      status: 'unconfirmed',
      error: 'No final result from fake after 60 minutes; check TikTok before reposting.',
    });
    const forced = await context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: true, scheduledAt: null });
    assert.equal(forced.length, 1);
    assert.equal(forced[0].forced, true);
    assert.notEqual(forced[0].id, unconfirmed.id);

    await assert.rejects(
      context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: true, scheduledAt: null }),
      (error: unknown) => {
        assert.ok(error instanceof StudioError);
        assert.equal(error.code, 'conflict');
        assert.match(error.message, /in flight/);
        return true;
      },
    );
  } finally {
    await cleanup(context);
  }
});

test('non-forced publishes send a publication-scoped idempotency key', async () => {
  const context = await makeContext(copyWriter(), undefined, bufferChannelConfig());
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const recorded = recordingPublisher({ result: PUBLISH_RESULT });
    const pipeline = pipelineFor(context, recorded.provider);
    const [queued] = await context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: null });
    await pipeline.runNext('output');
    assert.equal(recorded.publishInputs.length, 1);
    assert.equal(recorded.publishInputs[0].idempotencyKey, `shorts-tiktok-${exportRecord.id}-${queued.id}`);
  } finally {
    await cleanup(context);
  }
});

test('startup enqueues missing checks for submitted and recent unconfirmed publications', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const submitted = seedSubmittedPublication(context.store, seeded, exportRecord.id);
    const recentUnconfirmed = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_recent_unconfirmed',
      platform: 'instagram',
      status: 'unconfirmed',
      submittedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      error: 'No final result from fake after 60 minutes; check Instagram before reposting.',
    });
    const staleUnconfirmed = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_stale_unconfirmed',
      platform: 'youtube_shorts',
      status: 'unconfirmed',
      submittedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      error: 'No final result from fake after 60 minutes; check YouTube Shorts before reposting.',
    });
    const tracked = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_tracked',
      platform: 'youtube_shorts',
      provider: 'buffer',
    });
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: tracked.id });

    context.store.enqueueMissingPublicationChecks();

    const checks = queuedTasks(context.dbPath, 'check_publication').filter((task) => task.status === 'queued');
    const targets = checks.map((task) => String(task.payload.publicationId)).sort();
    assert.deepEqual(targets, [
      'pub_recent_unconfirmed',
      'pub_submitted',
      tracked.id,
    ]);
    assert.ok(!targets.includes(staleUnconfirmed.id));

    context.store.enqueueMissingPublicationChecks();
    const after = queuedTasks(context.dbPath, 'check_publication').filter((task) => task.status === 'queued');
    assert.equal(after.length, checks.length);
  } finally {
    await cleanup(context);
  }
});

test('a failing publish task does not downgrade a submitted publication', async () => {
  const context = await makeContext(copyWriter(), undefined, bufferChannelConfig());
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const store = context.store;
    const originalAppendAction = store.appendAction.bind(store);
    store.appendAction = (jobId, kind, payload) => {
      if (kind === 'short_video_submitted') {
        throw new Error('action log is full');
      }
      originalAppendAction(jobId, kind, payload);
    };
    try {
      const recorded = recordingPublisher({ result: PUBLISH_RESULT });
      const pipeline = pipelineFor(context, recorded.provider);
      const [queued] = await context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: null });
      assert.equal(await pipeline.runNext('output'), true);
      const submitted = store.getPublication(queued.id);
      assert.ok(submitted);
      assert.equal(submitted.status, 'submitted');
      assert.ok(submitted.submittedAt);
      const failedTask = queuedTasks(context.dbPath, 'publish_short_video')[0];
      assert.equal(failedTask.status, 'failed');
    } finally {
      store.appendAction = originalAppendAction;
    }
  } finally {
    await cleanup(context);
  }
});

test('an export stays ready without a cover when the cover render throws', { timeout: 120_000 }, async () => {
  const context = await makeContext(undefined, undefined, {
    fontsDir: join(import.meta.dirname, '..', 'assets', 'fonts'),
  });
  try {
    const words = transcriptWords().slice(0, 4);
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir, words);
    const job = context.store.getJob(seeded.jobId);
    assert.ok(job?.media);
    const thumbnailPath = join(context.rootDir, 'thumbnail.jpg');
    await writeFile(thumbnailPath, 'not an image', 'utf-8');
    job.media = { ...job.media, thumbnailPath };
    context.store.updateJob(job);
    await runProcess('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=${job.media.width}x${job.media.height}:rate=30`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', String(job.media.durationSeconds),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-ac', '2', '-c:a', 'aac', '-b:a', '96k',
      join(context.rootDir, 'source.mp4'),
    ]);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    exportRecord.status = 'queued';
    exportRecord.edit = { ...exportRecord.edit, endCard: { enabled: false } };
    context.store.updateExport(exportRecord);
    context.store.enqueueTask(seeded.jobId, 'export_short', { exportId: exportRecord.id });
    const pipeline = pipelineFor(context, fakePublisher());
    assert.equal(await pipeline.runNext('output'), true);
    const exported = context.store.getExport(exportRecord.id);
    assert.ok(exported);
    assert.equal(exported.status, 'ready');
    assert.equal(exported.coverPath, null);
    assert.ok(exported.artifactPath);
  } finally {
    await cleanup(context);
  }
});

test('a broken end-card thumbnail fails the export instead of hanging', { timeout: 120_000 }, async () => {
  const context = await makeContext(undefined, undefined, {
    fontsDir: join(import.meta.dirname, '..', 'assets', 'fonts'),
  });
  try {
    const words = transcriptWords().slice(0, 4);
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir, words);
    const job = context.store.getJob(seeded.jobId);
    assert.ok(job?.media);
    const thumbnailPath = join(context.rootDir, 'thumbnail.jpg');
    await writeFile(thumbnailPath, 'not an image', 'utf-8');
    job.media = { ...job.media, thumbnailPath };
    context.store.updateJob(job);
    await runProcess('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=${job.media.width}x${job.media.height}:rate=30`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', String(job.media.durationSeconds),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-ac', '2', '-c:a', 'aac', '-b:a', '96k',
      join(context.rootDir, 'source.mp4'),
    ]);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    exportRecord.status = 'queued';
    context.store.updateExport(exportRecord);
    context.store.enqueueTask(seeded.jobId, 'export_short', { exportId: exportRecord.id });
    const pipeline = pipelineFor(context, fakePublisher());
    assert.equal(await pipeline.runNext('output'), true);
    const exported = context.store.getExport(exportRecord.id);
    assert.ok(exported);
    assert.equal(exported.status, 'failed');
    assert.ok(exported.error);
  } finally {
    await cleanup(context);
  }
});

function hostHeadChatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const HOST_HEAD_BOXES: Array<[number, number, number, number]> = [
  [140, 280, 860, 1000],
  [150, 300, 850, 990],
  [147, 287, 858, 1000],
  [160, 310, 840, 980],
  [155, 290, 845, 995],
];

async function seedSourceVideo(rootDir: string): Promise<void> {
  await runProcess('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-ac', '2', '-c:a', 'aac', '-b:a', '96k',
    join(rootDir, 'source.mp4'),
  ]);
}

test('analyzeHostFraming clears the analysis stamp and enqueues analyze_host', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const job = context.store.getJob(seeded.jobId);
    assert.ok(job);
    job.hostFraming = { headBox: { x: 0.741181, y: 0.147, w: 0.258819, h: 0.711 } };
    job.hostFramingAnalyzedAt = nowIso();
    context.store.updateJob(job);

    context.service.analyzeHostFraming(seeded.jobId);

    const updated = context.store.getJob(seeded.jobId);
    assert.ok(updated);
    assert.equal(updated.hostFramingAnalyzedAt, null);
    assert.deepEqual(updated.hostFraming, { headBox: { x: 0.741181, y: 0.147, w: 0.258819, h: 0.711 } });
    const tasks = queuedTasks(context.dbPath, 'analyze_host');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, 'queued');
  } finally {
    await cleanup(context);
  }
});

test('analyzeHostFraming rejects a job that is not ready and a layout without a host panel', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const planning = context.store.getJob(seeded.jobId);
    assert.ok(planning);
    planning.status = 'planning';
    context.store.updateJob(planning);
    assert.throws(() => context.service.analyzeHostFraming(seeded.jobId), isStudioErrorWithCode('conflict'));

    planning.status = 'ready';
    planning.layoutProfileSnapshot = {
      ...planning.layoutProfileSnapshot,
      panels: [{ id: 'screen', role: 'content', sourceRect: { x: 0, y: 0, w: 0.632, h: 1 }, canvasRect: { x: 0, y: 0.1146, w: 1, h: 0.4375 } }],
    };
    context.store.updateJob(planning);
    assert.throws(() => context.service.analyzeHostFraming(seeded.jobId), isStudioErrorWithCode('invalid'));
    assert.equal(queuedTasks(context.dbPath, 'analyze_host').length, 0);
  } finally {
    await cleanup(context);
  }
});

test('exportShort reuses an export only while the job hostFraming is unchanged', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const job = context.store.getJob(seeded.jobId);
    assert.ok(job);
    const boxA = { headBox: { x: 0.741181, y: 0.147, w: 0.258819, h: 0.711 } };
    const boxB = { headBox: { x: 0.75316, y: 0.171, w: 0.193116, h: 0.467 } };
    job.hostFraming = boxA;
    context.store.updateJob(job);

    const first = await context.service.exportShort(seeded.shortId);
    const second = await context.service.exportShort(seeded.shortId);
    assert.equal(second.exports.length, 1);
    assert.equal(second.exports[0].id, first.exports[0].id);
    assert.equal(second.exports[0].current, true);

    job.hostFraming = boxB;
    job.updatedAt = nowIso();
    context.store.updateJob(job);
    const third = await context.service.exportShort(seeded.shortId);
    assert.equal(third.exports.length, 2);
    assert.equal(third.exports.find((record) => record.id === first.exports[0].id)?.current, false);
    assert.equal(third.exports.find((record) => record.id !== first.exports[0].id)?.current, true);

    const exports = context.store.listExportsForShort(seeded.shortId);
    assert.deepEqual(exports.find((record) => record.id === first.exports[0].id)?.hostFraming, boxA);
    assert.deepEqual(exports.find((record) => record.id !== first.exports[0].id)?.hostFraming, boxB);
  } finally {
    await cleanup(context);
  }
});

test('analyze_host stores the median head box and touches only the framing fields', async () => {
  const context = await makeContext();
  try {
    const words = transcriptWords().slice(0, 5);
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir, words);
    await seedSourceVideo(context.rootDir);
    let call = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const box = HOST_HEAD_BOXES[call];
      call += 1;
      return hostHeadChatResponse(JSON.stringify({ box_2d: box, reason: 'cabeça do apresentador' }));
    }) as typeof fetch;
    try {
      context.store.enqueueTask(seeded.jobId, 'analyze_host', {});
      const pipeline = pipelineFor(context, fakePublisher());
      assert.equal(await pipeline.runNext('ingest'), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(call, 5);
    const job = context.store.getJob(seeded.jobId);
    assert.ok(job);
    const hostSourceRect = { x: 0.342, y: 0, w: 0.316, h: 1 };
    const expected = boxToSourceFocus([150, 290, 850, 995], { sourceRect: hostSourceRect });
    assert.deepEqual(job.hostFraming, { headBox: expected });
    assert.ok(job.hostFramingAnalyzedAt);
    assert.equal(job.status, 'ready');
    assert.equal(job.error, null);
    assert.equal(job.failedTaskKind, null);
    const tasks = queuedTasks(context.dbPath, 'analyze_host');
    assert.equal(tasks[0].status, 'done');
  } finally {
    await cleanup(context);
  }
});

test('analyze_host keeps the previous box and stamps analyzedAt when detection fails non-transiently', async () => {
  const context = await makeContext();
  try {
    const words = transcriptWords().slice(0, 5);
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir, words);
    const previous = { headBox: { x: 0.741181, y: 0.147, w: 0.258819, h: 0.711 } };
    const seededJob = context.store.getJob(seeded.jobId);
    assert.ok(seededJob);
    seededJob.hostFraming = previous;
    context.store.updateJob(seededJob);
    await seedSourceVideo(context.rootDir);
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('vision provider unavailable', { status: 500 });
    }) as typeof fetch;
    try {
      context.store.enqueueTask(seeded.jobId, 'analyze_host', {});
      const pipeline = pipelineFor(context, fakePublisher());
      assert.equal(await pipeline.runNext('ingest'), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls, 5);
    const job = context.store.getJob(seeded.jobId);
    assert.ok(job);
    assert.deepEqual(job.hostFraming, previous);
    assert.ok(job.hostFramingAnalyzedAt);
    assert.equal(job.status, 'ready');
    assert.equal(job.error, null);
    const tasks = queuedTasks(context.dbPath, 'analyze_host');
    assert.equal(tasks[0].status, 'done');
  } finally {
    await cleanup(context);
  }
});

test('analyze_host keeps the previous box and leaves analyzedAt null on a transient failure', async () => {
  const context = await makeContext();
  try {
    const words = transcriptWords().slice(0, 5);
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir, words);
    const previous = { headBox: { x: 0.741181, y: 0.147, w: 0.258819, h: 0.711 } };
    const seededJob = context.store.getJob(seeded.jobId);
    assert.ok(seededJob);
    seededJob.hostFraming = previous;
    context.store.updateJob(seededJob);
    await seedSourceVideo(context.rootDir);
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls <= 2) {
        return hostHeadChatResponse(JSON.stringify({ box_2d: [147, 287, 858, 1000], reason: 'cabeça do apresentador' }));
      }
      const error = new Error('connect timed out');
      (error as Error & { code: string }).code = 'ETIMEDOUT';
      throw error;
    }) as typeof fetch;
    try {
      context.store.enqueueTask(seeded.jobId, 'analyze_host', {});
      const pipeline = pipelineFor(context, fakePublisher());
      assert.equal(await pipeline.runNext('ingest'), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const job = context.store.getJob(seeded.jobId);
    assert.ok(job);
    assert.deepEqual(job.hostFraming, previous);
    assert.equal(job.hostFramingAnalyzedAt, null);
    assert.equal(job.status, 'ready');
    assert.equal(job.error, null);
    const tasks = queuedTasks(context.dbPath, 'analyze_host');
    assert.equal(tasks[0].status, 'done');
  } finally {
    await cleanup(context);
  }
});

test('ExportDto.current flips when the title, transcript revision, or host framing changes', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    seedReadyExport(context.store, seeded, context.rootDir);
    const fresh = await context.service.getShort(seeded.shortId);
    assert.equal(fresh.exports[0].current, true);

    const job = context.store.getJob(seeded.jobId);
    assert.ok(job);
    job.transcriptRevision += 1;
    context.store.updateJob(job);
    const afterTranscript = await context.service.getShort(seeded.shortId);
    assert.equal(afterTranscript.exports[0].current, false);

    job.transcriptRevision = 0;
    job.hostFraming = { headBox: { x: 0.741181, y: 0.147, w: 0.258819, h: 0.711 } };
    context.store.updateJob(job);
    const afterFraming = await context.service.getShort(seeded.shortId);
    assert.equal(afterFraming.exports[0].current, false);

    job.hostFraming = null;
    context.store.updateJob(job);
    const short = context.store.getShort(seeded.shortId);
    assert.ok(short);
    short.title = 'Outro título';
    context.store.updateShort(short);
    const afterTitle = await context.service.getShort(seeded.shortId);
    assert.equal(afterTitle.exports[0].current, false);
  } finally {
    await cleanup(context);
  }
});

test('enqueueMissingHostHeadAnalyses enqueues once per job that still needs analysis', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const base = context.store.getJob(seeded.jobId);
    assert.ok(base);
    context.store.createJob({ ...base, id: 'job_analyzed', hostFramingAnalyzedAt: nowIso() });
    context.store.createJob({ ...base, id: 'job_nomedia', media: null });
    context.store.createJob({
      ...base,
      id: 'job_content',
      layoutProfileSnapshot: {
        ...base.layoutProfileSnapshot,
        panels: [{ id: 'screen', role: 'content', sourceRect: { x: 0, y: 0, w: 0.632, h: 1 }, canvasRect: { x: 0, y: 0.1146, w: 1, h: 0.4375 } }],
      },
    });
    context.store.createJob({ ...base, id: 'job_pending' });
    context.store.enqueueTask('job_pending', 'analyze_host', {});

    context.store.enqueueMissingHostHeadAnalyses();
    const afterFirst = queuedTasks(context.dbPath, 'analyze_host').filter((task) => task.status === 'queued');
    assert.equal(afterFirst.length, 2);

    context.store.enqueueMissingHostHeadAnalyses();
    const afterSecond = queuedTasks(context.dbPath, 'analyze_host').filter((task) => task.status === 'queued');
    assert.equal(afterSecond.length, 2);
  } finally {
    await cleanup(context);
  }
});

test('the store migrates a v4 database by adding the host framing fields', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'studio-migrate-'));
  const dbPath = join(rootDir, 'shorts.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL)');
  db.exec('CREATE TABLE exports (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, short_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL)');
  db.exec(`INSERT INTO jobs(id, status, updated_at, payload_json) VALUES('job_old', 'ready', '${nowIso()}', '{"id":"job_old","transcriptRevision":2}')`);
  db.exec(`INSERT INTO exports(id, job_id, short_id, status, created_at, payload_json) VALUES('export_old', 'job_old', 'short_old', 'ready', '${nowIso()}', '{"id":"export_old","editRevision":1,"transcriptRevision":0}')`);
  db.exec('PRAGMA user_version = 4');
  db.close();
  const store = await ShortsStore.open(dbPath);
  try {
    const job = store.getJob('job_old');
    assert.ok(job);
    assert.equal(job.hostFraming, null);
    assert.equal(job.hostFramingAnalyzedAt, null);
    const record = store.getExport('export_old');
    assert.ok(record);
    assert.equal(record.hostFraming, null);
  } finally {
    store.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('publish with scheduledAt stores scheduledFor, ends scheduled, and schedules the check at the scheduled time', async () => {
  const context = await makeContext(copyWriter(), undefined, bufferChannelConfig());
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const scheduledAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const recorded = recordingPublisher({ result: PUBLISH_RESULT });
    const pipeline = pipelineFor(context, recorded.provider);
    const detail = await context.service.getShort(seeded.shortId);
    const tiktok = detail.platforms.find((entry) => entry.platform === 'tiktok');
    assert.ok(tiktok);
    assert.equal(tiktok.available, true);
    assert.equal(tiktok.canSchedule, true);
    const [queued] = await context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.scheduledFor, scheduledAt);
    assert.equal(await pipeline.runNext('output'), true);
    assert.equal(await pipeline.runNext('output'), false);

    const publication = context.store.getPublication(queued.id);
    assert.ok(publication);
    assert.equal(publication.status, 'scheduled');
    assert.equal(publication.scheduledFor, scheduledAt);
    assert.ok(publication.submittedAt);
    assert.equal(publication.error, null);
    assert.equal(recorded.publishInputs.length, 1);
    assert.equal(recorded.publishInputs[0].scheduledAt, scheduledAt);

    const checks = queuedTasks(context.dbPath, 'check_publication');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'queued');
    assert.deepEqual(checks[0].payload, { publicationId: publication.id });
    assert.equal(checks[0].available_at, new Date(Date.parse(scheduledAt) + 15_000).toISOString());

    const after = await context.service.getShort(seeded.shortId);
    const scheduled = after.publications.find((entry) => entry.id === queued.id);
    assert.ok(scheduled);
    assert.equal(scheduled.status, 'scheduled');
    assert.equal(scheduled.scheduledFor, scheduledAt);
  } finally {
    await cleanup(context);
  }
});

test('the check before scheduledFor only reschedules at the scheduled time and follows the submitted flow after it', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const scheduledFor = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const recorded = recordingPublisher({ result: PUBLISH_RESULT, checkState: { status: 'pending', url: null, error: null } });
    const pipeline = pipelineFor(context, recorded.provider);
    const publication = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      status: 'scheduled',
      scheduledFor,
    });
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: publication.id });
    assert.equal(await pipeline.runNext('output'), true);

    const before = context.store.getPublication(publication.id);
    assert.ok(before);
    assert.equal(before.status, 'scheduled');
    assert.deepEqual(recorded.checkInputs, [{ provider: 'fake', platform: 'tiktok', remoteJobId: 'remote_job_1' }]);
    const checks = queuedTasks(context.dbPath, 'check_publication');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'queued');
    assert.equal(checks[0].available_at, new Date(Date.parse(scheduledFor) + 15_000).toISOString());

    before.scheduledFor = new Date(Date.now() - 60 * 1000).toISOString();
    context.store.updatePublication(before);
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: publication.id });
    assert.equal(await pipeline.runNext('output'), true);

    const after = context.store.getPublication(publication.id);
    assert.ok(after);
    assert.equal(after.status, 'submitted');
    const checksAfter = queuedTasks(context.dbPath, 'check_publication');
    assert.equal(checksAfter.length, 2);
    assert.equal(checksAfter[0].status, 'queued');
    assertRescheduledInAboutSeconds(checksAfter[1].available_at, 20);
  } finally {
    await cleanup(context);
  }
});

test('a remote failed result before the scheduled time fails the publication', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const scheduledFor = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const recorded = recordingPublisher({
      result: PUBLISH_RESULT,
      checkState: { status: 'failed', url: null, error: 'The job was cancelled in the dashboard.' },
    });
    const pipeline = pipelineFor(context, recorded.provider);
    const publication = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      status: 'scheduled',
      scheduledFor,
    });
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: publication.id });
    assert.equal(await pipeline.runNext('output'), true);

    const failed = context.store.getPublication(publication.id);
    assert.ok(failed);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'The job was cancelled in the dashboard.');
  } finally {
    await cleanup(context);
  }
});

test('a missed scheduled time fails the publication with the provider error', async () => {
  const context = await makeContext(copyWriter(), undefined, bufferChannelConfig());
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const scheduledFor = new Date(Date.now() + 60 * 1000).toISOString();
    const rejecting: ShortVideoPublishProvider = {
      ...recordingPublisher({ result: PUBLISH_RESULT }).provider,
      publishShortVideo: async () => {
        throw new ShortVideoPublishError({
          provider: 'mallary',
          stage: 'create',
          message: `Missed the scheduled time (${scheduledFor}); schedule it again.`,
          safeToFailover: false,
        });
      },
    };
    const pipeline = pipelineFor(context, rejecting);
    const publication = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_missed',
      status: 'queued',
      provider: null,
      batchId: null,
      remoteJobs: [],
      submittedAt: null,
      scheduledFor,
    });
    context.store.enqueueTask(seeded.jobId, 'publish_short_video', { publicationId: publication.id });
    assert.equal(await pipeline.runNext('output'), true);

    const failed = context.store.getPublication(publication.id);
    assert.ok(failed);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, `Missed the scheduled time (${scheduledFor}); schedule it again.`);
    assert.equal(queuedTasks(context.dbPath, 'check_publication').length, 0);
  } finally {
    await cleanup(context);
  }
});

test('cancelPublication cancels queued and deferred scheduled posts locally', async () => {
  const context = await makeContext(undefined, undefined, bufferChannelConfig());
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const [queued] = await context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt });
    const cancelledQueued = await context.service.cancelPublication(queued.id);
    assert.equal(cancelledQueued.publications.find((entry) => entry.id === queued.id)?.status, 'cancelled');

    context.store.setSetting(mallaryCooldownKey('instagram'), new Date(Date.now() + 30 * 60 * 1000).toISOString());
    const [deferred] = await context.service.publish(exportRecord.id, { platforms: ['instagram'], force: false, scheduledAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() });
    assert.equal(deferred.status, 'deferred');
    const cancelledDeferred = await context.service.cancelPublication(deferred.id);
    assert.equal(cancelledDeferred.publications.find((entry) => entry.id === deferred.id)?.status, 'cancelled');
  } finally {
    await cleanup(context);
  }
});

test('cancelPublication cancels a scheduled post through the provider', async () => {
  const recorded = recordingPublisher({ result: PUBLISH_RESULT });
  const context = await makeContext(copyWriter(), recorded.provider);
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const publication = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    const detail = await context.service.cancelPublication(publication.id);
    const cancelled = detail.publications.find((entry) => entry.id === publication.id);
    assert.ok(cancelled);
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(recorded.cancelInputs, [{ provider: 'fake', platform: 'tiktok', remoteJobId: 'remote_job_1' }]);
  } finally {
    await cleanup(context);
  }
});

test('cancelPublication surfaces a provider cancel failure as a conflict and keeps the post scheduled', async () => {
  const failingCancel = {
    ...fakePublisher(),
    cancelScheduled: async () => {
      throw new ShortVideoPublishError({
        provider: 'fake',
        stage: 'cancel',
        message: "TikTok is already publishing this post; it can't be cancelled.",
        safeToFailover: false,
        httpStatus: 409,
      });
    },
  };
  const context = await makeContext(copyWriter(), failingCancel);
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const publication = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    await assert.rejects(
      context.service.cancelPublication(publication.id),
      (error: unknown) => error instanceof StudioError
        && error.code === 'conflict'
        && error.message === "TikTok is already publishing this post; it can't be cancelled.",
    );
    const kept = context.store.getPublication(publication.id);
    assert.ok(kept);
    assert.equal(kept.status, 'scheduled');
  } finally {
    await cleanup(context);
  }
});

test('cancelPublication conflicts while uploading and for posts that cannot be cancelled', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const publishing = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_publishing',
      status: 'publishing',
      scheduledFor: scheduledAt,
    });
    await assert.rejects(
      context.service.cancelPublication(publishing.id),
      (error: unknown) => error instanceof StudioError && error.code === 'conflict' && error.message === 'Uploading right now. Try again in a minute.',
    );

    const submitted = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_submitted_late',
      scheduledFor: scheduledAt,
    });
    await assert.rejects(
      context.service.cancelPublication(submitted.id),
      (error: unknown) => error instanceof StudioError && error.code === 'conflict' && error.message === 'This post can no longer be cancelled.',
    );

    const immediate = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_immediate',
      status: 'queued',
      provider: null,
      batchId: null,
      remoteJobs: [],
      submittedAt: null,
      scheduledFor: null,
    });
    await assert.rejects(
      context.service.cancelPublication(immediate.id),
      (error: unknown) => error instanceof StudioError && error.code === 'conflict' && error.message === 'Only scheduled posts can be cancelled.',
    );
  } finally {
    await cleanup(context);
  }
});

test('publish rejects schedule times outside the lead window', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    await assert.rejects(
      context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() }),
      (error: unknown) => error instanceof StudioError && error.code === 'invalid' && error.message === 'Pick a time at least 15 minutes from now.',
    );
    await assert.rejects(
      context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: new Date(Date.now() + 61 * 24 * 60 * 60 * 1000).toISOString() }),
      (error: unknown) => error instanceof StudioError && error.code === 'invalid' && error.message === 'Pick a time within the next 60 days.',
    );
  } finally {
    await cleanup(context);
  }
});

test('publish rejects scheduling for platforms without a scheduling provider', async () => {
  const context = await makeContext(copyWriter(), undefined, { MALLARY_AI_API_TOKEN: undefined, ...bufferChannelConfig() });
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const detail = await context.service.getShort(seeded.shortId);
    const tiktok = detail.platforms.find((entry) => entry.platform === 'tiktok');
    assert.ok(tiktok);
    assert.equal(tiktok.available, true);
    assert.equal(tiktok.canSchedule, false);
    await assert.rejects(
      context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }),
      (error: unknown) => error instanceof StudioError && error.code === 'invalid' && error.message === 'Scheduling is not available for TikTok.',
    );
  } finally {
    await cleanup(context);
  }
});

test('listScheduledPosts returns upcoming scheduled posts ordered by time with short titles', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const base = Date.now();
    const later = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_later',
      status: 'scheduled',
      scheduledFor: new Date(base + 3 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const sooner = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_sooner',
      status: 'queued',
      provider: null,
      batchId: null,
      remoteJobs: [],
      submittedAt: null,
      scheduledFor: new Date(base + 24 * 60 * 60 * 1000).toISOString(),
    });
    const middle = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_middle',
      status: 'deferred',
      provider: null,
      batchId: null,
      remoteJobs: [],
      submittedAt: null,
      scheduledFor: new Date(base + 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_cancelled',
      status: 'cancelled',
      scheduledFor: new Date(base + 4 * 24 * 60 * 60 * 1000).toISOString(),
    });
    seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_live',
      status: 'published',
      scheduledFor: new Date(base + 5 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const posts = context.service.listScheduledPosts();
    assert.deepEqual(posts.map((post) => post.publicationId), [sooner.id, middle.id, later.id]);
    assert.deepEqual(posts[0], {
      publicationId: sooner.id,
      jobId: seeded.jobId,
      shortId: seeded.shortId,
      shortTitle: 'Short de teste',
      platform: 'tiktok',
      status: 'queued',
      scheduledFor: sooner.scheduledFor,
      timeZone: 'America/Sao_Paulo',
      provider: null,
    });
  } finally {
    await cleanup(context);
  }
});

test('startup backfills the check task for scheduled publications at the scheduled time', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const scheduledFor = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      status: 'scheduled',
      scheduledFor,
    });

    context.store.enqueueMissingPublicationChecks();
    const checks = queuedTasks(context.dbPath, 'check_publication');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'queued');
    assert.equal(checks[0].available_at, new Date(Date.parse(scheduledFor) + 15_000).toISOString());

    context.store.enqueueMissingPublicationChecks();
    assert.equal(queuedTasks(context.dbPath, 'check_publication').length, 1);
  } finally {
    await cleanup(context);
  }
});

test('a version-5 database gains scheduledFor on publications and lands on version 7', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const dbPath = context.dbPath;

    const legacy = new DatabaseSync(dbPath);
    legacy.exec('PRAGMA user_version = 5');
    const payload = JSON.stringify({
      id: 'pub_legacy',
      jobId: seeded.jobId,
      shortId: seeded.shortId,
      exportId: exportRecord.id,
      platform: 'tiktok',
      status: 'submitted',
      forced: false,
      provider: 'fake',
      batchId: 'batch_1',
      remoteJobs: [{ platform: 'tiktok', jobId: 'remote_job_1' }],
      remoteUrl: null,
      submittedAt: nowIso(),
      error: null,
      availableAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    legacy.prepare('INSERT INTO publications(id, export_id, short_id, platform, status, created_at, payload_json) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run('pub_legacy', exportRecord.id, seeded.shortId, 'tiktok', 'submitted', nowIso(), payload);
    legacy.close();

    const migrated = await ShortsStore.open(dbPath);
    try {
      const record = migrated.getPublication('pub_legacy');
      assert.ok(record);
      assert.equal(record.scheduledFor, null);
    } finally {
      migrated.close();
    }
    const versionDb = new DatabaseSync(dbPath);
    const versionRow = versionDb.prepare('PRAGMA user_version').get();
    versionDb.close();
    assert.ok(typeof versionRow === 'object' && versionRow !== null && 'user_version' in versionRow && versionRow.user_version === 7);
  } finally {
    await cleanup(context);
  }
});

test('a version-4 database with current payloads gains scheduledFor on publications', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const dbPath = context.dbPath;
    const publication = seedSubmittedPublication(context.store, seeded, exportRecord.id);
    const legacy = new DatabaseSync(dbPath);
    legacy.exec("UPDATE publications SET payload_json = json_remove(payload_json, '$.scheduledFor')");
    legacy.exec('PRAGMA user_version = 4');
    legacy.close();

    const migrated = await ShortsStore.open(dbPath);
    try {
      const record = migrated.getPublication(publication.id);
      assert.ok(record);
      assert.equal(record.scheduledFor, null);
      migrated.enqueueMissingPublicationChecks();
    } finally {
      migrated.close();
    }
  } finally {
    await cleanup(context);
  }
});

test('a check at the scheduled time applies the submitted rules to later errors', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    let checkState: RemotePublicationState = { status: 'pending', url: null, error: null };
    let checkError: Error | null = null;
    const gated: ShortVideoPublishProvider = {
      ...fakePublisher(),
      checkPublication: async () => {
        if (checkError) {
          throw checkError;
        }
        return checkState;
      },
    };
    const pipeline = pipelineFor(context, gated);
    const hardFailure = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_hard_fail',
      status: 'scheduled',
      scheduledFor: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: hardFailure.id });
    checkError = new ShortVideoPublishError({ provider: 'fake', stage: 'discovery', message: 'Mallary job status request failed: 404 not found', safeToFailover: false, httpStatus: 404 });
    assert.equal(await pipeline.runNext('output'), true);
    const afterHardFailure = context.store.getPublication(hardFailure.id);
    assert.ok(afterHardFailure);
    assert.equal(afterHardFailure.status, 'unconfirmed');
    assert.equal(afterHardFailure.error, 'ShortVideoPublishError: Mallary job status request failed: 404 not found');
    assert.equal(queuedTasks(context.dbPath, 'check_publication').filter((task) => task.status === 'queued').length, 0);

    const transient = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_transient',
      status: 'scheduled',
      scheduledFor: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: transient.id });
    checkError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    assert.equal(await pipeline.runNext('output'), true);
    const afterTransient = context.store.getPublication(transient.id);
    assert.ok(afterTransient);
    assert.equal(afterTransient.status, 'unconfirmed');
    const checks = queuedTasks(context.dbPath, 'check_publication').filter((task) => task.status === 'queued');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].payload.publicationId, transient.id);
    assertRescheduledInAboutSeconds(checks[0].available_at, 600);
  } finally {
    await cleanup(context);
  }
});

test('a cancelled scheduled publication is left alone when its pre-time check finishes', async () => {
  const checkStarted = Promise.withResolvers<void>();
  const releaseCheck = Promise.withResolvers<void>();
  const cancelCalls: ShortVideoCheckPublicationInput[] = [];
  const gated: ShortVideoPublishProvider = {
    ...fakePublisher(),
    checkPublication: async () => {
      checkStarted.resolve();
      await releaseCheck.promise;
      return { status: 'pending', url: null, error: null };
    },
    cancelScheduled: async (input) => {
      cancelCalls.push(input);
    },
  };
  const context = await makeContext(copyWriter(), gated);
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const publication = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    context.store.enqueueTask(seeded.jobId, 'check_publication', { publicationId: publication.id });
    const running = pipelineFor(context, gated).runNext('output');
    await checkStarted.promise;
    await context.service.cancelPublication(publication.id);
    assert.deepEqual(cancelCalls, [{ provider: 'fake', platform: 'tiktok', remoteJobId: 'remote_job_1' }]);
    releaseCheck.resolve();
    assert.equal(await running, true);

    const after = context.store.getPublication(publication.id);
    assert.ok(after);
    assert.equal(after.status, 'cancelled');
    assert.equal(queuedTasks(context.dbPath, 'check_publication').filter((task) => task.status === 'queued').length, 0);
  } finally {
    await cleanup(context);
  }
});

test('restart keeps settled scheduled publications and marks an interrupted scheduled upload unconfirmed', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const scheduledFor = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const settled = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_settled',
      status: 'scheduled',
      scheduledFor,
    });
    const cancelled = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_settled_cancelled',
      status: 'cancelled',
      scheduledFor,
    });
    const interrupted = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_interrupted',
      status: 'publishing',
      provider: null,
      batchId: null,
      remoteJobs: [],
      submittedAt: null,
      scheduledFor,
    });
    context.store.enqueueTask(seeded.jobId, 'publish_short_video', { publicationId: settled.id });
    context.store.enqueueTask(seeded.jobId, 'publish_short_video', { publicationId: cancelled.id });
    context.store.enqueueTask(seeded.jobId, 'publish_short_video', { publicationId: interrupted.id });
    assert.ok(context.store.claimNextTask(QUEUE_LANES.output));
    assert.ok(context.store.claimNextTask(QUEUE_LANES.output));
    assert.ok(context.store.claimNextTask(QUEUE_LANES.output));
    context.store.requeueRunningTasks();

    const keptScheduled = context.store.getPublication(settled.id);
    assert.ok(keptScheduled);
    assert.equal(keptScheduled.status, 'scheduled');
    const keptCancelled = context.store.getPublication(cancelled.id);
    assert.ok(keptCancelled);
    assert.equal(keptCancelled.status, 'cancelled');
    const stopped = context.store.getPublication(interrupted.id);
    assert.ok(stopped);
    assert.equal(stopped.status, 'unconfirmed');
    assert.equal(stopped.error, "The studio stopped while sending this scheduled post. Check Mallary's queue before scheduling it again.");

    context.store.enqueueMissingPublicationChecks();
    const checks = queuedTasks(context.dbPath, 'check_publication').filter((task) => task.status === 'queued');
    const scheduledCheck = checks.find((task) => task.payload.publicationId === settled.id);
    assert.ok(scheduledCheck);
    assert.equal(scheduledCheck.available_at, new Date(Date.parse(scheduledFor) + 15_000).toISOString());
  } finally {
    await cleanup(context);
  }
});

test('an ambiguous create failure marks the publication unconfirmed instead of failed', async () => {
  const ambiguous: ShortVideoPublishProvider = {
    ...fakePublisher(),
    publishShortVideo: async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    },
  };
  const context = await makeContext(copyWriter(), ambiguous, bufferChannelConfig());
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const scheduledFor = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const scheduled = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_ambiguous_scheduled',
      status: 'queued',
      provider: null,
      batchId: null,
      remoteJobs: [],
      submittedAt: null,
      scheduledFor,
    });
    context.store.enqueueTask(seeded.jobId, 'publish_short_video', { publicationId: scheduled.id });
    assert.equal(await pipelineFor(context, ambiguous).runNext('output'), true);
    const afterScheduled = context.store.getPublication(scheduled.id);
    assert.ok(afterScheduled);
    assert.equal(afterScheduled.status, 'unconfirmed');
    assert.equal(afterScheduled.error, "fake may have received this post; check Mallary's queue before reposting");

    const immediate = seedSubmittedPublication(context.store, seeded, exportRecord.id, {
      id: 'pub_ambiguous_immediate',
      status: 'queued',
      provider: null,
      batchId: null,
      remoteJobs: [],
      submittedAt: null,
      scheduledFor: null,
    });
    context.store.enqueueTask(seeded.jobId, 'publish_short_video', { publicationId: immediate.id });
    assert.equal(await pipelineFor(context, ambiguous).runNext('output'), true);
    const afterImmediate = context.store.getPublication(immediate.id);
    assert.ok(afterImmediate);
    assert.equal(afterImmediate.status, 'unconfirmed');
    assert.equal(afterImmediate.error, 'fake may have received this post; check TikTok before reposting');
  } finally {
    await cleanup(context);
  }
});

test('publish conflicts instead of returning a same-export post with a different schedule', async () => {
  const context = await makeContext(copyWriter(), undefined, bufferChannelConfig());
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const first = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const [queued] = await context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: first });
    const scheduledForMessage = `TikTok already has a post for this export scheduled for ${queued.scheduledFor}. Cancel it first.`;
    await assert.rejects(
      context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString() }),
      (error: unknown) => error instanceof StudioError && error.code === 'conflict' && error.message === scheduledForMessage,
    );
    await assert.rejects(
      context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: null }),
      (error: unknown) => error instanceof StudioError && error.code === 'conflict' && error.message === scheduledForMessage,
    );

    const otherExport: ExportRecord = {
      ...exportRecord,
      id: 'export_other',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    context.store.createExport(otherExport);
    await assert.rejects(
      context.service.publish(otherExport.id, { platforms: ['tiktok'], force: false, scheduledAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString() }),
      (error: unknown) => error instanceof StudioError
        && error.code === 'conflict'
        && error.message === 'TikTok has a scheduled post on another export; cancel it first.',
    );

    await context.service.cancelPublication(queued.id);
    const [immediate] = await context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: null });
    assert.equal(immediate.scheduledFor, null);
    await assert.rejects(
      context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString() }),
      (error: unknown) => error instanceof StudioError
        && error.code === 'conflict'
        && error.message === 'TikTok is already posting this export.',
    );
  } finally {
    await cleanup(context);
  }
});

test('a scheduled post accepted without job ids becomes unconfirmed with the Mallary queue message', async () => {
  const context = await makeContext(copyWriter(), undefined, bufferChannelConfig());
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const recorded = recordingPublisher({ result: { ...PUBLISH_RESULT, jobs: [] } });
    const pipeline = pipelineFor(context, recorded.provider);
    const scheduledFor = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const [queued] = await context.service.publish(exportRecord.id, { platforms: ['tiktok'], force: false, scheduledAt: scheduledFor });
    assert.equal(await pipeline.runNext('output'), true);

    const publication = context.store.getPublication(queued.id);
    assert.ok(publication);
    assert.equal(publication.status, 'unconfirmed');
    assert.equal(publication.error, "Mallary accepted the scheduled post but returned no id to track; check Mallary's queue before scheduling it again.");
    assert.equal(publication.scheduledFor, scheduledFor);
  } finally {
    await cleanup(context);
  }
});

test('a v6 database migrates to v7 adding the schedule to job snapshots', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'store-v6-'));
  try {
    const dbPath = join(rootDir, 'shorts.sqlite');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('PRAGMA user_version = 6');
    legacy.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL)');
    const legacyPayload = JSON.stringify({
      id: 'job_old',
      status: 'ready',
      creatorProfileId: 'creator_a',
      creatorProfileSnapshot: { id: 'creator_a', displayName: 'Creator A', schedule: null },
    });
    legacy.prepare("INSERT INTO jobs(id, status, updated_at, payload_json) VALUES('job_old', 'ready', '2026-10-17T10:00:00.000Z', ?)").run(legacyPayload);
    legacy.close();

    const store = await ShortsStore.open(dbPath);
    try {
      const migrated = store.getJob('job_old');
      assert.ok(migrated);
      assert.deepEqual(migrated.creatorProfileSnapshot.schedule, { timeZone: 'America/Sao_Paulo', slots: ['12:00', '19:00', '21:00'] });
    } finally {
      store.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('autopilot video records upsert and list newest first', async () => {
  const context = await makeContext();
  try {
    const older = autopilotVideo('vid_old', { detectedAt: '2026-10-17T12:00:00.000Z' });
    const newer = autopilotVideo('vid_new', { detectedAt: '2026-10-18T12:00:00.000Z', status: 'tracked', jobId: 'job_1' });
    context.store.saveAutopilotVideo(older);
    context.store.saveAutopilotVideo(newer);
    context.store.saveAutopilotVideo({ ...older, retries: 1, lastRetryAt: '2026-10-17T13:00:00.000Z' });

    assert.deepEqual(context.store.listAutopilotVideos('filipe_boni').map((record) => record.videoId), ['vid_new', 'vid_old']);
    const updated = context.store.getAutopilotVideo('filipe_boni', 'vid_old');
    assert.equal(updated?.retries, 1);
    assert.equal(updated?.lastRetryAt, '2026-10-17T13:00:00.000Z');
    assert.equal(context.store.getAutopilotVideo('filipe_boni', 'missing'), null);
    assert.deepEqual(context.store.listAutopilotVideos('other_creator'), []);
  } finally {
    await cleanup(context);
  }
});
