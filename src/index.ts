#!/usr/bin/env node

import { closeSync, openSync, unlinkSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { ShortsStore } from './infra/db.js';
import { loadConfig } from './infra/env.js';
import { OpenRouterClient } from './infra/openrouter.js';
import { TelegramApi } from './infra/telegram.js';
import { ShortsWorkflow } from './application/workflow.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await ShortsStore.open(config.dbPath);
  store.requeueRunningTasks();
  const openRouter = new OpenRouterClient(config);
  const args = process.argv.slice(2).filter((value, index) => !(index === 0 && value === '--'));
  if (args[0] === 'process-once') {
    const url = args[1];
    const speaker = readFlag(args, '--speaker') ?? 'host';
    if (!url) {
      throw new Error('Usage: process-once <youtube-url> --speaker "Name"');
    }
    const workflow = new ShortsWorkflow(config, store, null, openRouter);
    const finalPath = await workflow.processOnce(url, speaker);
    process.stdout.write(`${finalPath}\n`);
    store.close();
    return;
  }
  if (!config.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is required in bot mode.');
  }
  const lockFd = acquireLock(`${config.dbPath}.lock`);
  const release = () => {
    if (lockFd !== null) {
      try {
        closeSync(lockFd);
      } catch {}
      try {
        unlinkSync(`${config.dbPath}.lock`);
      } catch {}
    }
    store.close();
  };
  process.on('exit', release);
  const telegram = new TelegramApi(config.TELEGRAM_BOT_TOKEN);
  const workflow = new ShortsWorkflow(config, store, telegram, openRouter);
  await telegram.deleteWebhook(false);
  process.on('SIGINT', () => {
    release();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    release();
    process.exit(0);
  });
  await Promise.all([
    pollTelegram(store, telegram, workflow, config.TELEGRAM_SHORTS_POLL_INTERVAL_MS),
    runWorker(workflow),
  ]);
}

async function pollTelegram(store: ShortsStore, telegram: TelegramApi, workflow: ShortsWorkflow, pollIntervalMs: number): Promise<never> {
  let offset = Number(store.getSetting('last_update_id') ?? '0') + 1;
  while (true) {
    try {
      const updates = await telegram.getUpdates(offset, 30);
      for (const update of updates) {
        const updateId = Number((update as { update_id?: number }).update_id ?? 0);
        await workflow.handleUpdate(update);
        if (updateId >= offset) {
          offset = updateId + 1;
          store.setSetting('last_update_id', String(updateId));
        }
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      await sleep(pollIntervalMs);
    }
  }
}

async function runWorker(workflow: ShortsWorkflow): Promise<never> {
  while (true) {
    const didWork = await workflow.runNextTask();
    if (!didWork) {
      await sleep(500);
    }
  }
}

function readFlag(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
}

function acquireLock(path: string): number | null {
  try {
    return openSync(path, 'wx');
  } catch {
    throw new Error('telegram-shorts is already running.');
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
