import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { FixedLayoutProfile, ScenesLayoutProfile } from '../src/domain/layout.js';
import type { SceneTrack } from '../src/domain/model.js';
import { ShortsStore } from '../src/infra/db.js';

async function createTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'db-migration-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const repoManifestPath = join(import.meta.dirname, '..', 'profiles', 'creator-profiles.json');
const REAL_BONI_LAYOUT_V2 = {
  version: 2,
  creatorId: 'filipe_boni',
  layoutId: 'screen-top-host-bottom-v2',
  canvas: { width: 1080, height: 1920, fps: 30 },
  background: '#101010',
  defaultSpeed: 1.35,
  font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
  panels: [
    { id: 'screen', role: 'content', sourceRect: { x: 0, y: 0, w: 0.632, h: 1 }, canvasRect: { x: 0, y: 0.1146, w: 1, h: 0.4375 } },
    { id: 'host', role: 'host', sourceRect: { x: 0.637, y: 0, w: 0.363, h: 1 }, canvasRect: { x: 0, y: 0.5521, w: 1, h: 0.4479 }, anchor: { x: 0.5, y: 0.42 } },
  ],
  hookBand: { rect: { x: 0, y: 0, w: 1, h: 0.1146 }, background: '#C8102E', textColor: '#FFFFFF', sizePx: 58, maxCharsPerLine: 24, maxLines: 2, uppercase: true },
  captions: { sizePx: 62, textColor: '#FFFFFF', highlightColor: '#FFD400', outlineColor: '#000000', outlinePx: 6, shadowPx: 2, uppercase: true, maxWordsPerCue: 4, maxCharsPerLine: 16, maxLines: 2, centerY: 0.5521 },
};

const REAL_JONES_LAYOUT_V2 = {
  version: 2,
  creatorId: 'jones_manoel',
  layoutId: 'center-speaker-vertical-v2',
  canvas: { width: 1080, height: 1920, fps: 30 },
  background: '#101010',
  defaultSpeed: 1.1,
  font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
  panels: [
    { id: 'speaker', role: 'host', sourceRect: { x: 0.342, y: 0, w: 0.316, h: 1 }, canvasRect: { x: 0, y: 0, w: 1, h: 1 }, anchor: { x: 0.5, y: 0.4 } },
  ],
  hookBand: { rect: { x: 0.05, y: 0.07, w: 0.9, h: 0.11 }, background: '#000000B3', textColor: '#FFFFFF', sizePx: 56, maxCharsPerLine: 24, maxLines: 2, uppercase: true },
  captions: { sizePx: 64, textColor: '#FFFFFF', highlightColor: '#FFD400', outlineColor: '#000000', outlinePx: 6, shadowPx: 2, uppercase: true, maxWordsPerCue: 4, maxCharsPerLine: 16, maxLines: 2, centerY: 0.72 },
};

const REAL_MACHADO_LAYOUT_V2 = {
  version: 2,
  creatorId: 'gustavo_machado',
  layoutId: 'machado-slides-top-host-bottom-v2',
  canvas: { width: 1080, height: 1920, fps: 30 },
  background: '#101010',
  defaultSpeed: 1.25,
  font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
  panels: [
    { id: 'slides', role: 'content', sourceRect: { x: 0.35, y: 0, w: 0.65, h: 1 }, canvasRect: { x: 0, y: 0.1146, w: 1, h: 0.4375 } },
    { id: 'host', role: 'host', sourceRect: { x: 0, y: 0, w: 0.35, h: 1 }, canvasRect: { x: 0, y: 0.5521, w: 1, h: 0.4479 }, anchor: { x: 0.5, y: 0.42 } },
  ],
  hookBand: { rect: { x: 0, y: 0, w: 1, h: 0.1146 }, background: '#C8102E', textColor: '#FFFFFF', sizePx: 58, maxCharsPerLine: 24, maxLines: 2, uppercase: true },
  captions: { sizePx: 62, textColor: '#FFFFFF', highlightColor: '#FFD400', outlineColor: '#000000', outlinePx: 6, shadowPx: 2, uppercase: true, maxWordsPerCue: 4, maxCharsPerLine: 16, maxLines: 2, centerY: 0.5521 },
};

