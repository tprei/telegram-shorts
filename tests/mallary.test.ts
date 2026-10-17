import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MallaryClient, MallaryUploadClient, buildMallaryInstagramReelPayload, buildPublishMessage, mallaryMimeType, parseMallaryRetryAfterSeconds } from '../src/infra/mallary.js';
import { ShortVideoPublishError } from '../src/infra/instagram-publisher.js';

interface FakeMallary {
  baseUrl: string;
  uploadUrlRequests: number;
  putRequests: Array<{ contentLength: string | undefined; body: Buffer }>;
  close(): Promise<void>;
}

async function startFakeMallary(handlers: {
  uploadUrl: (attempt: number, request: IncomingMessage, response: ServerResponse, baseUrl: string) => void;
  put: (attempt: number, response: ServerResponse) => void;
}): Promise<FakeMallary> {
  const state = { uploadUrlRequests: 0, putRequests: [] as FakeMallary['putRequests'] };
  let baseUrl = '';
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/api/v1/upload') {
      state.uploadUrlRequests += 1;
      handlers.uploadUrl(state.uploadUrlRequests, request, response, baseUrl);
      return;
    }
    if (request.method === 'PUT' && request.url === '/put/video.mp4') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        state.putRequests.push({ contentLength: request.headers['content-length'], body: Buffer.concat(chunks) });
        handlers.put(state.putRequests.length, response);
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    get uploadUrlRequests() {
      return state.uploadUrlRequests;
    },
    get putRequests() {
      return state.putRequests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function presignedUpload(response: ServerResponse, baseUrl: string): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ uploadUrl: `${baseUrl}/put/video.mp4`, mediaUrl: 'https://files.mallary.ai/uploads/video.mp4', headers: { 'Content-Type': 'video/mp4' } }));
}

