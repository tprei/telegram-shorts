import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { StudioError } from '../src/application/errors.js';
import { CreatorProfileRepository } from '../src/infra/creator-profile-loader.js';

const rootDir = process.cwd();
const filipeLayoutPath = join(rootDir, 'profiles', 'filipe_boni_layout.json');
const jonesLayoutPath = join(rootDir, 'profiles', 'jones_manoel_layout.json');
const mixLayoutPath = join(rootDir, 'profiles', 'mix_layout.json');
const SCHEDULE = { timeZone: 'America/Sao_Paulo', slots: ['12:00', '19:00', '21:00'] };

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

function defaultAccounts(): unknown[] {
  return [
    {
      id: 'cortes_do_boni',
      displayName: 'Cortes do Boni',
      schedule: SCHEDULE,
      platforms: ['instagram', 'tiktok', 'youtube_shorts'],
      mallaryProfileId: 'S83DPA58Wwx',
      buffer: true,
    },
    {
      id: 'mix',
      displayName: 'Mix',
      schedule: SCHEDULE,
      platforms: ['instagram', 'tiktok'],
      mallaryProfileId: null,
      buffer: false,
    },
  ];
}

function creatorEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'filipe_boni',
    displayName: 'Filipe Boni',
    enabled: true,
    accountId: 'cortes_do_boni',
    render: {
      layoutPath: filipeLayoutPath,
      layoutId: 'screen-top-host-bottom-v2',
      defaultSpeed: 1.5,
      scene: null,
    },
    ...overrides,
  };
}

async function manifestRepo(
  t: TestContext,
  creators: Record<string, unknown>[],
  accounts: unknown[] = defaultAccounts(),
  extra: Record<string, unknown> = {},
): Promise<CreatorProfileRepository> {
  const dir = await createTempDir(t);
  const manifestPath = await writeManifest(dir, {
    version: 3,
    accounts,
    creators,
    ...extra,
  });
  return new CreatorProfileRepository({ rootDir: dir, manifestPath });
}

test('seven creators share reusable v3 styles and resolve two accounts', async () => {
  const repo = new CreatorProfileRepository({ rootDir, manifestPath: 'profiles/creator-profiles.json' });
  const manifest = await repo.getManifest();

  assert.equal(manifest.version, 3);
  assert.equal(manifest.defaultCreatorId, 'filipe_boni');
  assert.equal(manifest.accounts.length, 2);
  assert.equal(manifest.creators.length, 7);

  const expectedIds = ['filipe_boni', 'jones_manoel', 'samuel_borelli', 'jose_kobori', 'gustavo_gaiofato', 'gustavo_machado', 'raul_sena_flow'];
  assert.deepEqual(manifest.creators.map((creator) => creator.id), expectedIds);

  const boniAccount = manifest.accounts.find((account) => account.id === 'cortes_do_boni');
  assert.ok(boniAccount);
  assert.equal(boniAccount.id, 'cortes_do_boni');
  assert.equal(boniAccount.buffer, true);
  assert.equal(boniAccount.mallaryProfileId, 'S83DPA58Wwx');

  const mixAccount = manifest.accounts.find((account) => account.id === 'mix');
  assert.ok(mixAccount);
  assert.equal(mixAccount.id, 'mix');
  assert.equal(mixAccount.buffer, false);
  assert.equal(mixAccount.mallaryProfileId, 'mJjNF5k6f9h');
  assert.deepEqual(mixAccount.platforms, ['instagram']);

  for (const creatorId of expectedIds) {
    const resolved = await repo.resolveCreatorProfile({ requestedId: creatorId });
    assert.equal(resolved.profile.id, creatorId);
    assert.ok(resolved.layout);
    if (resolved.layout.strategy === 'fixed') {
      assert.ok(resolved.layout.panels.length >= 1);
    } else {
      assert.equal(resolved.layout.strategy, 'scenes');
      assert.ok(resolved.profile.render.scene !== null);
    }
  }

  const jonesResolved = await repo.resolvePublishingProfile('jones_manoel');
  assert.ok(jonesResolved.profile);
  assert.equal(jonesResolved.account, null);

  const boniResolved = await repo.resolvePublishingProfile('filipe_boni');
  assert.ok(boniResolved.profile);
  assert.equal(boniResolved.account?.id, 'cortes_do_boni');

  const mixCreatorIds = ['samuel_borelli', 'jose_kobori', 'gustavo_gaiofato', 'gustavo_machado', 'raul_sena_flow'];
  for (const creatorId of mixCreatorIds) {
    const mixResolved = await repo.resolvePublishingProfile(creatorId);
    assert.ok(mixResolved.profile);
    assert.equal(mixResolved.account?.id, 'mix');
    assert.equal(mixResolved.profile.render.layoutPath, 'profiles/mix_layout.json');
    assert.equal(mixResolved.profile.render.layoutId, 'mix-scenes-v3');
    assert.equal(mixResolved.profile.render.defaultSpeed, 1.25);
  }
});

