import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { SourceMedia } from '../domain/model.js';
import { runProcess } from './process.js';
import { ensureParent, logError } from './util.js';

export interface DownloadedSource {
  title: string;
  media: SourceMedia;
}

export interface YtDlpAuthOptions {
  cookiesPath?: string;
  cookiesFromBrowser?: string;
  jsRuntime?: string;
}

export function assertPublicYouTubeUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only public YouTube URLs are supported.');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(hostname)) {
    throw new Error('Only public YouTube URLs are supported.');
  }
}

const DOWNLOAD_TIMEOUT_MS = 60 * 60_000;

export async function downloadSource(outDir: string, url: string, options: YtDlpAuthOptions = {}): Promise<DownloadedSource> {
  assertPublicYouTubeUrl(url);
  const absoluteOutDir = resolve(outDir);
  const sourceBase = join(absoluteOutDir, 'source');
  const infoPath = `${sourceBase}.info.json`;
  const videoPath = join(absoluteOutDir, 'source.mp4');
  const audioPath = join(absoluteOutDir, 'source.m4a');
  const thumbnailPath = join(absoluteOutDir, 'thumbnail.jpg');
  await ensureParent(sourceBase);
  await runProcess('yt-dlp', buildYtDlpArgs(`${sourceBase}.%(ext)s`, url, options), { capture: false, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  const rawInfo = JSON.parse(await readFile(infoPath, 'utf-8')) as { title?: string; thumbnail?: string };
  await runProcess('ffmpeg', ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', audioPath], { capture: false, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  const probed = await probeSourceMedia(videoPath);
  const resolvedThumbnailPath = rawInfo.thumbnail
    ? await downloadThumbnail(rawInfo.thumbnail, thumbnailPath)
    : null;
  return {
    title: rawInfo.title ?? '',
    media: {
      videoPath,
      audioPath,
      thumbnailPath: resolvedThumbnailPath,
      width: probed.width,
      height: probed.height,
      fps: probed.fps,
      durationSeconds: probed.durationSeconds,
    },
  };
}

function ytDlpAuthArgs(options: YtDlpAuthOptions): string[] {
  const args: string[] = [];
  if (options.cookiesPath) {
    args.push('--cookies', options.cookiesPath);
  } else if (options.cookiesFromBrowser) {
    args.push('--cookies-from-browser', options.cookiesFromBrowser);
  }
  if (options.jsRuntime) {
    args.push('--js-runtimes', options.jsRuntime);
  }
  return args;
}

export function buildYtDlpArgs(sourceVideoPattern: string, url: string, options: YtDlpAuthOptions = {}): string[] {
  const args = [
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '--format', 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]/bv*[height<=1080]+ba/b',
    '--write-info-json',
    '--output', sourceVideoPattern,
    ...ytDlpAuthArgs(options),
    url,
  ];
  return args;
}

export interface ChannelUpload {
  videoId: string;
  title: string | null;
  durationSeconds: number | null;
  liveStatus: string | null;
}

const ChannelUploadsSchema = z.object({
  entries: z.array(z.object({
    id: z.string().min(1),
    title: z.string().nullable().optional(),
    duration: z.number().nullable().optional(),
    live_status: z.string().nullable().optional(),
  })),
});

export function parseChannelUploads(raw: string): ChannelUpload[] {
  const parsed = ChannelUploadsSchema.parse(JSON.parse(raw));
  return parsed.entries.map((entry) => ({
    videoId: entry.id,
    title: entry.title ?? null,
    durationSeconds: entry.duration ?? null,
    liveStatus: entry.live_status ?? null,
  }));
}

export async function listChannelUploads(channelUrl: string, limit: number, options: YtDlpAuthOptions): Promise<ChannelUpload[]> {
  const result = await runProcess('yt-dlp', ['--flat-playlist', '--playlist-end', String(limit), '-J', ...ytDlpAuthArgs(options), channelUrl], { capture: true, timeoutMs: 120_000 });
  return parseChannelUploads(result.stdout);
}

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function youTubeVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname === 'youtu.be' || parsed.hostname.endsWith('.youtu.be')) {
    const id = parsed.pathname.slice(1);
    return VIDEO_ID_PATTERN.test(id) ? id : null;
  }
  const vParam = parsed.searchParams.get('v');
  if (vParam !== null && VIDEO_ID_PATTERN.test(vParam)) {
    return vParam;
  }
  const pathMatch = parsed.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/);
  return pathMatch?.[1] ?? null;
}

export function parseFrameRate(value: string): number {
  const [numeratorText, denominatorText] = value.split('/');
  const numerator = Number(numeratorText);
  const denominator = denominatorText === undefined ? 1 : Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    throw new Error(`Unsupported frame rate: ${value}`);
  }
  return numerator / denominator;
}

interface ProbedSourceMedia {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
}

async function probeSourceMedia(path: string): Promise<ProbedSourceMedia> {
  const result = await runProcess('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate:format=duration',
    '-of', 'default=noprint_wrappers=1',
    path,
  ]);
  const fields: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) {
      fields[line.slice(0, separator)] = line.slice(separator + 1).trim();
    }
  }
  const width = Number(fields.width);
  const height = Number(fields.height);
  const fpsText = fields.r_frame_rate;
  const fps = fpsText ? parseFrameRate(fpsText) : Number.NaN;
  const durationSeconds = Number(fields.duration);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('Could not determine source video dimensions.');
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error('Could not determine source frame rate.');
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Could not determine source duration.');
  }
  return { width, height, fps, durationSeconds };
}

async function downloadThumbnail(url: string, path: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      logError('YouTube thumbnail download failed', new Error(`HTTP ${response.status}`), { url, path });
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await ensureParent(path);
    await writeFile(path, buffer);
    return path;
  } catch (error) {
    logError('YouTube thumbnail download failed', error, { url, path });
    return null;
  }
}
