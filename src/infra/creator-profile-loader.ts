import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  CreatorPlatformPublishConfig,
  CreatorProfile,
  CreatorProfileManifest,
  LayoutProfile,
  ProfileSelectionSource,
} from '../domain/model.js';
import { loadLayoutProfile } from './layout.js';

const PublishTargetSchema = z.strictObject({
  mode: z.enum(['disabled', 'global', 'profile']),
  provider: z.string().min(1).nullable().optional(),
  fallbackToGlobal: z.boolean().optional(),
  configRef: z.string().min(1).nullable().optional(),
});

const CreatorProfileSchema = z.strictObject({
  id: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean().default(true),
  description: z.string().min(1).optional(),
  telegram: z.strictObject({
    buttonLabel: z.string().min(1).optional(),
    aliases: z.array(z.string().min(1)).default([]).optional(),
  }).optional(),
  render: z.strictObject({
    layoutPath: z.string().min(1).nullable().optional(),
    layoutId: z.string().min(1).nullable().optional(),
    snapshotLayoutInJobs: z.boolean().default(true).optional(),
  }),
  publish: z.strictObject({
    instagram: PublishTargetSchema.optional(),
    tiktok: PublishTargetSchema.optional(),
    youtube_shorts: PublishTargetSchema.optional(),
  }).optional(),
});

const CreatorProfileManifestSchema = z.strictObject({
  version: z.literal(1),
  defaultCreatorId: z.string().min(1).optional(),
  creators: z.array(CreatorProfileSchema).default([]),
});

export interface CreatorProfileRepositoryOptions {
  rootDir: string;
  manifestPath?: string | null;
  defaultCreatorId?: string | null;
  legacyLayoutPath?: string | null;
}

export interface ResolveCreatorProfileInput {
  explicitCreatorId?: string | null;
  chatDefaultCreatorId?: string | null;
  strictChatDefault?: boolean;
  strictEnvDefault?: boolean;
}

export interface ResolvedCreatorProfile {
  profile: CreatorProfile;
  layoutProfile: LayoutProfile | null;
  source: ProfileSelectionSource;
}

export class CreatorProfileRepository {
  constructor(private readonly options: CreatorProfileRepositoryOptions) {}

  async loadManifest(): Promise<CreatorProfileManifest> {
    return loadCreatorProfileManifest(this.options);
  }

  async getEnabledCreatorProfiles(): Promise<CreatorProfile[]> {
    const manifest = await this.loadManifest();
    return manifest.creators.filter((profile) => profile.enabled);
  }

  async getCreatorProfileById(id: string): Promise<CreatorProfile | null> {
    const manifest = await this.loadManifest();
    return manifest.creators.find((profile) => profile.id === id) ?? null;
  }

  async resolveCreatorProfile(input: ResolveCreatorProfileInput = {}): Promise<ResolvedCreatorProfile> {
    const manifest = await this.loadManifest();
    const enabledProfiles = manifest.creators.filter((profile) => profile.enabled);
    const enabledById = new Map(enabledProfiles.map((profile) => [profile.id, profile]));
    const legacyOnlyManifest = isLegacyOnlyManifest(manifest);
    const candidates: Array<{ id?: string | null; source: ProfileSelectionSource; strict: boolean }> = [
      { id: input.explicitCreatorId, source: 'explicit', strict: true },
      { id: input.chatDefaultCreatorId, source: 'chat_default', strict: input.strictChatDefault === true },
      { id: this.options.defaultCreatorId, source: 'env_default', strict: input.strictEnvDefault === true },
      { id: manifest.defaultCreatorId, source: 'manifest_default', strict: false },
    ];
    for (const candidate of candidates) {
      const id = candidate.id?.trim();
      if (!id) {
        continue;
      }
      const profile = enabledById.get(id);
      if (profile) {
        return this.withLayout(profile, legacyOnlyManifest ? 'legacy_static_layout' : candidate.source);
      }
      if (candidate.strict) {
        throw new Error(`Creator profile is not enabled or does not exist: ${id}`);
      }
    }
    const firstEnabled = enabledProfiles[0];
    if (firstEnabled) {
      return this.withLayout(firstEnabled, legacyOnlyManifest ? 'legacy_static_layout' : 'first_enabled');
    }
    if (legacyOnlyManifest) {
      const legacy = await buildLegacyCreatorProfile(this.options.rootDir, this.options.legacyLayoutPath ?? undefined);
      return {
        profile: legacy.profile,
        layoutProfile: legacy.layoutProfile,
        source: 'legacy_static_layout',
      };
    }
    throw new Error('No enabled creator profiles are configured.');
  }

  private async withLayout(profile: CreatorProfile, source: ProfileSelectionSource): Promise<ResolvedCreatorProfile> {
    return {
      profile,
      layoutProfile: await loadCreatorLayoutProfile(profile, this.options.rootDir),
      source,
    };
  }
}

