import { readFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { runProcess } from './process.js';
import { ensureParent } from './util.js';

export interface DownloadedSource {
  sourceVideoPath: string;
  sourceAudioPath: string;
  sourceThumbnailPath: string | null;
  title: string | null;
  durationSeconds: number;
}

export interface YouTubeDownloadOptions {
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

export async function downloadSource(outDir: string, url: string, options: YouTubeDownloadOptions = {}): Promise<DownloadedSource> {
  assertPublicYouTubeUrl(url);
  const sourceBase = join(resolve(outDir), 'source');
  const infoPath = `${sourceBase}.info.json`;
  const sourceVideoPattern = `${sourceBase}.%(ext)s`;
  await ensureParent(sourceBase);
  await runProcess('yt-dlp', buildYtDlpArgs(sourceVideoPattern, url, options), { capture: false });
  const rawInfo = JSON.parse(await readFile(infoPath, 'utf-8')) as { title?: string; duration?: number; thumbnail?: string };
  const initialVideoPath = `${sourceBase}.mp4`;
  const normalizedVideoPath = join(resolve(outDir), 'source.mp4');
  if (initialVideoPath !== normalizedVideoPath) {
    await rename(initialVideoPath, normalizedVideoPath).catch(() => undefined);
  }
  const sourceAudioPath = join(resolve(outDir), 'source.m4a');
  await runProcess('ffmpeg', ['-y', '-i', normalizedVideoPath, '-vn', '-ac', '1', '-ar', '16000', sourceAudioPath], { capture: false });
  const durationSeconds = rawInfo.duration && Number.isFinite(rawInfo.duration)
    ? rawInfo.duration
    : await probeDuration(normalizedVideoPath);
  const sourceThumbnailPath = rawInfo.thumbnail
    ? await downloadThumbnail(rawInfo.thumbnail, join(resolve(outDir), 'source-thumbnail.jpg'))
    : null;
  return {
    sourceVideoPath: normalizedVideoPath,
    sourceAudioPath,
    sourceThumbnailPath,
    title: rawInfo.title ?? null,
    durationSeconds,
  };
}

export function buildYtDlpArgs(sourceVideoPattern: string, url: string, options: YouTubeDownloadOptions = {}): string[] {
  const args = [
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '--format', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/best[ext=mp4]/best',
    '--write-info-json',
    '--output', sourceVideoPattern,
  ];
  if (options.cookiesPath) {
    args.push('--cookies', options.cookiesPath);
  } else if (options.cookiesFromBrowser) {
    args.push('--cookies-from-browser', options.cookiesFromBrowser);
  }
  if (options.jsRuntime) {
    args.push('--js-runtimes', options.jsRuntime);
  }
  args.push(url);
  return args;
}

async function downloadThumbnail(url: string, path: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await ensureParent(path);
    await import('node:fs/promises').then(({ writeFile }) => writeFile(path, buffer));
    return path;
  } catch {
    return null;
  }
}

export async function probeDuration(path: string): Promise<number> {
  const result = await runProcess('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path]);
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Could not determine source duration.');
  }
  return duration;
}
