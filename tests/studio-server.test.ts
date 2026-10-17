import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { ShortEdit } from '../src/domain/edit.js';
import type { LayoutProfile } from '../src/domain/layout.js';
import { StudioError } from '../src/application/errors.js';
import type { StudioMediaResolver } from '../src/application/studio-media.js';
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
  type JobSummaryDto,
  type PublicationDto,
  type PublishRequest,
  type ReviseRequest,
  type ReviseResultDto,
  type SaveEditRequest,
  type SetDefaultCreatorRequest,
  type SetShortStatusRequest,
  type ShortDetailDto,
  type ShortSummaryDto,
  type StudioApi,
  type TranscriptDto,
  type UpdatePublishCopyRequest,
  type UpdateShortMetaRequest,
} from '../src/studio/api-types.js';
import { createStudioApp, startStudioServer } from '../src/studio/server.js';

const root = await mkdtemp(path.join(tmpdir(), 'studio-server-'));
const fontsDir = path.join(root, 'fonts');
const webDistDir = path.join(root, 'web');
const emptyDistDir = path.join(root, 'empty-dist');
const sourceFile = path.join(root, 'source.mp4');
const thumbFile = path.join(root, 'thumb.jpg');
const frameFile = path.join(root, 'frame.jpg');
const exportFile = path.join(root, 'short.mp4');

const fontBytes = new Uint8Array(200).map((_, i) => (i + 3) % 256);
const sourceBytes = new Uint8Array(1000).map((_, i) => (i * 7 + 13) % 256);
const thumbBytes = new Uint8Array(64).map((_, i) => (i * 3) % 256);
const exportBytes = new Uint8Array(512).map((_, i) => (i * 11) % 256);

await mkdir(fontsDir);
await mkdir(path.join(webDistDir, 'assets'), { recursive: true });
await mkdir(emptyDistDir);
await writeFile(path.join(fontsDir, 'Test-Font.ttf'), fontBytes);
await writeFile(path.join(root, 'secret.txt'), 'top secret');
await writeFile(sourceFile, sourceBytes);
await writeFile(thumbFile, thumbBytes);
await writeFile(frameFile, thumbBytes);
await writeFile(exportFile, exportBytes);
await writeFile(path.join(webDistDir, 'index.html'), '<!doctype html>studio');
await writeFile(path.join(webDistDir, 'assets', 'app.js'), 'console.log(1)');

after(async () => {
  await rm(root, { recursive: true, force: true });
});

class FakeMediaResolver implements StudioMediaResolver {
  calls: Array<{ method: string; args: unknown[] }> = [];

  sourceVideoPath(jobId: string): string {
    this.calls.push({ method: 'sourceVideoPath', args: [jobId] });
    return sourceFile;
  }

  thumbnailPath(jobId: string): string {
    this.calls.push({ method: 'thumbnailPath', args: [jobId] });
    return thumbFile;
  }

  async framePath(jobId: string, seconds: number, width: number): Promise<string> {
    this.calls.push({ method: 'framePath', args: [jobId, seconds, width] });
    return frameFile;
  }

  exportVideoPath(exportId: string): string {
    this.calls.push({ method: 'exportVideoPath', args: [exportId] });
    return exportFile;
  }
}

class FakeStudioApi implements StudioApi {
  calls: Array<{ method: string; args: unknown[] }> = [];
  error: Error | null = null;