test('scene descriptions are required exactly for scene layouts', async (t) => {
  const missingSceneConfig = await manifestRepo(t, [
    creatorEntry({
      id: 'samuel_borelli',
      accountId: 'mix',
      render: {
        layoutPath: mixLayoutPath,
        layoutId: 'mix-scenes-v3',
        defaultSpeed: 1.25,
        scene: null,
      },
    }),
  ]);
  await assert.rejects(() => missingSceneConfig.getManifest(), isInvalidStudioError);

  const unexpectedSceneOnFixed = await manifestRepo(t, [
    creatorEntry({
      render: {
        layoutPath: filipeLayoutPath,
        layoutId: 'screen-top-host-bottom-v2',
        defaultSpeed: 1.5,
        scene: {
          hostDescription: 'Host description',
          hints: null,
        },
      },
    }),
  ]);
  await assert.rejects(() => unexpectedSceneOnFixed.getManifest(), isInvalidStudioError);

  const emptyDescription = await manifestRepo(t, [
    creatorEntry({
      id: 'samuel_borelli',
      accountId: 'mix',
      render: {
        layoutPath: mixLayoutPath,
        layoutId: 'mix-scenes-v3',
        defaultSpeed: 1.25,
        scene: {
          hostDescription: '',
          hints: null,
        },
      },
    }),
  ]);
  await assert.rejects(() => emptyDescription.getManifest());
});