function createV7Database(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE shorts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL, rank INTEGER NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE exports (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, short_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE publications (id TEXT PRIMARY KEY, export_id TEXT NOT NULL, short_id TEXT NOT NULL, platform TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE queue_tasks (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, available_at TEXT, started_at TEXT, error TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE actions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE autopilot_videos (creator_id TEXT NOT NULL, video_id TEXT NOT NULL, status TEXT NOT NULL, detected_at TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY (creator_id, video_id));
    PRAGMA user_version = 7;
  `);
  return db;
}

function createV7DatabaseWithJob(path: string): string {
  const db = createV7Database(path);
  const payload = JSON.stringify({ id: 'job_untouched', status: 'ready' });
  db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)').run('job_untouched', 'ready', '2026-10-17T00:00:00.000Z', payload);
  db.close();
  return payload;
}

function assertV7Untouched(path: string, payload: string): void {
  const db = new DatabaseSync(path);
  try {
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(version.user_version, 7);
    const row = db.prepare('SELECT payload_json FROM jobs WHERE id = ?').get('job_untouched') as { payload_json: string };
    assert.equal(row.payload_json, payload);
  } finally {
    db.close();
  }
}

test('v7 jobs for every legacy creator migrate with historical speeds and preserved fixed framing', async (t) => {
  const dir = await createTempDir(t);
  const dbPath = join(dir, 'test.sqlite');
  const rawDb = createV7Database(dbPath);

  const boniJobV7 = {
    id: 'job_boni_1',
    sourceUrl: 'https://www.youtube.com/watch?v=lIZA6vBD29g',
    sourceTitle: 'Li o Plano do Flavio',
    status: 'ready',
    progress: null,
    creatorProfileId: 'filipe_boni',
    creatorProfileSnapshot: {
      id: 'filipe_boni',
      displayName: 'Filipe Boni',
      enabled: true,
      description: 'Default Filipe Boni profile.',
      render: { layoutPath: 'profiles/filipe_boni_layout.json', layoutId: 'screen-top-host-bottom-v2' },
      publish: { instagram: { mode: 'global' }, tiktok: { mode: 'global' }, youtube_shorts: { mode: 'global' } },
      schedule: { timeZone: 'America/Sao_Paulo', slots: ['12:00', '19:00', '21:00'] },
    },
    layoutProfileSnapshot: REAL_BONI_LAYOUT_V2,
    transcriptProvider: 'deepgram',
    media: { videoPath: '/tmp/v.mp4', audioPath: '/tmp/a.m4a', thumbnailPath: null, width: 1920, height: 1080, fps: 30, durationSeconds: 60 },
    transcriptWords: [],
    transcriptSentences: [],
    transcriptRevision: 0,
    semanticBlocks: [],
    strongSpeakers: [],
    chosenSpeakerId: 'spk_0',
    hostFraming: { headBox: { x: 0.72, y: 0.17, w: 0.2, h: 0.4 } },
    hostFramingAnalyzedAt: '2026-10-17T19:39:38.161Z',
    failedTaskKind: null,
    error: null,
    createdAt: '2026-10-17T19:30:00.000Z',
    updatedAt: '2026-10-17T19:40:00.000Z',
  };

  const jonesJobV7 = {
    id: 'job_jones_1',
    sourceUrl: 'https://www.youtube.com/watch?v=jones_sample',
    sourceTitle: 'Jones Video',
    status: 'ready',
    progress: null,
    creatorProfileId: 'jones_manoel',
    creatorProfileSnapshot: {
      id: 'jones_manoel',
      displayName: 'Jones Manoel',
      enabled: true,
      description: 'Jones profile.',
      render: { layoutPath: 'profiles/jones_manoel_layout.json', layoutId: 'center-speaker-vertical-v2' },
      publish: { instagram: { mode: 'disabled' }, tiktok: { mode: 'disabled' } },
      schedule: { timeZone: 'America/Sao_Paulo', slots: ['12:00', '19:00', '21:00'] },
    },
    layoutProfileSnapshot: REAL_JONES_LAYOUT_V2,
    transcriptProvider: 'deepgram',
    media: { videoPath: '/tmp/v.mp4', audioPath: '/tmp/a.m4a', thumbnailPath: null, width: 1920, height: 1080, fps: 30, durationSeconds: 120 },
    transcriptWords: [],
    transcriptSentences: [],
    transcriptRevision: 0,
    semanticBlocks: [],
    strongSpeakers: [],
    chosenSpeakerId: 'spk_0',
    hostFraming: { headBox: { x: 0.4, y: 0.2, w: 0.2, h: 0.3 } },
    hostFramingAnalyzedAt: '2026-10-17T20:00:00.000Z',
    failedTaskKind: null,
    error: null,
    createdAt: '2026-10-17T19:50:00.000Z',
    updatedAt: '2026-10-17T20:05:00.000Z',
  };

  const machadoJobV7 = {
    id: 'job_machado_1',
    sourceUrl: 'https://www.youtube.com/watch?v=machado_sample',
    sourceTitle: 'Machado Video',
    status: 'ready',
    progress: null,
    creatorProfileId: 'gustavo_machado',
    creatorProfileSnapshot: {
      id: 'gustavo_machado',
      displayName: 'Gustavo Machado',
      enabled: true,
      description: 'Machado legacy fixed profile.',
      render: { layoutPath: 'profiles/gustavo_machado_layout.json', layoutId: 'machado-slides-top-host-bottom-v2' },
      publish: { instagram: { mode: 'disabled' }, tiktok: { mode: 'disabled' } },
      schedule: { timeZone: 'America/Sao_Paulo', slots: ['12:00', '19:00', '21:00'] },
    },
    layoutProfileSnapshot: REAL_MACHADO_LAYOUT_V2,
    transcriptProvider: 'deepgram',
    media: { videoPath: '/tmp/v.mp4', audioPath: '/tmp/a.m4a', thumbnailPath: null, width: 1920, height: 1080, fps: 30, durationSeconds: 180 },
    transcriptWords: [],
    transcriptSentences: [],
    transcriptRevision: 0,
    semanticBlocks: [],
    strongSpeakers: [],
    chosenSpeakerId: 'spk_0',
    hostFraming: { headBox: { x: 0.1, y: 0.2, w: 0.15, h: 0.3 } },
    hostFramingAnalyzedAt: '2026-10-17T21:00:00.000Z',
    failedTaskKind: null,
    error: null,
    createdAt: '2026-10-17T20:50:00.000Z',
    updatedAt: '2026-10-17T21:05:00.000Z',
  };

  const borelliJobV7 = {
    ...machadoJobV7,
    id: 'job_borelli_1',
    creatorProfileId: 'samuel_borelli',
    creatorProfileSnapshot: {
      id: 'samuel_borelli',
      displayName: 'Samuel Borelli',
      enabled: true,
      render: { layoutPath: 'profiles/mix_layout.json', layoutId: 'mix-scenes-v3' },
      publish: { instagram: { mode: 'global' }, tiktok: { mode: 'global' } },
      schedule: { timeZone: 'America/Sao_Paulo', slots: ['12:00', '19:00', '21:00'] },
    },
    layoutProfileSnapshot: {
      ...REAL_MACHADO_LAYOUT_V2,
      creatorId: 'samuel_borelli',
      defaultSpeed: 1.3,
    },
    hostFramingAnalyzedAt: null,
    createdAt: '2026-10-17T22:00:00.000Z',
    updatedAt: '2026-10-17T22:05:00.000Z',
  };

  rawDb.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)').run(boniJobV7.id, boniJobV7.status, boniJobV7.updatedAt, JSON.stringify(boniJobV7));
  rawDb.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)').run(jonesJobV7.id, jonesJobV7.status, jonesJobV7.updatedAt, JSON.stringify(jonesJobV7));
  rawDb.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)').run(machadoJobV7.id, machadoJobV7.status, machadoJobV7.updatedAt, JSON.stringify(machadoJobV7));
  rawDb.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)').run(borelliJobV7.id, borelliJobV7.status, borelliJobV7.updatedAt, JSON.stringify(borelliJobV7));
  rawDb.close();

  const store = await ShortsStore.open(dbPath, { manifestPath: repoManifestPath });
  try {
    const migratedBoni = store.getJob('job_boni_1');
    assert.ok(migratedBoni);
    assert.equal(migratedBoni.creatorProfileSnapshot.accountId, 'cortes_do_boni');
    assert.equal(migratedBoni.creatorProfileSnapshot.render.defaultSpeed, 1.35);
    assert.equal(migratedBoni.creatorProfileSnapshot.render.scene, null);
    assert.equal(migratedBoni.sceneTrack, null);
    assert.equal(migratedBoni.sceneAnalysis, 'none');
    assert.equal(migratedBoni.sceneAnalysisError, null);
    assert.equal(migratedBoni.layoutProfileSnapshot.version, 3);
    assert.equal(migratedBoni.layoutProfileSnapshot.strategy, 'fixed');
    assert.deepEqual(migratedBoni.layoutProfileSnapshot.safeArea, { top: 0, bottom: 0, side: 0 });
    assert.equal((migratedBoni.layoutProfileSnapshot as unknown as Record<string, unknown>).creatorId, undefined);
    assert.equal((migratedBoni.layoutProfileSnapshot as unknown as Record<string, unknown>).defaultSpeed, undefined);
    assert.deepEqual((migratedBoni.layoutProfileSnapshot as FixedLayoutProfile).panels, REAL_BONI_LAYOUT_V2.panels);
    assert.equal((migratedBoni.creatorProfileSnapshot as unknown as Record<string, unknown>).schedule, undefined);
    assert.equal((migratedBoni.creatorProfileSnapshot as unknown as Record<string, unknown>).publish, undefined);

    const migratedJones = store.getJob('job_jones_1');
    assert.ok(migratedJones);
    assert.equal(migratedJones.creatorProfileSnapshot.accountId, null);
    assert.equal(migratedJones.creatorProfileSnapshot.render.defaultSpeed, 1.1);
    assert.equal(migratedJones.creatorProfileSnapshot.render.scene, null);
    assert.equal(migratedJones.layoutProfileSnapshot.version, 3);
    assert.equal(migratedJones.layoutProfileSnapshot.strategy, 'fixed');
    assert.deepEqual((migratedJones.layoutProfileSnapshot as FixedLayoutProfile).panels, REAL_JONES_LAYOUT_V2.panels);

    const migratedMachado = store.getJob('job_machado_1');
    assert.ok(migratedMachado);
    assert.equal(migratedMachado.creatorProfileSnapshot.accountId, 'mix');
    assert.equal(migratedMachado.creatorProfileSnapshot.render.defaultSpeed, 1.25);
    assert.equal(migratedMachado.creatorProfileSnapshot.render.scene, null);
    assert.equal(migratedMachado.layoutProfileSnapshot.version, 3);
    assert.equal(migratedMachado.layoutProfileSnapshot.strategy, 'fixed');
    assert.deepEqual((migratedMachado.layoutProfileSnapshot as FixedLayoutProfile).panels, REAL_MACHADO_LAYOUT_V2.panels);

    const migratedBorelli = store.getJob('job_borelli_1');
    assert.ok(migratedBorelli);
    assert.equal(migratedBorelli.creatorProfileSnapshot.accountId, 'mix');
    assert.equal(migratedBorelli.creatorProfileSnapshot.render.defaultSpeed, 1.3);
    assert.equal(migratedBorelli.creatorProfileSnapshot.render.scene, null);
    assert.equal(migratedBorelli.layoutProfileSnapshot.version, 3);
    assert.equal(migratedBorelli.layoutProfileSnapshot.strategy, 'fixed');
    assert.deepEqual((migratedBorelli.layoutProfileSnapshot as FixedLayoutProfile).panels, REAL_MACHADO_LAYOUT_V2.panels);
    assert.equal((migratedBorelli.creatorProfileSnapshot as unknown as Record<string, unknown>).publish, undefined);
  } finally {
    store.close();
  }
});

test('v8 initializes edit layout on every short and every export snapshot', async (t) => {
  const dir = await createTempDir(t);
  const dbPath = join(dir, 'test.sqlite');
  const rawDb = createV7Database(dbPath);

  const jobV7 = {
    id: 'job_1',
    sourceUrl: 'https://www.youtube.com/watch?v=xyz',
    sourceTitle: 'Title',
    status: 'ready',
    progress: null,
    creatorProfileId: 'filipe_boni',
    creatorProfileSnapshot: {
      id: 'filipe_boni',
      displayName: 'Filipe Boni',
      enabled: true,
      render: { layoutPath: 'profiles/filipe_boni_layout.json', layoutId: 'screen-top-host-bottom-v2' },
      publish: {},
      schedule: { timeZone: 'America/Sao_Paulo', slots: ['12:00'] },
    },
    layoutProfileSnapshot: REAL_BONI_LAYOUT_V2,
    transcriptProvider: 'deepgram',
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
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
  };

  const exportEdit = {
    ranges: [{ startWord: 0, endWord: 10 }],
    removedWords: [],
    tightenPauses: { enabled: true, maxGapSeconds: 0.35 },
    speed: 1.1,
    hook: { enabled: true, text: 'Old hook' },
    captions: { enabled: true },
    crops: [{ sourceSeconds: 5, focus: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, origin: 'auto' }],
    zoom: { enabled: false, strength: 1.12 },
    endCard: { enabled: false },
  };

  const shortEdit = {
    ranges: [{ startWord: 0, endWord: 10 }],
    removedWords: [],
    tightenPauses: { enabled: true, maxGapSeconds: 0.35 },
    speed: 1.2,
    hook: { enabled: true, text: 'New hook' },
    captions: { enabled: true },
    crops: [
      { sourceSeconds: 5, focus: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, origin: 'auto' },
      { sourceSeconds: 12, focus: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, origin: 'auto' },
    ],
    zoom: { enabled: false, strength: 1.12 },
    endCard: { enabled: false },
  };

  const shortV7 = {
    id: 'short_1',
    jobId: 'job_1',
    rank: 1,
    origin: 'planner',
    title: 'Short 1',
    summary: 'Summary',
    rationale: 'Rationale',
    hook: 'Hook',
    payoff: 'Payoff',
    risk: 'low',
    arc: null,
    status: 'active',
    edit: shortEdit,
    editRevision: 2,
    cropAnalysis: 'none',
    cropAnalysisError: null,
    publishCopy: null,
    createdAt: '2026-10-17T00:01:00.000Z',
    updatedAt: '2026-10-17T00:05:00.000Z',
  };

  const exportV7 = {
    id: 'export_1',
    jobId: 'job_1',
    shortId: 'short_1',
    editRevision: 1,
    transcriptRevision: 0,
    edit: exportEdit,
    title: 'Export 1',
    hostFraming: null,
    status: 'ready',
    artifactPath: '/tmp/art.mp4',
    coverPath: null,
    sizeBytes: 1000,
    durationSeconds: 15,
    error: null,
    createdAt: '2026-10-17T00:02:00.000Z',
    updatedAt: '2026-10-17T00:03:00.000Z',
  };

  rawDb.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)').run(jobV7.id, jobV7.status, jobV7.updatedAt, JSON.stringify(jobV7));
  rawDb.prepare('INSERT INTO shorts VALUES (?, ?, ?, ?, ?, ?)').run(shortV7.id, shortV7.jobId, shortV7.status, shortV7.rank, shortV7.updatedAt, JSON.stringify(shortV7));
  rawDb.prepare('INSERT INTO exports VALUES (?, ?, ?, ?, ?, ?)').run(exportV7.id, exportV7.jobId, exportV7.shortId, exportV7.status, exportV7.createdAt, JSON.stringify(exportV7));
  rawDb.close();

  const store = await ShortsStore.open(dbPath, { manifestPath: repoManifestPath });
  try {
    const short = store.getShort('short_1');
    assert.ok(short);
    assert.deepEqual(short.edit.layout, { split: null, overrides: [] });
    assert.equal(short.edit.crops.length, 2);
    assert.equal(short.edit.speed, 1.2);

    const exp = store.getExport('export_1');
    assert.ok(exp);
    assert.deepEqual(exp.edit.layout, { split: null, overrides: [] });
    assert.equal(exp.edit.crops.length, 1);
    assert.equal(exp.edit.speed, 1.1);
  } finally {
    store.close();
  }
});

test('v8 freezes parent layout and preserves ready artifacts and booked posts', async (t) => {
  const dir = await createTempDir(t);
  const dbPath = join(dir, 'test.sqlite');
  const rawDb = createV7Database(dbPath);

  const jobV7 = {
    id: 'job_prod_1',
    sourceUrl: 'https://www.youtube.com/watch?v=prod',
    sourceTitle: 'Prod Job',
    status: 'ready',
    progress: null,
    creatorProfileId: 'filipe_boni',
    creatorProfileSnapshot: {
      id: 'filipe_boni',
      displayName: 'Filipe Boni',
      enabled: true,
      render: { layoutPath: 'profiles/filipe_boni_layout.json', layoutId: 'screen-top-host-bottom-v2' },
      publish: {},
      schedule: { timeZone: 'America/Sao_Paulo', slots: ['12:00'] },
    },
    layoutProfileSnapshot: REAL_BONI_LAYOUT_V2,
    transcriptProvider: 'deepgram',
    media: null,
    transcriptWords: [],
    transcriptSentences: [],
    transcriptRevision: 1,
    semanticBlocks: [],
    strongSpeakers: [],
    chosenSpeakerId: null,
    hostFraming: { headBox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
    hostFramingAnalyzedAt: '2026-10-17T01:00:00.000Z',
    failedTaskKind: null,
    error: null,
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T01:05:00.000Z',
  };

  const shortV7 = {
    id: 'short_prod_1',
    jobId: 'job_prod_1',
    rank: 1,
    origin: 'planner',
    title: 'Prod Short',
    summary: 'Summary',
    rationale: 'Rationale',
    hook: 'Hook',
    payoff: 'Payoff',
    risk: 'low',
    arc: null,
    status: 'active',
    edit: {
      ranges: [{ startWord: 0, endWord: 5 }],
      removedWords: [],
      tightenPauses: { enabled: true, maxGapSeconds: 0.35 },
      speed: 1.5,
      hook: { enabled: false, text: '' },
      captions: { enabled: true },
      crops: [],
      zoom: { enabled: false, strength: 1.12 },
      endCard: { enabled: false },
    },
    editRevision: 1,
    cropAnalysis: 'none',
    cropAnalysisError: null,
    publishCopy: null,
    createdAt: '2026-10-17T01:10:00.000Z',
    updatedAt: '2026-10-17T01:10:00.000Z',
  };

  const readyExportV7 = {
    id: 'export_ready_1',
    jobId: 'job_prod_1',
    shortId: 'short_prod_1',
    editRevision: 1,
    transcriptRevision: 1,
    edit: shortV7.edit,
    title: 'Prod Short Title',
    hostFraming: { headBox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
    status: 'ready',
    artifactPath: '/var/data/shorts/artifacts/job_prod_1/exports/export_ready_1/short.mp4',
    coverPath: '/var/data/shorts/artifacts/job_prod_1/exports/export_ready_1/cover.jpg',
    sizeBytes: 15420000,
    durationSeconds: 45.2,
    error: null,
    createdAt: '2026-10-17T01:15:00.000Z',
    updatedAt: '2026-10-17T01:16:00.000Z',
  };

  const queuedExportV7 = {
    id: 'export_queued_1',
    jobId: 'job_prod_1',
    shortId: 'short_prod_1',
    editRevision: 1,
    transcriptRevision: 1,
    edit: shortV7.edit,
    title: 'Prod Short Title',
    hostFraming: null,
    status: 'queued',
    artifactPath: null,
    coverPath: null,
    sizeBytes: null,
    durationSeconds: null,
    error: null,
    createdAt: '2026-10-17T01:20:00.000Z',
    updatedAt: '2026-10-17T01:20:00.000Z',
  };

  const publicationV7 = {
    id: 'pub_booked_1',
    jobId: 'job_prod_1',
    shortId: 'short_prod_1',
    exportId: 'export_ready_1',
    platform: 'instagram',
    status: 'scheduled',
    forced: false,
    provider: 'buffer',
    batchId: null,
    remoteJobs: [{ platform: 'instagram', jobId: 'buffer_remote_99' }],
    remoteUrl: 'https://instagram.com/p/12345',
    submittedAt: '2026-10-17T02:00:00.000Z',
    scheduledFor: '2026-10-20T12:00:00.000Z',
    error: null,
    availableAt: null,
    createdAt: '2026-10-17T02:00:00.000Z',
    updatedAt: '2026-10-17T02:00:00.000Z',
  };

  rawDb.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)').run(jobV7.id, jobV7.status, jobV7.updatedAt, JSON.stringify(jobV7));
  rawDb.prepare('INSERT INTO shorts VALUES (?, ?, ?, ?, ?, ?)').run(shortV7.id, shortV7.jobId, shortV7.status, shortV7.rank, shortV7.updatedAt, JSON.stringify(shortV7));
  rawDb.prepare('INSERT INTO exports VALUES (?, ?, ?, ?, ?, ?)').run(readyExportV7.id, readyExportV7.jobId, readyExportV7.shortId, readyExportV7.status, readyExportV7.createdAt, JSON.stringify(readyExportV7));
  rawDb.prepare('INSERT INTO exports VALUES (?, ?, ?, ?, ?, ?)').run(queuedExportV7.id, queuedExportV7.jobId, queuedExportV7.shortId, queuedExportV7.status, queuedExportV7.createdAt, JSON.stringify(queuedExportV7));
  rawDb.prepare('INSERT INTO publications VALUES (?, ?, ?, ?, ?, ?, ?)').run(publicationV7.id, publicationV7.exportId, publicationV7.shortId, publicationV7.platform, publicationV7.status, publicationV7.createdAt, JSON.stringify(publicationV7));
  rawDb.close();

  const store = await ShortsStore.open(dbPath, { manifestPath: repoManifestPath });
  try {
    const readyExp = store.getExport('export_ready_1');
    assert.ok(readyExp);
    assert.equal(readyExp.layoutProfileSnapshot.version, 3);
    assert.equal(readyExp.layoutProfileSnapshot.strategy, 'fixed');
    assert.equal(readyExp.layoutProfileSnapshot.layoutId, 'screen-top-host-bottom-v2');
    assert.deepEqual(readyExp.layoutProfileSnapshot.safeArea, { top: 0, bottom: 0, side: 0 });
    assert.equal(readyExp.sceneTrack, null);
    assert.equal(readyExp.artifactPath, '/var/data/shorts/artifacts/job_prod_1/exports/export_ready_1/short.mp4');
    assert.equal(readyExp.coverPath, '/var/data/shorts/artifacts/job_prod_1/exports/export_ready_1/cover.jpg');
    assert.equal(readyExp.sizeBytes, 15420000);
    assert.equal(readyExp.durationSeconds, 45.2);
    assert.deepEqual(readyExp.hostFraming, { headBox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } });
    assert.equal(readyExp.status, 'ready');

    const queuedExp = store.getExport('export_queued_1');
    assert.ok(queuedExp);
    assert.equal(queuedExp.layoutProfileSnapshot.version, 3);
    assert.equal(queuedExp.layoutProfileSnapshot.strategy, 'fixed');
    assert.equal(queuedExp.sceneTrack, null);
    assert.equal(queuedExp.status, 'queued');

    const pub = store.getPublication('pub_booked_1');
    assert.ok(pub);
    assert.equal(pub.status, 'scheduled');
    assert.equal(pub.scheduledFor, '2026-10-20T12:00:00.000Z');
    assert.deepEqual(pub.remoteJobs, [{ platform: 'instagram', jobId: 'buffer_remote_99' }]);
    assert.equal(pub.remoteUrl, 'https://instagram.com/p/12345');
    assert.equal(pub.provider, 'buffer');
  } finally {
    store.close();
  }
});

test('v8 rollback leaves version and all payloads unchanged on an unmappable publisher or orphan export', async (t) => {
  const dir = await createTempDir(t);

  const unmappablePath = join(dir, 'unmappable.sqlite');
  const rawDb1 = createV7Database(unmappablePath);
  const unmappableJob = {
    id: 'job_bad_pub',
    sourceUrl: 'https://youtube.com/watch?v=1',
    status: 'ready',
    creatorProfileId: 'unknown_channel',
    creatorProfileSnapshot: {
      id: 'unknown_channel',
      displayName: 'Unknown',
      enabled: true,
      render: { layoutPath: 'profiles/filipe_boni_layout.json', layoutId: 'screen-top-host-bottom-v2' },
      publish: { instagram: { mode: 'global' } },
      schedule: { timeZone: 'America/Sao_Paulo', slots: ['12:00'] },
    },
    layoutProfileSnapshot: REAL_BONI_LAYOUT_V2,
    transcriptRevision: 0,
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
  };
  const originalPayload1 = JSON.stringify(unmappableJob);
  rawDb1.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)').run(unmappableJob.id, unmappableJob.status, unmappableJob.updatedAt, originalPayload1);
  rawDb1.close();

  await assert.rejects(
    () => ShortsStore.open(unmappablePath, { manifestPath: repoManifestPath }),
    /Cannot map legacy publishing creator unknown_channel to an account\./,
  );

  const inspectDb1 = new DatabaseSync(unmappablePath);
  try {
    const ver = inspectDb1.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(ver.user_version, 7);
    const row = inspectDb1.prepare('SELECT payload_json FROM jobs WHERE id = ?').get('job_bad_pub') as { payload_json: string };
    assert.equal(row.payload_json, originalPayload1);
  } finally {
    inspectDb1.close();
  }

  const orphanPath = join(dir, 'orphan.sqlite');
  const rawDb2 = createV7Database(orphanPath);
  const orphanExport = {
    id: 'export_orphan',
    jobId: 'job_missing',
    shortId: 'short_x',
    editRevision: 1,
    transcriptRevision: 0,
    edit: {
      ranges: [{ startWord: 0, endWord: 1 }],
      removedWords: [],
      tightenPauses: { enabled: false, maxGapSeconds: 0.35 },
      speed: 1.0,
      hook: { enabled: false, text: '' },
      captions: { enabled: false },
      crops: [],
      zoom: { enabled: false, strength: 1.12 },
      endCard: { enabled: false },
    },
    title: 'Orphan',
    hostFraming: null,
    status: 'ready',
    artifactPath: null,
    coverPath: null,
    sizeBytes: null,
    durationSeconds: null,
    error: null,
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
  };
  const originalExportPayload = JSON.stringify(orphanExport);
  rawDb2.prepare('INSERT INTO exports VALUES (?, ?, ?, ?, ?, ?)').run(orphanExport.id, orphanExport.jobId, orphanExport.shortId, orphanExport.status, orphanExport.createdAt, originalExportPayload);
  rawDb2.close();

  await assert.rejects(
    () => ShortsStore.open(orphanPath, { manifestPath: repoManifestPath }),
    /Orphan export export_orphan has no matching job/,
  );

  const inspectDb2 = new DatabaseSync(orphanPath);
  try {
    const ver = inspectDb2.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(ver.user_version, 7);
    const row = inspectDb2.prepare('SELECT payload_json FROM exports WHERE id = ?').get('export_orphan') as { payload_json: string };
    assert.equal(row.payload_json, originalExportPayload);
  } finally {
    inspectDb2.close();
  }
});

test('v7 migration requires a creator manifest and leaves the database untouched without one', async (t) => {
  const dir = await createTempDir(t);
  const dbPath = join(dir, 'no-manifest.sqlite');
  const payload = createV7DatabaseWithJob(dbPath);

  await assert.rejects(() => ShortsStore.open(dbPath), /is at schema version 7 and needs a creator manifest to migrate to version 8\./);
  assertV7Untouched(dbPath, payload);
});

test('v7 migration rejects a missing creator manifest before writing anything', async (t) => {
  const dir = await createTempDir(t);
  const dbPath = join(dir, 'missing-manifest.sqlite');
  const payload = createV7DatabaseWithJob(dbPath);

  await assert.rejects(
    () => ShortsStore.open(dbPath, { manifestPath: join(dir, 'creator-profiles.json') }),
    /Creator manifest not found at /,
  );
  assertV7Untouched(dbPath, payload);
});

test('v7 migration rejects malformed creator manifests before writing anything', async (t) => {
  const cases: Array<{ name: string; content: string; message: RegExp }> = [
    { name: 'invalid JSON', content: '{ "accounts": [', message: /is not valid JSON:/ },
    { name: 'missing accounts', content: JSON.stringify({ creators: [{ id: 'filipe_boni', accountId: null }] }), message: /has no accounts array\./ },
    { name: 'missing creators', content: JSON.stringify({ accounts: [{ id: 'mix' }] }), message: /has no creators array\./ },
    { name: 'empty creators', content: JSON.stringify({ accounts: [{ id: 'mix' }], creators: [] }), message: /has an empty creators array\./ },
    { name: 'account without id', content: JSON.stringify({ accounts: [{ displayName: 'Mix' }], creators: [{ id: 'filipe_boni', accountId: null }] }), message: /has an account without a string id\./ },
    { name: 'creator without id', content: JSON.stringify({ accounts: [{ id: 'mix' }], creators: [{ accountId: 'mix' }] }), message: /has a creator without a string id\./ },
    { name: 'duplicate creator', content: JSON.stringify({ accounts: [{ id: 'mix' }], creators: [{ id: 'filipe_boni', accountId: null }, { id: 'filipe_boni', accountId: 'mix' }] }), message: /lists creator filipe_boni more than once\./ },
    { name: 'non-string accountId', content: JSON.stringify({ accounts: [{ id: 'mix' }], creators: [{ id: 'filipe_boni', accountId: 42 }] }), message: /has creator filipe_boni without a string or null accountId\./ },
    { name: 'undeclared account', content: JSON.stringify({ accounts: [{ id: 'mix' }], creators: [{ id: 'filipe_boni', accountId: 'ghost' }] }), message: /maps creator filipe_boni to undeclared account ghost\./ },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const dir = await createTempDir(subtest);
      const dbPath = join(dir, 'malformed.sqlite');
      const payload = createV7DatabaseWithJob(dbPath);
      const manifestPath = join(dir, 'creator-profiles.json');
      await writeFile(manifestPath, entry.content);

      await assert.rejects(() => ShortsStore.open(dbPath, { manifestPath }), entry.message);
      assertV7Untouched(dbPath, payload);
    });
  }
});

test('reopening v8 does not rewrite scene tracks or manual layout edits', async (t) => {
  const dir = await createTempDir(t);
  const dbPath = join(dir, 'test.sqlite');
  const rawDb = new DatabaseSync(dbPath);
  rawDb.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE shorts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL, rank INTEGER NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE exports (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, short_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE publications (id TEXT PRIMARY KEY, export_id TEXT NOT NULL, short_id TEXT NOT NULL, platform TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE queue_tasks (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, available_at TEXT, started_at TEXT, error TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE actions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE autopilot_videos (creator_id TEXT NOT NULL, video_id TEXT NOT NULL, status TEXT NOT NULL, detected_at TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY (creator_id, video_id));
    PRAGMA user_version = 8;
  `);

  const realSceneTrack: SceneTrack = {
    version: 1,
    analyzedAt: '2026-10-19T10:00:00.000Z',
    frame: { width: 1920, height: 1080 },
    segments: [
      {
        startSeconds: 0,
        endSeconds: 15.5,
        host: { camera: { x: 0.6, y: 0.5, w: 0.35, h: 0.45 }, head: { x: 0.7, y: 0.55, w: 0.15, h: 0.2 } },
        content: { box: { x: 0, y: 0, w: 0.6, h: 1 }, kind: 'document', vertical: false, subject: { x: 0.1, y: 0.1, w: 0.4, h: 0.8 } },
        overlays: [],
      },
    ],
  };

  const scenesLayout: ScenesLayoutProfile = {
    version: 3,
    strategy: 'scenes',
    layoutId: 'mix-scenes-v3',
    canvas: { width: 1080, height: 1920, fps: 30 },
    background: '#101010',
    font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
    hookBand: { rect: { x: 0, y: 0, w: 1, h: 0.1146 }, background: '#C8102E', textColor: '#FFFFFF', sizePx: 58, maxCharsPerLine: 24, maxLines: 2, uppercase: true },
    captions: { sizePx: 62, textColor: '#FFFFFF', highlightColor: '#FFD400', outlineColor: '#000000', outlinePx: 6, shadowPx: 2, uppercase: true, maxWordsPerCue: 4, maxCharsPerLine: 16, maxLines: 2, centerY: 0.5521 },
    safeArea: { top: 0.135, bottom: 0.17, side: 0.055 },
    scene: { captionCenterY: { host: 0.72, content: 0.78 } },
  };

  const jobV8 = {
    id: 'job_scene_1',
    sourceUrl: 'https://youtube.com/watch?v=mix1',
    sourceTitle: 'Mix Job',
    status: 'ready',
    progress: null,
    creatorProfileId: 'samuel_borelli',
    creatorProfileSnapshot: {
      id: 'samuel_borelli',
      displayName: 'Samuel Borelli',
      enabled: true,
      accountId: 'mix',
      render: { layoutPath: 'profiles/mix_layout.json', layoutId: 'mix-scenes-v3', defaultSpeed: 1.25, scene: { hostDescription: 'Samuel', hints: null } },
    },
    layoutProfileSnapshot: scenesLayout,
    transcriptProvider: 'deepgram',
    media: { videoPath: '/tmp/v.mp4', audioPath: '/tmp/a.m4a', thumbnailPath: null, width: 1920, height: 1080, fps: 30, durationSeconds: 60 },
    transcriptWords: [],
    transcriptSentences: [],
    transcriptRevision: 0,
    semanticBlocks: [],
    strongSpeakers: [],
    chosenSpeakerId: null,
    hostFraming: null,
    hostFramingAnalyzedAt: null,
    sceneTrack: realSceneTrack,
    sceneAnalysis: 'done',
    sceneAnalysisError: null,
    failedTaskKind: null,
    error: null,
    createdAt: '2026-10-19T09:00:00.000Z',
    updatedAt: '2026-10-19T10:05:00.000Z',
  };

  const shortV8 = {
    id: 'short_scene_1',
    jobId: 'job_scene_1',
    rank: 1,
    origin: 'planner',
    title: 'Manual Layout Short',
    summary: 'Summary',
    rationale: 'Rationale',
    hook: 'Hook',
    payoff: 'Payoff',
    risk: 'low',
    arc: null,
    status: 'active',
    edit: {
      ranges: [{ startWord: 0, endWord: 20 }],
      removedWords: [],
      tightenPauses: { enabled: true, maxGapSeconds: 0.35 },
      speed: 1.25,
      hook: { enabled: true, text: 'Custom Hook' },
      captions: { enabled: true },
      crops: [],
      zoom: { enabled: false, strength: 1.12 },
      endCard: { enabled: false },
      layout: {
        split: 0.52,
        overrides: [{ sourceSeconds: 5, composition: 'host' as const }],
      },
    },
    editRevision: 3,
    cropAnalysis: 'none',
    cropAnalysisError: null,
    publishCopy: null,
    createdAt: '2026-10-19T10:10:00.000Z',
    updatedAt: '2026-10-19T10:15:00.000Z',
  };

  const exportV8 = {
    id: 'export_scene_1',
    jobId: 'job_scene_1',
    shortId: 'short_scene_1',
    editRevision: 3,
    transcriptRevision: 0,
    edit: shortV8.edit,
    title: 'Export Manual',
    hostFraming: null,
    layoutProfileSnapshot: scenesLayout,
    sceneTrack: realSceneTrack,
    status: 'queued',
    artifactPath: null,
    coverPath: null,
    sizeBytes: null,
    durationSeconds: null,
    error: null,
    createdAt: '2026-10-19T10:20:00.000Z',
    updatedAt: '2026-10-19T10:20:00.000Z',
  };

  const jobJsonBefore = JSON.stringify(jobV8);
  const shortJsonBefore = JSON.stringify(shortV8);
  const exportJsonBefore = JSON.stringify(exportV8);

  rawDb.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)').run(jobV8.id, jobV8.status, jobV8.updatedAt, jobJsonBefore);
  rawDb.prepare('INSERT INTO shorts VALUES (?, ?, ?, ?, ?, ?)').run(shortV8.id, shortV8.jobId, shortV8.status, shortV8.rank, shortV8.updatedAt, shortJsonBefore);
  rawDb.prepare('INSERT INTO exports VALUES (?, ?, ?, ?, ?, ?)').run(exportV8.id, exportV8.jobId, exportV8.shortId, exportV8.status, exportV8.createdAt, exportJsonBefore);
  rawDb.close();

  const store = await ShortsStore.open(dbPath, { manifestPath: repoManifestPath });
  store.close();

  const verifyDb = new DatabaseSync(dbPath);
  try {
    const jobRow = verifyDb.prepare('SELECT payload_json FROM jobs WHERE id = ?').get('job_scene_1') as { payload_json: string };
    const shortRow = verifyDb.prepare('SELECT payload_json FROM shorts WHERE id = ?').get('short_scene_1') as { payload_json: string };
    const exportRow = verifyDb.prepare('SELECT payload_json FROM exports WHERE id = ?').get('export_scene_1') as { payload_json: string };

    assert.equal(jobRow.payload_json, jobJsonBefore);
    assert.equal(shortRow.payload_json, shortJsonBefore);
    assert.equal(exportRow.payload_json, exportJsonBefore);
  } finally {
    verifyDb.close();
  }
});

