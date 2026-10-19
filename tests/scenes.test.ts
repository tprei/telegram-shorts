import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';

import type { AppConfig } from '../src/infra/env.js';
import { analyzeScenes, parseScdetScores, refineShotCut } from '../src/infra/scenes.js';
import { runProcess } from '../src/infra/process.js';

const scenesConfig = {
  OPENROUTER_API_KEY: 'test-key',
  OPENROUTER_VISION_MODEL: 'test-vision-model',
} as AppConfig;

interface SegmentSpec {
  color: string;
  seconds: number;
  box?: { x: number; y: number; w: number; h: number; color: string; from: number };
}

const HOST_RESPONSE = {
  host_visible: true,
  host_camera_box: [0, 0, 1000, 500],
  host_head_box: [100, 100, 400, 300],
  content_visible: true,
  content_box: [0, 0, 1000, 1000],
  content_kind: 'document',
  subject_box: [200, 200, 800, 800],
  overlay_boxes: [],
  reason: 'câmera com inseto',
};

const CONTENT_ONLY_RESPONSE = {
  host_visible: false,
  host_camera_box: [0, 0, 0, 0],
  host_head_box: [0, 0, 0, 0],
  content_visible: true,
  content_box: [0, 0, 1000, 1000],
  content_kind: 'document',
  subject_box: [200, 200, 800, 800],
  overlay_boxes: [],
  reason: 'sem apresentador',
};

const NO_MATERIAL_RESPONSE = {
  host_visible: false,
  host_camera_box: [0, 0, 0, 0],
  host_head_box: [0, 0, 0, 0],
  content_visible: false,
  content_box: [0, 0, 0, 0],
  content_kind: 'none',
  subject_box: [0, 0, 0, 0],
  overlay_boxes: [],
  reason: 'nenhum material utilizável',
};

const WIDE_CONTENT_RESPONSE = {
  ...CONTENT_ONLY_RESPONSE,
  content_box: [50, 100, 950, 700],
  subject_box: [150, 200, 850, 600],
};

const NARROW_CONTENT_RESPONSE = {
  ...CONTENT_ONLY_RESPONSE,
  content_box: [0, 350, 1000, 650],
  subject_box: [100, 400, 900, 600],
};

function stubSceneFetch(respond: (base64: string) => Promise<Response> | Response): { restore(): void } {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const base64 = sceneUserImage(body);
    const response = await respond(base64);
    return response;
  }) as typeof fetch;
  return { restore() {
    globalThis.fetch = originalFetch;
  } };
}

function sceneUserImage(body: string): string {
  const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
  const user = parsed.messages.find((message) => message.role === 'user');
  if (!Array.isArray(user?.content)) {
    return '';
  }
  const parts = user.content as Array<{ type: string; image_url?: { url: string } }>;
  const image = parts.find((part) => part.type === 'image_url');
  const url = image?.image_url?.url ?? '';
  return url.replace('data:image/jpeg;base64,', '');
}

async function pixelAt(base64: string, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(Buffer.from(base64, 'base64')).raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return { r: data[offset]!, g: data[offset + 1]!, b: data[offset + 2]! };
}

