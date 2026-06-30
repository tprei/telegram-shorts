import { AppConfig } from './env.js';
import { logError, describeError } from './util.js';
import { BufferClient } from './buffer.js';
import { MallaryClient } from './mallary.js';
import { createPublicAssetHost } from './public-asset-host.js';
import { ShortVideoPublishError, ShortVideoPlatform, ShortVideoPublishInput, ShortVideoPublishProvider, ShortVideoPublishResult } from './instagram-publisher.js';

export function createInstagramPublishProvider(config: AppConfig): ShortVideoPublishProvider | null {
  const providers: ShortVideoPublishProvider[] = [];
  const order = parseProviderOrder(config.TELEGRAM_SHORTS_INSTAGRAM_PUBLISH_PROVIDERS);
  const publicAssetHost = createPublicAssetHost(config);

  for (const providerName of order) {
    if (providerName === 'mallary' && config.MALLARY_AI_API_TOKEN) {
      providers.push(new MallaryClient(config.MALLARY_AI_API_TOKEN, config.MALLARY_PROFILE_ID));
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
  if (providers.length === 1) {
    return providers[0];
  }
  return new FallbackShortVideoPublishProvider(providers, {
    instagram: order,
    tiktok: ['buffer', 'mallary'],
    youtube_shorts: ['buffer', 'mallary'],
  });
}

class FallbackShortVideoPublishProvider implements ShortVideoPublishProvider {
  readonly name: string;
  readonly supportedPlatforms: ShortVideoPlatform[];

  constructor(
    private readonly providers: ShortVideoPublishProvider[],
    private readonly providerOrderByPlatform: Record<ShortVideoPlatform, Array<'mallary' | 'buffer'>>,
  ) {
    this.name = providers.map((provider) => provider.name).join(',');
    this.supportedPlatforms = Array.from(new Set(providers.flatMap((provider) => provider.supportedPlatforms)));
  }

  supports(platform: ShortVideoPlatform): boolean {
    return this.providers.some((provider) => provider.supports(platform));
  }

  async publishShortVideo(input: ShortVideoPublishInput): Promise<ShortVideoPublishResult> {
    const eligibleProviders = this.orderedProvidersForPlatform(input.platform);
    if (eligibleProviders.length === 0) {
      throw new Error(`No short-video provider supports ${input.platform}.`);
    }
    const failures: string[] = [];
    for (const provider of eligibleProviders) {
      try {
        return await provider.publishShortVideo(input);
      } catch (error) {
        failures.push(`${provider.name}: ${describeError(error)}`);
        const safeToFailover = error instanceof ShortVideoPublishError && error.safeToFailover;
        if (!safeToFailover) {
          throw error;
        }
        logError('Short-video provider failed; trying fallback provider', error, { provider: provider.name, platform: input.platform });
      }
    }
    throw new Error(`All short-video publish providers failed for ${input.platform}: ${failures.join(' | ')}`);
  }

  private orderedProvidersForPlatform(platform: ShortVideoPlatform): ShortVideoPublishProvider[] {
    const preferred = this.providerOrderByPlatform[platform] ?? ['mallary', 'buffer'];
    return this.providers
      .filter((provider) => provider.supports(platform))
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