  private note(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.error !== null) throw this.error;
  }

  async listCreators(): Promise<CreatorDto[]> {
    this.note('listCreators', []);
    return [creatorDto('filipe_boni', true), creatorDto('jones_manoel')];
  }

  async setDefaultCreator(request: SetDefaultCreatorRequest): Promise<CreatorDto[]> {
    this.note('setDefaultCreator', [request]);
    return [creatorDto(request.creatorId, true)];
  }

  listJobs(): JobSummaryDto[] {
    this.note('listJobs', []);
    return [jobSummaryDto('j1')];
  }

  async createJob(request: CreateJobRequest): Promise<JobSummaryDto> {
    this.note('createJob', [request]);
    return jobSummaryDto('j2');
  }

  getJob(jobId: string): JobDetailDto {
    this.note('getJob', [jobId]);
    return jobDetailDto(jobId);
  }

  retryJob(jobId: string): JobDetailDto {
    this.note('retryJob', [jobId]);
    return jobDetailDto(jobId);
  }

  getTranscript(jobId: string): TranscriptDto {
    this.note('getTranscript', [jobId]);
    return { words: [], sentences: [] };
  }

  correctWord(jobId: string, wordIndex: number, request: CorrectWordRequest): TranscriptDto {
    this.note('correctWord', [jobId, wordIndex, request]);
    return { words: [{ i: wordIndex, text: request.text, start: 1.5, end: 2.0, speakerId: 'S1' }], sentences: [] };
  }

  chooseSpeaker(jobId: string, request: ChooseSpeakerRequest): JobDetailDto {
    this.note('chooseSpeaker', [jobId, request]);
    return jobDetailDto(jobId);
  }

  replan(jobId: string): JobDetailDto {
    this.note('replan', [jobId]);
    return jobDetailDto(jobId);
  }

  createManualShort(jobId: string, request: CreateManualShortRequest): ShortDetailDto {
    this.note('createManualShort', [jobId, request]);
    return shortDetailDto(jobId, 's1');
  }

  async getShort(shortId: string): Promise<ShortDetailDto> {
    this.note('getShort', [shortId]);
    return shortDetailDto('j1', shortId);
  }

  async saveEdit(shortId: string, request: SaveEditRequest): Promise<ShortDetailDto> {
    this.note('saveEdit', [shortId, request]);
    return shortDetailDto('j1', shortId);
  }

  async revise(shortId: string, request: ReviseRequest): Promise<ReviseResultDto> {
    this.note('revise', [shortId, request]);
    return { detail: shortDetailDto('j1', shortId), summary: 'Applied', warnings: [] };
  }

  async suggestHooks(shortId: string): Promise<HookSuggestionsDto> {
    this.note('suggestHooks', [shortId]);
    return { options: ['First', 'Second', 'Third'] };
  }

  async updateShortMeta(shortId: string, request: UpdateShortMetaRequest): Promise<ShortDetailDto> {
    this.note('updateShortMeta', [shortId, request]);
    return shortDetailDto('j1', shortId);
  }

  async setShortStatus(shortId: string, request: SetShortStatusRequest): Promise<ShortDetailDto> {
    this.note('setShortStatus', [shortId, request]);
    return shortDetailDto('j1', shortId);
  }

  async analyzeCrops(shortId: string): Promise<ShortDetailDto> {
    this.note('analyzeCrops', [shortId]);
    return shortDetailDto('j1', shortId);
  }

  async exportShort(shortId: string): Promise<ShortDetailDto> {
    this.note('exportShort', [shortId]);
    return shortDetailDto('j1', shortId);
  }

  async generatePublishCopy(shortId: string): Promise<ShortDetailDto> {
    this.note('generatePublishCopy', [shortId]);
    return shortDetailDto('j1', shortId);
  }

  async updatePublishCopy(shortId: string, request: UpdatePublishCopyRequest): Promise<ShortDetailDto> {
    this.note('updatePublishCopy', [shortId, request]);
    return shortDetailDto('j1', shortId);
  }

  async publish(exportId: string, request: PublishRequest): Promise<PublicationDto[]> {
    this.note('publish', [exportId, request]);
    return [publicationDto(exportId)];
  }
}

function buildApp(options?: { api?: FakeStudioApi; media?: FakeMediaResolver; webDistDir?: string }) {
  return createStudioApp({
    api: options?.api ?? new FakeStudioApi(),
    media: options?.media ?? new FakeMediaResolver(),
    webDistDir: options?.webDistDir ?? webDistDir,
    fontsDir,
  });
}

function creatorDto(id: string, isDefault = false): CreatorDto {
  return { id, displayName: `Creator ${id}`, isDefault };
}