function ok(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function quotaLimited(): Response {
  return new Response('limite excedido', { status: 429 });
}

function greenInsetPresent(base64: string): Promise<boolean> {
  return pixelAt(base64, 320, 370).then((pixel) => pixel.g > 100 && pixel.g > pixel.r + 40 && pixel.g > pixel.b + 40);
}

const ENCODE_ARGS = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p'];

async function generateSceneVideo(target: string, segments: SegmentSpec[]): Promise<void> {
  const args: string[] = ['-v', 'error', '-y'];
  for (const segment of segments) {
    args.push('-f', 'lavfi', '-i', `color=c=${segment.color}:s=640x360:r=30:d=${segment.seconds}`);
  }
  const chains: string[] = [];
  const labels: string[] = [];
  segments.forEach((segment, index) => {
    if (segment.box === undefined) {
      labels.push(`[${index}:v]`);
      return;
    }
    const box = segment.box;
    chains.push(`[${index}:v]drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=${box.color}:t=fill:enable='gte(t,${box.from})'[s${index}]`);
    labels.push(`[s${index}]`);
  });
  chains.push(`${labels.join('')}concat=n=${segments.length}:v=1:a=0`);
  args.push(
    '-filter_complex', chains.join(';'),
    ...ENCODE_ARGS,
    target,
  );
  await runProcess('ffmpeg', args);
}

interface SceneFixture {
  videoPath: string;
  workDir: string;
  durationSeconds: number;
  cleanup(): Promise<void>;
}

async function synthesizedFixture(durationSeconds: number, generate: (videoPath: string) => Promise<void>): Promise<SceneFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'scenes-test-'));
  const videoPath = join(dir, 'source.mp4');
  await generate(videoPath);
  return {
    videoPath,
    workDir: dir,
    durationSeconds,
    async cleanup(): Promise<void> {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function sceneFixture(segments: SegmentSpec[]): Promise<SceneFixture> {
  return synthesizedFixture(
    segments.reduce((total, segment) => total + segment.seconds, 0),
    (videoPath) => generateSceneVideo(videoPath, segments),
  );
}

function mediaOf(fixture: SceneFixture): {
  videoPath: string;
  audioPath: string;
  thumbnailPath: null;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
} {
  return {
    videoPath: fixture.videoPath,
    audioPath: fixture.videoPath,
    thumbnailPath: null,
    width: 640,
    height: 360,
    fps: 30,
    durationSeconds: fixture.durationSeconds,
  };
}

function assertCompleteCoverage(track: { segments: Array<{ startSeconds: number; endSeconds: number; host: unknown; content: unknown }> }, durationSeconds: number): void {
  assert.ok(track.segments.length >= 1);
  assert.equal(track.segments[0]!.startSeconds, 0);
  assert.equal(track.segments[track.segments.length - 1]!.endSeconds, durationSeconds);
  let previousEnd: number | null = null;
  for (const segment of track.segments) {
    assert.ok(segment.endSeconds > segment.startSeconds, `segment ${segment.startSeconds}..${segment.endSeconds} is empty`);
    if (previousEnd !== null) {
      assert.ok(Math.abs(segment.startSeconds - previousEnd) < 1e-6, `gap between ${previousEnd} and ${segment.startSeconds}`);
    }
    assert.ok(segment.host !== null || segment.content !== null, `segment ${segment.startSeconds}..${segment.endSeconds} has no material`);
    previousEnd = segment.endSeconds;
  }
}

test('native cut refinement and in-shot PiP changes produce complete source segments', { timeout: 300_000 }, async () => {
  assert.deepEqual(
    parseScdetScores('frame:1 pts:1 pts_time:0.2\nlavfi.scd.score=0.000\nframe:2 pts:2 pts_time:0.4\nlavfi.scd.score=17.896\nframe:3 pts:3 pts_time:0.6\nlavfi.scd.score=4.5\n', 4.6),
    [
      { sourceSeconds: 4.8, score: 0 },
      { sourceSeconds: 5, score: 17.896 },
      { sourceSeconds: 4.6 + 0.6, score: 4.5 },
    ],
  );
  const fixture = await sceneFixture([
    { color: 'green', seconds: 4 },
    { color: 'black', seconds: 16, box: { x: 20, y: 40, w: 280, h: 290, color: 'green', from: 2 } },
    { color: 'green', seconds: 4 },
  ]);
  try {
    const retained = await refineShotCut({
      videoPath: fixture.videoPath,
      candidateSeconds: 2.03,
      durationSeconds: fixture.durationSeconds,
      fps: 30,
    });
    assert.equal(retained, Math.round(2.03 * 30) / 30);
    const stub = stubSceneFetch((base64) => greenInsetPresent(base64).then((present) => ok(present ? HOST_RESPONSE : CONTENT_ONLY_RESPONSE)));
    try {
      const track = await analyzeScenes({
        config: scenesConfig,
        media: mediaOf(fixture),
        scene: { hostDescription: 'apresentador do canal', hints: null },
        workDir: fixture.workDir,
      });
      assert.equal(track.version, 1);
      assert.deepEqual(track.frame, { width: 640, height: 360 });
      const boundaries = [...track.segments.map((segment) => segment.startSeconds), track.segments[track.segments.length - 1]!.endSeconds];
      assert.deepEqual(boundaries, [0, 4, 6, 20, 24]);
      assertCompleteCoverage(track, 24);
      const hostSegment = track.segments[2]!;
      const host = hostSegment.host as { camera: { x: number; y: number; w: number; h: number }; head: { x: number; y: number; w: number; h: number } };
      assert.ok(host !== null, 'the segment after the change point uses the right-side host observation');
      assert.ok(Math.abs(host.camera.x) < 0.01 && Math.abs(host.camera.w - 0.5) < 0.02, `camera ${JSON.stringify(host.camera)}`);
      assert.equal(track.segments[1]!.host, null);
      assert.ok(track.segments[1]!.content !== null);
    } finally {
      stub.restore();
    }
  } finally {
    await fixture.cleanup();
  }
});

test('exactly half successful scene samples are accepted and fewer fail visibly', { timeout: 300_000 }, async () => {
  const fixture = await sceneFixture([
    { color: 'green', seconds: 4 },
    { color: 'black', seconds: 4 },
  ]);
  try {
    const stub = stubSceneFetch((base64) => pixelAt(base64, 320, 180).then((pixel) => pixel.g > 100 ? ok(CONTENT_ONLY_RESPONSE) : quotaLimited()));
    try {
      const track = await analyzeScenes({
        config: scenesConfig,
        media: mediaOf(fixture),
        scene: { hostDescription: 'apresentador do canal', hints: null },
        workDir: fixture.workDir,
      });
      assert.deepEqual(track.frame, { width: 640, height: 360 });
      const boundaries = [...track.segments.map((segment) => segment.startSeconds), track.segments[track.segments.length - 1]!.endSeconds];
      assert.deepEqual(boundaries, [0, 4, 8]);
      assertCompleteCoverage(track, 8);
      const failedShotSegment = track.segments[1]!;
      assert.deepEqual(
        { host: failedShotSegment.host, content: failedShotSegment.content, overlays: failedShotSegment.overlays },
        { host: track.segments[0]!.host, content: track.segments[0]!.content, overlays: track.segments[0]!.overlays },
      );
    } finally {
      stub.restore();
    }
    const failing = stubSceneFetch(() => quotaLimited());
    try {
      await assert.rejects(
        analyzeScenes({
          config: scenesConfig,
          media: mediaOf(fixture),
          scene: { hostDescription: 'apresentador do canal', hints: null },
          workDir: fixture.workDir,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Scene analysis succeeded on 0 of 2 samples; at least 50% are required\./);
          assert.ok(error.cause !== undefined, 'the thrown analysis error preserves the last sample cause');
          return true;
        },
      );
    } finally {
      failing.restore();
    }
  } finally {
    await fixture.cleanup();
  }
});

test('black and logo intro samples do not fail scene analysis when half succeed', { timeout: 300_000 }, async () => {
  const fixture = await sceneFixture([
    { color: 'black', seconds: 2 },
    { color: 'green', seconds: 2 },
  ]);
  try {
    const stub = stubSceneFetch((base64) => pixelAt(base64, 320, 180).then((pixel) => pixel.g > 100 ? ok(CONTENT_ONLY_RESPONSE) : ok(NO_MATERIAL_RESPONSE)));
    try {
      const track = await analyzeScenes({
        config: scenesConfig,
        media: mediaOf(fixture),
        scene: { hostDescription: 'apresentador do canal', hints: null },
        workDir: fixture.workDir,
      });
      assert.deepEqual(track.frame, { width: 640, height: 360 });
      const boundaries = [...track.segments.map((segment) => segment.startSeconds), track.segments[track.segments.length - 1]!.endSeconds];
      assert.deepEqual(boundaries, [0, 2, 4]);
      assertCompleteCoverage(track, 4);
      const introSegment = track.segments[0]!;
      assert.deepEqual(
        { host: introSegment.host, content: introSegment.content, overlays: introSegment.overlays },
        { host: track.segments[1]!.host, content: track.segments[1]!.content, overlays: track.segments[1]!.overlays },
      );
    } finally {
      stub.restore();
    }
  } finally {
    await fixture.cleanup();
  }
});

test('scene sample timeout aborts the request and preserves the failure cause', { timeout: 300_000 }, async () => {
  const fixture = await sceneFixture([
    { color: 'green', seconds: 4 },
  ]);
  try {
    const originalTimeout = AbortSignal.timeout;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let signalAborted = false;
    AbortSignal.timeout = () => originalTimeout(20);
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const { promise, reject } = Promise.withResolvers<Response>();
      const signal = init?.signal;
      if (signal !== undefined) {
        if (signal.aborted) {
          signalAborted = true;
          reject(signal.reason);
        } else {
          signal.addEventListener('abort', () => {
            signalAborted = true;
            reject(signal.reason);
          }, { once: true });
        }
      }
      return promise;
    }) as typeof fetch;
    try {
      await assert.rejects(
        analyzeScenes({
          config: scenesConfig,
          media: mediaOf(fixture),
          scene: { hostDescription: 'apresentador do canal', hints: null },
          workDir: fixture.workDir,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Scene analysis succeeded on 0 of 1 samples; at least 50% are required\./);
          assert.ok(error.cause instanceof Error);
          assert.equal(error.cause.name, 'TimeoutError');
          return true;
        },
      );
      assert.ok(signalAborted, 'the sample fetch was aborted on timeout');
      assert.equal(calls, 1, 'aborted timeout request was not retried');
    } finally {
      AbortSignal.timeout = originalTimeout;
      globalThis.fetch = originalFetch;
    }
  } finally {
    await fixture.cleanup();
  }
});

