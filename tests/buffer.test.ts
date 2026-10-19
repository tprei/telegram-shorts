import assert from 'node:assert/strict';
import test from 'node:test';
import { BufferClient } from '../src/infra/buffer.js';
import { FallbackShortVideoPublishProvider } from '../src/infra/instagram-publisher-factory.js';
import { ShortVideoPublishError } from '../src/infra/instagram-publisher.js';
import type { ShortVideoCheckPublicationInput, ShortVideoPublishInput, ShortVideoPublishProvider, ShortVideoPublishResult } from '../src/infra/instagram-publisher.js';
import type { PublishingAccount, ShortVideoPlatform } from '../src/domain/model.js';

const BONI_ACCOUNT: PublishingAccount = {
  id: 'cortes_do_boni',
  displayName: 'Cortes do Boni',
  schedule: { timeZone: 'America/Sao_Paulo', slots: ['12:00', '19:00', '21:00'] },
  platforms: ['instagram', 'tiktok', 'youtube_shorts'],
  mallaryProfileId: 'S83DPA58Wwx',
  buffer: true,
};

const MIX_ACCOUNT: PublishingAccount = {
  id: 'mix',
  displayName: 'Mix',
  schedule: { timeZone: 'America/Sao_Paulo', slots: ['12:00', '19:00', '21:00'] },
  platforms: ['instagram', 'tiktok'],
  mallaryProfileId: 'mix_mallary_id',
  buffer: false,
};

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
      account: BONI_ACCOUNT,
      filePath: 'video.mp4',
      thumbnailPath: 'cover.jpg',
      commentsUnderPost: ['Fonte: https://example.com'],
      message: 'Legenda',
      idempotencyKey: 'key',
      scheduledAt: null,
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
      client.publishShortVideo({ platform: 'instagram', account: BONI_ACCOUNT, filePath: 'video.mp4', message: 'Legenda', idempotencyKey: 'key', scheduledAt: null }),
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
      client.publishShortVideo({ platform: 'instagram', account: BONI_ACCOUNT, filePath: 'video.mp4', message: 'Legenda', idempotencyKey: 'key', scheduledAt: null }),
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

test('Buffer cannot publish YouTube Shorts without a configured YouTube channel', () => {
  const withoutYouTube = new BufferClient({
    apiKey: 'key',
    organizationId: 'org-1',
    instagramChannelId: 'instagram-channel',
    publicAssetHost: { name: 'test', hostFile: async () => 'https://cdn.test/video.mp4' },
  });
  assert.equal(withoutYouTube.canPublish({ account: BONI_ACCOUNT, platform: 'youtube_shorts', scheduled: false }), false);
  assert.equal(withoutYouTube.canPublish({ account: BONI_ACCOUNT, platform: 'instagram', scheduled: false }), true);

  const withYouTube = new BufferClient({
    apiKey: 'key',
    organizationId: 'org-1',
    youtubeChannelId: 'youtube-channel',
    publicAssetHost: { name: 'test', hostFile: async () => 'https://cdn.test/video.mp4' },
  });
  assert.equal(withYouTube.canPublish({ account: BONI_ACCOUNT, platform: 'youtube_shorts', scheduled: false }), true);
});

test('Buffer cannot schedule and refuses to cancel scheduled posts', async () => {
  const client = bufferStatusClient();
  assert.equal(client.supportsScheduling, false);
  await assert.rejects(
    client.cancelScheduled({ provider: 'buffer', platform: 'instagram', remoteJobId: 'post-1' }),
    (error: unknown) => error instanceof ShortVideoPublishError
      && error.stage === 'cancel'
      && error.message === "Buffer posts can't be cancelled from the studio."
      && error.safeToFailover === false,
  );
});

