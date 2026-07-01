import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ShortsWorkflow } from '../src/application/workflow.js';
import type { AppConfig } from '../src/infra/env.js';
import { ShortsStore } from '../src/infra/db.js';
import type { TelegramCallbackAnswer, TelegramGateway, TelegramMessage } from '../src/infra/telegram.js';

class FakeTelegram implements TelegramGateway {
  readonly sentMessages: Array<{ chatId: string; text: string; replyMarkup?: Record<string, unknown>; message_id: number }> = [];
  readonly edits: Array<{ chatId: string; messageId: number; text: string; replyMarkup?: Record<string, unknown> }> = [];
  readonly deletedMessages: Array<{ chatId: string; messageId: number }> = [];
  readonly answers: TelegramCallbackAnswer[] = [];

  async deleteWebhook(): Promise<void> {}
  async getUpdates(): Promise<unknown[]> { return []; }

  async sendMessage(chatId: string | number, text: string, replyMarkup?: Record<string, unknown>): Promise<TelegramMessage> {
    const message = { chatId: String(chatId), text, replyMarkup, message_id: this.sentMessages.length + 1 };
    this.sentMessages.push(message);
    return { message_id: message.message_id };
  }

  async editMessageText(chatId: string | number, messageId: number, text: string, replyMarkup?: Record<string, unknown>): Promise<void> {
    this.edits.push({ chatId: String(chatId), messageId, text, replyMarkup });
  }

  async deleteMessage(chatId: string | number, messageId: number): Promise<void> {
    this.deletedMessages.push({ chatId: String(chatId), messageId });
  }
  async sendVideo(): Promise<TelegramMessage> { return { message_id: 100 }; }
  async sendDocument(): Promise<TelegramMessage> { return { message_id: 101 }; }

  async answerCallbackQuery(input: TelegramCallbackAnswer): Promise<void> {
    this.answers.push(input);
  }
}

test('/profile persists chat default and /process snapshots selected creator/layout', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-shorts-profile-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const store = await ShortsStore.open(join(dir, 'shorts.sqlite'));
  t.after(() => store.close());
  const telegram = new FakeTelegram();
  const workflow = new ShortsWorkflow(testConfig(dir), store, telegram, {} as never);

  await workflow.handleUpdate({
    update_id: 1,
    message: { message_id: 1, text: '/profile', chat: { id: 123 }, from: { id: 456 } },
  });

  assert.match(telegram.sentMessages[0]?.text ?? '', /Perfil atual: Filipe Boni/);
  const keyboard = telegram.sentMessages[0]?.replyMarkup?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
  const jonesButton = keyboard.flat().find((button) => button.text.includes('Jones Manoel'));
  assert.ok(jonesButton);

  await workflow.handleUpdate({
    update_id: 2,
    callback_query: {
      id: 'callback-1',
      data: jonesButton.callback_data,
      from: { id: 456 },
      message: { message_id: 1, chat: { id: 123 } },
    },
  });

  assert.equal(store.getDefaultCreatorProfileId('123'), 'jones_manoel');
  assert.match(telegram.edits[0]?.text ?? '', /Jones Manoel/);

  await workflow.handleUpdate({
    update_id: 3,
    message: { message_id: 2, text: 'https://youtu.be/video123', chat: { id: 123 }, from: { id: 456 } },
  });

  const job = store.listJobs(1)[0];
  assert.ok(job);
  assert.equal(job.creatorProfileId, 'jones_manoel');
  assert.equal(job.creatorProfileSnapshot?.displayName, 'Jones Manoel');
  assert.equal(job.layoutProfileId, 'center-speaker-vertical-crop-v1');
  assert.equal(job.layoutProfileSnapshot?.creatorId, 'jones_manoel');
  assert.equal(job.profileSelectionSource, 'chat_default');
  assert.match(telegram.sentMessages.at(-1)?.text ?? '', /Perfil: Jones Manoel/);
});

test('legacy mode ignores creator defaults when no manifest is configured', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-shorts-profile-legacy-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const store = await ShortsStore.open(join(dir, 'shorts.sqlite'));
  t.after(() => store.close());
  store.setDefaultCreatorProfileId('123', 'jones_manoel');
  const workflow = new ShortsWorkflow(testConfig(dir, { manifestPath: null }), store, new FakeTelegram(), {} as never);

  const job = await workflow.createJob('https://youtu.be/video123', '123', '456');
  assert.equal(job.creatorProfileId, 'legacy_default');
  assert.equal(job.profileSelectionSource, 'legacy_static_layout');
  assert.equal(job.layoutProfileSnapshot?.creatorId, 'filipe_boni');
});

