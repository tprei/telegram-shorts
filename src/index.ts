#!/usr/bin/env node

import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AUTOPILOT_TICK_MS } from './domain/autopilot.js';
import { Autopilot } from './application/autopilot.js';
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
import { listChannelUploads } from './infra/youtube.js';
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
  store.enqueueMissingPublicationChecks();
  store.enqueueMissingHostHeadAnalyses();
  const openRouter = new OpenRouterClient(config);
  const profiles = new CreatorProfileRepository({
    rootDir: config.rootDir,
    manifestPath: config.SHORTS_CREATOR_PROFILES_PATH,
  });
  const publisher = createShortVideoPublishProvider(config);
  const studio = new StudioService({ config, store, openRouter, profiles, publisher });
  const pipeline = new ShortsPipeline({ config, store, openRouter, profiles, publisher });
  const autopilot = new Autopilot({
    store,
    service: studio,
    profiles,
    listUploads: (channelUrl, limit) => listChannelUploads(channelUrl, limit, {
      cookiesPath: config.SHORTS_YTDLP_COOKIES_PATH ? resolve(config.rootDir, config.SHORTS_YTDLP_COOKIES_PATH) : undefined,
      cookiesFromBrowser: config.SHORTS_YTDLP_COOKIES_FROM_BROWSER,
      jsRuntime: config.SHORTS_YTDLP_JS_RUNTIME,
    }),
    now: () => new Date(),
  });
  const app = createStudioApp({
    api: studio,
    autopilot,
    media: studio,
    webDistDir: config.webDistDir,
    fontsDir: config.fontsDir,
  });
  const startedServer = await startStudioServer(app, config.SHORTS_STUDIO_PORT);
  server = startedServer;
  process.stdout.write(`Studio running at ${startedServer.url}\n`);
  await Promise.all([runLane(pipeline, 'ingest'), runLane(pipeline, 'output'), runAutopilot(autopilot)]);
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

async function runAutopilot(autopilot: Autopilot): Promise<never> {
  while (true) {
    try {
      await autopilot.tick();
    } catch (error) {
      logError('Autopilot tick crashed', error);
    }
    await sleep(AUTOPILOT_TICK_MS);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
