import { stat } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { ZodError, z } from 'zod';
import { StudioError, type StudioErrorCode } from '../application/errors.js';
import type { StudioMediaResolver } from '../application/studio-media.js';
import { logError } from '../infra/util.js';
import {
  ChooseSpeakerRequestSchema,
  CorrectWordRequestSchema,
  CreateJobRequestSchema,
  CreateManualShortRequestSchema,
  PublishRequestSchema,
  ReviseRequestSchema,
  SaveEditRequestSchema,
  SetDefaultCreatorRequestSchema,
  SetShortStatusRequestSchema,
  UpdatePublishCopyRequestSchema,
  UpdateShortMetaRequestSchema,
  type StudioApi,
} from './api-types.js';
import { serveFile } from './media.js';

const ERROR_STATUS: Record<StudioErrorCode, 400 | 404 | 409 | 503> = {
  not_found: 404,
  conflict: 409,
  invalid: 400,
  unavailable: 503,
};

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.mjs': 'text/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=UTF-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const FONT_CONTENT_TYPES: Record<string, string> = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const finiteNumberQuery = z
  .string()
  .min(1)
  .refine((value) => Number.isFinite(Number(value)))
  .transform((value) => Number(value));

const FrameQuerySchema = z.object({
  t: finiteNumberQuery,
  w: finiteNumberQuery,
});

const WordIndexParamSchema = z
  .string()
  .min(1)
  .regex(/^\d+$/)
  .transform((value) => Number.parseInt(value, 10));

export interface StudioAppInput {
  api: StudioApi;
  media: StudioMediaResolver;
  webDistDir: string;
  fontsDir: string;
}

