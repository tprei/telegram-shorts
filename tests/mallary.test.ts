import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MallaryUploadClient, buildMallaryInstagramReelPayload, buildPublishMessage, mallaryMimeType, parseMallaryRetryAfterSeconds } from '../src/infra/mallary.js';

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