test('content vertical flag compares source pixel shape, not normalized box sides', { timeout: 300_000 }, async () => {
  const fixture = await sceneFixture([
    { color: 'green', seconds: 4 },
    { color: 'black', seconds: 4 },
  ]);
  try {
    const stub = stubSceneFetch((base64) => pixelAt(base64, 320, 180).then((pixel) => ok(pixel.g > 100 ? WIDE_CONTENT_RESPONSE : NARROW_CONTENT_RESPONSE)));
    try {
      const track = await analyzeScenes({
        config: scenesConfig,
        media: mediaOf(fixture),
        scene: { hostDescription: 'apresentador do canal', hints: null },
        workDir: fixture.workDir,
      });
      const boundaries = [...track.segments.map((segment) => segment.startSeconds), track.segments[track.segments.length - 1]!.endSeconds];
      assert.deepEqual(boundaries, [0, 4, 8]);
      assert.equal(track.segments[0]!.content?.vertical, false);
      assert.equal(track.segments[1]!.content?.vertical, true);
    } finally {
      stub.restore();
    }
  } finally {
    await fixture.cleanup();
  }
});

const CORNER_A_BOX = { x: 40, y: 40, w: 128, h: 72, color: 'gray', from: 0 };
const CORNER_B_BOX = { x: 448, y: 240, w: 128, h: 72, color: 'gray', from: 0 };
const CORNER_A_RESPONSE = { ...HOST_RESPONSE, host_camera_box: [111, 63, 311, 263], host_head_box: [130, 90, 290, 240] };
const CORNER_B_RESPONSE = { ...HOST_RESPONSE, host_camera_box: [667, 700, 867, 900], host_head_box: [690, 730, 840, 870] };
const CORNER_A_PROBE = { x: 208, y: 152 };
const CORNER_B_PROBE = { x: 1024, y: 552 };

