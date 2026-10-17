import { SHORT_VIDEO_PLATFORMS, type CreatorProfile, type JobRecord, type ShortVideoPlatform } from '../domain/model.js';
import type { PlatformAvailabilityDto } from '../studio/api-types.js';
import { publishConfigForPlatform, type CreatorProfileRepository } from '../infra/creator-profile-loader.js';
import type { AppConfig } from '../infra/env.js';
import type { ShortVideoPublishProvider } from '../infra/instagram-publisher.js';
import type { ShortsStore } from '../infra/db.js';
import { nowIso } from '../infra/util.js';

export function configuredShortVideoPlatforms(config: AppConfig, publisher: ShortVideoPublishProvider | null): ShortVideoPlatform[] {
  const configured: ShortVideoPlatform[] = [];
  if (publisher?.supports('instagram') && (config.MALLARY_AI_API_TOKEN || (config.BUFFER_API_KEY && config.BUFFER_INSTAGRAM_CHANNEL_ID))) {
    configured.push('instagram');
  }
  if (publisher?.supports('tiktok') && (config.BUFFER_API_KEY && config.BUFFER_TIKTOK_CHANNEL_ID)) {
    configured.push('tiktok');
  }
  if (publisher?.supports('youtube_shorts') && (config.BUFFER_API_KEY && config.BUFFER_YOUTUBE_CHANNEL_ID)) {
    configured.push('youtube_shorts');
  }
  return configured;
}

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

function availabilityForProfile(profile: CreatorProfile | null, missingReason: string, configured: readonly ShortVideoPlatform[]): PlatformAvailabilityDto[] {
  return SHORT_VIDEO_PLATFORMS.map((platform): PlatformAvailabilityDto => {
    if (!profile) {
      return { platform, available: false, reason: missingReason };
    }
    if (!profile.enabled) {
      return { platform, available: false, reason: `Creator ${profile.displayName} is disabled.` };
    }
    if (publishConfigForPlatform(profile, platform).mode !== 'global') {
      return { platform, available: false, reason: `Publishing to ${platformLabel(platform)} is disabled for ${profile.displayName}.` };
    }
    if (!configured.includes(platform)) {
      return { platform, available: false, reason: `No publish provider is configured for ${platformLabel(platform)}.` };
    }
    return { platform, available: true, reason: null };
  });
}

export function platformAvailabilityFromSnapshot(job: JobRecord, publisher: ShortVideoPublishProvider | null, config: AppConfig): PlatformAvailabilityDto[] {
  const configured = configuredShortVideoPlatforms(config, publisher);
  return availabilityForProfile(job.creatorProfileSnapshot, `Creator profile ${job.creatorProfileId} is missing.`, configured);
}

export async function platformAvailability(job: JobRecord, publisher: ShortVideoPublishProvider | null, config: AppConfig, profiles: CreatorProfileRepository): Promise<PlatformAvailabilityDto[]> {
  const profile = await profiles.getCreatorProfileById(job.creatorProfileId);
  const configured = configuredShortVideoPlatforms(config, publisher);
  return availabilityForProfile(profile, `Creator profile ${job.creatorProfileId} no longer exists.`, configured);
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
