import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { StudioError } from '../application/errors.js';
import type { LayoutProfile } from '../domain/layout.js';
import type { CreatorProfile, CreatorProfileManifest, CreatorPlatformPublishConfig, ShortVideoPlatform } from '../domain/model.js';
import { SCHEDULE_LIMITS } from '../domain/schedule.js';
import { loadLayoutProfile } from './layout.js';
import { assertPublicYouTubeUrl } from './youtube.js';

const PublishTargetSchema = z.strictObject({
  mode: z.enum(['global', 'disabled']),
});

const SLOT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}

const PostingScheduleSchema = z.strictObject({
  timeZone: z.string().min(1).refine(isValidTimeZone, { message: 'timeZone must be a valid IANA time zone' }),
  slots: z
    .array(z.string().regex(SLOT_PATTERN, 'slots must be HH:MM (00-23:00-59)'))
    .min(1)
    .max(6)
    .refine((slots) => slots.every((slot, index) => {
      if (index === 0) {
        return true;
      }
      const previousMinutes = Number(slots[index - 1].slice(0, 2)) * 60 + Number(slots[index - 1].slice(3));
      const minutes = Number(slot.slice(0, 2)) * 60 + Number(slot.slice(3));
      return minutes - previousMinutes >= SCHEDULE_LIMITS.slotSpacingMinutes;
    }), { message: 'slots must be unique, sorted ascending, and at least 120 minutes apart' }),
});

const CreatorAutopilotConfigSchema = z
  .strictObject({
    channelUrl: z.string().min(1).refine((url) => {
      try {
        assertPublicYouTubeUrl(url);
        return true;
      } catch {
        return false;
      }
    }, { message: 'channelUrl must be a public YouTube URL' }),
    shortsPerVideo: z.number().int().min(1).max(5),
    platforms: z
      .array(z.enum(['instagram', 'tiktok', 'youtube_shorts']))
      .min(1)
      .max(3)
      .refine((platforms) => new Set(platforms).size === platforms.length, { message: 'platforms must not contain duplicates' }),
    reviewWindowHours: z.number().min(1).max(24),
    bookingHorizonHours: z.number().max(72),
    maxShortAgeHours: z.number().min(6).max(168),
    minVideoSeconds: z.number().min(60),
  })
  .refine((config) => config.bookingHorizonHours > config.reviewWindowHours, { message: 'bookingHorizonHours must be greater than reviewWindowHours' });

const CreatorProfileSchema = z.strictObject({
  id: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean(),
  description: z.string().min(1).optional(),
  render: z.strictObject({
    layoutPath: z.string().min(1),
    layoutId: z.string().min(1),
  }),
  publish: z.strictObject({
    instagram: PublishTargetSchema.optional(),
    tiktok: PublishTargetSchema.optional(),
    youtube_shorts: PublishTargetSchema.optional(),
  }).optional(),
  schedule: PostingScheduleSchema,
  autopilot: CreatorAutopilotConfigSchema.optional(),
});

const CreatorProfileManifestSchema = z.strictObject({
  version: z.literal(2),
  defaultCreatorId: z.string().min(1).optional(),
  creators: z.array(CreatorProfileSchema).min(1),
});

export interface ResolveCreatorProfileInput {
  requestedId?: string;
  studioDefaultId?: string | null;
}

export interface ResolvedCreatorProfile {
  profile: CreatorProfile;
  layout: LayoutProfile;
}

export class CreatorProfileRepository {
  private readonly rootDir: string;
  private readonly manifestPath: string;

  constructor(options: { rootDir: string; manifestPath: string }) {
    this.rootDir = options.rootDir;
    this.manifestPath = options.manifestPath;
  }

  async getManifest(): Promise<CreatorProfileManifest> {
    const absoluteManifestPath = resolve(this.rootDir, this.manifestPath);
    const payload: unknown = JSON.parse(await readFile(absoluteManifestPath, 'utf-8'));
    const manifest = CreatorProfileManifestSchema.parse(payload);
    await validateManifest(manifest, this.rootDir);
    return manifest;
  }

  async getEnabledCreatorProfiles(): Promise<CreatorProfile[]> {
    const manifest = await this.getManifest();
    return manifest.creators.filter((creator) => creator.enabled);
  }

  async getCreatorProfileById(id: string): Promise<CreatorProfile | null> {
    const manifest = await this.getManifest();
    return manifest.creators.find((creator) => creator.id === id) ?? null;
  }

  async resolveCreatorProfile(input: ResolveCreatorProfileInput = {}): Promise<ResolvedCreatorProfile> {
    const manifest = await this.getManifest();
    const profile = pickCreatorProfile(manifest, input);
    return { profile, layout: await loadLayoutProfile(profile.render.layoutPath, this.rootDir) };
  }
}

export function publishConfigForPlatform(profile: CreatorProfile, platform: ShortVideoPlatform): CreatorPlatformPublishConfig {
  return profile.publish?.[platform] ?? { mode: 'disabled' };
}

function pickCreatorProfile(manifest: CreatorProfileManifest, input: ResolveCreatorProfileInput): CreatorProfile {
  const byId = (id: string): CreatorProfile | undefined => manifest.creators.find((creator) => creator.id === id);

  if (input.requestedId !== undefined) {
    const requested = byId(input.requestedId);
    if (!requested || !requested.enabled) {
      throw new StudioError('invalid', `Requested creator profile does not exist or is disabled: ${input.requestedId}`);
    }
    return requested;
  }

  const studioDefault = input.studioDefaultId ? byId(input.studioDefaultId) : undefined;
  if (studioDefault?.enabled) {
    return studioDefault;
  }

  const manifestDefault = manifest.defaultCreatorId ? byId(manifest.defaultCreatorId) : undefined;
  if (manifestDefault?.enabled) {
    return manifestDefault;
  }

  const firstEnabled = manifest.creators.find((creator) => creator.enabled);
  if (firstEnabled) {
    return firstEnabled;
  }

  throw new StudioError('invalid', 'No enabled creator profiles are available.');
}

async function validateManifest(manifest: CreatorProfileManifest, rootDir: string): Promise<void> {
  const seenIds = new Set<string>();
  for (const creator of manifest.creators) {
    if (seenIds.has(creator.id)) {
      throw new StudioError('invalid', `Duplicate creator profile id: ${creator.id}`);
    }
    seenIds.add(creator.id);
  }
  for (const creator of manifest.creators) {
    if (!creator.enabled) {
      continue;
    }
    const layout = await loadLayoutProfile(creator.render.layoutPath, rootDir);
    if (layout.creatorId !== creator.id) {
      throw new StudioError('invalid', `Layout ${creator.render.layoutPath} declares creatorId ${layout.creatorId}, expected ${creator.id}.`);
    }
    if (layout.layoutId !== creator.render.layoutId) {
      throw new StudioError('invalid', `Layout ${creator.render.layoutPath} declares layoutId ${layout.layoutId}, expected ${creator.render.layoutId}.`);
    }
  }
}
