import assert from 'node:assert/strict';
import test from 'node:test';
import { BufferClient } from '../src/infra/buffer.js';
import { ShortVideoPublishError } from '../src/infra/instagram-publisher.js';

test('Buffer Instagram reels omit rejected custom video thumbnails', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: { query?: string; variables?: Record<string, unknown> } | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
    return new Response(JSON.stringify({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'post-123' } } } }), { status: 200 });
  };
  try {
    const client = new BufferClient({
      apiKey: 'key',
      instagramChannelId: 'instagram-channel',
      publicAssetHost: { name: 'test', hostFile: async (path: string) => `https://cdn.test/${path}` },
    });
    const result = await client.publishShortVideo({
      platform: 'instagram',
      filePath: 'video.mp4',
      thumbnailPath: 'cover.jpg',
      commentsUnderPost: ['Fonte: https://example.com'],
      message: 'Legenda',
      idempotencyKey: 'key',
    });
    assert.deepEqual(result.jobs, [{ platform: 'instagram', jobId: 'post-123' }]);
    assert.ok(requestBody?.query);
    assert.equal(requestBody.query.includes('thumbnailUrl'), false);
    assert.equal(requestBody.query.includes('firstComment'), false);
    assert.equal(requestBody.variables?.thumbnailUrl, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Buffer does not report success without a post id', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { createPost: { __typename: 'PostActionSuccess' } } }), { status: 200 });
  try {
    const client = new BufferClient({
      apiKey: 'key',
      instagramChannelId: 'instagram-channel',
      publicAssetHost: { name: 'test', hostFile: async () => 'https://cdn.test/video.mp4' },
    });
    await assert.rejects(
      client.publishShortVideo({ platform: 'instagram', filePath: 'video.mp4', message: 'Legenda', idempotencyKey: 'key' }),
      (error: unknown) => error instanceof ShortVideoPublishError
        && error.message === 'Buffer createPost succeeded without a post id.'
        && error.safeToFailover === false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('Buffer propagates concrete mutation errors instead of reporting queued', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: { createPost: { __typename: 'InvalidInputError', message: 'thumbnailUrl is not supported' } },
  }), { status: 200 });
  try {
    const client = new BufferClient({
      apiKey: 'key',
      instagramChannelId: 'instagram-channel',
      publicAssetHost: { name: 'test', hostFile: async () => 'https://cdn.test/video.mp4' },
    });
    await assert.rejects(
      client.publishShortVideo({ platform: 'instagram', filePath: 'video.mp4', message: 'Legenda', idempotencyKey: 'key' }),
      (error: unknown) => error instanceof ShortVideoPublishError && error.message === 'Buffer createPost failed: thumbnailUrl is not supported',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function bufferStatusClient(): BufferClient {
  return new BufferClient({
    apiKey: 'key',
    instagramChannelId: 'instagram-channel',
    publicAssetHost: { name: 'test', hostFile: async () => 'https://cdn.test/video.mp4' },
  });
}

test('Buffer check maps sent to live with the external link', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: { query?: string; variables?: Record<string, unknown> } | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
    return new Response(JSON.stringify({ data: { post: { status: 'sent', externalLink: 'https://www.instagram.com/reel/abc/' } } }), { status: 200 });
  };
  try {
    const state = await bufferStatusClient().checkPublication({ provider: 'buffer', platform: 'instagram', remoteJobId: 'post-123' });
    assert.deepEqual(state, { status: 'live', url: 'https://www.instagram.com/reel/abc/', error: null });
    assert.match(requestBody?.query ?? '', /post\(input: \{ id: \$id \}\)/);
    assert.deepEqual(requestBody?.variables, { id: 'post-123' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Buffer check maps error to failed with the provider message', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: { post: { status: 'error', externalLink: null, error: { message: 'Instagram authorization was lost' } } },
  }), { status: 200 });
  try {
    const state = await bufferStatusClient().checkPublication({ provider: 'buffer', platform: 'instagram', remoteJobId: 'post-123' });
    assert.deepEqual(state, { status: 'failed', url: null, error: 'Instagram authorization was lost' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Buffer check treats every other status as pending', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { post: { status: 'processing', externalLink: null, error: null } } }), { status: 200 });
  try {
    const state = await bufferStatusClient().checkPublication({ provider: 'buffer', platform: 'tiktok', remoteJobId: 'post-9' });
    assert.deepEqual(state, { status: 'pending', url: null, error: null });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Buffer check rejects a response without a parseable post', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: {} }), { status: 200 });
  try {
    await assert.rejects(
      bufferStatusClient().checkPublication({ provider: 'buffer', platform: 'instagram', remoteJobId: 'post-404' }),
      /Buffer post status response was unexpected/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Buffer check tolerates empty links and non-string error shapes', async () => {
  const originalFetch = globalThis.fetch;
  const cases: Array<{ post: Record<string, unknown>; state: { status: string; url: string | null; error: string | null } }> = [
    {
      post: { status: 'sent', externalLink: '', error: 'not-an-object' },
      state: { status: 'live', url: null, error: null },
    },
    {
      post: { status: 'error', externalLink: 42, error: { message: '' } },
      state: { status: 'failed', url: null, error: 'Buffer reported an error without a message for post-123.' },
    },
    {
      post: { status: 'sent', externalLink: 'https://www.instagram.com/reel/def/' },
      state: { status: 'live', url: 'https://www.instagram.com/reel/def/', error: null },
    },
  ];
  try {
    for (const testCase of cases) {
      globalThis.fetch = async () => new Response(JSON.stringify({ data: { post: testCase.post } }), { status: 200 });
      const state = await bufferStatusClient().checkPublication({ provider: 'buffer', platform: 'instagram', remoteJobId: 'post-123' });
      assert.deepEqual(state, testCase.state);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