test('invalid account references and duplicate Buffer owners are rejected', async (t) => {
  const missingAccount = await manifestRepo(t, [
    creatorEntry({ accountId: 'non_existent_account' }),
  ]);
  await assert.rejects(() => missingAccount.getManifest(), isInvalidStudioError);

  const twoBufferAccounts = [
    {
      id: 'account_1',
      displayName: 'Account 1',
      schedule: SCHEDULE,
      platforms: ['instagram'],
      mallaryProfileId: 'prof_1',
      buffer: true,
    },
    {
      id: 'account_2',
      displayName: 'Account 2',
      schedule: SCHEDULE,
      platforms: ['instagram'],
      mallaryProfileId: 'prof_2',
      buffer: true,
    },
  ];
  const duplicateBuffer = await manifestRepo(t, [creatorEntry({ accountId: 'account_1' })], twoBufferAccounts);
  await assert.rejects(() => duplicateBuffer.getManifest(), isInvalidStudioError);

  const duplicateMallaryAccounts = [
    {
      id: 'account_1',
      displayName: 'Account 1',
      schedule: SCHEDULE,
      platforms: ['instagram'],
      mallaryProfileId: 'same_mallary_id',
      buffer: true,
    },
    {
      id: 'account_2',
      displayName: 'Account 2',
      schedule: SCHEDULE,
      platforms: ['instagram'],
      mallaryProfileId: 'same_mallary_id',
      buffer: false,
    },
  ];
  const duplicateMallary = await manifestRepo(t, [creatorEntry({ accountId: 'account_1' })], duplicateMallaryAccounts);
  await assert.rejects(() => duplicateMallary.getManifest(), isInvalidStudioError);

  const duplicateAccountIds = [
    {
      id: 'account_1',
      displayName: 'Account 1',
      schedule: SCHEDULE,
      platforms: ['instagram'],
      mallaryProfileId: 'p1',
      buffer: false,
    },
    {
      id: 'account_1',
      displayName: 'Account 1 duplicate',
      schedule: SCHEDULE,
      platforms: ['instagram'],
      mallaryProfileId: 'p2',
      buffer: false,
    },
  ];
  const duplicateAccounts = await manifestRepo(t, [creatorEntry({ accountId: 'account_1' })], duplicateAccountIds);
  await assert.rejects(() => duplicateAccounts.getManifest(), isInvalidStudioError);

  const autopilotUnsupportedPlatform = await manifestRepo(t, [
    creatorEntry({
      accountId: 'mix',
      autopilot: {
        channelUrl: 'https://www.youtube.com/@filipe_boni/videos',
        shortsPerVideo: 2,
        platforms: ['youtube_shorts'],
        reviewWindowHours: 3,
        bookingHorizonHours: 24,
        maxShortAgeHours: 48,
        minVideoSeconds: 480,
      },
    }),
  ]);
  await assert.rejects(() => autopilotUnsupportedPlatform.getManifest(), isInvalidStudioError);

  const autopilotWithoutAccount = await manifestRepo(t, [
    creatorEntry({
      accountId: null,
      autopilot: {
        channelUrl: 'https://www.youtube.com/@filipe_boni/videos',
        shortsPerVideo: 2,
        platforms: ['instagram'],
        reviewWindowHours: 3,
        bookingHorizonHours: 24,
        maxShortAgeHours: 48,
        minVideoSeconds: 480,
      },
    }),
  ]);
  await assert.rejects(() => autopilotWithoutAccount.getManifest(), isInvalidStudioError);

  const missingDefaultCreator = await manifestRepo(
    t,
    [creatorEntry({ id: 'creator_a' })],
    defaultAccounts(),
    { defaultCreatorId: 'creator_b' },
  );
  await assert.rejects(() => missingDefaultCreator.getManifest(), isInvalidStudioError);

  const disabledDefaultCreator = await manifestRepo(
    t,
    [creatorEntry({ id: 'creator_a', enabled: false })],
    defaultAccounts(),
    { defaultCreatorId: 'creator_a' },
  );
  await assert.rejects(() => disabledDefaultCreator.getManifest(), isInvalidStudioError);
});

test('account schedules preserve timezone and spacing validation', async (t) => {
  const badZoneAccount = [
    {
      id: 'account_bad',
      displayName: 'Bad Zone',
      schedule: { timeZone: 'Mars/Olympus', slots: ['12:00'] },
      platforms: ['instagram'],
      mallaryProfileId: null,
      buffer: false,
    },
  ];
  const badZone = await manifestRepo(t, [creatorEntry({ accountId: 'account_bad' })], badZoneAccount);
  await assert.rejects(() => badZone.getManifest());

  const unsortedSlotsAccount = [
    {
      id: 'account_unsorted',
      displayName: 'Unsorted',
      schedule: { timeZone: 'America/Sao_Paulo', slots: ['19:00', '12:00'] },
      platforms: ['instagram'],
      mallaryProfileId: null,
      buffer: false,
    },
  ];
  const unsorted = await manifestRepo(t, [creatorEntry({ accountId: 'account_unsorted' })], unsortedSlotsAccount);
  await assert.rejects(() => unsorted.getManifest());

  const tooCloseSlotsAccount = [
    {
      id: 'account_close',
      displayName: 'Too Close',
      schedule: { timeZone: 'America/Sao_Paulo', slots: ['12:00', '13:00'] },
      platforms: ['instagram'],
      mallaryProfileId: null,
      buffer: false,
    },
  ];
  const tooClose = await manifestRepo(t, [creatorEntry({ accountId: 'account_close' })], tooCloseSlotsAccount);
  await assert.rejects(() => tooClose.getManifest());

  const duplicateSlotsAccount = [
    {
      id: 'account_dup',
      displayName: 'Duplicate Slots',
      schedule: { timeZone: 'America/Sao_Paulo', slots: ['12:00', '12:00'] },
      platforms: ['instagram'],
      mallaryProfileId: null,
      buffer: false,
    },
  ];
  const duplicate = await manifestRepo(t, [creatorEntry({ accountId: 'account_dup' })], duplicateSlotsAccount);
  await assert.rejects(() => duplicate.getManifest());
});

