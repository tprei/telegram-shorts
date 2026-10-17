import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { StudioError } from '../src/application/errors.js';
import { CreatorProfileRepository, publishConfigForPlatform } from '../src/infra/creator-profile-loader.js';
import type { CreatorProfile } from '../src/domain/model.js';
import { loadLayoutProfile } from '../src/infra/layout.js';

const rootDir = process.cwd();
const filipeLayoutPath = join(rootDir, 'profiles', 'filipe_boni_layout.json');
const jonesLayoutPath = join(rootDir, 'profiles', 'jones_manoel_layout.json');

async function createTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'creator-profiles-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeManifest(dir: string, manifest: unknown): Promise<string> {
  const manifestPath = join(dir, 'creator-profiles.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  return manifestPath;
}

function isInvalidStudioError(error: unknown): boolean {
  return error instanceof StudioError && error.code === 'invalid';
}

test('real profiles manifest loads both creators with valid v2 layouts', async () => {
  const repo = new CreatorProfileRepository({ rootDir, manifestPath: 'profiles/creator-profiles.json' });
  const manifest = await repo.getManifest();

  assert.equal(manifest.version, 2);
  assert.equal(manifest.defaultCreatorId, 'filipe_boni');
  assert.deepEqual(manifest.creators.map((creator) => creator.id), ['filipe_boni', 'jones_manoel']);

  const [filipe, jones] = manifest.creators;
  assert.ok(filipe && jones);
  assert.equal(filipe.render.layoutPath, 'profiles/filipe_boni_layout.json');
  assert.equal(filipe.render.layoutId, 'screen-top-host-bottom-v2');
  assert.equal(jones.render.layoutId, 'center-speaker-vertical-v2');
  assert.deepEqual(publishConfigForPlatform(filipe, 'youtube_shorts'), { mode: 'global' });
  assert.deepEqual(publishConfigForPlatform(jones, 'instagram'), { mode: 'disabled' });

  const filipeLayout = await loadLayoutProfile(filipe.render.layoutPath, rootDir);
  const jonesLayout = await loadLayoutProfile(jones.render.layoutPath, rootDir);
  assert.equal(filipeLayout.creatorId, 'filipe_boni');
  assert.deepEqual(filipeLayout.panels.map((panel) => panel.role), ['content', 'host']);
  assert.equal(jonesLayout.creatorId, 'jones_manoel');
  assert.deepEqual(jonesLayout.panels.map((panel) => panel.role), ['host']);
});

test('resolution follows requested > studio default > manifest default', async () => {
  const repo = new CreatorProfileRepository({ rootDir, manifestPath: 'profiles/creator-profiles.json' });

  const requested = await repo.resolveCreatorProfile({ requestedId: 'jones_manoel', studioDefaultId: 'filipe_boni' });
  assert.equal(requested.profile.id, 'jones_manoel');
  assert.equal(requested.layout.layoutId, 'center-speaker-vertical-v2');
  assert.equal(requested.layout.creatorId, 'jones_manoel');

  const studioDefault = await repo.resolveCreatorProfile({ studioDefaultId: 'jones_manoel' });
  assert.equal(studioDefault.profile.id, 'jones_manoel');
  assert.equal(studioDefault.layout.layoutId, 'center-speaker-vertical-v2');

  const manifestDefault = await repo.resolveCreatorProfile({ studioDefaultId: null });
  assert.equal(manifestDefault.profile.id, 'filipe_boni');
  assert.equal(manifestDefault.layout.layoutId, 'screen-top-host-bottom-v2');

  const byId = await repo.getCreatorProfileById('jones_manoel');
  assert.ok(byId);
  assert.equal(byId.id, 'jones_manoel');
  assert.equal(await repo.getCreatorProfileById('nobody'), null);
});

test('requested id that is missing or disabled is rejected as invalid', async (t) => {
  const repo = new CreatorProfileRepository({ rootDir, manifestPath: 'profiles/creator-profiles.json' });
  await assert.rejects(
    () => repo.resolveCreatorProfile({ requestedId: 'unknown_creator' }),
    isInvalidStudioError,
  );

  const dir = await createTempDir(t);
  const manifestPath = await writeManifest(dir, {
    version: 2,
    creators: [
      { id: 'filipe_boni', displayName: 'Filipe Boni', enabled: true, render: { layoutPath: filipeLayoutPath, layoutId: 'screen-top-host-bottom-v2' } },
      { id: 'jones_manoel', displayName: 'Jones Manoel', enabled: false, render: { layoutPath: jonesLayoutPath, layoutId: 'center-speaker-vertical-v2' } },
    ],
  });
  const withDisabled = new CreatorProfileRepository({ rootDir: dir, manifestPath });
  await assert.rejects(
    () => withDisabled.resolveCreatorProfile({ requestedId: 'jones_manoel' }),
    isInvalidStudioError,
  );
});