async function withVideoFile(run: (path: string, bytes: Buffer) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mallary-upload-'));
  const path = join(dir, 'video.mp4');
  const bytes = Buffer.alloc(3 * 1024 * 1024, 7);
  await writeFile(path, bytes);
  try {
    await run(path, bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('upload streams the file once and reuses the hosted URL for later publishes of the same file', async () => {
  const fake = await startFakeMallary({
    uploadUrl: (_attempt, _request, response, baseUrl) => presignedUpload(response, baseUrl),
    put: (_attempt, response) => response.writeHead(200).end(),
  });
  try {
    await withVideoFile(async (path, bytes) => {
      const client = new MallaryUploadClient('token', { baseUrl: fake.baseUrl, retryDelaysMs: [1, 1] });
      const first = await client.uploadFile(path);
      const second = await client.uploadFile(path);
      assert.equal(first.mediaUrl, 'https://files.mallary.ai/uploads/video.mp4');
      assert.equal(second.mediaUrl, first.mediaUrl);
      assert.equal(fake.uploadUrlRequests, 1);
      assert.equal(fake.putRequests.length, 1);
      assert.equal(fake.putRequests[0]!.contentLength, String(bytes.length));
      assert.ok(fake.putRequests[0]!.body.equals(bytes));
    });
  } finally {
    await fake.close();
  }
});

test('upload retries dropped connections and server errors, then succeeds', async () => {
  const fake = await startFakeMallary({
    uploadUrl: (attempt, request, response, baseUrl) => {
      if (attempt === 1) {
        request.socket.destroy();
        return;
      }
      presignedUpload(response, baseUrl);
    },
    put: (attempt, response) => response.writeHead(attempt === 1 ? 503 : 200).end(),
  });
  try {
    await withVideoFile(async (path) => {
      const client = new MallaryUploadClient('token', { baseUrl: fake.baseUrl, retryDelaysMs: [1, 1] });
      const upload = await client.uploadFile(path);
      assert.equal(upload.mediaUrl, 'https://files.mallary.ai/uploads/video.mp4');
      assert.equal(fake.uploadUrlRequests, 2);
      assert.equal(fake.putRequests.length, 2);
    });
  } finally {
    await fake.close();
  }
});

test('upload rejected by the storage host is not retried and a later call uploads again', async () => {
  const fake = await startFakeMallary({
    uploadUrl: (_attempt, _request, response, baseUrl) => presignedUpload(response, baseUrl),
    put: (attempt, response) => response.writeHead(attempt === 1 ? 403 : 200).end(attempt === 1 ? 'SignatureDoesNotMatch' : ''),
  });
  try {
    await withVideoFile(async (path) => {
      const client = new MallaryUploadClient('token', { baseUrl: fake.baseUrl, retryDelaysMs: [1, 1] });
      await assert.rejects(client.uploadFile(path), /403 SignatureDoesNotMatch/);
      assert.equal(fake.putRequests.length, 1);
      await client.uploadFile(path);
      assert.equal(fake.putRequests.length, 2);
    });
  } finally {
    await fake.close();
  }
});

test('publish message removes irrelevant platform/meta tags only', () => {
  const description = buildPublishMessage({
    line1: 'O neoliberalismo é hipócrita quando pede sacrifício só de quem já perdeu tudo',
    line2: 'A regra muda na hora em que o prejuízo encosta em quem sempre mandou no jogo',
    hashtags: ['#Business', '#Neoliberalismo', '#InstagramReels', '#LutaDeClasses', '#FYP', '#PoliticaBrasileira', '#OpenAI', '#Mindset'],
  });
  const lines = description.split('\n');
  assert.equal(lines[0], 'O neoliberalismo é hipócrita quando pede sacrifício só de quem já perdeu tudo.');
  assert.equal(lines[1], 'A regra muda na hora em que o prejuízo encosta em quem sempre mandou no jogo.');
  assert.equal(lines[3], '#Business #Neoliberalismo #LutaDeClasses #PoliticaBrasileira #OpenAI #Mindset');
  assert.equal(description.includes('#InstagramReels'), false);
  assert.equal(description.includes('#FYP'), false);
});

test('mallary instagram payload includes sanitized follow-up comments', () => {
  const payload = buildMallaryInstagramReelPayload({
    message: 'Legenda principal',
    mediaUrl: 'https://files.mallary.ai/video.mp4',
    mediaType: 'video/mp4',
    thumbnailUrl: 'https://files.mallary.ai/cover.jpg',
    commentsUnderPost: ['  Vídeo completo: https://youtube.com/watch?v=abc  ', '', 'Fonte: @canal  ', 'extra'],
  }) as {
    comments_under_post?: string[];
    media?: Array<{ thumbnail_url?: string }>;
  };

  assert.deepEqual(payload.comments_under_post, [
    'Vídeo completo: https://youtube.com/watch?v=abc',
    'Fonte: @canal',
    'extra',
  ]);
  assert.equal(payload.media?.[0]?.thumbnail_url, 'https://files.mallary.ai/cover.jpg');
});

test('mallary mime type supports video and image uploads', () => {
  assert.equal(mallaryMimeType('/tmp/video.mp4'), 'video/mp4');
  assert.equal(mallaryMimeType('/tmp/video.mov'), 'video/quicktime');
  assert.equal(mallaryMimeType('/tmp/cover.jpg'), 'image/jpeg');
  assert.equal(mallaryMimeType('/tmp/cover.png'), 'image/png');
});

test('mallary throttle payload exposes retry-after seconds', () => {
  const retryAfter = parseMallaryRetryAfterSeconds(JSON.stringify({
    status: 'error',
    error: {
      code: 'trial_posting_throttled',
      details: { retry_after: 234 },
    },
  }));
  assert.equal(retryAfter, 234);
  assert.equal(parseMallaryRetryAfterSeconds('{"error":{"code":"other"}}'), null);
});

function withJobFetch(body: string, status: number, record: { url: string; headers: Record<string, string> }): typeof fetch {
  return async (input, init) => {
    record.url = String(input);
    record.headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    return new Response(body, { status });
  };
}

function checkJob(remoteJobId: string): Promise<unknown> {
  return new MallaryClient('token', null, new MallaryUploadClient('token')).checkPublication({
    provider: 'mallary',
    platform: 'instagram',
    remoteJobId,
  });
}

async function withFetch(run: (restore: () => void) => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  try {
    await run(() => {
      globalThis.fetch = originalFetch;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('Mallary check maps completed jobs to live with the platform post url', async () => {
  await withFetch(async () => {
    const record = { url: '', headers: {} as Record<string, string> };
    globalThis.fetch = withJobFetch(JSON.stringify({ data: { job: { status: 'completed', platform_post_url: 'https://www.instagram.com/reel/xyz/' } } }), 200, record);
    const state = await checkJob('job_9');
    assert.deepEqual(state, { status: 'live', url: 'https://www.instagram.com/reel/xyz/', error: null });
    assert.equal(record.url, 'https://mallary.ai/api/v1/jobs/job_9');
    assert.equal(record.headers.Authorization, 'Bearer token');
  });
});

test('Mallary check maps terminal job states to failed using the first available reason', async () => {
  const cases: Array<{ job: Record<string, unknown>; error: string }> = [
    { job: { status: 'failed', failedReason: 'Instagram rejected the video' }, error: 'Instagram rejected the video' },
    { job: { status: 'failed', error: 'Upload processing failed' }, error: 'Upload processing failed' },
    { job: { status: 'action_required', action_required: { message: 'Reconnect the account' } }, error: 'Reconnect the account' },
    { job: { status: 'cancelled', error_code: 'CANCELLED_BY_USER' }, error: 'CANCELLED_BY_USER' },
  ];
  await withFetch(async () => {
    for (const testCase of cases) {
      globalThis.fetch = withJobFetch(JSON.stringify({ data: { job: testCase.job } }), 200, { url: '', headers: {} });
      const state = await checkJob('job_1');
      assert.deepEqual(state, { status: 'failed', url: null, error: testCase.error });
    }
  });
});

test('Mallary check treats every other job status as pending', async () => {
  await withFetch(async () => {
    globalThis.fetch = withJobFetch(JSON.stringify({ data: { job: { status: 'processing' } } }), 200, { url: '', headers: {} });
    const state = await checkJob('job_2');
    assert.deepEqual(state, { status: 'pending', url: null, error: null });
  });
});

test('Mallary check surfaces error.message from non-2xx bodies instead of the raw JSON', async () => {
  await withFetch(async () => {
    globalThis.fetch = withJobFetch(JSON.stringify({ error: { message: 'Job lookup failed', code: 'job_not_found' } }), 500, { url: '', headers: {} });
    await assert.rejects(
      checkJob('job_3'),
      (error: unknown) => {
        if (!(error instanceof ShortVideoPublishError)) {
          return false;
        }
        assert.equal(error.message, 'Mallary job status request failed: Job lookup failed');
        assert.equal(error.message.includes('job_not_found'), false);
        return true;
      },
    );
  });
});

test('Mallary check keeps status and raw body in the error when no error.message exists', async () => {
  await withFetch(async () => {
    globalThis.fetch = withJobFetch('upstream exploded', 502, { url: '', headers: {} });
    await assert.rejects(
      checkJob('job_4'),
      (error: unknown) => error instanceof ShortVideoPublishError && error.message === 'Mallary job status request failed: 502 upstream exploded',
    );
  });
});

test('Mallary check tolerates empty strings and non-string error fields on completed jobs', async () => {
  await withFetch(async () => {
    globalThis.fetch = withJobFetch(JSON.stringify({
      data: {
        job: {
          status: 'completed',
          platform_post_url: '',
          failedReason: 42,
          error: { code: 'LEGACY', message: 'should not break parsing' },
          error_code: '',
          action_required: 'not-an-object',
        },
      },
    }), 200, { url: '', headers: {} });
    const state = await checkJob('job_10');
    assert.deepEqual(state, { status: 'live', url: null, error: null });
  });
});

test('Mallary check falls back through lenient failure reasons', async () => {
  const cases: Array<{ job: Record<string, unknown>; error: string }> = [
    { job: { status: 'failed', error: '', failedReason: '  ' }, error: 'Mallary job ended as failed without a reason.' },
    { job: { status: 'failed', failedReason: 'Kept reason', error: { code: 'E1' } }, error: 'Kept reason' },
    { job: { status: 'cancelled', error: { code: 'E2' }, error_code: 'CANCELLED' }, error: 'CANCELLED' },
  ];
  await withFetch(async () => {
    for (const testCase of cases) {
      globalThis.fetch = withJobFetch(JSON.stringify({ data: { job: testCase.job } }), 200, { url: '', headers: {} });
      const state = await checkJob('job_11');
      assert.deepEqual(state, { status: 'failed', url: null, error: testCase.error });
    }
  });
});
