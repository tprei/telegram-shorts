import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ShortsPipeline } from '../src/application/pipeline.js';
import { StudioService } from '../src/application/studio-service.js';
import { CreatorProfileRepository } from '../src/infra/creator-profile-loader.js';
import { ShortsStore } from '../src/infra/db.js';
import type { AppConfig } from '../src/infra/env.js';
import type { OpenRouterClient } from '../src/infra/openrouter.js';
import type { CropKeyframe, JobRecord, SceneTrack, ShortRecord, TranscriptWord } from '../src/domain/model.js';
import type { ScenesLayoutProfile } from '../src/domain/layout.js';
import type { AnalyzeContentCropsFunction } from '../src/infra/vision.js';
import type { AnalyzeScenesFunction } from '../src/infra/scenes.js';
import { StudioError } from '../src/application/errors.js';
import { createInitialEdit } from '../src/domain/edit.js';
import { buildTimeline } from '../src/domain/timeline.js';
import { createId, nowIso } from '../src/infra/util.js';

const SCENES_LAYOUT: ScenesLayoutProfile = {
  version: 3,
  strategy: 'scenes',
  layoutId: 'mix-scenes-v3',
  canvas: { width: 1080, height: 1920, fps: 30 },
  background: '#101010',
  font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
  hookBand: { rect: { x: 0, y: 0, w: 1, h: 0.215 }, background: '#C8102E', textColor: '#FFFFFF', sizePx: 58, maxCharsPerLine: 24, maxLines: 2, uppercase: true },
  captions: { sizePx: 62, textColor: '#FFFFFF', highlightColor: '#FFD400', outlineColor: '#000000', outlinePx: 6, shadowPx: 2, uppercase: true, maxWordsPerCue: 4, maxCharsPerLine: 16, maxLines: 2, centerY: 0.5521 },
  safeArea: { top: 0.135, bottom: 0.17, side: 0.055 },
  scene: { captionCenterY: { host: 0.72, content: 0.78 } },
};

function testWords(): TranscriptWord[] {
  return Array.from({ length: 72 }, (_, index) => {
    const pause = index >= 36 ? 1.0 : 0;
    return {
      id: `w_${String(index + 1).padStart(6, '0')}`,
      text: `palavra${index + 1}`,
      startSeconds: index * 0.6 + pause,
      endSeconds: index * 0.6 + 0.5 + pause,
      speakerId: 'spk_0',
      confidence: 0.99,
    };
  });
}

function documentTrack(): SceneTrack {
  return {
    version: 1,
    analyzedAt: nowIso(),
    frame: { width: 1920, height: 1080 },
    segments: [
      {
        startSeconds: 0,
        endSeconds: 50,
        host: { camera: { x: 0.6, y: 0.5, w: 0.4, h: 0.5 }, head: { x: 0.7, y: 0.55, w: 0.2, h: 0.3 } },
        content: {
          box: { x: 0, y: 0, w: 0.6, h: 1 },
          kind: 'document',
          vertical: false,
          subject: { x: 0.1, y: 0.1, w: 0.4, h: 0.8 },
        },
        overlays: [],
      },
    ],
  };
}

function footageTrack(): SceneTrack {
  return {
    version: 1,
    analyzedAt: nowIso(),
    frame: { width: 1920, height: 1080 },
    segments: [
      {
        startSeconds: 0,
        endSeconds: 50,
        host: { camera: { x: 0.6, y: 0.5, w: 0.4, h: 0.5 }, head: { x: 0.7, y: 0.55, w: 0.2, h: 0.3 } },
        content: {
          box: { x: 0, y: 0, w: 0.6, h: 1 },
          kind: 'footage',
          vertical: false,
          subject: { x: 0.1, y: 0.1, w: 0.4, h: 0.8 },
        },
        overlays: [],
      },
    ],
  };
}

interface QueueTaskRow {
  id: string;
  status: string;
  payload: { shortId?: string };
  error: string | null;
}

const QueueTaskRowSchema = z.strictObject({
  id: z.string(),
  status: z.string(),
  payload_json: z.string(),
  error: z.string().nullable(),
});

