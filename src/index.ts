#!/usr/bin/env node

import { setTimeout as sleep } from 'node:timers/promises';
import { ShortsPipeline } from './application/pipeline.js';
import { StudioService } from './application/studio-service.js';
import type { QueueLane } from './domain/model.js';
import { ShortsStore } from './infra/db.js';
import { loadConfig } from './infra/env.js';
import { CreatorProfileRepository } from './infra/creator-profile-loader.js';
import { createShortVideoPublishProvider } from './infra/instagram-publisher-factory.js';
import { acquireStudioLock } from './infra/studio-lock.js';
import { OpenRouterClient } from './infra/openrouter.js';
import { describeError, logError } from './infra/util.js';
import { createStudioApp, startStudioServer } from './studio/server.js';

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[${new Date().toISOString()}] unhandledRejection: ${describeError(reason)}\n`);
});

process.on('uncaughtExceptionMonitor', (error) => {
  process.stderr.write(`[${new Date().toISOString()}] uncaughtException: ${describeError(error)}\n`);
});

async function main(): Promise<void> {
  const config = loadConfig();
  const lock = acquireStudioLock(config.dbPath);
  let lockReleased = false;
  const release = () => {
    if (lockReleased) {
      return;
    }
    lockReleased = true;
    lock.release();
  };
  const store = await ShortsStore.open(config.dbPath);
  let server: { close(): Promise<void> } | null = null;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await server?.close();
    } catch (error) {
      logError('Studio server close failed', error);
    }
    release();
    try {
      store.close();
    } catch (error) {
      logError('Store close failed', error);
    }
  };
  process.on('exit', release);
  process.on('SIGINT', () => {
    void shutdown().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown().then(() => process.exit(0));
  });
  store.requeueRunningTasks();
  const openRouter = new OpenRouterClient(config);
  const profiles = new CreatorProfileRepository({
    rootDir: config.rootDir,
    manifestPath: config.SHORTS_CREATOR_PROFILES_PATH,
  });
  const publisher = createShortVideoPublishProvider(config);
  const studio = new StudioService({ config, store, openRouter, profiles, publisher });
  const pipeline = new ShortsPipeline({ config, store, openRouter, profiles, publisher });
  const app = createStudioApp({
    api: studio,
    media: studio,
    webDistDir: config.webDistDir,
    fontsDir: config.fontsDir,
  });
  const startedServer = await startStudioServer(app, config.SHORTS_STUDIO_PORT);
  server = startedServer;
  process.stdout.write(`Studio running at ${startedServer.url}\n`);
  await Promise.all([runLane(pipeline, 'ingest'), runLane(pipeline, 'output')]);
}

async function runLane(pipeline: ShortsPipeline, lane: QueueLane): Promise<never> {
  while (true) {
    try {
      const didWork = await pipeline.runNext(lane);
      if (!didWork) {
        await sleep(500);
      }
    } catch (error) {
      logError(`Pipeline lane ${lane} crashed`, error);
      await sleep(500);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