test('resolution follows requested > studio default > manifest default', async () => {
  const repo = new CreatorProfileRepository({ rootDir, manifestPath: 'profiles/creator-profiles.json' });

  const requested = await repo.resolveCreatorProfile({ requestedId: 'jones_manoel', studioDefaultId: 'filipe_boni' });
  assert.equal(requested.profile.id, 'jones_manoel');
  assert.equal(requested.layout.layoutId, 'center-speaker-vertical-v2');

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
    version: 3,
    accounts: defaultAccounts(),
    creators: [
      creatorEntry({ id: 'filipe_boni', displayName: 'Filipe Boni', enabled: true }),
      creatorEntry({
        id: 'jones_manoel',
        displayName: 'Jones Manoel',
        enabled: false,
        accountId: null,
        render: { layoutPath: jonesLayoutPath, layoutId: 'center-speaker-vertical-v2', defaultSpeed: 1.0, scene: null },
      }),
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
    version: 3,
    accounts: defaultAccounts(),
    defaultCreatorId: 'filipe_boni',
    creators: [
      creatorEntry({
        id: 'jones_manoel',
        displayName: 'Jones Manoel',
        enabled: false,
        accountId: null,
        render: { layoutPath: jonesLayoutPath, layoutId: 'center-speaker-vertical-v2', defaultSpeed: 1.0, scene: null },
      }),
      creatorEntry({ id: 'filipe_boni', displayName: 'Filipe Boni', enabled: true }),
    ],
  });
  const repo = new CreatorProfileRepository({ rootDir: dir, manifestPath });

  const fromDisabledStudioDefault = await repo.resolveCreatorProfile({ studioDefaultId: 'jones_manoel' });
  assert.equal(fromDisabledStudioDefault.profile.id, 'filipe_boni');

  const fromUnknownStudioDefault = await repo.resolveCreatorProfile({ studioDefaultId: 'ghost' });
  assert.equal(fromUnknownStudioDefault.profile.id, 'filipe_boni');

  const fromManifestDefault = await repo.resolveCreatorProfile();
  assert.equal(fromManifestDefault.profile.id, 'filipe_boni');

  const noDefaultPath = await writeManifest(dir, {
    version: 3,
    accounts: defaultAccounts(),
    creators: [
      creatorEntry({
        id: 'jones_manoel',
        displayName: 'Jones Manoel',
        enabled: false,
        accountId: null,
        render: { layoutPath: jonesLayoutPath, layoutId: 'center-speaker-vertical-v2', defaultSpeed: 1.0, scene: null },
      }),
      creatorEntry({ id: 'filipe_boni', displayName: 'Filipe Boni', enabled: true }),
    ],
  });
  const noDefaultRepo = new CreatorProfileRepository({ rootDir: dir, manifestPath: noDefaultPath });
  const fromFirstEnabled = await noDefaultRepo.resolveCreatorProfile();
  assert.equal(fromFirstEnabled.profile.id, 'filipe_boni');
});

test('layout with an invalid color is rejected', async (t) => {
  const dir = await createTempDir(t);
  const rawLayout = JSON.parse(await readFile(filipeLayoutPath, 'utf-8')) as Record<string, unknown>;
  rawLayout.background = '#12345';
  const layoutPath = join(dir, 'broken_layout.json');
  await writeFile(layoutPath, JSON.stringify(rawLayout, null, 2), 'utf-8');

  const manifestPath = await writeManifest(dir, {
    version: 3,
    accounts: defaultAccounts(),
    creators: [
      creatorEntry({ render: { layoutPath, layoutId: 'screen-top-host-bottom-v2', defaultSpeed: 1.5, scene: null } }),
    ],
  });
  const repo = new CreatorProfileRepository({ rootDir: dir, manifestPath });
  await assert.rejects(() => repo.getManifest());
});