type InsetCorner = 'a' | 'b' | 'none';

const RESPONSE_BY_CORNER: Record<InsetCorner, unknown> = {
  a: CORNER_A_RESPONSE,
  b: CORNER_B_RESPONSE,
  none: CONTENT_ONLY_RESPONSE,
};

async function visibleInsetCorner(base64: string): Promise<InsetCorner> {
  const [a, b] = await Promise.all([
    pixelAt(base64, CORNER_A_PROBE.x, CORNER_A_PROBE.y),
    pixelAt(base64, CORNER_B_PROBE.x, CORNER_B_PROBE.y),
  ]);
  if (a.g > 100) {
    return 'a';
  }
  return b.g > 100 ? 'b' : 'none';
}

test('an inset that moves to another corner mid-shot and back gets a camera-scan sample and its own segment', { timeout: 300_000 }, async () => {
  const fixture = await sceneFixture([
    { color: 'black', seconds: 6, box: CORNER_A_BOX },
    { color: 'black', seconds: 2, box: CORNER_B_BOX },
    { color: 'black', seconds: 12, box: CORNER_A_BOX },
  ]);
  try {
    const observed: InsetCorner[] = [];
    const stub = stubSceneFetch(async (base64) => {
      const corner = await visibleInsetCorner(base64);
      observed.push(corner);
      return ok(RESPONSE_BY_CORNER[corner]);
    });
    try {
      const track = await analyzeScenes({
        config: scenesConfig,
        media: mediaOf(fixture),
        scene: { hostDescription: 'apresentador do canal', hints: null },
        workDir: fixture.workDir,
      });
      assert.deepEqual([...observed].sort(), ['a', 'a', 'a', 'b']);
      const boundaries = [...track.segments.map((segment) => segment.startSeconds), track.segments[track.segments.length - 1]!.endSeconds];
      assert.deepEqual(boundaries, [0, 6, 8, 20]);
      assertCompleteCoverage(track, 20);
      const first = track.segments[0]!.host!.camera;
      const moved = track.segments[1]!.host!.camera;
      const last = track.segments[2]!.host!.camera;
      assert.ok(first.x < 0.5 && first.y < 0.5, `first camera ${JSON.stringify(first)}`);
      assert.ok(moved.x > 0.5 && moved.y > 0.5, `moved camera ${JSON.stringify(moved)}`);
      assert.ok(last.x < 0.5 && last.y < 0.5, `last camera ${JSON.stringify(last)}`);
    } finally {
      stub.restore();
    }
  } finally {
    await fixture.cleanup();
  }
});

