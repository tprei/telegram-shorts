import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Candidate, LayoutProfile, RenderArtifact, TranscriptSentence, TranscriptWord } from '../domain/model.js';
import { ensureParent, sha256 } from './util.js';
import { runProcess } from './process.js';
import { buildLayoutFilter } from './layout.js';
import { buildAssSubtitles } from './subtitles.js';

interface RenderProfileSettings {
  width: number;
  height: number;
  fps: number;
  videoBitrate: string;
  audioBitrate: string;
  crf: string;
  preset: string;
}

export async function renderCandidate(input: {
  jobId: string;
  candidate: Candidate;
  candidateVersionId: string;
  kind: 'draft' | 'final';
  sourceVideoPath: string;
  sourceTitle: string;
  sourceThumbnailPath?: string | null;
  transcriptWords: TranscriptWord[];
  chosenSpeakerId?: string | null;
  layoutProfile?: LayoutProfile | null;
  artifactsDir: string;
}): Promise<Omit<RenderArtifact, 'telegramMessageId' | 'status' | 'createdAt' | 'id'>> {
  const profile = renderProfile(input.kind);
  const baseDir = resolve(input.artifactsDir, input.jobId, input.candidateVersionId, input.candidate.id, input.kind);
  const clipsDir = join(baseDir, 'clips');
  const listPath = join(baseDir, 'clips.txt');
  const stitchedPath = join(baseDir, 'stitched.mp4');
  const subtitlePath = join(baseDir, 'captions.ass');
  const bodyPath = join(baseDir, 'body.mp4');
  const endCardPath = join(baseDir, 'preview-end-card.mp4');
  const concatPath = join(baseDir, 'final-parts.txt');
  const artifactPath = join(baseDir, `${input.candidate.id}-${input.kind}.mp4`);
  await ensureParent(join(clipsDir, 'noop'));
  const clipPaths: string[] = [];
  for (const [index, segment] of input.candidate.segments.entries()) {
    const clipPath = join(clipsDir, `${String(index + 1).padStart(2, '0')}.mp4`);
    await createClip({
      sourceVideoPath: input.sourceVideoPath,
      outputPath: clipPath,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      profile,
      layoutProfile: input.layoutProfile,
      playbackSpeed: input.candidate.playbackSpeed ?? 1,
    });
    clipPaths.push(clipPath);
  }
  await writeFile(listPath, clipPaths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join('\n'), 'utf-8');
  await runProcess('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', stitchedPath], { capture: false });
  await writeFile(subtitlePath, buildAssSubtitles({
    candidate: input.candidate,
    transcriptWords: input.transcriptWords,
    chosenSpeakerId: input.chosenSpeakerId,
    profile: input.kind,
    layoutProfile: input.layoutProfile,
    outputWidth: profile.width,
    outputHeight: profile.height,
  }), 'utf-8');
  await burnSubtitles({
    sourcePath: stitchedPath,
    subtitlePath,
    outputPath: bodyPath,
    profile,
  });
  if (input.candidate.previewEndCard) {
    await createPreviewEndCard({
      sourcePath: input.sourceVideoPath,
      sourceStartSeconds: input.candidate.segments[input.candidate.segments.length - 1]!.endSeconds,
      sourceTitle: input.sourceTitle,
      thumbnailPath: input.sourceThumbnailPath ?? undefined,
      outputPath: endCardPath,
      profile,
    });
    await writeFile(concatPath, [`file '${bodyPath.replace(/'/g, "'\\''")}'`, `file '${endCardPath.replace(/'/g, "'\\''")}'`].join('\n'), 'utf-8');
    await runProcess('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c:v', 'libx264', '-preset', profile.preset, '-crf', profile.crf, '-b:v', profile.videoBitrate, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', profile.audioBitrate, '-movflags', '+faststart', artifactPath], { capture: false });
  } else {
    await runProcess('ffmpeg', ['-y', '-i', bodyPath, '-c', 'copy', artifactPath], { capture: false });
  }
  const buffer = await readFile(artifactPath);
  const fileStat = await stat(artifactPath);
  return {
    jobId: input.jobId,
    candidateId: input.candidate.id,
    candidateVersionId: input.candidateVersionId,
    kind: input.kind,
    profile: input.kind,
    artifactPath,
    subtitlePath,
    sizeBytes: fileStat.size,
    sha256: sha256(buffer),
  };
}

async function createClip(input: {
  sourceVideoPath: string;
  outputPath: string;
  startSeconds: number;
  endSeconds: number;
  profile: RenderProfileSettings;
  layoutProfile?: LayoutProfile | null;
  playbackSpeed: number;
}): Promise<void> {
  const duration = Math.max(0.1, input.endSeconds - input.startSeconds);
  const speed = Math.max(1, input.playbackSpeed);
  if (!input.layoutProfile) {
    const vf = `${fallbackVisualFilter(input.profile.width, input.profile.height)},setpts=PTS/${speed}`;
    await runProcess('ffmpeg', [
      '-y',
      '-ss', input.startSeconds.toFixed(3),
      '-to', input.endSeconds.toFixed(3),
      '-i', input.sourceVideoPath,
      '-vf', vf,
      '-r', String(input.profile.fps),
      '-c:v', 'libx264',
      '-preset', input.profile.preset,
      '-crf', input.profile.crf,
      '-b:v', input.profile.videoBitrate,
      '-pix_fmt', 'yuv420p',
      '-af', `atempo=${speed}`,
      '-c:a', 'aac',
      '-b:a', input.profile.audioBitrate,
      '-movflags', '+faststart',
      input.outputPath,
    ], { capture: false });
    return;
  }
  const filterComplex = `${buildLayoutFilter(input.layoutProfile, input.profile.width, input.profile.height, duration)};[vout]setpts=PTS/${speed}[vfinal]`;
  await runProcess('ffmpeg', [
    '-y',
    '-ss', input.startSeconds.toFixed(3),
    '-to', input.endSeconds.toFixed(3),
    '-i', input.sourceVideoPath,
    '-filter_complex', filterComplex,
    '-map', '[vfinal]',
    '-map', '0:a:0',
    '-r', String(input.profile.fps),
    '-c:v', 'libx264',
    '-preset', input.profile.preset,
    '-crf', input.profile.crf,
    '-b:v', input.profile.videoBitrate,
    '-pix_fmt', 'yuv420p',
    '-af', `atempo=${speed}`,
    '-c:a', 'aac',
    '-b:a', input.profile.audioBitrate,
    '-movflags', '+faststart',
    input.outputPath,
  ], { capture: false });
}