const StoredQueueTaskSchema = z.object({ payload: z.object({ shortId: z.string().optional() }) });

function queuedTasks(dbPath: string, kind: string): QueueTaskRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    return QueueTaskRowSchema.array().parse(db.prepare('SELECT id, status, payload_json, error FROM queue_tasks WHERE kind = ? ORDER BY created_at ASC').all(kind)).map((entry) => ({
      id: entry.id,
      status: entry.status,
      payload: StoredQueueTaskSchema.parse(JSON.parse(entry.payload_json)).payload,
      error: entry.error,
    }));
  } finally {
    db.close();
  }
}

interface TestSetup {
  rootDir: string;
  dbPath: string;
  store: ShortsStore;
  pipeline: ShortsPipeline;
  service: StudioService;
  setSceneResult(track: SceneTrack): void;
  failScenes(error: unknown): void;
  failCrops(error: unknown): void;
  cleanup(): Promise<void>;
}

async function makeTestSetup(): Promise<TestSetup> {
  const rootDir = await mkdtemp(join(tmpdir(), 'pipe-scenes-'));
  await mkdir(join(rootDir, 'profiles'), { recursive: true });
  await mkdir(join(rootDir, 'artifacts'), { recursive: true });
  await writeFile(join(rootDir, 'profiles', 'mix_layout.json'), JSON.stringify(SCENES_LAYOUT));
  const manifest = {
    version: 3,
    defaultCreatorId: 'samuel_borelli',
    accounts: [
      {
        id: 'mix',
        displayName: 'Mix',
        schedule: { timeZone: 'America/Sao_Paulo', slots: ['12:00', '19:00', '21:00'] },
        platforms: ['instagram', 'tiktok'],
        mallaryProfileId: 'mix-prof-id',
        buffer: false,
        cover: null,
      },
    ],
    creators: [
      {
        id: 'samuel_borelli',
        displayName: 'Samuel Borelli',
        enabled: true,
        accountId: 'mix',
        render: {
          layoutPath: 'profiles/mix_layout.json',
          layoutId: 'mix-scenes-v3',
          defaultSpeed: 1.25,
          scene: {
            hostDescription: 'Samuel Borelli na webcam.',
            hints: 'Webcam à direita.',
          },
        },
      },
    ],
  };
  await writeFile(join(rootDir, 'profiles', 'creator-profiles.json'), JSON.stringify(manifest));

  const config: AppConfig = {
    SHORTS_TRANSCRIPT_PROVIDER: 'deepgram',
    SHORTS_PUBLISH_PROVIDERS: 'mallary',
    SHORTS_DB_PATH: join(rootDir, 'shorts.sqlite'),
    SHORTS_ARTIFACTS_DIR: join(rootDir, 'artifacts'),
    MALLARY_AI_API_TOKEN: 'token',
    rootDir,
    dbPath: join(rootDir, 'shorts.sqlite'),
    artifactsDir: join(rootDir, 'artifacts'),
    fontsDir: join(rootDir, 'assets', 'fonts'),
    webDistDir: join(rootDir, 'web', 'dist'),
  } as AppConfig;

  const store = await ShortsStore.open(config.dbPath);
  const profiles = new CreatorProfileRepository({ rootDir, manifestPath: join(rootDir, 'profiles', 'creator-profiles.json') });

  const openRouter: OpenRouterClient = {
    buildSemanticBlocks: async () => ({ blocks: [] }),
    findOpportunities: async (input: { title: string | null; blocks: Array<{ id: string }>; speed: number }) => {
      const ids = input.blocks.map((block) => block.id);
      return {
        opportunities: [
          {
            id: 'opp_1',
            title: 'Documento Importante',
            summary: 'Resumo',
            hook: 'Gancho',
            hook_text: 'MANCHETE',
            payoff: 'Payoff',
            rationale: 'Racional',
            thesis: 'Tese',
            viewer_promise: 'Promessa',
            tension: 'Tensão',
            why_this_short: 'Porque',
            risk: 'low' as const,
            block_ids: ids.slice(0, 3),
            steps: [
              { kind: 'hook' as const, label: 'gancho', block_ids: [ids[0]!] },
              { kind: 'explain' as const, label: 'mecanismo', block_ids: [ids[Math.min(1, ids.length - 1)]!] },
              { kind: 'payoff' as const, label: 'aterrissagem', block_ids: [ids[ids.length - 1]!] },
            ],
          },
        ],
      };
    },
    planCandidates: async (input: { title: string | null; blocks: Array<{ id: string }>; speed: number }) => {
      const ids = input.blocks.map((block) => block.id);
      return {
        candidates: [
          {
            opportunity_id: 'opp_1',
            title: 'Documento Importante',
            summary: 'Resumo',
            hook: 'Gancho',
            hook_text: 'MANCHETE',
            payoff: 'Payoff',
            rationale: 'Racional',
            thesis: 'Tese',
            risk: 'low' as const,
            block_ids: ids.slice(0, 3),
            steps: [
              { kind: 'hook' as const, label: 'gancho', block_ids: [ids[0]!] },
              { kind: 'explain' as const, label: 'mecanismo', block_ids: [ids[Math.min(1, ids.length - 1)]!] },
              { kind: 'payoff' as const, label: 'aterrissagem', block_ids: [ids[ids.length - 1]!] },
            ],
          },
        ],
      };
    },
  } as unknown as OpenRouterClient;

  const cropKeyframes: CropKeyframe[] = [
    { sourceSeconds: 5, origin: 'auto', focus: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 } },
  ];
  let sceneImpl: AnalyzeScenesFunction = async () => {
    throw new Error('Scene analysis stub is not configured');
  };
  let cropsImpl: AnalyzeContentCropsFunction = (async () => cropKeyframes.map((keyframe) => ({ ...keyframe }))) as AnalyzeContentCropsFunction;

  const pipeline = new ShortsPipeline({
    config,
    store,
    openRouter,
    profiles,
    publisher: null,
    analyzeScenes: (...input: Parameters<AnalyzeScenesFunction>) => sceneImpl(...input),
    analyzeContentCrops: (...input: Parameters<AnalyzeContentCropsFunction>) => cropsImpl(...input),
  });

  const service = new StudioService({
    config,
    store,
    openRouter,
    profiles,
    publisher: null,
  });

  return {
    rootDir,
    dbPath: config.dbPath,
    store,
    pipeline,
    service,
    setSceneResult: (track: SceneTrack) => {
      sceneImpl = async () => track;
    },
    failScenes: (error: unknown) => {
      sceneImpl = async () => {
        throw error;
      };
    },
    failCrops: (error: unknown) => {
      cropsImpl = async () => {
        throw error;
      };
    },
    cleanup: async () => {
      store.close();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

function seedSceneShort(store: ShortsStore, job: JobRecord): ShortRecord {
  const words = testWords();
  const short: ShortRecord = {
    id: createId('short'),
    jobId: job.id,
    rank: 1,
    origin: 'planner',
    title: 'Short de teste',
    summary: 'Resumo de teste',
    rationale: '',
    hook: '',
    payoff: '',
    risk: 'low',
    arc: null,
    status: 'active',
    edit: createInitialEdit({ ranges: [{ startWord: 0, endWord: words.length - 1 }], words, speed: 1, hookText: '' }),
    editRevision: 1,
    cropAnalysis: 'queued',
    cropAnalysisError: null,
    publishCopy: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.createShort(short);
  return short;
}

function seedScenesJob(store: ShortsStore, rootDir: string): JobRecord {
  const words = testWords();
  const videoPath = join(rootDir, 'source.mp4');
  const job: JobRecord = {
    id: createId('job'),
    sourceUrl: 'https://www.youtube.com/watch?v=mockscenes',
    sourceTitle: 'Vídeo Mix de Teste',
    status: 'planning',
    progress: null,
    creatorProfileId: 'samuel_borelli',
    creatorProfileSnapshot: {
      id: 'samuel_borelli',
      displayName: 'Samuel Borelli',
      enabled: true,
      accountId: 'mix',
      render: {
        layoutPath: 'profiles/mix_layout.json',
        layoutId: 'mix-scenes-v3',
        defaultSpeed: 1.25,
        scene: {
          hostDescription: 'Samuel Borelli na webcam.',
          hints: 'Webcam à direita.',
        },
      },
    },
    layoutProfileSnapshot: SCENES_LAYOUT,
    transcriptProvider: 'deepgram',
    media: {
      videoPath,
      thumbnailPath: null,
      width: 1920,
      height: 1080,
      fps: 30,
      durationSeconds: 50.0,
    },
    transcriptWords: words,
    transcriptSentences: [
      { id: 's_1', startWord: 0, endWord: 35, startSeconds: 0.0, endSeconds: 21.5, text: 'Primeira parte da analise do documento.' },
      { id: 's_2', startWord: 36, endWord: 71, startSeconds: 22.6, endSeconds: 44.1, text: 'Segunda parte fechando a analise do documento.' },
    ],
    transcriptRevision: 1,
    semanticBlocks: [],
    strongSpeakers: [{ speakerId: 'spk_0', totalSeconds: 44.1, sampleSentences: [] }],
    chosenSpeakerId: 'spk_0',
    hostFraming: null,
    hostFramingAnalyzedAt: null,
    sceneTrack: null,
    sceneAnalysis: 'queued',
    sceneAnalysisError: null,
    failedTaskKind: null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.createJob(job);
  return job;
}

async function analyzeScenesWithDocument(setup: TestSetup): Promise<{ job: JobRecord; short: ShortRecord }> {
  const job = seedScenesJob(setup.store, setup.rootDir);
  setup.store.enqueueTask(job.id, 'plan_shorts', {});
  setup.store.enqueueTask(job.id, 'analyze_scenes', {});
  assert.equal(await setup.pipeline.runNext('ingest'), true);
  const short = setup.store.listShortsForJob(job.id)[0]!;
  setup.setSceneResult(documentTrack());
  assert.equal(await setup.pipeline.runNext('ingest'), true);
  return { job, short };
}

test('planning completes before scene analysis and exports wait for its scene track', async () => {
  const setup = await makeTestSetup();
  try {
    const job = seedScenesJob(setup.store, setup.rootDir);
    setup.store.enqueueTask(job.id, 'plan_shorts', {});
    setup.store.enqueueTask(job.id, 'analyze_scenes', {});

    assert.equal(await setup.pipeline.runNext('ingest'), true);
    const plannedJob = setup.store.getJob(job.id)!;
    assert.equal(plannedJob.status, 'ready');
    assert.equal(plannedJob.sceneAnalysis, 'queued');
    const shorts = setup.store.listShortsForJob(job.id);
    assert.equal(shorts.length, 1);
    const short = shorts[0]!;
    assert.equal(short.cropAnalysis, 'queued');

    await assert.rejects(
      setup.service.exportShort(short.id),
      (err: unknown) => err instanceof StudioError && err.code === 'conflict' && /Scene analysis is still running/.test(err.message),
    );

    setup.setSceneResult(documentTrack());
    assert.equal(await setup.pipeline.runNext('ingest'), true);
    const analyzedJob = setup.store.getJob(job.id)!;
    assert.equal(analyzedJob.sceneAnalysis, 'done');
    assert.equal(analyzedJob.sceneTrack?.segments.length, 1);

    const crops = queuedTasks(setup.dbPath, 'analyze_crops');
    assert.equal(crops.length, 1);
    assert.equal(crops[0]?.payload.shortId, short.id);
    assert.equal(crops[0]?.status, 'queued');

    assert.equal(await setup.pipeline.runNext('ingest'), true);
    const cropped = setup.store.getShort(short.id)!;
    assert.equal(cropped.cropAnalysis, 'done');
    assert.ok(cropped.edit.crops.length > 0);

    const exported = await setup.service.exportShort(short.id);
    assert.ok(exported.exports.length > 0);
    const exportRecord = setup.store.getExport(exported.exports[0]!.id)!;
    assert.equal(exportRecord.layoutProfileSnapshot.strategy, 'scenes');
    assert.equal(exportRecord.sceneTrack?.segments.length, 1);
  } finally {
    await setup.cleanup();
  }
});

test('scene failure keeps shorts usable and a rerun with footage clears crops and enables export', async () => {
  const setup = await makeTestSetup();
  try {
    const job = seedScenesJob(setup.store, setup.rootDir);
    setup.store.enqueueTask(job.id, 'plan_shorts', {});
    setup.store.enqueueTask(job.id, 'analyze_scenes', {});
    assert.equal(await setup.pipeline.runNext('ingest'), true);
    const short = setup.store.listShortsForJob(job.id)[0]!;

    setup.failScenes(new Error('Vision timeout occurred on frame 12'));
    assert.equal(await setup.pipeline.runNext('ingest'), true);

    const failedJob = setup.store.getJob(job.id)!;
    assert.equal(failedJob.status, 'ready');
    assert.equal(failedJob.sceneAnalysis, 'failed');
    assert.equal(failedJob.sceneAnalysisError, 'Vision timeout occurred on frame 12');
    assert.equal(queuedTasks(setup.dbPath, 'analyze_scenes').filter((task) => task.status === 'failed').length, 1);
    assert.equal(setup.store.listShortsForJob(job.id).length, 1);

    await assert.rejects(
      setup.service.exportShort(short.id),
      (err: unknown) => err instanceof StudioError && err.code === 'conflict' && /Vision timeout/.test(err.message),
    );

    const rerun = setup.service.analyzeScenes(job.id);
    assert.equal(rerun.sceneAnalysis.status, 'queued');

    setup.setSceneResult(footageTrack());
    assert.equal(await setup.pipeline.runNext('ingest'), true);
    const rerunJob = setup.store.getJob(job.id)!;
    assert.equal(rerunJob.sceneAnalysis, 'done');
    assert.equal(setup.store.getShort(short.id)!.cropAnalysis, 'none');
    assert.equal(queuedTasks(setup.dbPath, 'analyze_crops').length, 0);

    const exported = await setup.service.exportShort(short.id);
    assert.ok(exported.exports.length > 0);
  } finally {
    await setup.cleanup();
  }
});

test('restart backfills missing scene analysis once and unsticks queued crops', async () => {
  const setup = await makeTestSetup();
  try {
    const ready = seedScenesJob(setup.store, setup.rootDir);
    ready.status = 'ready';
    ready.sceneAnalysis = 'none';
    setup.store.updateJob(ready);

    const waiting = seedScenesJob(setup.store, setup.rootDir);
    waiting.status = 'awaiting_speaker';
    waiting.sceneAnalysis = 'none';
    setup.store.updateJob(waiting);

    const crashed = seedScenesJob(setup.store, setup.rootDir);
    crashed.status = 'planning';
    setup.store.updateJob(crashed);

    const failed = seedScenesJob(setup.store, setup.rootDir);
    failed.status = 'failed';
    failed.sceneAnalysis = 'queued';
    setup.store.updateJob(failed);

    const stuck = seedScenesJob(setup.store, setup.rootDir);
    stuck.status = 'ready';
    stuck.sceneAnalysis = 'done';
    stuck.sceneTrack = footageTrack();
    setup.store.updateJob(stuck);
    const stuckShort = seedSceneShort(setup.store, stuck);

    const done = seedScenesJob(setup.store, setup.rootDir);
    done.status = 'ready';
    done.sceneAnalysis = 'done';
    done.sceneTrack = documentTrack();
    setup.store.updateJob(done);

    const reopened = await ShortsStore.open(setup.dbPath);
    try {
      reopened.enqueueMissingSceneAnalyses();
      reopened.enqueueMissingCropAnalyses();
      const sceneTasks = queuedTasks(setup.dbPath, 'analyze_scenes');
      assert.equal(sceneTasks.filter((task) => task.status === 'queued').length, 3);
      const cropTasks = queuedTasks(setup.dbPath, 'analyze_crops');
      assert.equal(cropTasks.length, 1);
      assert.equal(cropTasks[0]?.payload.shortId, stuckShort.id);
    } finally {
      reopened.close();
    }

    const reopenedAgain = await ShortsStore.open(setup.dbPath);
    try {
      reopenedAgain.enqueueMissingSceneAnalyses();
      reopenedAgain.enqueueMissingCropAnalyses();
      assert.equal(queuedTasks(setup.dbPath, 'analyze_scenes').filter((task) => task.status === 'queued').length, 3);
      assert.equal(queuedTasks(setup.dbPath, 'analyze_crops').length, 1);
    } finally {
      reopenedAgain.close();
    }
  } finally {
    await setup.cleanup();
  }
});

test('a scene rerun drops stale auto crops and leaves the short exportable', async () => {
  const setup = await makeTestSetup();
  try {
    const { job, short } = await analyzeScenesWithDocument(setup);
    assert.equal(await setup.pipeline.runNext('ingest'), true);
    const cropped = setup.store.getShort(short.id);
    assert.ok(cropped);
    assert.ok(cropped.edit.crops.some((crop) => crop.origin === 'auto'));

    const rerun = setup.service.analyzeScenes(job.id);
    assert.equal(rerun.sceneAnalysis.status, 'queued');
    setup.setSceneResult(footageTrack());
    assert.equal(await setup.pipeline.runNext('ingest'), true);

    const rerunShort = setup.store.getShort(short.id);
    assert.ok(rerunShort);
    assert.equal(rerunShort.edit.crops.some((crop) => crop.origin === 'auto'), false);
    assert.equal(rerunShort.editRevision, cropped.editRevision + 1);
    assert.equal(rerunShort.cropAnalysis, 'none');
    assert.equal(queuedTasks(setup.dbPath, 'analyze_crops').filter((task) => task.status === 'queued').length, 0);

    const exported = await setup.service.exportShort(short.id);
    const exportRecord = setup.store.getExport(exported.exports[0]!.id);
    assert.ok(exportRecord);
    const finalJob = setup.store.getJob(job.id);
    assert.ok(finalJob?.media);
    const media = finalJob.media;
    assert.doesNotThrow(() =>
      buildTimeline({
        edit: exportRecord.edit,
        title: exportRecord.title,
        words: finalJob.transcriptWords,
        layout: exportRecord.layoutProfileSnapshot,
        source: { width: media.width, height: media.height, durationSeconds: media.durationSeconds },
        hostFraming: exportRecord.hostFraming,
        sceneTrack: exportRecord.sceneTrack,
      }),
    );
  } finally {
    await setup.cleanup();
  }
});

test('scene analysis failures store at most 2000 characters on the task row and job', async () => {
  const setup = await makeTestSetup();
  try {
    const job = seedScenesJob(setup.store, setup.rootDir);
    setup.store.enqueueTask(job.id, 'plan_shorts', {});
    setup.store.enqueueTask(job.id, 'analyze_scenes', {});
    assert.equal(await setup.pipeline.runNext('ingest'), true);

    setup.failScenes(new Error('v'.repeat(5000)));
    assert.equal(await setup.pipeline.runNext('ingest'), true);

    const [failedTask] = queuedTasks(setup.dbPath, 'analyze_scenes');
    assert.equal(failedTask?.status, 'failed');
    assert.equal(failedTask?.error, 'v'.repeat(2000));
    assert.equal(setup.store.getJob(job.id)?.sceneAnalysisError, 'v'.repeat(2000));
  } finally {
    await setup.cleanup();
  }
});

test('crop analysis failures store at most 2000 characters on the task row', async () => {
  const setup = await makeTestSetup();
  try {
    await analyzeScenesWithDocument(setup);

    setup.failCrops(new Error('c'.repeat(5000)));
    assert.equal(await setup.pipeline.runNext('ingest'), true);

    const [failedTask] = queuedTasks(setup.dbPath, 'analyze_crops');
    assert.equal(failedTask?.status, 'failed');
    assert.equal(failedTask?.error, 'c'.repeat(2000));
  } finally {
    await setup.cleanup();
  }
});
