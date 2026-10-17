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
import { createInitialEdit, type ShortEdit, type WordRange } from '../src/domain/edit.js';
import { buildSentences } from '../src/domain/policies.js';
import type { LayoutProfile } from '../src/domain/layout.js';
import { QUEUE_LANES, type CreatorProfile, type ExportRecord, type JobRecord, type PublicationRecord, type PublishCopyResponse, type RevisionIntent, type ShortRecord, type TranscriptWord } from '../src/domain/model.js';
import { acquireStudioLock } from '../src/infra/studio-lock.js';
import { ShortsStore } from '../src/infra/db.js';
import type { AppConfig } from '../src/infra/env.js';
import { CreatorProfileRepository } from '../src/infra/creator-profile-loader.js';
import type { OpenRouterClient } from '../src/infra/openrouter.js';
import type { ShortVideoPublishProvider } from '../src/infra/instagram-publisher.js';
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
};

interface TestContext {
  rootDir: string;
  store: ShortsStore;
  service: StudioService;
}

async function makeContext(openRouter: OpenRouterClient = {} as OpenRouterClient): Promise<TestContext> {
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
  const service = new StudioService({
    config: testConfig(rootDir),
    store,
    openRouter,
    profiles,
    publisher: fakePublisher(),
  });
  return { rootDir, store, service };
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
    supports: () => true,
    publishShortVideo: async () => {
      throw new Error('publisher must not be called from the studio service');
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

function isStudioErrorWithCode(code: StudioError['code']): (error: unknown) => boolean {
  return (error) => error instanceof StudioError && error.code === code;
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

test('publish reuses the active publication unless forced', async () => {
  const context = await makeContext();
  try {
    const seeded = seedReadyJob(context.store, CREATOR_A, context.rootDir);
    const exportRecord = seedReadyExport(context.store, seeded, context.rootDir);
    const first = await context.service.publish(exportRecord.id, { platforms: ['instagram'], force: false });
    assert.equal(first.length, 1);
    assert.equal(first[0].status, 'queued');

    const second = await context.service.publish(exportRecord.id, { platforms: ['instagram'], force: false });
    assert.equal(second[0].id, first[0].id);
    assert.equal(context.store.listPublicationsForShort(seeded.shortId).length, 1);

    const forced = await context.service.publish(exportRecord.id, { platforms: ['instagram'], force: true });
    assert.notEqual(forced[0].id, first[0].id);
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
      context.service.publish(exportRecord.id, { platforms: ['instagram'], force: false }),
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
