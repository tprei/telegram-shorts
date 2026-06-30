import { basename, extname } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { Candidate, InstagramReelCopy } from '../domain/model.js';
import type { ShortVideoPlatform, ShortVideoPublishInput, ShortVideoPublishProvider, ShortVideoPublishResult } from './instagram-publisher.js';
import { ShortVideoPublishError } from './instagram-publisher.js';
import { runProcess } from './process.js';
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

export class MallaryUploadClient {
  constructor(private readonly apiToken: string) {}

  async uploadFile(path: string): Promise<{ uploadUrl: string; mediaUrl: string; headers?: Record<string, string> }> {
    const upload = await this.createUploadUrl({
      filename: basename(path),
      size: (await readFile(path)).byteLength,
      type: mallaryMimeType(path),
    });
    const buffer = await readFile(path);
    let response: Response;
    try {
      response = await fetch(upload.uploadUrl, {
        method: 'PUT',
        headers: upload.headers ?? {},
        body: buffer,
      });
    } catch (error) {
      logError('Mallary media upload failed', error, { path, uploadUrl: upload.uploadUrl, type: mallaryMimeType(path) });
      throw new ShortVideoPublishError({
        provider: 'mallary',
        stage: 'upload',
        message: `Mallary media upload failed for ${path}`,
        safeToFailover: true,
        cause: error,
      });
    }
    await assertOk('mallary', 'upload', 'Mallary upload failed')(response);
    return upload;
  }

  private async createUploadUrl(input: { filename: string; size: number; type: string }): Promise<{ uploadUrl: string; mediaUrl: string; headers?: Record<string, string> }> {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/api/v1/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      });
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

export class MallaryClient implements ShortVideoPublishProvider {
  readonly name = 'mallary';
  readonly supportedPlatforms: ShortVideoPlatform[] = ['instagram', 'tiktok', 'youtube_shorts'];
  private readonly uploadClient: MallaryUploadClient;

  constructor(
    private readonly apiToken: string,
    private readonly profileId?: string | null,
  ) {
    this.uploadClient = new MallaryUploadClient(apiToken);
  }

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
      response = await fetch(`${BASE_URL}/api/v1/post`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
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

export async function createInstagramCoverImage(input: {
  sourceVideoPath: string;
  sourceThumbnailPath?: string | null;
  candidate: Candidate;
  outputPath: string;
}): Promise<string> {
  const fallbackFramePath = `${input.outputPath}.frame.jpg`;
  const baseImagePath = input.sourceThumbnailPath ?? fallbackFramePath;
  if (!input.sourceThumbnailPath) {
    const probeSeconds = input.candidate.segments[0]
      ? input.candidate.segments[0].startSeconds + Math.max(0.3, Math.min(2, (input.candidate.segments[0].endSeconds - input.candidate.segments[0].startSeconds) / 3))
      : 1;
    await runProcess('ffmpeg', [
      '-y',
      '-ss', probeSeconds.toFixed(3),
      '-i', input.sourceVideoPath,
      '-frames:v', '1',
      fallbackFramePath,
    ], { capture: false });
  }
  try {
    await runProcess('ffmpeg', [
      '-y',
      '-loop', '1',
      '-i', baseImagePath,
      '-filter_complex', '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=18:2[bg];[0:v]scale=920:920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[vout]',
      '-map', '[vout]',
      '-frames:v', '1',
      '-update', '1',
      input.outputPath,
    ], { capture: false });
  } finally {
    if (!input.sourceThumbnailPath) {
      await unlink(fallbackFramePath).catch(() => undefined);
    }
  }
  return input.outputPath;
}

export function buildInstagramReelDescription(copy: InstagramReelCopy): string {
  const hashtags = uniqueHashtags(copy.hashtags).slice(0, 6);
  return `${ensureSentence(copy.line_1)}\n${ensureSentence(copy.line_2)}\n\n${hashtags.join(' ')}`;
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
