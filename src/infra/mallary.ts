import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, extname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PublishCopy, ShortVideoPlatform } from '../domain/model.js';
import type { ShortVideoPublishInput, ShortVideoPublishProvider, ShortVideoPublishResult } from './instagram-publisher.js';
import { ShortVideoPublishError } from './instagram-publisher.js';
import { logError } from './util.js';

const BASE_URL = 'https://mallary.ai';
const DISALLOWED_HASHTAGS = new Set([
  '#instagramreels',
  '#reels',
  '#reel',
  '#reelsinstagram',
  '#instareels',
  '#fyp',
  '#fy',
  '#foryou',
  '#foryoupage',
  '#viral',
  '#explorepage',
  '#explore',
]);

const UPLOAD_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAYS_MS = [2_000, 5_000];
const TRANSIENT_NETWORK_CODES: Record<string, true> = {
  ETIMEDOUT: true,
  ECONNRESET: true,
  ECONNREFUSED: true,
  ECONNABORTED: true,
  EPIPE: true,
  EAI_AGAIN: true,
  ENETUNREACH: true,
  EHOSTUNREACH: true,
  UND_ERR_CONNECT_TIMEOUT: true,
  UND_ERR_HEADERS_TIMEOUT: true,
  UND_ERR_BODY_TIMEOUT: true,
  UND_ERR_SOCKET: true,
};

export interface MallaryUpload {
  uploadUrl: string;
  mediaUrl: string;
  headers?: Record<string, string>;
}

class UploadStalledError extends Error {
  constructor(seconds: number) {
    super(`Upload stalled: no bytes accepted for ${seconds}s`);
    this.name = 'UploadStalledError';
  }
}

class UploadHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Upload rejected: ${status} ${body}`.trim());
    this.name = 'UploadHttpError';
  }
}

export class MallaryUploadClient {
  private readonly uploads = new Map<string, Promise<MallaryUpload>>();
  private readonly baseUrl: string;
  private readonly retryDelaysMs: number[];

  constructor(
    private readonly apiToken: string,
    options: { baseUrl?: string; retryDelaysMs?: number[] } = {},
  ) {
    this.baseUrl = options.baseUrl ?? BASE_URL;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  async uploadFile(path: string): Promise<MallaryUpload> {
    const info = await stat(path);
    const key = `${path}:${info.size}:${info.mtimeMs}`;
    const existing = this.uploads.get(key);
    if (existing) {
      return existing;
    }
    const pending = this.upload(path, info.size);
    this.uploads.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      this.uploads.delete(key);
      throw error;
    }
  }

  private async upload(path: string, size: number): Promise<MallaryUpload> {
    const type = mallaryMimeType(path);
    const upload = await this.createUploadUrl({ filename: basename(path), size, type });
    try {
      await withNetworkRetries('Mallary media upload', this.retryDelaysMs, (error) => isTransientNetworkError(error) || (error instanceof UploadHttpError && error.status >= 500), () => putFile(upload, path, size));
    } catch (error) {
      logError('Mallary media upload failed', error, { path, size, type });
      throw new ShortVideoPublishError({
        provider: 'mallary',
        stage: 'upload',
        message: `Mallary media upload failed for ${path}${error instanceof UploadHttpError ? `: ${error.message}` : ''}`,
        safeToFailover: !(error instanceof UploadHttpError) || error.status < 500,
        cause: error,
      });
    }
    return upload;
  }

  private async createUploadUrl(input: { filename: string; size: number; type: string }): Promise<MallaryUpload> {
    let response: Response;
    try {
      response = await withNetworkRetries('Mallary upload URL request', this.retryDelaysMs, isTransientNetworkError, () => fetch(`${this.baseUrl}/api/v1/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      }));
    } catch (error) {
      logError('Mallary upload URL request failed', error, input);
      throw new ShortVideoPublishError({
        provider: 'mallary',
        stage: 'upload',
        message: 'Mallary upload URL request failed.',
        safeToFailover: true,
        cause: error,
      });
    }
    response = await assertOk('mallary', 'upload', 'Mallary upload URL request failed')(response);
    const json = await response.json() as { uploadUrl?: string; mediaUrl?: string; headers?: Record<string, string> };
    if (!json.uploadUrl || !json.mediaUrl) {
      throw new ShortVideoPublishError({
        provider: 'mallary',
        stage: 'upload',
        message: 'Mallary upload URL response was incomplete.',
        safeToFailover: true,
      });
    }
    return {
      uploadUrl: json.uploadUrl,
      mediaUrl: json.mediaUrl,
      headers: json.headers,
    };
  }
}

