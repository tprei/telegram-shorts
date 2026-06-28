import { AppConfig } from './env.js';
import { logError, describeError } from './util.js';
import { BufferClient } from './buffer.js';
import { MallaryClient } from './mallary.js';
import { createPublicAssetHost } from './public-asset-host.js';
import { InstagramPublishError, InstagramPublishInput, InstagramPublishProvider, InstagramPublishResult } from './instagram-publisher.js';

export function createInstagramPublishProvider(config: AppConfig): InstagramPublishProvider | null {
  const providers: InstagramPublishProvider[] = [];
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
  return new FallbackInstagramPublishProvider(providers);
}

class FallbackInstagramPublishProvider implements InstagramPublishProvider {
  readonly name: string;
  readonly capabilities: { commentsUnderPostMax: number; customThumbnail: boolean };

  constructor(private readonly providers: InstagramPublishProvider[]) {
    this.name = providers.map((provider) => provider.name).join(',');
    this.capabilities = {
      commentsUnderPostMax: Math.max(...providers.map((provider) => provider.capabilities.commentsUnderPostMax)),
      customThumbnail: providers.some((provider) => provider.capabilities.customThumbnail),
    };
  }

  async publishInstagramReel(input: InstagramPublishInput): Promise<InstagramPublishResult> {
    const failures: string[] = [];
    for (const provider of this.providers) {
      try {
        return await provider.publishInstagramReel(input);
      } catch (error) {
        failures.push(`${provider.name}: ${describeError(error)}`);
        const safeToFailover = error instanceof InstagramPublishError && error.safeToFailover;
        if (!safeToFailover) {
          throw error;
        }
        logError('Instagram provider failed; trying fallback provider', error, { provider: provider.name });
      }
    }
    throw new Error(`All Instagram publish providers failed: ${failures.join(' | ')}`);
  }
}

function parseProviderOrder(value: string): Array<'mallary' | 'buffer'> {
  const providers = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is 'mallary' | 'buffer' => entry === 'mallary' || entry === 'buffer');
  return providers.length > 0 ? providers : ['mallary', 'buffer'];
}