test('two disagreeing samples on a static picture are settled by the midpoint sample and keep one segment', { timeout: 300_000 }, async () => {
  const fixture = await sceneFixture([{ color: 'black', seconds: 20, box: CORNER_A_BOX }]);
  try {
    let calls = 0;
    const stub = stubSceneFetch(() => {
      calls += 1;
      return ok(calls === 1 ? CORNER_A_RESPONSE : CONTENT_ONLY_RESPONSE);
    });
    try {
      const track = await analyzeScenes({
        config: scenesConfig,
        media: mediaOf(fixture),
        scene: { hostDescription: 'apresentador do canal', hints: null },
        workDir: fixture.workDir,
      });
      assert.equal(calls, 3);
      const boundaries = [...track.segments.map((segment) => segment.startSeconds), track.segments[track.segments.length - 1]!.endSeconds];
      assert.deepEqual(boundaries, [0, 20]);
      assertCompleteCoverage(track, 20);
      assert.equal(track.segments[0]!.host, null);
      assert.ok(track.segments[0]!.content !== null);
    } finally {
      stub.restore();
    }
  } finally {
    await fixture.cleanup();
  }
});

async function generateFadeVideo(target: string): Promise<void> {
  await runProcess('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=white:s=640x360:r=30:d=32',
    '-f', 'lavfi', '-i', `color=c=black:s=640x360:r=30:d=20,drawbox=x=${CORNER_A_BOX.x}:y=${CORNER_A_BOX.y}:w=${CORNER_A_BOX.w}:h=${CORNER_A_BOX.h}:color=${CORNER_A_BOX.color}:t=fill`,
    '-filter_complex', '[0:v][1:v]xfade=transition=fade:duration=4:offset=28,format=yuv420p[v]',
    '-map', '[v]',
    ...ENCODE_ARGS,
    target,
  ]);
}

