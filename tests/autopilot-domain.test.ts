import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOPILOT_LIVE_STATUSES_TO_SKIP, autopilotShortPlan, exportMatchesShort, isAutopilotEligibleUpload, orderReadyShorts, type AutopilotShortPlan } from '../src/domain/autopilot.js';
import { createInitialEdit, type WordRange } from '../src/domain/edit.js';
import type { LayoutProfile } from '../src/domain/layout.js';
import type { AutopilotVideoRecord, CreatorAutopilotConfig, CreatorProfile, ExportRecord, JobRecord, PublicationRecord, ShortRecord, TranscriptWord } from '../src/domain/model.js';

const DETECTED_AT = '2026-10-18T12:00:00.000Z';
const NOW = new Date('2026-10-18T13:00:00.000Z');

const CONFIG: CreatorAutopilotConfig = {
  channelUrl: 'https://www.youtube.com/@filipe_boni/videos',
  shortsPerVideo: 2,
  platforms: ['instagram', 'tiktok'],
  reviewWindowHours: 3,
  bookingHorizonHours: 24,
  maxShortAgeHours: 48,
  minVideoSeconds: 480,
};

const PROFILE: CreatorProfile = {
  id: 'filipe_boni',
  displayName: 'Filipe Boni',
  enabled: true,
  render: { layoutPath: 'profiles/filipe_boni_layout.json', layoutId: 'screen-top-host-bottom-v2' },
  publish: { instagram: { mode: 'global' }, tiktok: { mode: 'global' }, youtube_shorts: { mode: 'global' } },
  schedule: { timeZone: 'America/Sao_Paulo', slots: ['12:00', '19:00', '21:00'] },
  autopilot: CONFIG,
};

const WORDS: TranscriptWord[] = 'um dois tres quatro cinco seis sete oito nove dez'.split(' ').map((text, index) => ({
  id: `w_${index}`,
  text,
  startSeconds: index * 0.5,
  endSeconds: index * 0.5 + 0.45,
  speakerId: 'speaker_0',
  confidence: null,
}));

const RANGE: WordRange = { startWord: 0, endWord: 4 };

function layoutSnapshot(): LayoutProfile {
  return { creatorId: PROFILE.id, layoutId: PROFILE.render.layoutId } as unknown as LayoutProfile;
}

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job_1',
    sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    sourceTitle: 'Video longo',
    status: 'ready',
    progress: null,
    creatorProfileId: PROFILE.id,
    creatorProfileSnapshot: PROFILE,
    layoutProfileSnapshot: layoutSnapshot(),
    transcriptProvider: 'deepgram',
    media: null,
    transcriptWords: WORDS,
    transcriptSentences: [],
    transcriptRevision: 0,
    semanticBlocks: [],
    strongSpeakers: [],
    chosenSpeakerId: null,
    hostFraming: null,
    hostFramingAnalyzedAt: DETECTED_AT,
    failedTaskKind: null,
    error: null,
    createdAt: DETECTED_AT,
    updatedAt: DETECTED_AT,
    ...overrides,
  };
}

function makeVideo(overrides: Partial<AutopilotVideoRecord> = {}): AutopilotVideoRecord {
  return {
    creatorId: PROFILE.id,
    videoId: 'vid_1',
    title: 'Video longo',
    status: 'tracked',
    jobId: 'job_1',
    detectedAt: DETECTED_AT,
    retries: 0,
    lastRetryAt: null,
    ...overrides,
  };
}

function makeShort(rank: number, overrides: Partial<ShortRecord> = {}): ShortRecord {
  return {
    id: `short_${rank}`,
    jobId: 'job_1',
    rank,
    origin: 'planner',
    title: `Short ${rank}`,
    summary: `Resumo ${rank}`,
    rationale: '',
    hook: '',
    payoff: '',
    risk: 'low',
    arc: null,
    status: 'active',
    edit: createInitialEdit({ ranges: [RANGE], words: WORDS, speed: 1, hookText: 'MANCHETE' }),
    editRevision: 1,
    cropAnalysis: 'done',
    cropAnalysisError: null,
    publishCopy: { line1: 'linha um', line2: 'linha dois', hashtags: ['#um', '#dois', '#tres'] },
    createdAt: DETECTED_AT,
    updatedAt: DETECTED_AT,
    ...overrides,
  };
}

