import { PublicAssetHost } from './public-asset-host.js';
import type { InstagramPublishInput, InstagramPublishProvider, InstagramPublishResult } from './instagram-publisher.js';
import { InstagramPublishError } from './instagram-publisher.js';
import { logError } from './util.js';

interface BufferClientOptions {
  apiKey: string;
  organizationId?: string | null;
  instagramChannelId?: string | null;
  instagramChannelName?: string | null;
  publicAssetHost: PublicAssetHost;
}

interface BufferGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface BufferChannel {
  id: string;
  name?: string | null;
  displayName?: string | null;
  service?: string | null;
  isLocked?: boolean | null;
}

export class BufferClient implements InstagramPublishProvider {
  readonly name = 'buffer';
  readonly capabilities = {
    commentsUnderPostMax: 1,
    customThumbnail: true,
  } as const;

  private cachedChannelId: string | null = null;

  constructor(private readonly options: BufferClientOptions) {}

  async publishInstagramReel(input: InstagramPublishInput): Promise<InstagramPublishResult> {
    const channelId = await this.resolveInstagramChannelId();
    const videoUrl = await this.hostAsset(input.filePath);
    const thumbnailUrl = input.thumbnailPath ? await this.hostAsset(input.thumbnailPath) : null;
    const firstComment = normalizeFirstComment(input.commentsUnderPost);
    const response = await this.callGraphQL<{
      createPost?: {
        __typename?: string;
        message?: string;
        post?: { id?: string | null } | null;
      };
    }>({
      title: 'create-buffer-instagram-reel',
      stage: 'create',
      query: `
        mutation CreateInstagramReel($channelId: ChannelId!, $text: String!, $videoUrl: String!, $thumbnailUrl: String, $firstComment: String) {
          createPost(input: {
            channelId: $channelId
            text: $text
            schedulingType: automatic
            mode: addToQueue
            assets: [{ video: { url: $videoUrl, thumbnailUrl: $thumbnailUrl } }]
            metadata: { instagram: { type: reel, firstComment: $firstComment } }
          }) {
            __typename
            ... on PostActionSuccess {
              post {
                id
              }
            }
            ... on MutationError {
              message
            }
          }
        }
      `,
      variables: {
        channelId,
        text: input.message,
        videoUrl,
        thumbnailUrl,
        firstComment,
      },
      safeToFailover: true,
    });
    const result = response.data?.createPost;
    if (!result) {
      throw new InstagramPublishError({
        provider: this.name,
        stage: 'create',
        message: 'Buffer createPost response was empty.',
        safeToFailover: true,
      });
    }
    if (result.__typename === 'MutationError') {
      throw new InstagramPublishError({
        provider: this.name,
        stage: 'create',
        message: `Buffer createPost failed: ${result.message ?? 'unknown mutation error'}`,
        safeToFailover: true,
      });
    }
    return {
      provider: this.name,
      status: 'queued',
      batchId: null,
      jobs: [{ platform: 'instagram', jobId: String(result.post?.id ?? '') }].filter((entry) => entry.jobId.length > 0),
    };
  }

  private async resolveInstagramChannelId(): Promise<string> {
    if (this.cachedChannelId) {
      return this.cachedChannelId;
    }
    if (this.options.instagramChannelId) {
      this.cachedChannelId = this.options.instagramChannelId;
      return this.cachedChannelId;
    }
    const organizationId = await this.resolveOrganizationId();
    const response = await this.callGraphQL<{ channels?: BufferChannel[] }>({
      title: 'buffer-list-channels',
      stage: 'discovery',
      query: `
        query GetChannels($organizationId: OrganizationId!) {
          channels(input: { organizationId: $organizationId }) {
            id
            name
            displayName
            service
            isLocked
          }
        }
      `,
      variables: { organizationId },
      safeToFailover: true,
    });
    const channels = (response.data?.channels ?? []).filter((channel) => channel.service === 'instagram' && !channel.isLocked);
    const configuredName = this.options.instagramChannelName?.trim().toLowerCase();
    const matchingChannels = configuredName
      ? channels.filter((channel) => [channel.name, channel.displayName].some((value) => value?.trim().toLowerCase() === configuredName))
      : channels;
    if (matchingChannels.length === 1) {
      this.cachedChannelId = matchingChannels[0]!.id;
      return this.cachedChannelId;
    }
    if (matchingChannels.length === 0) {
      throw new InstagramPublishError({
        provider: this.name,
        stage: 'discovery',
        message: configuredName
          ? `No unlocked Instagram Buffer channel matched ${this.options.instagramChannelName}.`
          : 'No unlocked Instagram Buffer channel was found.',
        safeToFailover: true,
      });
    }
    throw new InstagramPublishError({
      provider: this.name,
      stage: 'discovery',
      message: configuredName
        ? `Multiple Instagram Buffer channels matched ${this.options.instagramChannelName}; set BUFFER_INSTAGRAM_CHANNEL_ID.`
        : 'Multiple unlocked Instagram Buffer channels found; set BUFFER_INSTAGRAM_CHANNEL_ID.',
      safeToFailover: true,
    });
  }

