import { SHORT_VIDEO_PLATFORMS, type CreatorProfile, type PublishingAccount, type ShortVideoPlatform } from '../domain/model.js';
import type { PlatformAvailabilityDto } from '../studio/api-types.js';
import type { AppConfig } from '../infra/env.js';
import type { ShortVideoPublishProvider } from '../infra/instagram-publisher.js';
import type { ShortsStore } from '../infra/db.js';
import { nowIso } from '../infra/util.js';

export function mallaryCooldownKey(platform: ShortVideoPlatform): string {
  return `cooldown:mallary:${platform}`;
}

export function activeMallaryCooldownUntil(config: AppConfig, store: ShortsStore, platform: ShortVideoPlatform): string | null {
  if (!shouldUseMallaryCooldown(config, platform)) {
    return null;
  }
  const value = store.getSetting(mallaryCooldownKey(platform));
  if (!value) {
    return null;
  }
  return value > nowIso() ? value : null;
}

function shouldUseMallaryCooldown(config: AppConfig, platform: ShortVideoPlatform): boolean {
  return platform === 'instagram'
    && Boolean(config.MALLARY_AI_API_TOKEN)
    && preferredProvidersForPlatform(config, platform)[0] === 'mallary';
}

function preferredProvidersForPlatform(config: AppConfig, platform: ShortVideoPlatform): Array<'mallary' | 'buffer'> {
  if (platform === 'instagram') {
    const providers = config.SHORTS_PUBLISH_PROVIDERS
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry): entry is 'mallary' | 'buffer' => entry === 'mallary' || entry === 'buffer');
    return providers.length > 0 ? providers : ['mallary', 'buffer'];
  }
  return ['buffer', 'mallary'];
}

export function availabilityForPublishingProfile(input: {
  profile: CreatorProfile | null;
  account: PublishingAccount | null;
  missingReason: string;
  publisher: ShortVideoPublishProvider | null;
  config: AppConfig;
}): PlatformAvailabilityDto[] {
  return SHORT_VIDEO_PLATFORMS.map((platform): PlatformAvailabilityDto => {
    if (!input.profile) {
      return { platform, available: false, reason: input.missingReason, canSchedule: false };
    }
    if (!input.profile.enabled) {
      return { platform, available: false, reason: `Creator ${input.profile.displayName} is disabled.`, canSchedule: false };
    }
    if (!input.account) {
      return { platform, available: false, reason: 'No publishing account is assigned to this creator.', canSchedule: false };
    }
    if (input.account.mallaryProfileId === null) {
      return { platform, available: false, reason: 'Account not connected in Mallary', canSchedule: false };
    }
    if (!input.account.platforms.includes(platform)) {
      return { platform, available: false, reason: `Publishing to ${platformLabel(platform)} is disabled for ${input.profile.displayName}.`, canSchedule: false };
    }
    if (!input.publisher || !input.publisher.canPublish({ account: input.account, platform, scheduled: false })) {
      return { platform, available: false, reason: `No publish provider is configured for ${platformLabel(platform)}.`, canSchedule: false };
    }
    return {
      platform,
      available: true,
      reason: null,
      canSchedule: input.publisher.canPublish({ account: input.account, platform, scheduled: true }),
    };
  });
}

export function platformLabel(platform: ShortVideoPlatform): string {
  if (platform === 'instagram') {
    return 'Instagram';
  }
  if (platform === 'tiktok') {
    return 'TikTok';
  }
  return 'YouTube Shorts';
}