function jobSummaryDto(id: string): JobSummaryDto {
  return {
    id,
    sourceUrl: 'https://www.youtube.com/watch?v=abc123',
    title: 'Source title',
    thumbnailUrl: `/media/jobs/${id}/thumbnail`,
    status: 'ready',
    progress: null,
    error: null,
    creator: { id: 'filipe_boni', displayName: 'Filipe Boni' },
    shortCounts: { active: 2, rejected: 1, exported: 1 },
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T11:00:00.000Z',
  };
}

function jobDetailDto(jobId: string): JobDetailDto {
  return {
    ...jobSummaryDto(jobId),
    media: { width: 1920, height: 1080, fps: 60, durationSeconds: 180, videoUrl: `/media/jobs/${jobId}/source` },
    speakers: [],
    chosenSpeakerId: null,
    canRetry: false,
    shorts: [shortSummaryDto(jobId, 's1')],
  };
}

function exportDto(shortId: string): ExportDto {
  return {
    id: `exp_${shortId}`,
    shortId,
    editRevision: 3,
    status: 'ready',
    error: null,
    videoUrl: `/media/exports/exp_${shortId}`,
    sizeBytes: 4096,
    durationSeconds: 45.5,
    createdAt: '2026-10-16T11:05:00.000Z',
    updatedAt: '2026-10-16T11:06:00.000Z',
  };
}

function shortSummaryDto(jobId: string, id: string): ShortSummaryDto {
  return {
    id,
    jobId,
    rank: 1,
    origin: 'planner',
    title: 'Short title',
    summary: 'Summary text',
    status: 'active',
    durationSeconds: 45.5,
    hookText: 'Hook text',
    cropAnalysis: 'done',
    latestExport: exportDto(id),
    updatedAt: '2026-10-16T11:00:00.000Z',
  };
}

function shortDetailDto(jobId: string, id: string): ShortDetailDto {
  return {
    short: {
      ...shortSummaryDto(jobId, id),
      rationale: 'Rationale',
      hook: 'Hook narrative',
      payoff: 'Payoff',
      risk: 'low',
      arc: null,
      edit: makeEdit(),
      editRevision: 3,
      cropAnalysisError: null,
      publishCopy: null,
    },
    job: {
      id: jobId,
      title: 'Source title',
      sourceUrl: 'https://www.youtube.com/watch?v=abc123',
      thumbnailUrl: `/media/jobs/${jobId}/thumbnail`,
      media: { width: 1920, height: 1080, fps: 60, durationSeconds: 180, videoUrl: `/media/jobs/${jobId}/source` },
      layout: layoutProfile,
      fontUrl: '/fonts/Montserrat-ExtraBold.ttf',
    },
    exports: [exportDto(id)],
    publications: [],
    platforms: [],
  };
}

function publicationDto(exportId: string): PublicationDto {
  return {
    id: `pub_${exportId}`,
    exportId,
    platform: 'instagram',
    status: 'queued',
    provider: null,
    url: null,
    error: null,
    forced: false,
    availableAt: null,
    submittedAt: null,
    createdAt: '2026-10-16T11:10:00.000Z',
    updatedAt: '2026-10-16T11:10:00.000Z',
  };
}

function makeEdit(): ShortEdit {
  return {
    ranges: [{ startWord: 0, endWord: 30 }],
    removedWords: [5],
    tightenPauses: { enabled: true, maxGapSeconds: 0.35 },
    speed: 1.1,
    hook: { enabled: true, text: 'O truque que ninguém conta' },
    captions: { enabled: true },
    crops: [],
    zoom: { enabled: true, strength: 1.12 },
    endCard: { enabled: false },
  };
}