test('hook band must clear the platform safe area', async (t) => {
  const dir = await createTempDir(t);
  const rawLayout = JSON.parse(await readFile(filipeLayoutPath, 'utf-8')) as Record<string, unknown>;
  const band = rawLayout.hookBand as Record<string, unknown>;
  band.rect = { x: 0, y: 0, w: 1, h: 0.15 };
  const layoutPath = join(dir, 'tight_band_layout.json');
  await writeFile(layoutPath, JSON.stringify(rawLayout, null, 2), 'utf-8');

  const manifestPath = await writeManifest(dir, {
    version: 3,
    accounts: defaultAccounts(),
    creators: [
      creatorEntry({ render: { layoutPath, layoutId: 'screen-top-host-bottom-v2', defaultSpeed: 1.5, scene: null } }),
    ],
  });
  const repo = new CreatorProfileRepository({ rootDir: dir, manifestPath });
  await assert.rejects(() => repo.getManifest(), /Hook band leaves no room for its text below the platform safe area\./);
});

test('duplicate creator ids are rejected', async (t) => {
  const dir = await createTempDir(t);
  const entry = creatorEntry();
  const manifestPath = await writeManifest(dir, {
    version: 3,
    accounts: defaultAccounts(),
    creators: [entry, { ...entry }],
  });
  const repo = new CreatorProfileRepository({ rootDir: dir, manifestPath });
  await assert.rejects(() => repo.getManifest(), isInvalidStudioError);
});

test('autopilot config enforces the documented bounds', async (t) => {
  const validConfig = {
    channelUrl: 'https://www.youtube.com/@filipe_boni/videos',
    shortsPerVideo: 2,
    platforms: ['instagram', 'tiktok'] as const,
    reviewWindowHours: 3,
    bookingHorizonHours: 24,
    maxShortAgeHours: 48,
    minVideoSeconds: 480,
  };
  const valid = await manifestRepo(t, [creatorEntry({ autopilot: validConfig })]);
  const manifest = await valid.getManifest();
  assert.deepEqual(manifest.creators[0].autopilot, validConfig);

  const nonYouTubeChannel = await manifestRepo(t, [creatorEntry({ autopilot: { ...validConfig, channelUrl: 'https://example.com/videos' } })]);
  await assert.rejects(() => nonYouTubeChannel.getManifest());

  const tooManyShorts = await manifestRepo(t, [creatorEntry({ autopilot: { ...validConfig, shortsPerVideo: 6 } })]);
  await assert.rejects(() => tooManyShorts.getManifest());

  const zeroShorts = await manifestRepo(t, [creatorEntry({ autopilot: { ...validConfig, shortsPerVideo: 0 } })]);
  await assert.rejects(() => zeroShorts.getManifest());

  const duplicatePlatforms = await manifestRepo(t, [creatorEntry({ autopilot: { ...validConfig, platforms: ['instagram', 'instagram'] } })]);
  await assert.rejects(() => duplicatePlatforms.getManifest());

  const emptyPlatforms = await manifestRepo(t, [creatorEntry({ autopilot: { ...validConfig, platforms: [] } })]);
  await assert.rejects(() => emptyPlatforms.getManifest());

  const reviewWindowTooLong = await manifestRepo(t, [creatorEntry({ autopilot: { ...validConfig, reviewWindowHours: 25 } })]);
  await assert.rejects(() => reviewWindowTooLong.getManifest());

  const horizonBeyondLimit = await manifestRepo(t, [creatorEntry({ autopilot: { ...validConfig, bookingHorizonHours: 73 } })]);
  await assert.rejects(() => horizonBeyondLimit.getManifest());

  const horizonNotPastReview = await manifestRepo(t, [creatorEntry({ autopilot: { ...validConfig, bookingHorizonHours: 3 } })]);
  await assert.rejects(() => horizonNotPastReview.getManifest());

  const ageTooOld = await manifestRepo(t, [creatorEntry({ autopilot: { ...validConfig, maxShortAgeHours: 169 } })]);
  await assert.rejects(() => ageTooOld.getManifest());

  const minVideoTooShort = await manifestRepo(t, [creatorEntry({ autopilot: { ...validConfig, minVideoSeconds: 59 } })]);
  await assert.rejects(() => minVideoTooShort.getManifest());
});