test('legacy chat defaults migrate cleanly once a real creator manifest is enabled', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-shorts-profile-migrate-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const store = await ShortsStore.open(join(dir, 'shorts.sqlite'));
  t.after(() => store.close());
  store.setDefaultCreatorProfileId('123', 'legacy_default');
  const workflow = new ShortsWorkflow(testConfig(dir), store, new FakeTelegram(), {} as never);

  const job = await workflow.createJob('https://youtu.be/video123', '123', '456');
  assert.equal(job.creatorProfileId, 'filipe_boni');
  assert.equal(job.profileSelectionSource, 'env_default');
});

test('stale chat profile defaults do not silently switch to another publish-enabled creator', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-shorts-profile-stale-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const manifestPath = join(dir, 'creator-profiles.json');
  await writeManifest(manifestPath, { instagramMode: 'global', jonesEnabled: false });
  const store = await ShortsStore.open(join(dir, 'shorts.sqlite'));
  t.after(() => store.close());
  store.setDefaultCreatorProfileId('123', 'jones_manoel');
  const workflow = new ShortsWorkflow(testConfig(dir, { manifestPath }), store, new FakeTelegram(), {} as never);

  await assert.rejects(
    () => workflow.createJob('https://youtu.be/video123', '123', '456'),
    /jones_manoel/i,
  );
});

test('legacy publish_instagram tasks still dedupe new Instagram publish requests', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-shorts-profile-dedupe-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const store = await ShortsStore.open(join(dir, 'shorts.sqlite'));
  t.after(() => store.close());
  const workflow = new ShortsWorkflow(testConfig(dir), store, new FakeTelegram(), {} as never);

  const job = await workflow.createJob('https://youtu.be/video123', '123', '456');
  store.enqueueTask(job.id, 'publish_instagram', {
    renderId: 'rnd_legacy',
    candidateId: 'cand_1',
    candidateVersionId: 'cv_1',
  });

  const skipped = (workflow as any).enqueueShortVideoPublish(job.id, {
    platform: 'instagram',
    renderId: 'rnd_legacy',
    candidateId: 'cand_1',
    candidateVersionId: 'cv_1',
    force: false,
  });
  const forced = (workflow as any).enqueueShortVideoPublish(job.id, {
    platform: 'instagram',
    renderId: 'rnd_legacy',
    candidateId: 'cand_1',
    candidateVersionId: 'cv_1',
    force: true,
  });

  assert.equal(skipped, 'skipped');
  assert.equal(forced, 'enqueued');
});

test('denied publish callbacks keep the final Telegram message visible', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-shorts-profile-callback-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const manifestPath = join(dir, 'creator-profiles.json');
  await writeManifest(manifestPath, { instagramMode: 'global' });
  const store = await ShortsStore.open(join(dir, 'shorts.sqlite'));
  t.after(() => store.close());
  const telegram = new FakeTelegram();
  const workflow = new ShortsWorkflow(testConfig(dir, { manifestPath, mallaryToken: 'mallary-token' }), store, telegram, {} as never);

  const job = await workflow.createJob('https://youtu.be/video123', '123', '456');
  store.saveRender({
    id: 'rnd_1',
    jobId: job.id,
    candidateId: 'cand_1',
    candidateVersionId: 'cv_1',
    kind: 'final',
    profile: 'final',
    status: 'sent',
    artifactPath: '/tmp/final.mp4',
    subtitlePath: '/tmp/final.ass',
    sizeBytes: 1234,
    sha256: 'abc',
    telegramMessageId: 77,
    createdAt: new Date().toISOString(),
  } as never);
  await writeManifest(manifestPath, { instagramMode: 'disabled' });

  const token = store.createCallbackToken({
    kind: 'publish_instagram',
    jobId: job.id,
    candidateId: 'cand_1',
    candidateVersionId: 'cv_1',
    renderId: 'rnd_1',
  });
  await workflow.handleUpdate({
    update_id: 9,
    callback_query: {
      id: 'callback-publish-disabled',
      data: token,
      from: { id: 456 },
      message: { message_id: 77, chat: { id: 123 } },
    },
  });

  assert.equal(telegram.deletedMessages.length, 0);
  assert.match(telegram.answers.at(-1)?.text ?? '', /Indisponível: Instagram/);
});