export function createStudioApp(input: StudioAppInput): Hono {
  const api = input.api;
  const media = input.media;
  const webRoot = path.resolve(input.webDistDir);
  const fontsRoot = path.resolve(input.fontsDir);
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof StudioError) {
      return c.json({ error: error.message, code: error.code }, ERROR_STATUS[error.code]);
    }
    if (error instanceof ZodError) {
      return c.json({ error: 'Invalid request', code: 'invalid', issues: error.issues }, 400);
    }
    logError('Studio request failed', error, { method: c.req.method, path: c.req.path });
    return c.json({ error: error instanceof Error ? error.message : String(error), code: 'internal' }, 500);
  });

  app.get('/api/creators', async (c) => c.json(await api.listCreators()));
  app.put('/api/creators/default', async (c) => c.json(await api.setDefaultCreator(SetDefaultCreatorRequestSchema.parse(await parseBody(c)))));
  app.get('/api/jobs', (c) => c.json(api.listJobs()));
  app.post('/api/jobs', async (c) => c.json(await api.createJob(CreateJobRequestSchema.parse(await parseBody(c)))));
  app.get('/api/jobs/:jobId', (c) => c.json(api.getJob(c.req.param('jobId'))));
  app.post('/api/jobs/:jobId/retry', (c) => c.json(api.retryJob(c.req.param('jobId'))));
  app.get('/api/jobs/:jobId/transcript', (c) => c.json(api.getTranscript(c.req.param('jobId'))));
  app.put('/api/jobs/:jobId/words/:wordIndex', async (c) =>
    c.json(api.correctWord(c.req.param('jobId'), WordIndexParamSchema.parse(c.req.param('wordIndex')), CorrectWordRequestSchema.parse(await parseBody(c)))),
  );
  app.post('/api/jobs/:jobId/speaker', async (c) =>
    c.json(api.chooseSpeaker(c.req.param('jobId'), ChooseSpeakerRequestSchema.parse(await parseBody(c)))),
  );
  app.post('/api/jobs/:jobId/replan', (c) => c.json(api.replan(c.req.param('jobId'))));
  app.post('/api/jobs/:jobId/host-framing/analyze', (c) => c.json(api.analyzeHostFraming(c.req.param('jobId'))));
  app.post('/api/jobs/:jobId/shorts', async (c) =>
    c.json(api.createManualShort(c.req.param('jobId'), CreateManualShortRequestSchema.parse(await parseBody(c)))),
  );
  app.get('/api/shorts/:shortId', async (c) => c.json(await api.getShort(c.req.param('shortId'))));
  app.put('/api/shorts/:shortId/edit', async (c) =>
    c.json(await api.saveEdit(c.req.param('shortId'), SaveEditRequestSchema.parse(await parseBody(c)))),
  );
  app.post('/api/shorts/:shortId/revise', async (c) =>
    c.json(await api.revise(c.req.param('shortId'), ReviseRequestSchema.parse(await parseBody(c)))),
  );
  app.post('/api/shorts/:shortId/hooks', async (c) => c.json(await api.suggestHooks(c.req.param('shortId'))));
  app.patch('/api/shorts/:shortId', async (c) =>
    c.json(await api.updateShortMeta(c.req.param('shortId'), UpdateShortMetaRequestSchema.parse(await parseBody(c)))),
  );
  app.put('/api/shorts/:shortId/status', async (c) =>
    c.json(await api.setShortStatus(c.req.param('shortId'), SetShortStatusRequestSchema.parse(await parseBody(c)))),
  );
  app.post('/api/shorts/:shortId/crops/analyze', async (c) => c.json(await api.analyzeCrops(c.req.param('shortId'))));
  app.post('/api/shorts/:shortId/exports', async (c) => c.json(await api.exportShort(c.req.param('shortId'))));
  app.post('/api/shorts/:shortId/copy/generate', async (c) => c.json(await api.generatePublishCopy(c.req.param('shortId'))));
  app.put('/api/shorts/:shortId/copy', async (c) =>
    c.json(await api.updatePublishCopy(c.req.param('shortId'), UpdatePublishCopyRequestSchema.parse(await parseBody(c)))),
  );
  app.post('/api/exports/:exportId/publish', async (c) =>
    c.json(await api.publish(c.req.param('exportId'), PublishRequestSchema.parse(await parseBody(c)))),
  );

  app.all('/api/*', (c) => c.json({ error: 'Not found', code: 'not_found' }, 404));

  app.get('/media/jobs/:jobId/source', (c) =>
    serveFile({ filePath: media.sourceVideoPath(c.req.param('jobId')), contentType: 'video/mp4', rangeHeader: c.req.header('range') }),
  );
  app.get('/media/jobs/:jobId/thumbnail', (c) =>
    serveFile({ filePath: media.thumbnailPath(c.req.param('jobId')), contentType: 'image/jpeg', rangeHeader: c.req.header('range') }),
  );
  app.get('/media/jobs/:jobId/frame', async (c) => {
    const query = FrameQuerySchema.parse({ t: c.req.query('t'), w: c.req.query('w') });
    return serveFile({
      filePath: await media.framePath(c.req.param('jobId'), query.t, query.w),
      contentType: 'image/jpeg',
      rangeHeader: c.req.header('range'),
    });
  });
  app.get('/media/exports/:exportId', (c) => {
    const filePath = media.exportVideoPath(c.req.param('exportId'));
    return serveFile({
      filePath,
      contentType: 'video/mp4',
      rangeHeader: c.req.header('range'),
      downloadFileName: c.req.query('download') === '1' ? path.basename(filePath) : null,
    });
  });
  app.get('/media/exports/:exportId/cover', (c) =>
    serveFile({ filePath: media.exportCoverPath(c.req.param('exportId')), contentType: 'image/jpeg', rangeHeader: c.req.header('range') }),
  );
  app.get('/fonts/:file', (c) => {
    const file = c.req.param('file');
    const safe = file.length > 0 && file !== '.' && !file.includes('/') && !file.includes('\\') && !file.includes('..') && !file.includes('\0');
    if (!safe) throw new StudioError('invalid', `Invalid font name: ${file}`);
    return serveFile({
      filePath: path.join(fontsRoot, file),
      contentType: FONT_CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      rangeHeader: c.req.header('range'),
    });
  });

  app.get('*', async (c) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(c.req.path);
    } catch {
      throw new StudioError('invalid', 'Invalid request path');
    }
    if (pathname.includes('\0')) {
      throw new StudioError('invalid', 'Invalid request path');
    }
    const target = path.resolve(webRoot, `.${pathname}`);
    const inside = target === webRoot || target.startsWith(`${webRoot}${path.sep}`);
    const candidates = inside ? [target, path.join(webRoot, 'index.html')] : [path.join(webRoot, 'index.html')];
    for (const candidate of candidates) {
      try {
        if ((await stat(candidate)).isFile()) {
          return serveFile({
            filePath: candidate,
            contentType: STATIC_CONTENT_TYPES[path.extname(candidate).toLowerCase()] ?? 'application/octet-stream',
            rangeHeader: c.req.header('range'),
          });
        }
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
        throw error;
      }
    }
    return new Response('Run pnpm build:web', { status: 503, headers: { 'Content-Type': 'text/plain; charset=UTF-8' } });
  });

  return app;
}

export async function startStudioServer(app: Hono, port: number): Promise<{ url: string; close(): Promise<void> }> {
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  return {
    url: `http://127.0.0.1:${boundPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

async function parseBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new StudioError('invalid', 'Invalid JSON body');
  }
}