test('older supported migrations still reach v8 and future versions fail clearly', async (t) => {
  const dir = await createTempDir(t);
  const dbPath = join(dir, 'v2.sqlite');
  const rawDb = new DatabaseSync(dbPath);
  rawDb.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE shorts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL, rank INTEGER NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE exports (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, short_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE publications (id TEXT PRIMARY KEY, export_id TEXT NOT NULL, short_id TEXT NOT NULL, platform TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE queue_tasks (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, available_at TEXT, started_at TEXT, error TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE actions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE autopilot_videos (creator_id TEXT NOT NULL, video_id TEXT NOT NULL, status TEXT NOT NULL, detected_at TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY (creator_id, video_id));
    PRAGMA user_version = 2;
  `);

  const jobV2 = {
    id: 'job_v2_1',
    sourceUrl: 'https://youtube.com/watch?v=old',
    status: 'ready',
    creatorProfileId: 'filipe_boni',
    creatorProfileSnapshot: {
      id: 'filipe_boni',
      displayName: 'Filipe Boni',
      enabled: true,
      render: { layoutPath: 'profiles/filipe_boni_layout.json', layoutId: 'screen-top-host-bottom-v2' },
      publish: { instagram: { mode: 'global' } },
    },
    layoutProfileSnapshot: REAL_BONI_LAYOUT_V2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const exportV2 = {
    id: 'export_v2_1',
    jobId: 'job_v2_1',
    shortId: 'short_v2_1',
    editRevision: 0,
    edit: {
      ranges: [{ startWord: 0, endWord: 5 }],
      removedWords: [],
      tightenPauses: { enabled: false, maxGapSeconds: 0.35 },
      speed: 1.0,
      hook: { enabled: false, text: '' },
      captions: { enabled: false },
      crops: [],
      zoom: { enabled: false, strength: 1.12 },
      endCard: { enabled: false },
    },
    title: 'V2 Export',
    status: 'ready',
    artifactPath: '/tmp/art.mp4',
    sizeBytes: 100,
    durationSeconds: 10,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  rawDb.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)').run(jobV2.id, jobV2.status, jobV2.updatedAt, JSON.stringify(jobV2));
  rawDb.prepare('INSERT INTO exports VALUES (?, ?, ?, ?, ?, ?)').run(exportV2.id, exportV2.jobId, exportV2.shortId, exportV2.status, exportV2.createdAt, JSON.stringify(exportV2));
  rawDb.close();

  const store = await ShortsStore.open(dbPath, { manifestPath: repoManifestPath });
  try {
    const job = store.getJob('job_v2_1');
    assert.ok(job);
    assert.equal(job.transcriptRevision, 0);
    assert.equal(job.creatorProfileSnapshot.accountId, 'cortes_do_boni');
    assert.equal(job.creatorProfileSnapshot.render.defaultSpeed, 1.35);
    assert.equal(job.layoutProfileSnapshot.version, 3);
    assert.equal(job.layoutProfileSnapshot.strategy, 'fixed');

    const exp = store.getExport('export_v2_1');
    assert.ok(exp);
    assert.equal(exp.transcriptRevision, 0);
    assert.equal(exp.coverPath, null);
    assert.equal(exp.layoutProfileSnapshot.version, 3);
    assert.equal(exp.layoutProfileSnapshot.strategy, 'fixed');
    assert.deepEqual(exp.edit.layout, { split: null, overrides: [] });
  } finally {
    store.close();
  }

  const futurePath = join(dir, 'future.sqlite');
  const futureDb = new DatabaseSync(futurePath);
  futureDb.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version = 9;
  `);
  futureDb.close();

  await assert.rejects(
    () => ShortsStore.open(futurePath),
    /Incompatible database/,
  );
});

test('startup queues missing scenes once and never queues host detection for scenes', async (t) => {
  const dir = await createTempDir(t);
  const dbPath = join(dir, 'backfill.sqlite');
  const store = await ShortsStore.open(dbPath, { manifestPath: repoManifestPath });

  const scenesLayout: ScenesLayoutProfile = {
    version: 3,
    strategy: 'scenes',
    layoutId: 'mix-scenes-v3',
    canvas: { width: 1080, height: 1920, fps: 30 },
    background: '#101010',
    font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
    hookBand: { rect: { x: 0, y: 0, w: 1, h: 0.1146 }, background: '#C8102E', textColor: '#FFFFFF', sizePx: 58, maxCharsPerLine: 24, maxLines: 2, uppercase: true },
    captions: { sizePx: 62, textColor: '#FFFFFF', highlightColor: '#FFD400', outlineColor: '#000000', outlinePx: 6, shadowPx: 2, uppercase: true, maxWordsPerCue: 4, maxCharsPerLine: 16, maxLines: 2, centerY: 0.5521 },
    safeArea: { top: 0.135, bottom: 0.17, side: 0.055 },
    scene: { captionCenterY: { host: 0.72, content: 0.78 } },
  };

  const fixedLayout: FixedLayoutProfile = {
    version: 3,
    strategy: 'fixed',
    layoutId: 'screen-top-host-bottom-v2',
    canvas: { width: 1080, height: 1920, fps: 30 },
    background: '#101010',
    font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
    panels: [
      { id: 'screen', role: 'content', sourceRect: { x: 0, y: 0, w: 0.632, h: 1 }, canvasRect: { x: 0, y: 0.1146, w: 1, h: 0.4375 } },
      { id: 'host', role: 'host', sourceRect: { x: 0.637, y: 0, w: 0.363, h: 1 }, canvasRect: { x: 0, y: 0.5521, w: 1, h: 0.4479 }, anchor: { x: 0.5, y: 0.42 } },
    ],
    hookBand: null,
    captions: { sizePx: 62, textColor: '#FFFFFF', highlightColor: '#FFD400', outlineColor: '#000000', outlinePx: 6, shadowPx: 2, uppercase: true, maxWordsPerCue: 4, maxCharsPerLine: 16, maxLines: 2, centerY: 0.5521 },
    safeArea: { top: 0.135, bottom: 0.17, side: 0.055 },
  };

  const media = { videoPath: '/tmp/v.mp4', audioPath: '/tmp/a.m4a', thumbnailPath: null, width: 1920, height: 1080, fps: 30, durationSeconds: 60 };

  const job1ScenesNone = {
    id: 'job_scenes_none',
    sourceUrl: 'https://youtube.com/watch?v=1',
    sourceTitle: 'Scenes 1',
    status: 'ready' as const,
    progress: null,
    creatorProfileId: 'samuel_borelli',
    creatorProfileSnapshot: {
      id: 'samuel_borelli',
      displayName: 'Samuel Borelli',
      enabled: true,
      accountId: 'mix',
      render: { layoutPath: 'profiles/mix_layout.json', layoutId: 'mix-scenes-v3', defaultSpeed: 1.25, scene: { hostDescription: 'Samuel', hints: null } },
    },
    layoutProfileSnapshot: scenesLayout,
    transcriptProvider: 'deepgram' as const,
    media,
    transcriptWords: [],
    transcriptSentences: [],
    transcriptRevision: 0,
    semanticBlocks: [],
    strongSpeakers: [],
    chosenSpeakerId: null,
    hostFraming: null,
    hostFramingAnalyzedAt: null,
    sceneTrack: null,
    sceneAnalysis: 'none' as const,
    sceneAnalysisError: null,
    failedTaskKind: null,
    error: null,
    createdAt: '2026-10-19T10:00:00.000Z',
    updatedAt: '2026-10-19T10:00:00.000Z',
  };

  const job2ScenesFailed = {
    ...job1ScenesNone,
    id: 'job_scenes_failed',
    sceneAnalysis: 'failed' as const,
    sceneAnalysisError: 'Previous vision failure',
  };

  const job3Fixed = {
    ...job1ScenesNone,
    id: 'job_fixed_missing_host',
    creatorProfileId: 'filipe_boni',
    creatorProfileSnapshot: {
      id: 'filipe_boni',
      displayName: 'Filipe Boni',
      enabled: true,
      accountId: 'cortes_do_boni',
      render: { layoutPath: 'profiles/filipe_boni_layout.json', layoutId: 'screen-top-host-bottom-v2', defaultSpeed: 1.5, scene: null },
    },
    layoutProfileSnapshot: fixedLayout,
  };

  const job4ScenesAlreadyQueued = {
    ...job1ScenesNone,
    id: 'job_scenes_already_queued',
    sceneAnalysis: 'queued' as const,
  };

  store.createJob(job1ScenesNone);
  store.createJob(job2ScenesFailed);
  store.createJob(job3Fixed);
  store.createJob(job4ScenesAlreadyQueued);

  store.enqueueTask(job4ScenesAlreadyQueued.id, 'analyze_scenes', {});

  store.requeueRunningTasks();
  store.enqueueMissingHostHeadAnalyses();
  store.enqueueMissingSceneAnalyses();

  const rawDb = new DatabaseSync(dbPath);
  try {
    const tasks = rawDb.prepare('SELECT job_id, kind, status FROM queue_tasks ORDER BY created_at ASC').all() as Array<{ job_id: string; kind: string; status: string }>;

    assert.equal(tasks.filter((t) => t.job_id === 'job_scenes_none' && t.kind === 'analyze_scenes').length, 1);
    assert.equal(tasks.filter((t) => t.job_id === 'job_scenes_none' && t.kind === 'analyze_host').length, 0);

    assert.equal(tasks.filter((t) => t.job_id === 'job_scenes_failed').length, 0);

    assert.equal(tasks.filter((t) => t.job_id === 'job_fixed_missing_host' && t.kind === 'analyze_host').length, 1);
    assert.equal(tasks.filter((t) => t.job_id === 'job_fixed_missing_host' && t.kind === 'analyze_scenes').length, 0);

    assert.equal(tasks.filter((t) => t.job_id === 'job_scenes_already_queued' && t.kind === 'analyze_scenes').length, 1);
    assert.equal(tasks.filter((t) => t.job_id === 'job_scenes_already_queued' && t.kind === 'analyze_host').length, 0);

    const reloadedJob1 = store.getJob('job_scenes_none');
    assert.ok(reloadedJob1);
    assert.equal(reloadedJob1.sceneAnalysis, 'queued');
  } finally {
    rawDb.close();
    store.close();
  }
});
