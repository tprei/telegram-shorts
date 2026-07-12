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