test('publishing availability follows the current creator manifest for existing jobs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-shorts-profile-publish-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const manifestPath = join(dir, 'creator-profiles.json');
  await writeManifest(manifestPath, { instagramMode: 'global' });
  const store = await ShortsStore.open(join(dir, 'shorts.sqlite'));
  t.after(() => store.close());
  const workflow = new ShortsWorkflow(testConfig(dir, { manifestPath, mallaryToken: 'mallary-token' }), store, new FakeTelegram(), {} as never);

  const job = await workflow.createJob('https://youtu.be/video123', '123', '456');
  const availableBefore = await (workflow as any).availableShortVideoPlatforms(job);
  assert.deepEqual(availableBefore, ['instagram']);

  await writeManifest(manifestPath, { instagramMode: 'disabled' });
  const refreshed = store.getJob(job.id);
  assert.ok(refreshed);
  const availableAfter = await (workflow as any).availableShortVideoPlatforms(refreshed);
  assert.deepEqual(availableAfter, []);
});

function testConfig(dir: string, options: { manifestPath?: string | null; mallaryToken?: string } = {}): AppConfig {
  return {
    rootDir: process.cwd(),
    dbPath: join(dir, 'shorts.sqlite'),
    artifactsDir: join(dir, 'artifacts'),
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_MODEL: 'test-model',
    TELEGRAM_SHORTS_TRANSCRIPT_PROVIDER: 'deepgram',
    MALLARY_AI_API_TOKEN: options.mallaryToken,
    TELEGRAM_SHORTS_INSTAGRAM_PUBLISH_PROVIDERS: 'mallary,buffer',
    TELEGRAM_SHORTS_DB_PATH: join(dir, 'shorts.sqlite'),
    TELEGRAM_SHORTS_ARTIFACTS_DIR: join(dir, 'artifacts'),
    TELEGRAM_SHORTS_POLL_INTERVAL_MS: 1500,
    TELEGRAM_SHORTS_MAX_FILE_BYTES: 45_000_000,
    TELEGRAM_SHORTS_CREATOR_PROFILES_PATH: options.manifestPath === null ? undefined : options.manifestPath ?? 'profiles/creator-profiles.json',
    TELEGRAM_SHORTS_DEFAULT_CREATOR_ID: 'filipe_boni',
    TELEGRAM_SHORTS_STATIC_LAYOUT_PATH: 'profiles/filipe_boni_layout.json',
    TELEGRAM_SHORTS_RENDER_TIER: 'dev',
  };
}

async function writeManifest(path: string, options: { instagramMode: 'global' | 'disabled'; jonesEnabled?: boolean }): Promise<void> {
  await writeFile(path, JSON.stringify({
    version: 1,
    defaultCreatorId: 'filipe_boni',
    creators: [
      {
        id: 'filipe_boni',
        displayName: 'Filipe Boni',
        enabled: true,
        telegram: { buttonLabel: 'Filipe Boni', aliases: ['filipe'] },
        render: {
          layoutPath: 'profiles/filipe_boni_layout.json',
          layoutId: 'source-left-host-right-stack-v1',
          snapshotLayoutInJobs: true,
        },
        publish: {
          instagram: {
            mode: options.instagramMode,
            provider: 'global',
            fallbackToGlobal: true,
            configRef: null,
          },
          tiktok: { mode: 'disabled' },
          youtube_shorts: { mode: 'disabled' },
        },
      },
      {
        id: 'jones_manoel',
        displayName: 'Jones Manoel',
        enabled: options.jonesEnabled ?? true,
        telegram: { buttonLabel: 'Jones Manoel', aliases: ['jones'] },
        render: {
          layoutPath: 'profiles/jones_manoel_layout.json',
          layoutId: 'center-speaker-vertical-crop-v1',
          snapshotLayoutInJobs: true,
        },
        publish: {
          instagram: { mode: 'disabled' },
          tiktok: { mode: 'disabled' },
          youtube_shorts: { mode: 'disabled' },
        },
      },
    ],
  }, null, 2), 'utf-8');
}