export async function loadCreatorProfileManifest(options: CreatorProfileRepositoryOptions): Promise<CreatorProfileManifest> {
  const manifestPath = options.manifestPath?.trim();
  if (!manifestPath) {
    const legacy = await buildLegacyCreatorProfile(options.rootDir, options.legacyLayoutPath ?? undefined);
    return { version: 1, defaultCreatorId: legacy.profile.id, creators: [legacy.profile] };
  }
  const absolutePath = resolve(options.rootDir, manifestPath);
  if (!(await fileExists(absolutePath))) {
    throw new Error(`Creator profile manifest not found: ${manifestPath}`);
  }
  const payload = JSON.parse(await readFile(absolutePath, 'utf-8')) as unknown;
  const manifest = CreatorProfileManifestSchema.parse(payload) as CreatorProfileManifest;
  await validateCreatorProfileManifest(manifest, options.rootDir);
  return manifest;
}

export async function getEnabledCreatorProfiles(manifest: CreatorProfileManifest): Promise<CreatorProfile[]> {
  return manifest.creators.filter((profile) => profile.enabled);
}

export async function loadCreatorLayoutProfile(profile: CreatorProfile, rootDir: string): Promise<LayoutProfile | null> {
  if (!profile.render.layoutPath) {
    return null;
  }
  return loadLayoutProfile(profile.render.layoutPath, rootDir);
}

export async function resolveLayoutProfileForJob(job: { layoutProfileSnapshot?: LayoutProfile | null }, rootDir: string, legacyLayoutPath?: string | null): Promise<LayoutProfile | null> {
  if (Object.prototype.hasOwnProperty.call(job, 'layoutProfileSnapshot')) {
    return job.layoutProfileSnapshot ?? null;
  }
  return loadLayoutProfile(legacyLayoutPath ?? undefined, rootDir);
}

export function snapshotCreatorProfile(profile: CreatorProfile): CreatorProfile {
  return cloneJson(profile);
}

export function snapshotLayoutProfile(profile: LayoutProfile | null): LayoutProfile | null {
  return profile ? cloneJson(profile) : null;
}

export function publishConfigForPlatform(profile: CreatorProfile | null | undefined, platform: string): CreatorPlatformPublishConfig | null {
  if (!profile?.publish) {
    return null;
  }
  return (profile.publish as Record<string, CreatorPlatformPublishConfig | undefined>)[platform] ?? null;
}

function isLegacyOnlyManifest(manifest: CreatorProfileManifest): boolean {
  return manifest.creators.length === 1 && manifest.creators[0]?.id === 'legacy_default';
}

async function validateCreatorProfileManifest(manifest: CreatorProfileManifest, rootDir: string): Promise<void> {
  const seen = new Set<string>();
  for (const profile of manifest.creators) {
    if (seen.has(profile.id)) {
      throw new Error(`Duplicate creator profile id: ${profile.id}`);
    }
    seen.add(profile.id);
    if (profile.id === 'legacy_default') {
      throw new Error('Creator profile id "legacy_default" is reserved for the synthetic legacy fallback.');
    }
    if (!profile.enabled) {
      continue;
    }
    if (!profile.render.layoutPath) {
      throw new Error(`Creator profile ${profile.id} must define render.layoutPath.`);
    }
    const layout = await loadCreatorLayoutProfile(profile, rootDir);
    if (!layout) {
      throw new Error(`Creator profile ${profile.id} layout did not load.`);
    }
    if (layout.creatorId && layout.creatorId !== profile.id) {
      throw new Error(`Creator profile ${profile.id} references layout for creator ${layout.creatorId}.`);
    }
    if (profile.render.layoutId && layout.layoutId !== profile.render.layoutId) {
      throw new Error(`Creator profile ${profile.id} expected layout ${profile.render.layoutId}, got ${layout.layoutId}.`);
    }
    for (const [platform, config] of Object.entries(profile.publish ?? {})) {
      if (!config) {
        continue;
      }
      if (config.mode === 'profile') {
        throw new Error(`Creator profile ${profile.id} uses unsupported publish mode for ${platform}: profile`);
      }
    }
  }
  if (manifest.defaultCreatorId) {
    const defaultProfile = manifest.creators.find((profile) => profile.id === manifest.defaultCreatorId);
    if (!defaultProfile) {
      throw new Error(`defaultCreatorId does not match a creator profile: ${manifest.defaultCreatorId}`);
    }
    if (!defaultProfile.enabled) {
      throw new Error(`defaultCreatorId is not enabled: ${manifest.defaultCreatorId}`);
    }
  }
}

async function buildLegacyCreatorProfile(rootDir: string, legacyLayoutPath?: string): Promise<{ profile: CreatorProfile; layoutProfile: LayoutProfile | null }> {
  const layoutProfile = await loadLayoutProfile(legacyLayoutPath, rootDir);
  const profile: CreatorProfile = {
    id: 'legacy_default',
    displayName: 'Legacy default',
    enabled: true,
    description: 'Synthetic profile backed by TELEGRAM_SHORTS_STATIC_LAYOUT_PATH.',
    telegram: { buttonLabel: 'Legacy default', aliases: ['legacy'] },
    render: {
      layoutPath: legacyLayoutPath ?? null,
      layoutId: layoutProfile?.layoutId ?? null,
      snapshotLayoutInJobs: true,
    },
    publish: {
      instagram: { mode: 'global', provider: 'global', fallbackToGlobal: true, configRef: null },
      tiktok: { mode: 'global', provider: 'global', fallbackToGlobal: true, configRef: null },
      youtube_shorts: { mode: 'global', provider: 'global', fallbackToGlobal: true, configRef: null },
    },
  };
  return { profile, layoutProfile };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