async function burnSubtitles(input: { sourcePath: string; subtitlePath: string; outputPath: string; profile: RenderProfileSettings }): Promise<void> {
  const subtitleArg = `${input.subtitlePath}`;
  await runProcess('ffmpeg', [
    '-y',
    '-i', input.sourcePath,
    '-vf', `subtitles=${subtitleArg}`,
    '-c:v', 'libx264',
    '-preset', input.profile.preset,
    '-crf', input.profile.crf,
    '-b:v', input.profile.videoBitrate,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    input.outputPath,
  ], { capture: false });
}

async function createPreviewEndCard(input: { sourcePath: string; sourceStartSeconds: number; sourceTitle: string; thumbnailPath?: string; outputPath: string; profile: RenderProfileSettings }): Promise<void> {
  const resolvedThumbPath = input.thumbnailPath ?? `${input.outputPath}.thumb.png`;
  if (!input.thumbnailPath) {
    await runProcess('ffmpeg', [
      '-y',
      '-ss', '1.000',
      '-i', input.sourcePath,
      '-frames:v', '1',
      resolvedThumbPath,
    ], { capture: false });
  }
  const titleLines = wrapTitle(input.sourceTitle, 22).slice(0, 3);
  const titleDraw = titleLines
    .map((line, index) => `drawtext=text='${escapeDrawtext(line)}':fontfile=/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf:fontcolor=white:fontsize=38:x=(w-text_w)/2:y=${74 + index * 48}`)
    .join(',');
  const titleBoxHeight = 90 + titleLines.length * 52;
  const titleBox = `drawbox=x=36:y=40:w=iw-72:h=${titleBoxHeight}:color=black@0.45:t=fill`;
  const linkBox = `drawbox=x=48:y=ih-240:w=iw-96:h=128:color=black@0.60:t=fill`;
  const linkText = `drawtext=text='Link na descrição':fontfile=/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf:fontcolor=white:fontsize=42:x=(w-text_w)/2:y=h-168`;
  await runProcess('ffmpeg', [
    '-y',
    '-ss', input.sourceStartSeconds.toFixed(3),
    '-t', '2.4',
    '-i', input.sourcePath,
    '-loop', '1',
    '-i', resolvedThumbPath,
    '-filter_complex', `[0:v]scale=${input.profile.width}:${input.profile.height}:force_original_aspect_ratio=decrease,pad=${input.profile.width}:${input.profile.height}:(ow-iw)/2:(oh-ih)/2:color=black,boxblur=18:2[bg];[1:v]scale=360:-1[thumb];[bg][thumb]overlay=(W-w)/2:240[tmp];[tmp]${titleBox},${titleDraw},${linkBox},${linkText}[vout]`,
    '-map', '[vout]',
    '-map', '0:a:0',
    '-r', String(input.profile.fps),
    '-c:v', 'libx264',
    '-preset', input.profile.preset,
    '-crf', input.profile.crf,
    '-b:v', input.profile.videoBitrate,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-movflags', '+faststart',
    input.outputPath,
  ], { capture: false });
}

function wrapTitle(value: string, maxChars: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current.length === 0 ? word : `${current} ${word}`;
    if (next.length > maxChars && current.length > 0) {
      lines.push(current);
      current = word;
      continue;
    }
    current = next;
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.slice(0, 3);
}

function escapeDrawtext(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/\n/g, '\\\\n');
}

function fallbackVisualFilter(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

function renderProfile(kind: 'draft' | 'final'): RenderProfileSettings {
  const tier = process.env.TELEGRAM_SHORTS_RENDER_TIER === 'prod' ? 'prod' : 'dev';
  if (tier === 'dev') {
    return kind === 'draft'
      ? {
          width: 480,
          height: 854,
          fps: 24,
          videoBitrate: '550k',
          audioBitrate: '96k',
          crf: '30',
          preset: 'veryfast',
        }
      : {
          width: 480,
          height: 854,
          fps: 24,
          videoBitrate: '700k',
          audioBitrate: '96k',
          crf: '28',
          preset: 'veryfast',
        };
  }
  return kind === 'draft'
    ? {
        width: 480,
        height: 854,
        fps: 24,
        videoBitrate: '550k',
        audioBitrate: '96k',
        crf: '30',
        preset: 'veryfast',
      }
    : {
        width: 720,
        height: 1280,
        fps: 24,
        videoBitrate: '1500k',
        audioBitrate: '128k',
        crf: '24',
        preset: 'medium',
      };
}
