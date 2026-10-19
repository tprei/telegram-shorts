import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { StudioError } from '../application/errors.js';
import { EDIT_LIMITS } from '../domain/edit.js';
import type { LayoutProfile } from '../domain/layout.js';
import type { CreatorProfile, CreatorProfileManifest, PublishingAccount, ShortVideoPlatform } from '../domain/model.js';
import { SCHEDULE_LIMITS } from '../domain/schedule.js';
import { loadLayoutProfile } from './layout.js';
import { assertPublicYouTubeUrl } from './youtube.js';

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
      } catch (error) {
        if (error instanceof TypeError || (error instanceof Error && error.message === 'Only public YouTube URLs are supported.')) {
          return false;
        }
        throw error;
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

const PublishingAccountSchema = z.strictObject({
  id: z.string().min(1),
  displayName: z.string().min(1),
  schedule: PostingScheduleSchema,
  platforms: z.array(z.enum(['instagram', 'tiktok', 'youtube_shorts'])).min(1).max(3)
    .refine((p) => new Set(p).size === p.length, { message: 'Duplicate account platform' }),
  mallaryProfileId: z.string().min(1).nullable(),
  buffer: z.boolean(),
});

const CreatorProfileSchema = z.strictObject({
  id: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean(),
  description: z.string().min(1).optional(),
  accountId: z.string().min(1).nullable(),
  render: z.strictObject({
    layoutPath: z.string().min(1),
    layoutId: z.string().min(1),
    defaultSpeed: z.number().min(EDIT_LIMITS.minSpeed).max(EDIT_LIMITS.maxSpeed),
    scene: z.strictObject({
      hostDescription: z.string().min(1),
      hints: z.string().min(1).nullable(),
    }).nullable(),
  }),
  autopilot: CreatorAutopilotConfigSchema.optional(),
});

const CreatorProfileManifestSchema = z.strictObject({
  version: z.literal(3),
  defaultCreatorId: z.string().min(1).optional(),
  accounts: z.array(PublishingAccountSchema),
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

export interface ResolvedPublishingProfile {
  profile: CreatorProfile | null;
  account: PublishingAccount | null;
}

export function pickPublishingProfile(manifest: CreatorProfileManifest, creatorId: string): ResolvedPublishingProfile {
  const profile = manifest.creators.find((creator) => creator.id === creatorId) ?? null;
  const account = profile?.accountId
    ? manifest.accounts.find((candidate) => candidate.id === profile.accountId) ?? null
    : null;
  return { profile, account };
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

  async resolvePublishingProfile(creatorId: string): Promise<ResolvedPublishingProfile> {
    const manifest = await this.getManifest();
    return pickPublishingProfile(manifest, creatorId);
  }

  async resolveCreatorProfile(input: ResolveCreatorProfileInput = {}): Promise<ResolvedCreatorProfile> {
    const manifest = await this.getManifest();
    const profile = pickCreatorProfile(manifest, input);
    return { profile, layout: await loadLayoutProfile(profile.render.layoutPath, this.rootDir) };
  }
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
  const seenAccountIds = new Set<string>();
  const seenMallaryIds = new Set<string>();
  let bufferAccountCount = 0;

  for (const account of manifest.accounts) {
    if (seenAccountIds.has(account.id)) {
      throw new StudioError('invalid', `Duplicate publishing account id: ${account.id}`);
    }
    seenAccountIds.add(account.id);

    if (account.mallaryProfileId !== null) {
      if (seenMallaryIds.has(account.mallaryProfileId)) {
        throw new StudioError('invalid', `Duplicate Mallary profile id: ${account.mallaryProfileId}`);
      }
      seenMallaryIds.add(account.mallaryProfileId);
    }

    if (account.buffer) {
      bufferAccountCount += 1;
      if (bufferAccountCount > 1) {
        throw new StudioError('invalid', 'Only one publishing account can have buffer enabled.');
      }
    }
  }

  const seenCreatorIds = new Set<string>();
  for (const creator of manifest.creators) {
    if (seenCreatorIds.has(creator.id)) {
      throw new StudioError('invalid', `Duplicate creator profile id: ${creator.id}`);
    }
    seenCreatorIds.add(creator.id);

    if (creator.accountId !== null && !seenAccountIds.has(creator.accountId)) {
      throw new StudioError('invalid', `Creator ${creator.id} references missing account ${creator.accountId}.`);
    }

    if (creator.autopilot) {
      if (creator.accountId === null) {
        throw new StudioError('invalid', `Creator ${creator.id} specifies autopilot without an assigned account.`);
      }
      const account = manifest.accounts.find((candidate) => candidate.id === creator.accountId);
      if (account) {
        const accountPlatforms = new Set(account.platforms);
        for (const platform of creator.autopilot.platforms) {
          if (!accountPlatforms.has(platform)) {
            throw new StudioError('invalid', `Creator ${creator.id} autopilot platform ${platform} is not supported by account ${account.id}.`);
          }
        }
      }
    }
  }

  if (manifest.defaultCreatorId !== undefined) {
    const defaultCreator = manifest.creators.find((creator) => creator.id === manifest.defaultCreatorId);
    if (!defaultCreator || !defaultCreator.enabled) {
      throw new StudioError('invalid', `Default creator profile ${manifest.defaultCreatorId} does not exist or is disabled.`);
    }
  }

  for (const creator of manifest.creators) {
    const layout = await loadLayoutProfile(creator.render.layoutPath, rootDir);
    if (layout.layoutId !== creator.render.layoutId) {
      throw new StudioError('invalid', `Layout ${creator.render.layoutPath} declares layoutId ${layout.layoutId}, expected ${creator.render.layoutId}.`);
    }
    if ((layout.strategy === 'scenes') !== (creator.render.scene !== null)) {
      throw new StudioError('invalid', `Layout ${creator.render.layoutPath} strategy ${layout.strategy} does not match creator scene config for ${creator.id}.`);
    }
  }
}
