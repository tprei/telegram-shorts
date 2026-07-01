import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CreatorProfileRepository, publishConfigForPlatform } from '../src/infra/creator-profile-loader.js';

const rootDir = process.cwd();

test('creator profile manifest loads Filipe and Jones profiles with validated layouts', async () => {
  const repo = new CreatorProfileRepository({
    rootDir,
    manifestPath: 'profiles/creator-profiles.json',
    defaultCreatorId: 'filipe_boni',
    legacyLayoutPath: 'profiles/filipe_boni_layout.json',
  });

  const manifest = await repo.loadManifest();
  assert.equal(manifest.defaultCreatorId, 'filipe_boni');
  assert.deepEqual(manifest.creators.map((profile) => profile.id), ['filipe_boni', 'jones_manoel']);

  const jones = manifest.creators.find((profile) => profile.id === 'jones_manoel');
  assert.ok(jones);
  assert.equal(jones.render.layoutPath, 'profiles/jones_manoel_layout.json');
  assert.equal(publishConfigForPlatform(jones, 'instagram')?.mode, 'disabled');

  const resolved = await repo.resolveCreatorProfile({ chatDefaultCreatorId: 'jones_manoel' });
  assert.equal(resolved.source, 'chat_default');
  assert.equal(resolved.profile.displayName, 'Jones Manoel');
  assert.equal(resolved.layoutProfile?.creatorId, 'jones_manoel');
  assert.equal(resolved.layoutProfile?.layoutId, 'center-speaker-vertical-crop-v1');
});

test('explicit missing creator manifest is rejected instead of failing open to legacy publish defaults', async () => {
  const repo = new CreatorProfileRepository({
    rootDir,
    manifestPath: 'profiles/does-not-exist.json',
    legacyLayoutPath: 'profiles/filipe_boni_layout.json',
  });

  await assert.rejects(() => repo.resolveCreatorProfile(), /manifest not found/i);
});

test('omitting creator manifest path preserves legacy static layout selection', async () => {
  const repo = new CreatorProfileRepository({
    rootDir,
    legacyLayoutPath: 'profiles/jones_manoel_layout.json',
  });

  const resolved = await repo.resolveCreatorProfile();
  assert.equal(resolved.source, 'legacy_static_layout');
  assert.equal(resolved.profile.id, 'legacy_default');
  assert.equal(resolved.layoutProfile?.creatorId, 'jones_manoel');
  assert.equal(resolved.layoutProfile?.layoutId, 'center-speaker-vertical-crop-v1');
});

test('disabled profiles with broken layouts do not block enabled creator selection', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-shorts-profile-manifest-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const manifestPath = join(dir, 'creator-profiles.json');
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    defaultCreatorId: 'filipe_boni',
    creators: [
      {
        id: 'filipe_boni',
        displayName: 'Filipe Boni',
        enabled: true,
        render: {
          layoutPath: 'profiles/filipe_boni_layout.json',
          layoutId: 'source-left-host-right-stack-v1',
          snapshotLayoutInJobs: true,
        },
        publish: {
          instagram: { mode: 'global', provider: 'global', fallbackToGlobal: true, configRef: null },
        },
      },
      {
        id: 'jones_manoel',
        displayName: 'Jones Manoel',
        enabled: false,
        render: {
          layoutPath: 'profiles/does-not-exist.json',
          layoutId: 'broken-layout',
          snapshotLayoutInJobs: true,
        },
        publish: {
          instagram: { mode: 'disabled' },
        },
      },
    ],
  }, null, 2), 'utf-8');

  const repo = new CreatorProfileRepository({
    rootDir,
    manifestPath,
    legacyLayoutPath: 'profiles/filipe_boni_layout.json',
  });

  const resolved = await repo.resolveCreatorProfile();
  assert.equal(resolved.profile.id, 'filipe_boni');
  assert.equal(resolved.source, 'manifest_default');
});

test('manifest with no enabled creators is rejected instead of falling back to legacy publishing defaults', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-shorts-profile-manifest-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const manifestPath = join(dir, 'creator-profiles.json');
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    creators: [{
      id: 'filipe_boni',
      displayName: 'Filipe Boni',
      enabled: false,
      render: {
        layoutPath: 'profiles/filipe_boni_layout.json',
        layoutId: 'source-left-host-right-stack-v1',
        snapshotLayoutInJobs: true,
      },
      publish: {
        instagram: { mode: 'disabled' },
      },
    }],
  }, null, 2), 'utf-8');

  const repo = new CreatorProfileRepository({
    rootDir,
    manifestPath,
    legacyLayoutPath: 'profiles/filipe_boni_layout.json',
  });

  await assert.rejects(() => repo.resolveCreatorProfile(), /no enabled creator profiles/i);
});

test('phase-1 manifest rejects reserved legacy_default creator ids', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-shorts-profile-manifest-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const manifestPath = join(dir, 'creator-profiles.json');
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    creators: [{
      id: 'legacy_default',
      displayName: 'Legacy default',
      enabled: true,
      render: {
        layoutPath: 'profiles/filipe_boni_layout.json',
        layoutId: 'source-left-host-right-stack-v1',
        snapshotLayoutInJobs: true,
      },
      publish: {
        instagram: { mode: 'disabled' },
      },
    }],
  }, null, 2), 'utf-8');

  const repo = new CreatorProfileRepository({
    rootDir,
    manifestPath,
    legacyLayoutPath: 'profiles/filipe_boni_layout.json',
  });

  await assert.rejects(() => repo.loadManifest(), /reserved/i);
});

test('phase-1 manifest rejects unsupported profile-scoped publish mode', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-shorts-profile-manifest-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const manifestPath = join(dir, 'creator-profiles.json');
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    defaultCreatorId: 'filipe_boni',
    creators: [{
      id: 'filipe_boni',
      displayName: 'Filipe Boni',
      enabled: true,
      render: {
        layoutPath: 'profiles/filipe_boni_layout.json',
        layoutId: 'source-left-host-right-stack-v1',
        snapshotLayoutInJobs: true,
      },
      publish: {
        instagram: {
          mode: 'profile',
          provider: 'buffer',
          configRef: 'FILIPE_BUFFER',
          fallbackToGlobal: false,
        },
      },
    }],
  }, null, 2), 'utf-8');

  const repo = new CreatorProfileRepository({
    rootDir,
    manifestPath,
    legacyLayoutPath: 'profiles/filipe_boni_layout.json',
  });

  await assert.rejects(() => repo.loadManifest(), /unsupported publish mode/i);
});