const layoutProfile: LayoutProfile = {
  version: 2,
  creatorId: 'filipe_boni',
  layoutId: 'screen-top-host-bottom-v2',
  canvas: { width: 1080, height: 1920, fps: 30 },
  background: '#101010',
  defaultSpeed: 1.1,
  font: { family: 'Montserrat ExtraBold', file: 'assets/fonts/Montserrat-ExtraBold.ttf', assSizeScale: 1.562 },
  panels: [
    { id: 'screen', role: 'content', sourceRect: { x: 0, y: 0, w: 0.632, h: 1 }, canvasRect: { x: 0, y: 0.1146, w: 1, h: 0.4375 } },
    { id: 'host', role: 'host', sourceRect: { x: 0.637, y: 0, w: 0.363, h: 1 }, canvasRect: { x: 0, y: 0.5521, w: 1, h: 0.4479 }, anchor: { x: 0.5, y: 0.42 } },
  ],
  hookBand: {
    rect: { x: 0, y: 0, w: 1, h: 0.1146 },
    background: '#C8102E',
    textColor: '#FFFFFF',
    sizePx: 58,
    maxCharsPerLine: 24,
    maxLines: 2,
    uppercase: true,
  },
  captions: {
    sizePx: 62,
    textColor: '#FFFFFF',
    highlightColor: '#FFD400',
    outlineColor: '#000000',
    outlinePx: 6,
    shadowPx: 2,
    uppercase: true,
    maxWordsPerCue: 4,
    maxCharsPerLine: 16,
    maxLines: 2,
    centerY: 0.5521,
  },
};

async function bytesOf(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

test('GET /api/creators returns the StudioApi payload', async () => {
  const api = new FakeStudioApi();
  const app = buildApp({ api });
  const res = await app.request('/api/creators');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [creatorDto('filipe_boni', true), creatorDto('jones_manoel')]);
  assert.deepEqual(api.calls, [{ method: 'listCreators', args: [] }]);
});

test('POST /api/jobs parses the body with the request schema', async () => {
  const api = new FakeStudioApi();
  const app = buildApp({ api });
  const res = await app.request('/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://youtu.be/x', creatorId: 'filipe_boni' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), jobSummaryDto('j2'));
  assert.deepEqual(api.calls, [{ method: 'createJob', args: [{ url: 'https://youtu.be/x', creatorId: 'filipe_boni' }] }]);
});