function makeExport(short: ShortRecord, overrides: Partial<ExportRecord> = {}): ExportRecord {
  return {
    id: `export_${short.id}`,
    jobId: short.jobId,
    shortId: short.id,
    editRevision: short.editRevision,
    transcriptRevision: 0,
    edit: short.edit,
    title: short.title,
    hostFraming: null,
    status: 'ready',
    artifactPath: null,
    coverPath: null,
    sizeBytes: null,
    durationSeconds: null,
    error: null,
    createdAt: DETECTED_AT,
    updatedAt: DETECTED_AT,
    ...overrides,
  };
}

let publicationCounter = 0;

function makePublication(short: ShortRecord, overrides: Partial<PublicationRecord> = {}): PublicationRecord {
  publicationCounter += 1;
  return {
    id: `pub_${publicationCounter}`,
    jobId: short.jobId,
    shortId: short.id,
    exportId: `export_${short.id}`,
    platform: 'instagram',
    status: 'scheduled',
    forced: false,
    provider: 'mallary',
    batchId: null,
    remoteJobs: [],
    remoteUrl: null,
    submittedAt: null,
    scheduledFor: '2026-10-18T19:00:00.000Z',
    error: null,
    availableAt: null,
    createdAt: DETECTED_AT,
    updatedAt: DETECTED_AT,
    ...overrides,
  };
}

interface PlanOptions {
  exports?: ExportRecord[];
  publications?: PublicationRecord[];
  video?: AutopilotVideoRecord;
  config?: CreatorAutopilotConfig;
  now?: Date;
  hasHostPanel?: boolean;
}

function planFor(shorts: ShortRecord[], job: JobRecord = makeJob(), options: PlanOptions = {}): AutopilotShortPlan[] {
  return autopilotShortPlan({
    video: options.video ?? makeVideo(),
    job,
    shorts,
    exports: options.exports ?? shorts.map((short) => makeExport(short)),
    publications: options.publications ?? [],
    config: options.config ?? CONFIG,
    now: options.now ?? NOW,
    hasHostPanel: options.hasHostPanel ?? true,
  });
}

test('isAutopilotEligibleUpload checks duration and live status', () => {
  assert.equal(isAutopilotEligibleUpload({ durationSeconds: 600, liveStatus: 'not_live' }, CONFIG), true);
  assert.equal(isAutopilotEligibleUpload({ durationSeconds: 480, liveStatus: null }, CONFIG), true);
  assert.equal(isAutopilotEligibleUpload({ durationSeconds: 479.9, liveStatus: null }, CONFIG), false);
  assert.equal(isAutopilotEligibleUpload({ durationSeconds: null, liveStatus: null }, CONFIG), false);
  assert.equal(isAutopilotEligibleUpload({ durationSeconds: 600, liveStatus: 'is_upcoming' }, CONFIG), false);
  assert.equal(isAutopilotEligibleUpload({ durationSeconds: 600, liveStatus: 'is_live' }, CONFIG), false);
  assert.equal('is_upcoming' in AUTOPILOT_LIVE_STATUSES_TO_SKIP, true);
});

test('exportMatchesShort compares revision, title, transcript revision, and host framing', () => {
  const job = makeJob();
  const short = makeShort(1);
  assert.equal(exportMatchesShort(makeExport(short), short, job), true);
  assert.equal(exportMatchesShort(makeExport(short, { editRevision: 2 }), short, job), false);
  assert.equal(exportMatchesShort(makeExport(short, { title: 'Outro' }), short, job), false);
  assert.equal(exportMatchesShort(makeExport(short, { transcriptRevision: 1 }), short, job), false);
  assert.equal(exportMatchesShort(makeExport(short, { hostFraming: { headBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } }), short, job), false);
  const framedJob = makeJob({ hostFraming: { headBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } });
  assert.equal(exportMatchesShort(makeExport(short, { hostFraming: { headBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } }), short, framedJob), true);
});