test('disabled studio default falls through to manifest default and first enabled', async (t) => {
  const dir = await createTempDir(t);
  const manifestPath = await writeManifest(dir, {
    version: 2,
    defaultCreatorId: 'jones_manoel',
    creators: [
      { id: 'jones_manoel', displayName: 'Jones Manoel', enabled: false, render: { layoutPath: jonesLayoutPath, layoutId: 'center-speaker-vertical-v2' } },
      { id: 'filipe_boni', displayName: 'Filipe Boni', enabled: true, render: { layoutPath: filipeLayoutPath, layoutId: 'screen-top-host-bottom-v2' } },
    ],
  });
  const repo = new CreatorProfileRepository({ rootDir: dir, manifestPath });

  const fromDisabledStudioDefault = await repo.resolveCreatorProfile({ studioDefaultId: 'jones_manoel' });
  assert.equal(fromDisabledStudioDefault.profile.id, 'filipe_boni');

  const fromUnknownStudioDefault = await repo.resolveCreatorProfile({ studioDefaultId: 'ghost' });
  assert.equal(fromUnknownStudioDefault.profile.id, 'filipe_boni');

  const fromDisabledManifestDefault = await repo.resolveCreatorProfile();
  assert.equal(fromDisabledManifestDefault.profile.id, 'filipe_boni');
});

test('layout creatorId and layoutId must match the creator manifest entry', async (t) => {
  const dir = await createTempDir(t);
  const mismatchedLayoutIdPath = await writeManifest(dir, {
    version: 2,
    creators: [
      { id: 'filipe_boni', displayName: 'Filipe Boni', enabled: true, render: { layoutPath: filipeLayoutPath, layoutId: 'some-other-layout' } },
    ],
  });
  const mismatchedLayoutId = new CreatorProfileRepository({ rootDir: dir, manifestPath: mismatchedLayoutIdPath });
  await assert.rejects(() => mismatchedLayoutId.getManifest(), isInvalidStudioError);

  const mismatchedCreatorIdPath = await writeManifest(dir, {
    version: 2,
    creators: [
      { id: 'someone_else', displayName: 'Someone Else', enabled: true, render: { layoutPath: filipeLayoutPath, layoutId: 'screen-top-host-bottom-v2' } },
    ],
  });
  const mismatchedCreatorId = new CreatorProfileRepository({ rootDir: dir, manifestPath: mismatchedCreatorIdPath });
  await assert.rejects(() => mismatchedCreatorId.getManifest(), isInvalidStudioError);
});

test('layout with an invalid color is rejected', async (t) => {
  const dir = await createTempDir(t);
  const rawLayout = JSON.parse(await readFile(filipeLayoutPath, 'utf-8')) as Record<string, unknown>;
  rawLayout.background = '#12345';
  const layoutPath = join(dir, 'broken_layout.json');
  await writeFile(layoutPath, JSON.stringify(rawLayout, null, 2), 'utf-8');

  const manifestPath = await writeManifest(dir, {
    version: 2,
    creators: [
      { id: 'filipe_boni', displayName: 'Filipe Boni', enabled: true, render: { layoutPath, layoutId: 'screen-top-host-bottom-v2' } },
    ],
  });
  const repo = new CreatorProfileRepository({ rootDir: dir, manifestPath });
  await assert.rejects(() => repo.getManifest());
});

test('duplicate creator ids are rejected', async (t) => {
  const dir = await createTempDir(t);
  const entry = { id: 'filipe_boni', displayName: 'Filipe Boni', enabled: true, render: { layoutPath: filipeLayoutPath, layoutId: 'screen-top-host-bottom-v2' } };
  const manifestPath = await writeManifest(dir, {
    version: 2,
    creators: [entry, { ...entry }],
  });
  const repo = new CreatorProfileRepository({ rootDir: dir, manifestPath });
  await assert.rejects(() => repo.getManifest(), isInvalidStudioError);
});

test('publish config defaults to disabled when the platform is absent', () => {
  const profile: CreatorProfile = {
    id: 'filipe_boni',
    displayName: 'Filipe Boni',
    enabled: true,
    render: { layoutPath: 'profiles/filipe_boni_layout.json', layoutId: 'screen-top-host-bottom-v2' },
  };
  assert.deepEqual(publishConfigForPlatform(profile, 'instagram'), { mode: 'disabled' });
  assert.deepEqual(publishConfigForPlatform({ ...profile, publish: { tiktok: { mode: 'global' } } }, 'tiktok'), { mode: 'global' });
});