  private async resolveOrganizationId(): Promise<string> {
    if (this.options.organizationId) {
      return this.options.organizationId;
    }
    const response = await this.callGraphQL<{ account?: { organizations?: Array<{ id?: string | null }> } }>({
      title: 'buffer-list-organizations',
      stage: 'discovery',
      query: `
        query GetOrganizations {
          account {
            organizations {
              id
            }
          }
        }
      `,
      variables: {},
      safeToFailover: true,
    });
    const organizations = (response.data?.account?.organizations ?? []).map((entry) => entry.id ?? '').filter((entry) => entry.length > 0);
    if (organizations.length === 1) {
      return organizations[0]!;
    }
    throw new InstagramPublishError({
      provider: this.name,
      stage: 'discovery',
      message: organizations.length === 0
        ? 'No Buffer organizations found for the API key.'
        : 'Multiple Buffer organizations found; set BUFFER_ORGANIZATION_ID.',
      safeToFailover: true,
    });
  }

  private async hostAsset(path: string): Promise<string> {
    try {
      return await this.options.publicAssetHost.hostFile(path);
    } catch (error) {
      logError('Buffer public asset hosting failed', error, { path, assetHost: this.options.publicAssetHost.name });
      throw new InstagramPublishError({
        provider: this.name,
        stage: 'upload',
        message: `Buffer asset hosting failed for ${path}`,
        safeToFailover: true,
        cause: error,
      });
    }
  }

  private async callGraphQL<T>(input: {
    title: string;
    stage: 'discovery' | 'create';
    query: string;
    variables: Record<string, unknown>;
    safeToFailover: boolean;
  }): Promise<BufferGraphQLResponse<T>> {
    let response: Response;
    try {
      response = await fetch('https://api.buffer.com', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: input.query, variables: input.variables }),
      });
    } catch (error) {
      logError('Buffer API request failed', error, { title: input.title, stage: input.stage });
      throw new InstagramPublishError({
        provider: this.name,
        stage: input.stage,
        message: `Buffer request failed during ${input.title}`,
        safeToFailover: false,
        cause: error,
      });
    }
    const payload = await response.json().catch(() => undefined) as BufferGraphQLResponse<T> | undefined;
    if (!response.ok) {
      const message = payload?.errors?.map((entry) => entry.message).filter(Boolean).join(' | ') || `${response.status}`;
      throw new InstagramPublishError({
        provider: this.name,
        stage: input.stage,
        message: `Buffer request failed: ${message}`,
        safeToFailover: response.status < 500 && input.safeToFailover,
      });
    }
    if (payload?.errors?.length) {
      throw new InstagramPublishError({
        provider: this.name,
        stage: input.stage,
        message: `Buffer GraphQL error: ${payload.errors.map((entry) => entry.message).filter(Boolean).join(' | ')}`,
        safeToFailover: input.safeToFailover,
      });
    }
    return payload ?? {};
  }
}

function normalizeFirstComment(values: string[] | undefined): string | null {
  const value = values?.map((entry) => entry.replace(/\s+/g, ' ').trim()).find((entry) => entry.length > 0);
  return value ?? null;
}
