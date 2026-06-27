import { basename, extname } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { Candidate, InstagramReelCopy } from '../domain/model.js';
import { runProcess } from './process.js';

const BASE_URL = 'https://mallary.ai';
const GENERIC_HASHTAGS = ['#InstagramReels', '#ReelsBrasil'];

export interface MallaryPublishResult {
  status: string;
  batchId: string | null;
  jobs: Array<{ platform: string; jobId: string }>;
}

export class MallaryClient {
  constructor(
    private readonly apiToken: string,
    private readonly profileId?: string | null,
  ) {}

  async publishInstagramReel(input: {
    filePath: string;
    message: string;
    idempotencyKey: string;
    thumbnailPath?: string | null;
  }): Promise<MallaryPublishResult> {
    const upload = await this.uploadFile(input.filePath);
    const thumbnailUpload = input.thumbnailPath ? await this.uploadFile(input.thumbnailPath) : null;
    const payload = {
      message: input.message,
      platforms: ['instagram'],
      ...(this.profileId ? { profile_id: this.profileId } : {}),
      media: [{
        url: upload.mediaUrl,
        type: mimeType(input.filePath),
        ...(thumbnailUpload ? { thumbnail_url: thumbnailUpload.mediaUrl } : {}),
      }],
      platform_options: {
        instagram: {
          post_type: 'reel',
        },
      },
    };
    const response = await fetch(`${BASE_URL}/api/v1/post`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify(payload),
    }).then(assertOk('Mallary create post failed'));
    const json = await response.json() as { status?: string; batch_id?: string; jobs?: Array<{ platform?: string; jobId?: string }> };
    return {
      status: json.status ?? 'unknown',
      batchId: json.batch_id ?? null,
      jobs: (json.jobs ?? []).map((job) => ({ platform: String(job.platform ?? ''), jobId: String(job.jobId ?? '') })).filter((job) => job.platform.length > 0 && job.jobId.length > 0),
    };
  }

  private async uploadFile(path: string): Promise<{ uploadUrl: string; mediaUrl: string; headers?: Record<string, string> }> {
    const upload = await this.createUploadUrl({
      filename: basename(path),
      size: (await readFile(path)).byteLength,
      type: mimeType(path),
    });
    const buffer = await readFile(path);
    await fetch(upload.uploadUrl, {
      method: 'PUT',
      headers: upload.headers ?? {},
      body: buffer,
    }).then(assertOk('Mallary upload failed'));
    return upload;
  }

  private async createUploadUrl(input: { filename: string; size: number; type: string }): Promise<{ uploadUrl: string; mediaUrl: string; headers?: Record<string, string> }> {
    const response = await fetch(`${BASE_URL}/api/v1/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    }).then(assertOk('Mallary upload URL request failed'));
    const json = await response.json() as { uploadUrl?: string; mediaUrl?: string; headers?: Record<string, string> };
    if (!json.uploadUrl || !json.mediaUrl) {
      throw new Error('Mallary upload URL response was incomplete.');
    }
    return {
      uploadUrl: json.uploadUrl,
      mediaUrl: json.mediaUrl,
      headers: json.headers,
    };
  }
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
  const paddedHashtags = [...hashtags, ...GENERIC_HASHTAGS.filter((tag) => !hashtags.includes(tag))].slice(0, 6);
  return `${ensureSentence(copy.line_1)}\n${ensureSentence(copy.line_2)}\n\n${paddedHashtags.join(' ')}`;
}

function uniqueHashtags(values: string[]): string[] {
  const tags: string[] = [];
  for (const value of values) {
    const normalized = value.trim().replace(/\s+/g, '');
    if (!normalized) {
      continue;
    }
    const tag = normalized.startsWith('#') ? normalized : `#${normalized}`;
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

function mimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.mp4') {
    return 'video/mp4';
  }
  if (extension === '.mov') {
    return 'video/quicktime';
  }
  return 'application/octet-stream';
}

function assertOk(message: string) {
  return async (response: Response): Promise<Response> => {
    if (response.ok) {
      return response;
    }
    const text = await response.text().catch(() => '');
    throw new Error(`${message}: ${response.status} ${text}`.trim());
  };
}