interface ScriptedProviderOptions {
  supportsScheduling: boolean;
  result: ShortVideoPublishResult;
  cancelError?: Error;
  canPublish?: (input: { account: PublishingAccount; platform: ShortVideoPlatform; scheduled: boolean }) => boolean;
  failWithSafe?: boolean;
  failWithUnsafe?: boolean;
}

function scriptedProvider(
  name: string,
  publishCalls: ShortVideoPublishInput[],
  cancelCalls: ShortVideoCheckPublicationInput[],
  options: ScriptedProviderOptions,
): ShortVideoPublishProvider {
  return {
    name,
    supportedPlatforms: ['instagram', 'tiktok', 'youtube_shorts'],
    supportsScheduling: options.supportsScheduling,
    supports: () => true,
    canPublish: (input) => {
      if (options.canPublish) {
        return options.canPublish(input);
      }
      if (input.scheduled && !options.supportsScheduling) {
        return false;
      }
      if (name === 'buffer' && (!input.account.buffer || input.scheduled)) {
        return false;
      }
      if (name === 'mallary' && input.account.mallaryProfileId === null) {
        return false;
      }
      return true;
    },
    publishShortVideo: async (input) => {
      publishCalls.push(input);
      if (options.failWithSafe) {
        throw new ShortVideoPublishError({
          provider: name,
          stage: 'create',
          message: `${name} transient failure`,
          safeToFailover: true,
        });
      }
      if (options.failWithUnsafe) {
        throw new ShortVideoPublishError({
          provider: name,
          stage: 'create',
          message: `${name} permanent rejection`,
          safeToFailover: false,
        });
      }
      return options.result;
    },
    checkPublication: async () => ({ status: 'pending', url: null, error: null }),
    cancelScheduled: async (input) => {
      cancelCalls.push(input);
      if (options.cancelError) {
        throw options.cancelError;
      }
    },
  };
}

const BUFFER_STYLE_RESULT: ShortVideoPublishResult = { provider: 'buffer', platform: 'instagram', status: 'queued', batchId: null, jobs: [{ platform: 'instagram', jobId: 'buffer-1' }] };
const MALLARY_STYLE_RESULT: ShortVideoPublishResult = { provider: 'mallary', platform: 'instagram', status: 'queued', batchId: null, jobs: [{ platform: 'instagram', jobId: 'mallary-1' }] };

function fallbackProviderOrder(): Record<'instagram' | 'tiktok' | 'youtube_shorts', Array<'mallary' | 'buffer'>> {
  return { instagram: ['buffer', 'mallary'], tiktok: ['buffer', 'mallary'], youtube_shorts: ['buffer', 'mallary'] };
}

test('the fallback provider skips providers without scheduling support for scheduled posts', async () => {
  const bufferPublishCalls: ShortVideoPublishInput[] = [];
  const mallaryPublishCalls: ShortVideoPublishInput[] = [];
  const fallback = new FallbackShortVideoPublishProvider(
    [
      scriptedProvider('buffer', bufferPublishCalls, [], { supportsScheduling: false, result: BUFFER_STYLE_RESULT }),
      scriptedProvider('mallary', mallaryPublishCalls, [], { supportsScheduling: true, result: MALLARY_STYLE_RESULT }),
    ],
    fallbackProviderOrder(),
  );
  assert.equal(fallback.supportsScheduling, true);

  const scheduled = await fallback.publishShortVideo({
    platform: 'instagram',
    account: BONI_ACCOUNT,
    filePath: 'video.mp4',
    message: 'Legenda',
    idempotencyKey: 'k1',
    scheduledAt: '2026-10-25T19:00:00.000Z',
  });
  assert.equal(scheduled.provider, 'mallary');
  assert.equal(bufferPublishCalls.length, 0);
  assert.equal(mallaryPublishCalls.length, 1);

  const immediate = await fallback.publishShortVideo({
    platform: 'instagram',
    account: BONI_ACCOUNT,
    filePath: 'video.mp4',
    message: 'Legenda',
    idempotencyKey: 'k2',
    scheduledAt: null,
  });
  assert.equal(immediate.provider, 'buffer');
  assert.equal(bufferPublishCalls.length, 1);
  assert.equal(mallaryPublishCalls.length, 1);
});