function putFile(upload: MallaryUpload, path: string, size: number): Promise<void> {
  const target = new URL(upload.uploadUrl);
  const send = target.protocol === 'http:' ? httpRequest : httpsRequest;
  return new Promise<void>((resolve, reject) => {
    const request = send(target, { method: 'PUT', headers: { ...upload.headers, 'Content-Length': String(size) } }, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve();
          return;
        }
        reject(new UploadHttpError(status, Buffer.concat(chunks).toString('utf-8').slice(0, 500)));
      });
    });
    request.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => request.destroy(new UploadStalledError(UPLOAD_IDLE_TIMEOUT_MS / 1000)));
    request.on('error', reject);
    const file = createReadStream(path);
    file.on('error', (error) => request.destroy(error));
    file.pipe(request);
  });
}

async function withNetworkRetries<T>(label: string, delaysMs: number[], retryable: (error: unknown) => boolean, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay === undefined || !retryable(error)) {
        throw error;
      }
      logError(`${label} failed; retrying in ${delay / 1000}s`, error, { attempt: attempt + 1 });
      await sleep(delay);
    }
  }
}

function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof UploadStalledError) {
    return true;
  }
  let current: unknown = error;
  while (current instanceof Error) {
    if ('code' in current && typeof current.code === 'string' && TRANSIENT_NETWORK_CODES[current.code] === true) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export class MallaryClient implements ShortVideoPublishProvider {
  readonly name = 'mallary';
  readonly supportedPlatforms: ShortVideoPlatform[] = ['instagram', 'tiktok', 'youtube_shorts'];

  constructor(
    private readonly apiToken: string,
    private readonly profileId: string | null | undefined,
    private readonly uploadClient: MallaryUploadClient,
  ) {}

  supports(platform: ShortVideoPlatform): boolean {
    return this.supportedPlatforms.includes(platform);
  }

  async publishShortVideo(input: ShortVideoPublishInput): Promise<ShortVideoPublishResult> {
    const upload = await this.uploadClient.uploadFile(input.filePath);
    const thumbnailUpload = input.platform === 'instagram' && input.thumbnailPath
      ? await this.uploadClient.uploadFile(input.thumbnailPath)
      : null;
    const payload = buildMallaryShortVideoPayload({
      platform: input.platform,
      message: input.message,
      title: input.title,
      mediaUrl: upload.mediaUrl,
      mediaType: mallaryMimeType(input.filePath),
      profileId: this.profileId,
      thumbnailUrl: thumbnailUpload?.mediaUrl ?? null,
      commentsUnderPost: input.commentsUnderPost,
    });
    let response: Response;
    try {
      response = await withNetworkRetries('Mallary create post request', DEFAULT_RETRY_DELAYS_MS, isTransientNetworkError, () => fetch(`${BASE_URL}/api/v1/post`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify(payload),
      }));
    } catch (error) {
      logError('Mallary create post request failed', error, {
        platform: input.platform,
        filePath: input.filePath,
        hasThumbnail: Boolean(input.thumbnailPath),
        commentsUnderPostCount: input.commentsUnderPost?.length ?? 0,
      });
      throw new ShortVideoPublishError({
        provider: this.name,
        stage: 'create',
        message: 'Mallary create post request failed.',
        safeToFailover: false,
        cause: error,
      });
    }
    response = await assertOk(this.name, 'create', 'Mallary create post failed')(response);
    const json = await response.json() as { status?: string; batch_id?: string; jobs?: Array<{ platform?: string; jobId?: string }> };
    return {
      provider: this.name,
      platform: input.platform,
      status: json.status ?? 'unknown',
      batchId: json.batch_id ?? null,
      jobs: (json.jobs ?? []).map((job) => ({ platform: String(job.platform ?? ''), jobId: String(job.jobId ?? '') })).filter((job) => job.platform.length > 0 && job.jobId.length > 0),
    };
  }
}