test('ineligible shorts are skipped and the next ranks replace them', () => {
  const shorts = [
    makeShort(1, { risk: 'high' }),
    makeShort(2, { cropAnalysis: 'failed' }),
    makeShort(3, { cropAnalysis: 'done' }),
    makeShort(4),
    makeShort(5),
  ];
  const exportsForShorts = [
    makeExport(shorts[2], { status: 'failed' }),
    makeExport(shorts[3]),
    makeExport(shorts[4]),
  ];
  const plans = planFor(shorts, makeJob(), { exports: exportsForShorts });
  assert.deepEqual(plans.map((entry) => [entry.short.rank, entry.state, entry.reason]), [
    [1, 'skipped', 'High risk: review it yourself'],
    [2, 'skipped', 'Crop analysis failed'],
    [3, 'skipped', 'Export failed'],
    [4, 'ready', null],
    [5, 'ready', null],
  ]);
});

test('rejected shorts are not candidates and ineligible shorts below the last selection are not reported', () => {
  const shorts = [makeShort(1), makeShort(2), makeShort(3, { risk: 'high' }), makeShort(4, { status: 'rejected', risk: 'high' })];
  const plans = planFor(shorts);
  assert.deepEqual(plans.map((entry) => entry.short.rank), [1, 2]);
});

test('any publication counts toward shortsPerVideo', () => {
  const shorts = [makeShort(1), makeShort(2)];
  const plans = planFor(shorts, makeJob(), {
    exports: [makeExport(shorts[1])],
    publications: [makePublication(shorts[0])],
  });
  assert.deepEqual(plans.map((entry) => [entry.short.rank, entry.state]), [[1, 'booked'], [2, 'ready']]);
  assert.equal(plans[0].scheduledFor, '2026-10-18T19:00:00.000Z');
});

test('a rejected short with publications counts as used and stays booked', () => {
  const shorts = [makeShort(1, { status: 'rejected' }), makeShort(2), makeShort(3)];
  const plans = planFor(shorts, makeJob(), {
    exports: [makeExport(shorts[1])],
    publications: [makePublication(shorts[0], { status: 'scheduled' })],
  });
  assert.deepEqual(plans.map((entry) => [entry.short.rank, entry.state, entry.reason]), [
    [1, 'booked', null],
    [2, 'ready', null],
  ]);
});

test('failed publications skip the short with the first error as the reason', () => {
  const short = makeShort(1);
  const plans = planFor([short], makeJob(), {
    exports: [],
    publications: [
      makePublication(short, { id: 'pub_fail_a', status: 'failed', error: 'Mallary rejected the video', scheduledFor: '2026-10-18T19:00:00.000Z' }),
      makePublication(short, { id: 'pub_fail_b', status: 'failed', error: 'Second failure', scheduledFor: null }),
    ],
  });
  assert.deepEqual([plans[0].state, plans[0].reason, plans[0].scheduledFor], ['skipped', 'Posting failed: Mallary rejected the video', null]);
});

test('booked keeps the earliest non-cancelled publication start', () => {
  const short = makeShort(1);
  const plans = planFor([short], makeJob(), {
    exports: [],
    publications: [
      makePublication(short, { id: 'pub_a', status: 'cancelled', scheduledFor: '2026-10-18T19:00:00.000Z' }),
      makePublication(short, { id: 'pub_b', status: 'scheduled', scheduledFor: '2026-10-19T12:00:00.000Z' }),
      makePublication(short, { id: 'pub_c', status: 'published', scheduledFor: '2026-10-18T22:00:00.000Z' }),
    ],
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].state, 'booked');
  assert.equal(plans[0].scheduledFor, '2026-10-18T22:00:00.000Z');
});

test('an all-cancelled short is skipped and not replaced', () => {
  const shorts = [makeShort(1), makeShort(2), makeShort(3)];
  const plans = planFor(shorts, makeJob(), {
    exports: [makeExport(shorts[1])],
    publications: [makePublication(shorts[0], { status: 'cancelled' })],
  });
  assert.deepEqual(plans.map((entry) => [entry.short.rank, entry.state, entry.reason]), [
    [1, 'skipped', 'Cancelled in the studio'],
    [2, 'ready', null],
  ]);
});