test('the fallback provider refuses scheduled posts when no provider can schedule', async () => {
  const bufferPublishCalls: ShortVideoPublishInput[] = [];
  const fallback = new FallbackShortVideoPublishProvider(
    [scriptedProvider('buffer', bufferPublishCalls, [], { supportsScheduling: false, result: BUFFER_STYLE_RESULT })],
    fallbackProviderOrder(),
  );
  assert.equal(fallback.supportsScheduling, false);
  await assert.rejects(
    fallback.publishShortVideo({
      platform: 'instagram',
      account: BONI_ACCOUNT,
      filePath: 'video.mp4',
      message: 'Legenda',
      idempotencyKey: 'k3',
      scheduledAt: '2026-10-25T19:00:00.000Z',
    }),
  );
  assert.equal(bufferPublishCalls.length, 0);
});

test('the fallback provider cancels scheduled posts by provider name', async () => {
  const cancelCalls: ShortVideoCheckPublicationInput[] = [];
  const fallback = new FallbackShortVideoPublishProvider(
    [
      bufferStatusClient(),
      scriptedProvider('mallary', [], cancelCalls, { supportsScheduling: true, result: MALLARY_STYLE_RESULT }),
    ],
    fallbackProviderOrder(),
  );
  await fallback.cancelScheduled({ provider: 'mallary', platform: 'instagram', remoteJobId: 'mallary-9' });
  assert.deepEqual(cancelCalls, [{ provider: 'mallary', platform: 'instagram', remoteJobId: 'mallary-9' }]);

  await assert.rejects(
    fallback.cancelScheduled({ provider: 'buffer', platform: 'instagram', remoteJobId: 'post-1' }),
    (error: unknown) => error instanceof ShortVideoPublishError
      && error.stage === 'cancel'
      && error.message === "Buffer posts can't be cancelled from the studio.",
  );
  await assert.rejects(
    fallback.cancelScheduled({ provider: 'unknown', platform: 'instagram', remoteJobId: 'post-2' }),
    (error: unknown) => error instanceof ShortVideoPublishError
      && error.stage === 'cancel'
      && error.message === 'No publish provider named unknown is configured to cancel instagram.',
  );
});

test('Mix never uses Boni Buffer channels during provider failover', async () => {
  const mallaryPublishCalls: ShortVideoPublishInput[] = [];
  const bufferPublishCalls: ShortVideoPublishInput[] = [];
  const fallback = new FallbackShortVideoPublishProvider(
    [
      scriptedProvider('mallary', mallaryPublishCalls, [], {
        supportsScheduling: true,
        result: MALLARY_STYLE_RESULT,
        failWithSafe: true,
      }),
      scriptedProvider('buffer', bufferPublishCalls, [], {
        supportsScheduling: false,
        result: BUFFER_STYLE_RESULT,
      }),
    ],
    fallbackProviderOrder(),
  );

  await assert.rejects(
    fallback.publishShortVideo({
      platform: 'instagram',
      account: MIX_ACCOUNT,
      filePath: 'video.mp4',
      message: 'Legenda',
      idempotencyKey: 'k_mix_1',
      scheduledAt: null,
    }),
    /All short-video publish providers failed for instagram: mallary: mallary transient failure/,
  );
  assert.equal(mallaryPublishCalls.length, 1);
  assert.equal(bufferPublishCalls.length, 0);
});

