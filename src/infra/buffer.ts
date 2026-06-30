import { PublicAssetHost } from './public-asset-host.js';
import type { ShortVideoPlatform, ShortVideoPublishInput, ShortVideoPublishProvider, ShortVideoPublishResult } from './instagram-publisher.js';
import { ShortVideoPublishError } from './instagram-publisher.js';
import { logError } from './util.js';

interface BufferClientOptions {
  apiKey: string;
  organizationId?: string | null;
  instagramChannelId?: string | null;
  instagramChannelName?: string | null;
  tiktokChannelId?: string | null;
  tiktokChannelName?: string | null;
  youtubeChannelId?: string | null;
  youtubeChannelName?: string | null;
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

export class BufferClient implements ShortVideoPublishProvider {
  readonly name = 'buffer';
  readonly supportedPlatforms: ShortVideoPlatform[] = ['instagram', 'tiktok', 'youtube_shorts'];

  private readonly cachedChannelIds = new Map<ShortVideoPlatform, string>();

  constructor(private readonly options: BufferClientOptions) {}

  supports(platform: ShortVideoPlatform): boolean {
    return this.supportedPlatforms.includes(platform);
  }

  async publishShortVideo(input: ShortVideoPublishInput): Promise<ShortVideoPublishResult> {
    if (input.platform === 'instagram') {
      return this.publishInstagram(input);
    }
    if (input.platform === 'tiktok') {
      return this.publishTikTok(input);
    }
    return this.publishYouTubeShort(input);
  }

  private async publishInstagram(input: ShortVideoPublishInput): Promise<ShortVideoPublishResult> {
    const channelId = await this.resolveChannelId('instagram');
    const videoUrl = await this.hostAsset(input.filePath);
    const thumbnailUrl = input.thumbnailPath ? await this.hostAsset(input.thumbnailPath) : null;
    const firstComment = normalizeFirstComment(input.commentsUnderPost);
    const result = await this.callCreatePost<{
      createPost?: {
        __typename?: string;
        message?: string;
        post?: { id?: string | null } | null;
      };
    }>({
      title: 'create-buffer-instagram-reel',
      query: `
        mutation CreateInstagramReel($channelId: ChannelId!, $text: String!, $videoUrl: String!, $thumbnailUrl: String, $firstComment: String) {
          createPost(input: {
            channelId: $channelId
            text: $text
            schedulingType: automatic
            mode: shareNow
            assets: [{ video: { url: $videoUrl, thumbnailUrl: $thumbnailUrl } }]
            metadata: { instagram: { type: reel, shouldShareToFeed: true, firstComment: $firstComment } }
          }) {
            __typename
            ... on PostActionSuccess { post { id } }
            ... on MutationError { message }
          }
        }
      `,
      variables: { channelId, text: input.message, videoUrl, thumbnailUrl, firstComment },
      platform: 'instagram',
    });
    return toPublishResult('buffer', 'instagram', result.data?.createPost);
  }

  private async publishTikTok(input: ShortVideoPublishInput): Promise<ShortVideoPublishResult> {
    const channelId = await this.resolveChannelId('tiktok');
    const videoUrl = await this.hostAsset(input.filePath);
    const thumbnailUrl = input.thumbnailPath ? await this.hostAsset(input.thumbnailPath) : null;
    const result = await this.callCreatePost<{
      createPost?: {
        __typename?: string;
        message?: string;
        post?: { id?: string | null } | null;
      };
    }>({
      title: 'create-buffer-tiktok-video',
      query: `
        mutation CreateTikTokVideo($channelId: ChannelId!, $text: String!, $videoUrl: String!, $thumbnailUrl: String) {
          createPost(input: {
            channelId: $channelId
            text: $text
            schedulingType: automatic
            mode: shareNow
            assets: [{ video: { url: $videoUrl, thumbnailUrl: $thumbnailUrl } }]
            metadata: { tiktok: { isAiGenerated: false } }
          }) {
            __typename
            ... on PostActionSuccess { post { id } }
            ... on MutationError { message }
          }
        }
      `,
      variables: { channelId, text: input.message, videoUrl, thumbnailUrl },
      platform: 'tiktok',
    });
    return toPublishResult('buffer', 'tiktok', result.data?.createPost);
  }

  private async publishYouTubeShort(input: ShortVideoPublishInput): Promise<ShortVideoPublishResult> {
    const channelId = await this.resolveChannelId('youtube_shorts');
    const videoUrl = await this.hostAsset(input.filePath);
    const title = normalizeYouTubeTitle(input.title ?? input.message);
    const result = await this.callCreatePost<{
      createPost?: {
        __typename?: string;
        message?: string;
        post?: { id?: string | null } | null;
      };
    }>({
      title: 'create-buffer-youtube-short',
      query: `
        mutation CreateYoutubeShort($channelId: ChannelId!, $text: String!, $videoUrl: String!, $title: String!) {
          createPost(input: {
            channelId: $channelId
            text: $text
            schedulingType: automatic
            mode: shareNow
            assets: [{ video: { url: $videoUrl } }]
            metadata: {
              youtube: {
                title: $title
                privacy: public
                categoryId: "22"
                notifySubscribers: true
                embeddable: true
                madeForKids: false
                isAiGenerated: false
              }
            }
          }) {
            __typename
            ... on PostActionSuccess { post { id } }
            ... on MutationError { message }
          }
        }
      `,
      variables: { channelId, text: input.message, videoUrl, title },
      platform: 'youtube_shorts',
    });
    return toPublishResult('buffer', 'youtube_shorts', result.data?.createPost);
  }