test('shorts expire after maxShortAgeHours from detection', () => {
  const short = makeShort(1);
  const stillValid = planFor([short], makeJob(), { now: new Date(Date.parse(DETECTED_AT) + CONFIG.maxShortAgeHours * 3_600_000) });
  assert.equal(stillValid[0].state, 'ready');
  const expired = planFor([short], makeJob(), { now: new Date(Date.parse(DETECTED_AT) + CONFIG.maxShortAgeHours * 3_600_000 + 1) });
  assert.deepEqual([expired[0].state, expired[0].reason, expired[0].readyExportId], ['expired', null, null]);
});

test('shorts wait while crops or host framing are pending', () => {
  const cropsQueued = planFor([makeShort(1, { cropAnalysis: 'queued' })]);
  assert.equal(cropsQueued[0].state, 'waiting');
  const cropsRunning = planFor([makeShort(1, { cropAnalysis: 'running' })]);
  assert.equal(cropsRunning[0].state, 'waiting');
  const hostPending = planFor([makeShort(1)], makeJob({ hostFramingAnalyzedAt: null }));
  assert.equal(hostPending[0].state, 'waiting');
  const noHostPanel = planFor([makeShort(1)], makeJob({ hostFramingAnalyzedAt: null }), { hasHostPanel: false });
  assert.equal(noHostPanel[0].state, 'ready');
});

test('exporting sets the copy and export flags independently', () => {
  const job = makeJob();
  const short = makeShort(1);
  const missingBoth = planFor([makeShort(1, { publishCopy: null })], job, { exports: [makeExport(makeShort(1), { status: 'failed', editRevision: 9 })] });
  assert.deepEqual([missingBoth[0].state, missingBoth[0].needsCopy, missingBoth[0].needsExport], ['exporting', true, true]);

  const copyOnly = planFor([short], job, { exports: [] });
  assert.deepEqual([copyOnly[0].state, copyOnly[0].needsCopy, copyOnly[0].needsExport], ['exporting', false, true]);

  const rendering = planFor([short], job, { exports: [makeExport(short, { status: 'rendering' })] });
  assert.deepEqual([rendering[0].state, rendering[0].needsCopy, rendering[0].needsExport], ['exporting', false, false]);

  const staleExportOnly = planFor([short], job, { exports: [makeExport(short, { editRevision: 9, status: 'ready' })] });
  assert.deepEqual([staleExportOnly[0].state, staleExportOnly[0].needsExport], ['exporting', true]);
});

test('a short with copy and a current ready export is ready', () => {
  const short = makeShort(1);
  const older = makeExport(short, { id: 'export_old', status: 'failed', createdAt: '2026-10-18T12:30:00.000Z' });
  const newest = makeExport(short, { id: 'export_new', createdAt: '2026-10-18T12:40:00.000Z' });
  const plans = planFor([short], makeJob(), { exports: [older, newest] });
  assert.equal(plans.length, 1);
  assert.deepEqual([plans[0].state, plans[0].readyExportId, plans[0].needsCopy, plans[0].needsExport], ['ready', 'export_new', false, false]);
});

test('a job that is not ready has no plans', () => {
  const plans = planFor([makeShort(1)], makeJob({ status: 'planning' }));
  assert.deepEqual(plans, []);
});

test('orderReadyShorts puts the newest video first and ranks ascending within it', () => {
  const olderVideo = makeVideo({ videoId: 'vid_old', detectedAt: '2026-10-18T12:00:00.000Z' });
  const newerVideo = makeVideo({ videoId: 'vid_new', detectedAt: '2026-10-18T15:00:00.000Z' });
  const olderPlan = planFor([makeShort(1)])[0];
  const newerRank2 = planFor([makeShort(2)])[0];
  const newerRank1 = planFor([makeShort(1, { id: 'short_new_1' })])[0];
  const ordered = orderReadyShorts([
    { video: olderVideo, plan: olderPlan },
    { video: newerVideo, plan: newerRank2 },
    { video: newerVideo, plan: newerRank1 },
  ]);
  assert.deepEqual(ordered.map((entry) => [entry.video.videoId, entry.plan.short.rank]), [
    ['vid_new', 1],
    ['vid_new', 2],
    ['vid_old', 1],
  ]);
});