test('Boni retains safe failover and stops on unsafe failure on all three platforms', async () => {
  const platforms: ShortVideoPlatform[] = ['instagram', 'tiktok', 'youtube_shorts'];
  for (const platform of platforms) {
    const mallaryCalls1: ShortVideoPublishInput[] = [];
    const bufferCalls1: ShortVideoPublishInput[] = [];
    const fallbackSafe = new FallbackShortVideoPublishProvider(
      [
        scriptedProvider('mallary', mallaryCalls1, [], {
          supportsScheduling: true,
          result: { ...MALLARY_STYLE_RESULT, platform },
          failWithSafe: true,
        }),
        scriptedProvider('buffer', bufferCalls1, [], {
          supportsScheduling: false,
          result: { ...BUFFER_STYLE_RESULT, platform },
        }),
      ],
      { instagram: ['mallary', 'buffer'], tiktok: ['mallary', 'buffer'], youtube_shorts: ['mallary', 'buffer'] },
    );

    const safeResult = await fallbackSafe.publishShortVideo({
      platform,
      account: BONI_ACCOUNT,
      filePath: 'video.mp4',
      message: 'Legenda',
      idempotencyKey: `k_safe_${platform}`,
      scheduledAt: null,
    });
    assert.equal(safeResult.provider, 'buffer');
    assert.equal(mallaryCalls1.length, 1);
    assert.equal(bufferCalls1.length, 1);
    assert.equal(mallaryCalls1[0]?.account.id, BONI_ACCOUNT.id);
    assert.equal(bufferCalls1[0]?.account.id, BONI_ACCOUNT.id);

    const mallaryCalls2: ShortVideoPublishInput[] = [];
    const bufferCalls2: ShortVideoPublishInput[] = [];
    const fallbackUnsafe = new FallbackShortVideoPublishProvider(
      [
        scriptedProvider('mallary', mallaryCalls2, [], {
          supportsScheduling: true,
          result: { ...MALLARY_STYLE_RESULT, platform },
          failWithUnsafe: true,
        }),
        scriptedProvider('buffer', bufferCalls2, [], {
          supportsScheduling: false,
          result: { ...BUFFER_STYLE_RESULT, platform },
        }),
      ],
      { instagram: ['mallary', 'buffer'], tiktok: ['mallary', 'buffer'], youtube_shorts: ['mallary', 'buffer'] },
    );

    await assert.rejects(
      fallbackUnsafe.publishShortVideo({
        platform,
        account: BONI_ACCOUNT,
        filePath: 'video.mp4',
        message: 'Legenda',
        idempotencyKey: `k_unsafe_${platform}`,
        scheduledAt: null,
      }),
      (error: unknown) => error instanceof ShortVideoPublishError
        && error.message === 'mallary permanent rejection'
        && error.safeToFailover === false,
    );
    assert.equal(mallaryCalls2.length, 1);
    assert.equal(bufferCalls2.length, 0);
  }
});

test('scheduled posts require an eligible Mallary provider for that account', async () => {
  const bufferCalls: ShortVideoPublishInput[] = [];
  const mallaryCalls: ShortVideoPublishInput[] = [];
  const fallback = new FallbackShortVideoPublishProvider(
    [
      scriptedProvider('buffer', bufferCalls, [], {
        supportsScheduling: false,
        result: BUFFER_STYLE_RESULT,
      }),
      scriptedProvider('mallary', mallaryCalls, [], {
        supportsScheduling: true,
        result: MALLARY_STYLE_RESULT,
      }),
    ],
    fallbackProviderOrder(),
  );

  const disconnectedAccount: PublishingAccount = {
    ...BONI_ACCOUNT,
    mallaryProfileId: null,
  };

  await assert.rejects(
    fallback.publishShortVideo({
      platform: 'instagram',
      account: disconnectedAccount,
      filePath: 'video.mp4',
      message: 'Legenda',
      idempotencyKey: 'k_sched_req',
      scheduledAt: '2026-10-25T19:00:00.000Z',
    }),
    (error: unknown) => error instanceof ShortVideoPublishError
      && error.message === 'Account not connected in Mallary',
  );
  assert.equal(bufferCalls.length, 0);
  assert.equal(mallaryCalls.length, 0);
});
