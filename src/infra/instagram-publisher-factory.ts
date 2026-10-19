import type { AppConfig } from './env.js';
import { logError, describeError } from './util.js';
import { BufferClient } from './buffer.js';
import { MallaryClient, MallaryUploadClient } from './mallary.js';
import { createPublicAssetHost } from './public-asset-host.js';
import type { PublishingAccount, ShortVideoPlatform } from '../domain/model.js';
import type { ShortVideoCheckPublicationInput, ShortVideoPublishInput, ShortVideoPublishProvider, ShortVideoPublishResult, RemotePublicationState } from './instagram-publisher.js';
import { ShortVideoPublishError } from './instagram-publisher.js';

export function createShortVideoPublishProvider(config: AppConfig): ShortVideoPublishProvider | null {
  const providers: ShortVideoPublishProvider[] = [];
  const order = parseProviderOrder(config.SHORTS_PUBLISH_PROVIDERS);
  const mallaryUploads = config.MALLARY_AI_API_TOKEN ? new MallaryUploadClient(config.MALLARY_AI_API_TOKEN) : null;
  const publicAssetHost = createPublicAssetHost(config, mallaryUploads);

  for (const providerName of order) {
    if (providerName === 'mallary' && config.MALLARY_AI_API_TOKEN && mallaryUploads) {
      providers.push(new MallaryClient(config.MALLARY_AI_API_TOKEN, mallaryUploads));
      continue;
    }
    if (providerName === 'buffer' && config.BUFFER_API_KEY && publicAssetHost) {
      providers.push(new BufferClient({
        apiKey: config.BUFFER_API_KEY,
        organizationId: config.BUFFER_ORGANIZATION_ID,
        instagramChannelId: config.BUFFER_INSTAGRAM_CHANNEL_ID,
        instagramChannelName: config.BUFFER_INSTAGRAM_CHANNEL_NAME,
        tiktokChannelId: config.BUFFER_TIKTOK_CHANNEL_ID,
        tiktokChannelName: config.BUFFER_TIKTOK_CHANNEL_NAME,
        youtubeChannelId: config.BUFFER_YOUTUBE_CHANNEL_ID,
        youtubeChannelName: config.BUFFER_YOUTUBE_CHANNEL_NAME,
        publicAssetHost,
      }));
    }
  }

  if (providers.length === 0) {
    return null;
  }
  return new FallbackShortVideoPublishProvider(providers, {
    instagram: order,
    tiktok: ['buffer', 'mallary'],
    youtube_shorts: ['buffer', 'mallary'],
  });
}

export class FallbackShortVideoPublishProvider implements ShortVideoPublishProvider {
  readonly name: string;
  readonly supportedPlatforms: ShortVideoPlatform[];
  readonly supportsScheduling: boolean;

  constructor(
    private readonly providers: ShortVideoPublishProvider[],
    private readonly providerOrderByPlatform: Record<ShortVideoPlatform, Array<'mallary' | 'buffer'>>,
  ) {
    this.name = providers.map((provider) => provider.name).join(',');
    this.supportedPlatforms = Array.from(new Set(providers.flatMap((provider) => provider.supportedPlatforms)));
    this.supportsScheduling = providers.some((provider) => provider.supportsScheduling);
  }

  supports(platform: ShortVideoPlatform): boolean {
    return this.providers.some((provider) => provider.supports(platform));
  }
  canPublish(input: { account: PublishingAccount; platform: ShortVideoPlatform; scheduled: boolean }): boolean {
    if (input.account.mallaryProfileId === null || !input.account.platforms.includes(input.platform)) {
      return false;
    }
    const eligibleProviders = this.orderedProvidersForPlatform(input.platform, input.account);
    if (input.scheduled) {
      return eligibleProviders.some((provider) => provider.supportsScheduling && provider.canPublish(input));
    }
    return eligibleProviders.some((provider) => provider.canPublish(input));
  }

  async publishShortVideo(input: ShortVideoPublishInput): Promise<ShortVideoPublishResult> {
    if (input.account.mallaryProfileId === null) {
      throw new ShortVideoPublishError({
        provider: this.name,
        stage: 'configuration',
        message: 'Account not connected in Mallary',
        safeToFailover: false,
      });
    }
    if (!input.account.platforms.includes(input.platform)) {
      throw new ShortVideoPublishError({
        provider: this.name,
        stage: 'configuration',
        message: `Publishing to ${input.platform} is disabled for ${input.account.displayName}.`,
        safeToFailover: false,
      });
    }
    let eligibleProviders = this.orderedProvidersForPlatform(input.platform, input.account);
    if (input.scheduledAt !== null) {
      eligibleProviders = eligibleProviders.filter((provider) => provider.supportsScheduling);
      if (eligibleProviders.length === 0) {
        throw new Error(`No provider can schedule ${input.platform}.`);
      }
    }
    if (eligibleProviders.length === 0) {
      throw new Error(`No short-video provider supports ${input.platform}.`);
    }
    const failures: string[] = [];
    for (const provider of eligibleProviders) {
      try {
        return await provider.publishShortVideo(input);
      } catch (error) {
        failures.push(`${provider.name}: ${error instanceof ShortVideoPublishError ? error.message : describeError(error)}`);
        const safeToFailover = error instanceof ShortVideoPublishError && error.safeToFailover;
        if (!safeToFailover) {
          throw error;
        }
        logError('Short-video provider failed; trying fallback provider', error, { provider: provider.name, platform: input.platform });
      }
    }
    throw new Error(`All short-video publish providers failed for ${input.platform}: ${failures.join(' | ')}`);
  }

  async checkPublication(input: ShortVideoCheckPublicationInput): Promise<RemotePublicationState> {
    const provider = this.providers.find((entry) => entry.name === input.provider);
    if (!provider) {
      throw new ShortVideoPublishError({
        provider: input.provider,
        stage: 'discovery',
        message: `No publish provider named ${input.provider} is configured to check ${input.platform}.`,
        safeToFailover: false,
      });
    }
    return provider.checkPublication(input);
  }

  async cancelScheduled(input: ShortVideoCheckPublicationInput): Promise<void> {
    const provider = this.providers.find((entry) => entry.name === input.provider);
    if (!provider) {
      throw new ShortVideoPublishError({
        provider: input.provider,
        stage: 'cancel',
        message: `No publish provider named ${input.provider} is configured to cancel ${input.platform}.`,
        safeToFailover: false,
      });
    }
    await provider.cancelScheduled(input);
  }

  private orderedProvidersForPlatform(platform: ShortVideoPlatform, account: PublishingAccount): ShortVideoPublishProvider[] {
    const preferred = this.providerOrderByPlatform[platform] ?? ['mallary', 'buffer'];
    return this.providers
      .filter((provider) => {
        if (!provider.supports(platform)) {
          return false;
        }
        if (provider.name === 'buffer' && !account.buffer) {
          return false;
        }
        if (provider.name === 'mallary' && account.mallaryProfileId === null) {
          return false;
        }
        return provider.canPublish({ account, platform, scheduled: false });
      })
      .sort((left, right) => preferred.indexOf(left.name as 'mallary' | 'buffer') - preferred.indexOf(right.name as 'mallary' | 'buffer'));
  }
}

function parseProviderOrder(value: string): Array<'mallary' | 'buffer'> {
  const providers = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is 'mallary' | 'buffer' => entry === 'mallary' || entry === 'buffer');
  return providers.length > 0 ? providers : ['mallary', 'buffer'];
}