  private async resolveChannelId(platform: ShortVideoPlatform): Promise<string> {
    const cached = this.cachedChannelIds.get(platform);
    if (cached) {
      return cached;
    }
    const configuredId = configuredChannelId(this.options, platform);
    if (configuredId) {
      this.cachedChannelIds.set(platform, configuredId);
      return configuredId;
    }
    const organizationId = await this.resolveOrganizationId();
    const response = await this.callGraphQL<{ channels?: BufferChannel[] }>({
      title: `buffer-list-${platform}-channels`,
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
    const service = serviceForPlatform(platform);
    const channels = (response.data?.channels ?? []).filter((channel) => channel.service === service && !channel.isLocked);
    const configuredName = configuredChannelName(this.options, platform)?.trim().toLowerCase();
    const matchingChannels = configuredName
      ? channels.filter((channel) => [channel.name, channel.displayName].some((value) => value?.trim().toLowerCase() === configuredName))
      : channels;
    if (matchingChannels.length === 1) {
      const id = matchingChannels[0]!.id;
      this.cachedChannelIds.set(platform, id);
      return id;
    }
    if (matchingChannels.length === 0) {
      throw new ShortVideoPublishError({
        provider: this.name,
        stage: 'discovery',
        message: configuredName
          ? `No unlocked ${platform} Buffer channel matched ${configuredChannelName(this.options, platform)}.`
          : `No unlocked ${platform} Buffer channel was found.`,
        safeToFailover: true,
      });
    }
    throw new ShortVideoPublishError({
      provider: this.name,
      stage: 'discovery',
      message: configuredName
        ? `Multiple ${platform} Buffer channels matched ${configuredChannelName(this.options, platform)}; set the explicit channel id.`
        : `Multiple unlocked ${platform} Buffer channels found; set the explicit channel id.`,
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
            organizations { id }
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
    throw new ShortVideoPublishError({
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
      throw new ShortVideoPublishError({
        provider: this.name,
        stage: 'upload',
        message: `Buffer asset hosting failed for ${path}`,
        safeToFailover: true,
        cause: error,
      });
    }
  }

  private async callCreatePost<T>(input: {
    title: string;
    query: string;
    variables: Record<string, unknown>;
    platform: ShortVideoPlatform;
  }): Promise<BufferGraphQLResponse<T>> {
    return this.callGraphQL<T>({
      title: input.title,
      stage: 'create',
      query: input.query,
      variables: input.variables,
      safeToFailover: true,
    });
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
      throw new ShortVideoPublishError({
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
      throw new ShortVideoPublishError({
        provider: this.name,
        stage: input.stage,
        message: `Buffer request failed: ${message}`,
        safeToFailover: response.status < 500 && input.safeToFailover,
      });
    }
    if (payload?.errors?.length) {
      throw new ShortVideoPublishError({
        provider: this.name,
        stage: input.stage,
        message: `Buffer GraphQL error: ${payload.errors.map((entry) => entry.message).filter(Boolean).join(' | ')}`,
        safeToFailover: input.safeToFailover,
      });
    }
    return payload ?? {};
  }
}

function configuredChannelId(options: BufferClientOptions, platform: ShortVideoPlatform): string | null | undefined {
  if (platform === 'instagram') {
    return options.instagramChannelId;
  }
  if (platform === 'tiktok') {
    return options.tiktokChannelId;
  }
  return options.youtubeChannelId;
}

function configuredChannelName(options: BufferClientOptions, platform: ShortVideoPlatform): string | null | undefined {
  if (platform === 'instagram') {
    return options.instagramChannelName;
  }
  if (platform === 'tiktok') {
    return options.tiktokChannelName;
  }
  return options.youtubeChannelName;
}

function serviceForPlatform(platform: ShortVideoPlatform): string {
  if (platform === 'youtube_shorts') {
    return 'youtube';
  }
  return platform;
}

function toPublishResult(provider: string, platform: ShortVideoPlatform, result: { __typename?: string; message?: string; post?: { id?: string | null } | null } | undefined): ShortVideoPublishResult {
  if (!result) {
    throw new ShortVideoPublishError({
      provider,
      stage: 'create',
      message: 'Buffer createPost response was empty.',
      safeToFailover: true,
    });
  }
  if (result.__typename === 'MutationError') {
    throw new ShortVideoPublishError({
      provider,
      stage: 'create',
      message: `Buffer createPost failed: ${result.message ?? 'unknown mutation error'}`,
      safeToFailover: true,
    });
  }
  return {
    provider,
    platform,
    status: 'queued',
    batchId: null,
    jobs: [{ platform: platform === 'youtube_shorts' ? 'youtube' : platform, jobId: String(result.post?.id ?? '') }].filter((entry) => entry.jobId.length > 0),
  };
}

function normalizeFirstComment(values: string[] | undefined): string | null {
  const value = values?.map((entry) => entry.replace(/\s+/g, ' ').trim()).find((entry) => entry.length > 0);
  return value ?? null;
}

function normalizeYouTubeTitle(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) {
    return 'Shorts';
  }
  return compact.length <= 100 ? compact : compact.slice(0, 100);
}