const LATE_PATCH_PROBE = { x: 1216, y: 656 };

async function generateLatePatchVideo(target: string): Promise<void> {
  await runProcess('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=640x360:r=30:d=60,drawbox=x=${CORNER_A_BOX.x}:y=${CORNER_A_BOX.y}:w=${CORNER_A_BOX.w}:h=${CORNER_A_BOX.h}:color=${CORNER_A_BOX.color}:t=fill,drawbox=x=576:y=296:w=64:h=64:color=white:t=fill:enable='gte(t,35)'`,
    ...ENCODE_ARGS,
    target,
  ]);
}

test('a fade from content to a host inset puts the scene boundary inside the fade', { timeout: 300_000 }, async () => {
  const fixture = await synthesizedFixture(48, generateFadeVideo);
  try {
    const stub = stubSceneFetch(async (base64) => {
      const centre = await pixelAt(base64, 640, 360);
      return ok(centre.g > 100 ? CONTENT_ONLY_RESPONSE : CORNER_A_RESPONSE);
    });
    try {
      const track = await analyzeScenes({
        config: scenesConfig,
        media: mediaOf(fixture),
        scene: { hostDescription: 'apresentador do canal', hints: null },
        workDir: fixture.workDir,
      });
      const boundaries = [...track.segments.map((segment) => segment.startSeconds), track.segments[track.segments.length - 1]!.endSeconds];
      assert.equal(boundaries.length, 3, `boundaries ${boundaries}`);
      assert.ok(boundaries[1]! >= 28 && boundaries[1]! <= 32, `fade boundary ${boundaries[1]}`);
      assertCompleteCoverage(track, 48);
      assert.equal(track.segments[0]!.host, null);
      assert.notEqual(track.segments[1]!.host, null);
    } finally {
      stub.restore();
    }
  } finally {
    await fixture.cleanup();
  }
});

test('a host sample removed by the vote re-forms the boundary so the later host segment survives', { timeout: 300_000 }, async () => {
  const fixture = await synthesizedFixture(60, generateLatePatchVideo);
  try {
    const stub = stubSceneFetch(async (base64) => {
      const patch = await pixelAt(base64, LATE_PATCH_PROBE.x, LATE_PATCH_PROBE.y);
      return ok(patch.g > 100 ? CORNER_A_RESPONSE : CONTENT_ONLY_RESPONSE);
    });
    try {
      const track = await analyzeScenes({
        config: scenesConfig,
        media: mediaOf(fixture),
        scene: { hostDescription: 'apresentador do canal', hints: null },
        workDir: fixture.workDir,
      });
      const boundaries = [...track.segments.map((segment) => segment.startSeconds), track.segments[track.segments.length - 1]!.endSeconds];
      assert.equal(boundaries.length, 3, `boundaries ${boundaries}`);
      assert.ok(Math.abs(boundaries[1]! - 39.6) <= 1 / 30, `boundary ${boundaries[1]}`);
      assertCompleteCoverage(track, 60);
      assert.equal(track.segments[0]!.host, null);
      assert.notEqual(track.segments[1]!.host, null);
    } finally {
      stub.restore();
    }
  } finally {
    await fixture.cleanup();
  }
});