test('invalid JSON body yields 400 with the exact error shape', async () => {
  const app = buildApp();
  const res = await app.request('/api/jobs', { method: 'POST', body: '{nope' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Invalid JSON body', code: 'invalid' });
});

test('schema-invalid body yields 400 Invalid request with issues', async () => {
  const app = buildApp();
  const res = await app.request('/api/jobs', { method: 'POST', body: JSON.stringify({ url: '' }) });
  assert.equal(res.status, 400);
  const body: { error: string; code: string; issues: unknown[] } = await res.json();
  assert.deepEqual({ error: body.error, code: body.code }, { error: 'Invalid request', code: 'invalid' });
  assert.ok(body.issues.length > 0);
});

test('unknown keys are rejected by strict request schemas', async () => {
  const api = new FakeStudioApi();
  const app = buildApp({ api });
  const res = await app.request('/api/creators/default', {
    method: 'PUT',
    body: JSON.stringify({ creatorId: 'filipe_boni', extra: 1 }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(api.calls, []);
});

test('StudioError maps to its HTTP status with error and code', async () => {
  for (const [code, status] of [
    ['not_found', 404],
    ['conflict', 409],
    ['invalid', 400],
    ['unavailable', 503],
  ] as const) {
    const api = new FakeStudioApi();
    api.error = new StudioError(code, `${code} detail`);
    const app = buildApp({ api });
    const res = await app.request('/api/jobs/j1');
    assert.equal(res.status, status, code);
    assert.deepEqual(await res.json(), { error: `${code} detail`, code });
  }
});

test('unexpected errors map to 500 internal', async () => {
  const api = new FakeStudioApi();
  api.error = new Error('boom');
  const app = buildApp({ api });
  const res = await app.request('/api/shorts/s1');
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'boom', code: 'internal' });
});

test('media source serves the full file without a Range header', async () => {
  const app = buildApp();
  const res = await app.request(MEDIA_ROUTES.source('j1'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('content-length'), '1000');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(await bytesOf(res), sourceBytes);
});

test('media source serves byte ranges with 206 and Content-Range', async () => {
  const app = buildApp();
  const res = await app.request(MEDIA_ROUTES.source('j1'), { headers: { range: 'bytes=100-199' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 100-199/1000');
  assert.equal(res.headers.get('content-length'), '100');
  assert.deepEqual(await bytesOf(res), sourceBytes.subarray(100, 200));
});

test('media source serves open-ended ranges', async () => {
  const app = buildApp();
  const res = await app.request(MEDIA_ROUTES.source('j1'), { headers: { range: 'bytes=500-' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 500-999/1000');
  assert.equal(res.headers.get('content-length'), '500');
  assert.deepEqual(await bytesOf(res), sourceBytes.subarray(500));
});

test('media source serves suffix ranges clamped to the file size', async () => {
  const app = buildApp();
  const suffix = await app.request(MEDIA_ROUTES.source('j1'), { headers: { range: 'bytes=-100' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), 'bytes 900-999/1000');
  assert.deepEqual(await bytesOf(suffix), sourceBytes.subarray(900));
  const oversized = await app.request(MEDIA_ROUTES.source('j1'), { headers: { range: 'bytes=-5000' } });
  assert.equal(oversized.status, 206);
  assert.equal(oversized.headers.get('content-range'), 'bytes 0-999/1000');
  assert.deepEqual(await bytesOf(oversized), sourceBytes);
});

test('unsatisfiable ranges yield 416 with Content-Range bytes', async () => {
  const app = buildApp();
  for (const header of ['bytes=1000-', 'bytes=1000-1005', 'bytes=700-200']) {
    const res = await app.request(MEDIA_ROUTES.source('j1'), { headers: { range: header } });
    assert.equal(res.status, 416, header);
    assert.equal(res.headers.get('content-range'), 'bytes */1000');
    assert.equal((await bytesOf(res)).length, 0, header);
  }
});

test('multi-range headers are ignored and the full file is served', async () => {
  const app = buildApp();
  const res = await app.request(MEDIA_ROUTES.source('j1'), { headers: { range: 'bytes=0-1,3-4' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-range'), null);
  assert.deepEqual(await bytesOf(res), sourceBytes);
});

test('frame route validates t and w and forwards them to the resolver', async () => {
  const media = new FakeMediaResolver();
  const app = buildApp({ media });
  const res = await app.request(MEDIA_ROUTES.frame('j1', 1.5, 640));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(await bytesOf(res), thumbBytes);
  assert.deepEqual(media.calls, [{ method: 'framePath', args: ['j1', 1.5, 640] }]);
  for (const query of ['?t=abc&w=640', '?t=1.5', '?t=1.5&w=Infinity']) {
    const bad = await app.request(`/media/jobs/j1/frame${query}`);
    assert.equal(bad.status, 400, query);
    const body: { error: string; code: string } = await bad.json();
    assert.deepEqual({ error: body.error, code: body.code }, { error: 'Invalid request', code: 'invalid' }, query);
  }
});

test('export route serves video and attaches Content-Disposition on download=1', async () => {
  const app = buildApp();
  const plain = await app.request(MEDIA_ROUTES.export('e1'));
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('content-type'), 'video/mp4');
  assert.equal(plain.headers.get('content-disposition'), null);
  assert.deepEqual(await bytesOf(plain), exportBytes);
  const download = await app.request(`${MEDIA_ROUTES.export('e1')}?download=1`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-disposition'), 'attachment; filename="short.mp4"');
});

test('fonts serve from the fonts directory', async () => {
  const app = buildApp();
  const res = await app.request(MEDIA_ROUTES.font('Test-Font.ttf'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'font/ttf');
  assert.deepEqual(await bytesOf(res), fontBytes);
});

test('font traversal attempts are rejected', async () => {
  const app = buildApp();
  for (const [name, param, decoded] of [
    ['dotdot slash', '..%2Fsecret.txt', '../secret.txt'],
    ['encoded dots', '%2E%2E%2Fsecret.txt', '../secret.txt'],
    ['backslash', '..%5Csecret.txt', '..\\secret.txt'],
    ['nested', '..%2F..%2Fsecret.txt', '../../secret.txt'],
  ] as const) {
    const res = await app.request(`/fonts/${param}`);
    assert.equal(res.status, 400, name);
    assert.deepEqual(await res.json(), { error: `Invalid font name: ${decoded}`, code: 'invalid' }, name);
  }
});

test('static files are served from the web dist directory', async () => {
  const app = buildApp();
  const index = await app.request('/');
  assert.equal(index.status, 200);
  assert.equal(index.headers.get('content-type'), 'text/html; charset=UTF-8');
  assert.equal(await index.text(), '<!doctype html>studio');
  const asset = await app.request('/assets/app.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=UTF-8');
  assert.equal(await asset.text(), 'console.log(1)');
});

test('SPA fallback serves index.html for client-side routes and escapes the dist dir', async () => {
  const app = buildApp();
  const spa = await app.request('/shorts/abc');
  assert.equal(spa.status, 200);
  assert.equal(spa.headers.get('content-type'), 'text/html; charset=UTF-8');
  assert.equal(await spa.text(), '<!doctype html>studio');
  const escape = await app.request('/%2e%2e/%2e%2e/package.json');
  assert.equal(escape.status, 200);
  assert.equal(await escape.text(), '<!doctype html>studio');
});

test('missing index.html yields the build hint with status 503', async () => {
  const app = buildApp({ webDistDir: emptyDistDir });
  const res = await app.request('/anything');
  assert.equal(res.status, 503);
  assert.equal(await res.text(), 'Run pnpm build:web');
});

test('every StudioApi route dispatches with parsed bodies', async () => {
  const api = new FakeStudioApi();
  const app = buildApp({ api });
  const edit = makeEdit();
  const cases: Array<[string, RequestInit, string, unknown[]]> = [
    ['/api/creators/default', { method: 'PUT', body: JSON.stringify({ creatorId: 'jones_manoel' }) }, 'setDefaultCreator', [{ creatorId: 'jones_manoel' }]],
    ['/api/jobs/j1/retry', { method: 'POST' }, 'retryJob', ['j1']],
    ['/api/jobs/j1/transcript', {}, 'getTranscript', ['j1']],
    ['/api/jobs/j1/words/3', { method: 'PUT', body: JSON.stringify({ text: 'mês' }) }, 'correctWord', ['j1', 3, { text: 'mês' }]],
    ['/api/jobs/j1/speaker', { method: 'POST', body: JSON.stringify({ speakerId: 'S1' }) }, 'chooseSpeaker', ['j1', { speakerId: 'S1' }]],
    ['/api/jobs/j1/replan', { method: 'POST' }, 'replan', ['j1']],
    ['/api/jobs/j1/shorts', { method: 'POST', body: JSON.stringify({ range: { startWord: 0, endWord: 10 } }) }, 'createManualShort', ['j1', { range: { startWord: 0, endWord: 10 } }]],
    ['/api/shorts/s1', { method: 'PATCH', body: JSON.stringify({ title: 'New title' }) }, 'updateShortMeta', ['s1', { title: 'New title' }]],
    ['/api/shorts/s1/edit', { method: 'PUT', body: JSON.stringify({ edit, baseRevision: 2 }) }, 'saveEdit', ['s1', { edit, baseRevision: 2 }]],
    ['/api/shorts/s1/revise', { method: 'POST', body: JSON.stringify({ message: 'cut the intro', baseRevision: 2 }) }, 'revise', ['s1', { message: 'cut the intro', baseRevision: 2 }]],
    ['/api/shorts/s1/hooks', { method: 'POST' }, 'suggestHooks', ['s1']],
    ['/api/shorts/s1/status', { method: 'PUT', body: JSON.stringify({ status: 'rejected' }) }, 'setShortStatus', ['s1', { status: 'rejected' }]],
    ['/api/shorts/s1/crops/analyze', { method: 'POST' }, 'analyzeCrops', ['s1']],
    ['/api/shorts/s1/exports', { method: 'POST' }, 'exportShort', ['s1']],
    ['/api/shorts/s1/copy/generate', { method: 'POST' }, 'generatePublishCopy', ['s1']],
    ['/api/shorts/s1/copy', { method: 'PUT', body: JSON.stringify({ copy: { line1: 'First line', line2: 'Second line', hashtags: ['#shorts'] } }) }, 'updatePublishCopy', ['s1', { copy: { line1: 'First line', line2: 'Second line', hashtags: ['#shorts'] } }]],
    ['/api/exports/e1/publish', { method: 'POST', body: JSON.stringify({ platforms: ['instagram'], force: false }) }, 'publish', ['e1', { platforms: ['instagram'], force: false }]],
  ];
  for (const [route, init, method] of cases) {
    const res = await app.request(route, init);
    assert.equal(res.status, 200, `${init.method ?? 'GET'} ${route}`);
  }
  assert.deepEqual(
    api.calls.map((call) => call.method),
    cases.map(([, , method]) => method),
  );
  assert.deepEqual(api.calls[8], { method: 'saveEdit', args: cases[8][3] });
  assert.deepEqual(api.calls[10], { method: 'suggestHooks', args: cases[10][3] });
  assert.deepEqual(api.calls[16], { method: 'publish', args: cases[16][3] });
});

test('PUT /api/jobs/:jobId/words/:wordIndex parses the index or rejects bad input with 400', async () => {
  const api = new FakeStudioApi();
  const app = buildApp({ api });
  const ok = await app.request('/api/jobs/j1/words/3', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '  mês  ' }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { words: [{ i: 3, text: 'mês', start: 1.5, end: 2.0, speakerId: 'S1' }], sentences: [] });
  assert.deepEqual(api.calls, [{ method: 'correctWord', args: ['j1', 3, { text: 'mês' }] }]);

  for (const [route, body] of [
    ['/api/jobs/j1/words/abc', { text: 'mês' }],
    ['/api/jobs/j1/words/-1', { text: 'mês' }],
    ['/api/jobs/j1/words/1.5', { text: 'mês' }],
    ['/api/jobs/j1/words/3', { text: '' }],
    ['/api/jobs/j1/words/3', { text: '   ' }],
    ['/api/jobs/j1/words/3', { text: 'duas\nlinhas' }],
    ['/api/jobs/j1/words/3', { text: 'coluna\tsecreta' }],
    ['/api/jobs/j1/words/3', { text: 'x'.repeat(41) }],
    ['/api/jobs/j1/words/3', { text: 'mês', extra: 1 }],
  ] as const) {
    const bad = await app.request(route, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(bad.status, 400, route);
    const payload: { code: string } = await bad.json();
    assert.equal(payload.code, 'invalid', route);
    assert.equal(api.calls.length, 1, route);
  }
});

test('startStudioServer binds 127.0.0.1 and serves the app', async () => {
  const app = buildApp();
  const { url, close } = await startStudioServer(app, 0);
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${url}/api/jobs`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [jobSummaryDto('j1')]);
    const range = await fetch(`${url}${MEDIA_ROUTES.source('j1')}`, { headers: { range: 'bytes=0-9' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-length'), '10');
    assert.equal((await bytesOf(range)).length, 10);
  } finally {
    await close();
  }
});

test('unknown /api routes return a JSON 404', async () => {
  const api = new FakeStudioApi();
  const app = buildApp({ api });
  const res = await app.request('/api/typo');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Not found', code: 'not_found' });
  assert.equal(api.calls.length, 0);
});

test('static paths containing NUL are rejected with 400', async () => {
  const app = buildApp();
  const res = await app.request('/%00');
  assert.equal(res.status, 400);
  const body: { code: string } = await res.json();
  assert.equal(body.code, 'invalid');
});

test('duplicate publish platforms are rejected with 400 before dispatch', async () => {
  const api = new FakeStudioApi();
  const app = buildApp({ api });
  const res = await app.request('/api/exports/e1/publish', {
    method: 'POST',
    body: JSON.stringify({ platforms: ['instagram', 'instagram'], force: false }),
  });
  assert.equal(res.status, 400);
  const body: { code: string } = await res.json();
  assert.equal(body.code, 'invalid');
  assert.equal(api.calls.length, 0);
});