export function buildMallaryInstagramReelPayload(input: {
  message: string;
  mediaUrl: string;
  mediaType: string;
  profileId?: string | null;
  thumbnailUrl?: string | null;
  commentsUnderPost?: string[];
}): Record<string, unknown> {
  const commentsUnderPost = normalizeCommentsUnderPost(input.commentsUnderPost);
  return {
    message: input.message,
    platforms: ['instagram'],
    ...(input.profileId ? { profile_id: input.profileId } : {}),
    media: [{
      url: input.mediaUrl,
      type: input.mediaType,
      ...(input.thumbnailUrl ? { thumbnail_url: input.thumbnailUrl } : {}),
    }],
    ...(commentsUnderPost.length > 0 ? { comments_under_post: commentsUnderPost } : {}),
    platform_options: {
      instagram: {
        post_type: 'reel',
      },
    },
  };
}

function buildMallaryShortVideoPayload(input: {
  platform: ShortVideoPlatform;
  message: string;
  title?: string | null;
  mediaUrl: string;
  mediaType: string;
  profileId?: string | null;
  thumbnailUrl?: string | null;
  commentsUnderPost?: string[];
}): Record<string, unknown> {
  if (input.platform === 'instagram') {
    return buildMallaryInstagramReelPayload(input);
  }
  if (input.platform === 'tiktok') {
    return {
      message: input.message,
      platforms: ['tiktok'],
      ...(input.profileId ? { profile_id: input.profileId } : {}),
      media: [{
        url: input.mediaUrl,
        type: input.mediaType,
      }],
      platform_options: {
        tiktok: {
          post_type: 'video',
          post_mode: 'DIRECT_POST',
          source: 'FILE_UPLOAD',
        },
      },
    };
  }
  return {
    message: input.message,
    platforms: ['youtube'],
    ...(input.profileId ? { profile_id: input.profileId } : {}),
    media: [{
      url: input.mediaUrl,
      type: input.mediaType,
    }],
    platform_options: {
      youtube: {
        post_type: 'shorts',
        title: input.title ?? 'Shorts',
        visibility: 'public',
        categoryId: '22',
        madeForKids: false,
      },
    },
  };
}

export function buildPublishMessage(copy: PublishCopy): string {
  const hashtags = uniqueHashtags(copy.hashtags).slice(0, 6);
  return `${ensureSentence(copy.line1)}\n${ensureSentence(copy.line2)}\n\n${hashtags.join(' ')}`;
}

function normalizeCommentsUnderPost(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter((value) => value.length > 0)
    .slice(0, 3);
}

function uniqueHashtags(values: string[]): string[] {
  const tags: string[] = [];
  for (const value of values) {
    const normalized = value.trim().replace(/\s+/g, '');
    if (!normalized) {
      continue;
    }
    const tag = normalized.startsWith('#') ? normalized : `#${normalized}`;
    if (DISALLOWED_HASHTAGS.has(tag.toLowerCase())) {
      continue;
    }
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }
  return tags;
}

function ensureSentence(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) {
    return '';
  }
  return /[.!?…]$/.test(compact) ? compact : `${compact}.`;
}

export function mallaryMimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.mp4') {
    return 'video/mp4';
  }
  if (extension === '.mov') {
    return 'video/quicktime';
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }
  if (extension === '.png') {
    return 'image/png';
  }
  if (extension === '.webp') {
    return 'image/webp';
  }
  if (extension === '.gif') {
    return 'image/gif';
  }
  return 'application/octet-stream';
}

export function parseMallaryRetryAfterSeconds(bodyText: string): number | null {
  try {
    const payload = JSON.parse(bodyText) as {
      error?: { code?: string; details?: { retry_after?: number | string } };
    };
    if (payload.error?.code !== 'trial_posting_throttled') {
      return null;
    }
    const retryAfter = payload.error.details?.retry_after;
    const numeric = typeof retryAfter === 'number' ? retryAfter : typeof retryAfter === 'string' ? Number(retryAfter) : NaN;
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  } catch {
    return null;
  }
}

function assertOk(provider: string, stage: 'upload' | 'create', message: string) {
  return async (response: Response): Promise<Response> => {
    if (response.ok) {
      return response;
    }
    const text = await response.text().catch(() => '');
    const retryAfterSeconds = provider === 'mallary' && response.status === 429 ? parseMallaryRetryAfterSeconds(text) : null;
    throw new ShortVideoPublishError({
      provider,
      stage,
      message: `${message}: ${response.status} ${text}`.trim(),
      safeToFailover: retryAfterSeconds === null && response.status < 500,
      retryAfterSeconds,
    });
  };
}
