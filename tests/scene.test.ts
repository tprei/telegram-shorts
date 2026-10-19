import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormRect } from '../src/domain/layout.js';
import {
  buildSceneSegments,
  buildSceneShots,
  CAMERA_EDGE_MAX_FRAMES,
  HEAD_SMOOTHING_IOU,
  clusterCameras,
  documentCropSpans,
  evenlySpacedMemberIndices,
  freezeSceneTrack,
  isFullFrameCamera,
  meanEdgeGradient,
  medianEdges,
  rectContains,
  rectIntersectionArea,
  rectIoU,
  refineCameraEdges,
  sceneAt,
  sceneSampleTimes,
  sceneSignature,
  smoothSceneHeads,
  allowedCompositions,
  defaultComposition,
  hostUsable,
  type ClusteredObservation,
  type ClusteredSceneSegment,
  type GreyFrame,
  type SceneObservation,
} from '../src/domain/scene.js';
import type { SceneSegment, TranscriptWord } from '../src/domain/model.js';

function rect(x: number, y: number, w: number, h: number): NormRect {
  return { x, y, w, h };
}

function hostObservation(sourceSeconds: number, camera: NormRect, head: NormRect, content: ClusteredObservation['content'] = null): SceneObservation {
  return { sourceSeconds, host: { camera, head }, content, overlays: [] };
}

test('short shots merge without losing leading or trailing source coverage', () => {
  const shots = buildSceneShots([0.4, 0.5, 0.5 + 1 / 30, 5], 10, 30);
  assert.deepEqual(
    shots.map((shot) => [shot.startSeconds, shot.endSeconds]),
    [
      [0, 0.5 + 1 / 30],
      [0.5 + 1 / 30, 5],
      [5, 10],
    ],
  );
  assert.equal(shots[0]!.startSeconds, 0);
  assert.equal(shots[shots.length - 1]!.endSeconds, 10);
  for (let index = 1; index < shots.length; index += 1) {
    assert.equal(shots[index]!.startSeconds, shots[index - 1]!.endSeconds);
  }

  assert.deepEqual(
    buildSceneShots([0.2], 10, 30).map((shot) => [shot.startSeconds, shot.endSeconds]),
    [[0, 10]],
  );
  assert.deepEqual(
    buildSceneShots([9.9], 10, 30).map((shot) => [shot.startSeconds, shot.endSeconds]),
    [[0, 10]],
  );
  assert.deepEqual(
    buildSceneShots([], 0.3, 30).map((shot) => [shot.startSeconds, shot.endSeconds]),
    [[0, 0.3]],
  );
  assert.deepEqual(
    buildSceneShots([2.5, 2.5 + 1 / 30, 5], 10, 30).map((shot) => [shot.startSeconds, shot.endSeconds]),
    [
      [0, 2.5 + 1 / 30],
      [2.5 + 1 / 30, 5],
      [5, 10],
    ],
  );
  assert.throws(() => buildSceneShots([], 0, 30));
  assert.throws(() => buildSceneShots([], 10, 0));

  const samples = sceneSampleTimes({ startSeconds: 20, endSeconds: 60 });
  assert.deepEqual(samples, [20.6, 32.6, 44.6, 56.6]);
  assert.deepEqual(sceneSampleTimes({ startSeconds: 0, endSeconds: 2 }), [0.5]);
  assert.deepEqual(sceneSampleTimes({ startSeconds: 0, endSeconds: 1 }), [0.25]);
});

test('nearby camera observations snap together and heads stay stable across cuts', () => {
  const pip = (dy: number, dw: number): NormRect => rect(719 / 1000, (55 + dy) / 1000, (263 + dw) / 1000, 362 / 1000);
  const observations: SceneObservation[] = [
    hostObservation(1, pip(0, 0), rect(0.788, 0.076, 0.096, 0.22)),
    hostObservation(13, pip(-1, 0), rect(0.79, 0.074, 0.094, 0.222)),
    hostObservation(25, pip(-1, 2), rect(0.786, 0.078, 0.098, 0.218)),
    hostObservation(37, rect(0.06, 0.68, 0.24, 0.26), rect(0.14, 0.72, 0.08, 0.12)),
  ];
  const { observations: clustered, clusters } = clusterCameras(observations);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clustered.map((observation) => observation.cameraClusterId), [0, 0, 0, 1]);
  const median = medianEdges(clustered.slice(0, 3).map((observation) => observation.host!.camera));
  assert.deepEqual(clusters[0]!.camera, median);
  assert.ok(clustered.slice(0, 3).every((observation) => observation.host!.camera.x === median.x && observation.host!.camera.h === median.h));
  assert.equal(clusters[0]!.memberIndices.length, 3);

  const fullFrame = hostObservation(49, rect(0, 0, 1, 1), rect(0.4, 0.2, 0.2, 0.3));
  const withFull = clusterCameras([fullFrame, hostObservation(50, rect(0.01, 0.01, 0.98, 0.98), rect(0.4, 0.2, 0.2, 0.3))]);
  assert.deepEqual(withFull.observations.map((observation) => observation.cameraClusterId), [-1, -1]);
  assert.equal(withFull.clusters.length, 0);
  assert.equal(isFullFrameCamera(rect(0, 0, 1, 0.531)), false);
  assert.equal(isFullFrameCamera(rect(0.01, 0.005, 0.982, 0.985)), true);

  const segments: ClusteredObservation[] = [
    { ...hostObservation(1, median, rect(0.788, 0.076, 0.096, 0.22)), cameraClusterId: 0 },
    { ...hostObservation(13, median, rect(0.79, 0.074, 0.094, 0.222)), cameraClusterId: 0 },
    { ...hostObservation(25, median, rect(0.786, 0.078, 0.098, 0.218)), cameraClusterId: 0 },
    { ...hostObservation(37, rect(0.06, 0.68, 0.24, 0.26), rect(0.14, 0.72, 0.08, 0.12)), cameraClusterId: 1 },
  ];
  const smoothed = smoothSceneHeads([
    ...segments.map((segment, index) => ({ ...segment, startSeconds: index * 12, endSeconds: (index + 1) * 12 })),
  ]);
  assert.deepEqual(smoothed[0]!.host!.head, smoothed[1]!.host!.head);
  assert.deepEqual(smoothed[1]!.host!.head, smoothed[2]!.host!.head);
  assert.notDeepEqual(smoothed[2]!.host!.head, smoothed[3]!.host!.head);
  assert.equal('cameraClusterId' in smoothed[0], false);

  const absentHost = clusterCameras([{ sourceSeconds: 61, host: null, content: null, overlays: [] }]);
  assert.deepEqual(absentHost.observations.map((observation) => observation.cameraClusterId), [null]);
});

function uniformGreyFrame(width: number, height: number, columnValue: (x: number) => number): GreyFrame {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = columnValue(x);
    }
  }
  return { width, height, data };
}

function pipFixtureFrames(): GreyFrame[] {
  const base = (x: number): number => (x < 250 ? 10 : 60);
  const chart = (x: number): number => (x < 250 ? 10 : x >= 252 && x <= 259 ? 220 : 60);
  return [uniformGreyFrame(512, 32, chart), uniformGreyFrame(512, 32, base), uniformGreyFrame(512, 32, base), uniformGreyFrame(512, 32, base)];
}

test('averaged narrow-radius gradients retain the real PiP edge beside a transient white chart', () => {
  const frames = pipFixtureFrames();
  const camera = rect(249.4 / 512, 0, (512 - 249.4) / 512, 1);
  approxEqual(meanEdgeGradient(frames, camera, 'left', 250), 50);
  approxEqual(meanEdgeGradient(frames, camera, 'left', 251), 0);
  approxEqual(meanEdgeGradient(frames, camera, 'left', 252), 40);

  const refined = refineCameraEdges(camera, frames);
  approxEqual(refined.x, 250 / 512);
  approxEqual(refined.w, 1 - 250 / 512);
  approxEqual(refined.y, 0);
  approxEqual(refined.h, 1);

  const singleFrame = refineCameraEdges(camera, [frames[0]!]);
  approxEqual(singleFrame.x, 252 / 512);

  const members = evenlySpacedMemberIndices([0, 3, 6, 9, 12, 15, 18, 21, 24], CAMERA_EDGE_MAX_FRAMES);
  assert.deepEqual(members, [0, 3, 6, 9, 15, 18, 21, 24]);
  assert.deepEqual(evenlySpacedMemberIndices([7], CAMERA_EDGE_MAX_FRAMES), [7]);
  assert.deepEqual(evenlySpacedMemberIndices([], CAMERA_EDGE_MAX_FRAMES), []);
});

function approxEqual(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be close to ${expected}`);
}

test('flat and frame-border edges retain median geometry', () => {
  const flat = [uniformGreyFrame(512, 32, () => 128), uniformGreyFrame(512, 32, () => 128)];
  const camera = rect(0.25, 0.25, 0.5, 0.5);
  assert.deepEqual(refineCameraEdges(camera, flat), camera);

  const busy = pipFixtureFrames();
  const bordered = rect(0, 0, 1, 1);
  assert.deepEqual(refineCameraEdges(bordered, busy), bordered);
  const halfBordered = rect(0, 0.2, 0.5, 0.6);
  const refined = refineCameraEdges(halfBordered, busy);
  assert.equal(refined.x, 0);
  assert.equal(refined.y, 0.2);
  assert.equal(refined.h, 0.6);

  assert.equal(rectContains(rect(0, 0, 1, 1), rect(0.1, 0.1, 0.5, 0.5)), true);
  assert.equal(rectContains(rect(0, 0, 0.5, 0.5), rect(0.1, 0.1, 0.45, 0.3)), false);
  approxEqual(rectIntersectionArea(rect(0, 0, 1, 1), rect(0.5, 0.5, 1, 1)), 0.25);
  approxEqual(rectIntersectionArea(rect(0, 0, 0.2, 0.2), rect(0.5, 0.5, 0.2, 0.2)), 0);
  approxEqual(rectIoU(rect(0, 0, 1, 1), rect(0, 0, 1, 1)), 1);
  approxEqual(rectIoU(rect(0, 0, 1, 1), rect(0, 0, 0.5, 0.5)), 0.25);
  assert.throws(() => medianEdges([]));
  assert.deepEqual(medianEdges([rect(0.25, 0.25, 0.25, 0.25), rect(0.5, 0.25, 0.5, 0.25)]), rect(0.375, 0.25, 0.375, 0.25));
});

test('failed shots inherit the previous successful shot or the next one for a leading run', () => {
  const hostA = rect(0.719, 0.055, 0.263, 0.362);
  const headA = rect(0.788, 0.076, 0.096, 0.22);
  const hostB = rect(0.06, 0.68, 0.24, 0.26);
  const headB = rect(0.14, 0.72, 0.08, 0.12);
  const shots = buildSceneShots([10, 20, 30], 40, 30);
  const observations = [
    { ...hostObservation(10.6, hostA, headA), cameraClusterId: 0 },
    { ...hostObservation(30.6, hostB, headB), cameraClusterId: 1 },
  ];
  const segments = buildSceneSegments(shots, observations, []);
  assert.deepEqual(
    segments.map((segment) => [segment.startSeconds, segment.endSeconds]),
    [
      [0, 10],
      [10, 20],
      [20, 30],
      [30, 40],
    ],
  );
  assert.deepEqual(segments.slice(0, 3).map((segment) => segment.host!.camera), [hostA, hostA, hostA]);
  assert.deepEqual(segments[3]!.host!.camera, hostB);

  const leadingShots = buildSceneShots([5, 10], 20, 30);
  const successful: ClusteredObservation = { ...hostObservation(10.6, hostA, headA), cameraClusterId: 0 };
  const leadingSegments = buildSceneSegments(leadingShots, [successful], []);
  assert.deepEqual(
    leadingSegments.map((segment) => segment.host!.camera),
    [hostA, hostA, hostA],
  );
  assert.deepEqual(
    leadingSegments.map((segment) => segment.startSeconds),
    [0, 5, 10],
  );
});

test('signature transitions change scene geometry even without a global cut', () => {
  const shot = buildSceneShots([], 30, 30);
  const hostA = rect(0.719, 0.055, 0.263, 0.362);
  const before: ClusteredObservation = {
    ...hostObservation(0.6, hostA, rect(0.788, 0.076, 0.096, 0.22)),
    cameraClusterId: 0,
  };
  const after: ClusteredObservation = {
    sourceSeconds: 12.6,
    host: null,
    content: { box: rect(0.341, 0, 0.317, 1), kind: 'footage', vertical: true, subject: rect(0.443, 0.468, 0.215, 0.259) },
    overlays: [rect(0.762, 0.929, 0.23, 0.054)],
    cameraClusterId: null,
  };
  const later: ClusteredObservation = { ...after, sourceSeconds: 24.6 };
  assert.equal(sceneSignature(before), 'host0:contentabsent');
  assert.equal(sceneSignature(after), 'hostabsent:contentvertical');
  const segments = buildSceneSegments(shot, [before, after, later], [{ shotIndex: 0, sourceSeconds: 6.5, rightObservationIndex: 1 }]);
  assert.deepEqual(
    segments.map((segment) => [segment.startSeconds, segment.endSeconds]),
    [
      [0, 6.5],
      [6.5, 30],
    ],
  );
  assert.deepEqual(segments[0]!.host!.camera, hostA);
  assert.equal(segments[1]!.host, null);
  assert.deepEqual(segments[1]!.content!.box, after.content!.box);
  assert.deepEqual(segments[1]!.overlays, after.overlays);
  assert.equal(segments[0]!.content, null);
});

test('sceneAt uses half-open segments and freezeSceneTrack keeps boundaries and metadata', () => {
  const segments: SceneSegment[] = [
    {
      startSeconds: 0,
      endSeconds: 5,
      host: { camera: rect(0.719, 0.055, 0.263, 0.362), head: rect(0.788, 0.076, 0.096, 0.22) },
      content: null,
      overlays: [],
    },
    {
      startSeconds: 5,
      endSeconds: 10,
      host: null,
      content: { box: rect(0, 0, 1, 1), kind: 'footage', vertical: false, subject: rect(0.2, 0.2, 0.5, 0.5) },
      overlays: [],
    },
  ];
  const track = { version: 1 as const, analyzedAt: '2026-10-19T10:00:00.000Z', frame: { width: 1920, height: 1080 }, segments };
  assert.equal(sceneAt(track, 0), segments[0]);
  assert.equal(sceneAt(track, 4.999), segments[0]);
  assert.equal(sceneAt(track, 5), segments[1]);
  assert.equal(sceneAt(track, 10), segments[1]);
  assert.equal(sceneAt(track, 10.001), null);
  assert.equal(sceneAt(track, -0.001), null);

  const frozen = freezeSceneTrack(track, [{ sourceStart: 6, sourceEnd: 9 }]);
  assert.equal(frozen.version, 1);
  assert.equal(frozen.analyzedAt, track.analyzedAt);
  assert.deepEqual(frozen.frame, track.frame);
  assert.deepEqual(frozen.segments, [segments[1]]);
  assert.notEqual(frozen.segments[0], segments[1]);
  const everything = freezeSceneTrack(track, [{ sourceStart: 0, sourceEnd: 10 }]);
  assert.deepEqual(everything.segments.map((segment) => segment.startSeconds), [0, 5]);
  const clamped = freezeSceneTrack(track, [{ sourceStart: 4, sourceEnd: 5.5 }]);
  assert.deepEqual(clamped.segments.map((segment) => segment.endSeconds), [5, 10]);
});

test('documentCropSpans intersects document segments with kept clips only', () => {
  const words: TranscriptWord[] = [
    { id: 'w0', text: 'um', startSeconds: 1, endSeconds: 2, speakerId: 'A', confidence: null },
    { id: 'w1', text: 'dois', startSeconds: 2.5, endSeconds: 3.5, speakerId: 'A', confidence: null },
    { id: 'w2', text: 'três', startSeconds: 11, endSeconds: 12, speakerId: 'A', confidence: null },
  ];
  const documentSegment: SceneSegment = {
    startSeconds: 0,
    endSeconds: 10,
    host: null,
    content: { box: rect(0, 0, 1, 1), kind: 'document', vertical: false, subject: rect(0.2, 0.2, 0.5, 0.5) },
    overlays: [],
  };
  const footageSegment: SceneSegment = {
    startSeconds: 10,
    endSeconds: 20,
    host: null,
    content: { box: rect(0, 0, 1, 1), kind: 'footage', vertical: false, subject: rect(0.2, 0.2, 0.5, 0.5) },
    overlays: [],
  };
  const spans = documentCropSpans({
    clips: [
      { sourceStart: 0, sourceEnd: 6 },
      { sourceStart: 10, sourceEnd: 15 },
    ],
    words,
    segments: [documentSegment, footageSegment],
  });
  assert.equal(spans.length, 1);
  assert.deepEqual([spans[0]!.startSeconds, spans[0]!.endSeconds, spans[0]!.text], [0, 6, 'um dois']);
  assert.equal(spans[0]!.segment, documentSegment);
  const clipped = documentCropSpans({
    clips: [{ sourceStart: 4, sourceEnd: 12 }],
    words,
    segments: [documentSegment, footageSegment],
  });
  assert.equal(clipped.length, 1);
  assert.deepEqual([clipped[0]!.startSeconds, clipped[0]!.endSeconds, clipped[0]!.text], [4, 10, '']);
});

test('a PiP over full-screen footage stacks for Gaiofato while a covered full-frame host does not', () => {
  const gaiofato82: SceneSegment = {
    startSeconds: 80,
    endSeconds: 84,
    host: {
      camera: rect(719 / 1000, 55 / 1000, 263 / 1000, 362 / 1000),
      head: rect(788 / 1000, 76 / 1000, 96 / 1000, 220 / 1000),
    },
    content: {
      box: rect(0, 0, 1, 1),
      kind: 'footage',
      vertical: false,
      subject: rect(170 / 1000, 19 / 1000, 605 / 1000, 781 / 1000),
    },
    overlays: [
      rect(24 / 1000, 34 / 1000, 83 / 1000, 51 / 1000),
      rect(722 / 1000, 462 / 1000, 262 / 1000, 480 / 1000),
      rect(973 / 1000, 938 / 1000, 23 / 1000, 41 / 1000),
    ],
  };
  const gaiofato650: SceneSegment = {
    ...gaiofato82,
    startSeconds: 648,
    host: { camera: rect(719 / 1000, 54 / 1000, 263 / 1000, 364 / 1000), head: rect(796 / 1000, 73 / 1000, 186 / 1000, 230 / 1000) },
    content: {
      box: rect(0, 0, 1, 1),
      kind: 'person',
      vertical: false,
      subject: rect(40 / 1000, 0, 676 / 1000, 1),
    },
  };
  for (const segment of [gaiofato82, gaiofato650]) {
    assert.equal(isFullFrameCamera(segment.host!.camera), false);
    assert.equal(hostUsable(segment), true);
    assert.equal(defaultComposition(segment), 'stack');
    assert.deepEqual(allowedCompositions(segment), ['stack', 'host', 'content']);
  }

  const koboriQuestionCard: SceneSegment = {
    startSeconds: 4,
    endSeconds: 8,
    host: {
      camera: rect(0, 0, 1, 1),
      head: rect(399 / 1000, 95 / 1000, 184 / 1000, 179 / 1000),
    },
    content: {
      box: rect(26 / 1000, 190 / 1000, 950 / 1000, 615 / 1000),
      kind: 'document',
      vertical: false,
      subject: rect(52 / 1000, 301 / 1000, 805 / 1000, 468 / 1000),
    },
    overlays: [rect(24 / 1000, 34 / 1000, 102 / 1000, 241 / 1000)],
  };
  assert.equal(isFullFrameCamera(koboriQuestionCard.host!.camera), true);
  assert.equal(hostUsable(koboriQuestionCard), false);
  assert.equal(defaultComposition(koboriQuestionCard), 'content');
  assert.deepEqual(allowedCompositions(koboriQuestionCard), ['content']);
});

test('a portrait document with a usable host stacks', () => {
  const borelliPortraitArticle: SceneSegment = {
    startSeconds: 140,
    endSeconds: 150,
    host: {
      camera: rect(719 / 1000, 0, 281 / 1000, 318 / 1000),
      head: rect(40 / 1000, 804 / 1000, 198 / 1000, 78 / 1000),
    },
    content: {
      box: rect(22 / 1000, 283 / 1000, 955 / 1000, 431 / 1000),
      kind: 'document',
      vertical: true,
      subject: rect(178 / 1000, 309 / 1000, 400 / 1000, 249 / 1000),
    },
    overlays: [],
  };
  assert.equal(borelliPortraitArticle.content!.vertical, true);
  assert.equal(borelliPortraitArticle.content!.kind, 'document');
  assert.equal(hostUsable(borelliPortraitArticle), true);
  assert.equal(defaultComposition(borelliPortraitArticle), 'stack');
  assert.deepEqual(allowedCompositions(borelliPortraitArticle), ['stack', 'host', 'content']);

  const fullFrameHostPortraitDocument: SceneSegment = {
    ...borelliPortraitArticle,
    host: { camera: rect(0, 0, 1, 1), head: rect(0.1, 0.05, 0.12, 0.1) },
    content: { box: rect(0.4, 0.3, 0.5, 0.6), kind: 'document', vertical: true, subject: rect(0.5, 0.4, 0.3, 0.4) },
  };
  assert.equal(defaultComposition(fullFrameHostPortraitDocument), 'stack');

  const verticalFootageWithPip: SceneSegment = {
    ...borelliPortraitArticle,
    content: { box: rect(341 / 1000, 0, 317 / 1000, 1), kind: 'footage', vertical: true, subject: rect(443 / 1000, 468 / 1000, 215 / 1000, 259 / 1000) },
  };
  assert.equal(defaultComposition(verticalFootageWithPip), 'content');
});

test('alternating close-up and wide full-frame segments keep their own heads', () => {
  const closeUp: ClusteredSceneSegment = {
    startSeconds: 10,
    endSeconds: 12,
    host: { camera: rect(0, 0, 1, 1), head: rect(0.43, 0.06, 0.22, 0.54) },
    content: null,
    overlays: [],
    cameraClusterId: -1,
  };
  const wideTable: ClusteredSceneSegment = {
    ...closeUp,
    startSeconds: 12,
    endSeconds: 14,
    host: { camera: rect(0, 0, 1, 1), head: rect(0.85, 0.55, 0.1, 0.18) },
  };
  const smoothed = smoothSceneHeads([closeUp, wideTable, { ...closeUp, startSeconds: 14, endSeconds: 16 }]);
  approxEqual(smoothed[0]!.host!.head.x, 0.43);
  approxEqual(smoothed[0]!.host!.head.y, 0.06);
  approxEqual(smoothed[0]!.host!.head.w, 0.22);
  approxEqual(smoothed[0]!.host!.head.h, 0.54);
  approxEqual(smoothed[1]!.host!.head.x, 0.85);
  approxEqual(smoothed[1]!.host!.head.y, 0.55);
  approxEqual(smoothed[1]!.host!.head.w, 0.1);
  approxEqual(smoothed[1]!.host!.head.h, 0.18);
  approxEqual(smoothed[2]!.host!.head.x, 0.43);
  approxEqual(smoothed[2]!.host!.head.w, 0.22);
  assert.ok(rectIoU(smoothed[1]!.host!.head, smoothed[0]!.host!.head) < HEAD_SMOOTHING_IOU);
});

test('consecutive same-framing segments with small jitter share the median head', () => {
  const segments: ClusteredSceneSegment[] = [
    {
      startSeconds: 20,
      endSeconds: 22,
      host: { camera: rect(0, 0, 1, 1), head: rect(0.4, 0.3, 0.2, 0.3) },
      content: null,
      overlays: [],
      cameraClusterId: -1,
    },
    {
      startSeconds: 22,
      endSeconds: 24,
      host: { camera: rect(0, 0, 1, 1), head: rect(0.41, 0.31, 0.19, 0.29) },
      content: null,
      overlays: [],
      cameraClusterId: -1,
    },
    {
      startSeconds: 24,
      endSeconds: 26,
      host: { camera: rect(0, 0, 1, 1), head: rect(0.39, 0.29, 0.21, 0.31) },
      content: null,
      overlays: [],
      cameraClusterId: -1,
    },
  ];
  const smoothed = smoothSceneHeads(segments);
  const median = smoothed[0]!.host!.head;
  assert.deepEqual(smoothed[1]!.host!.head, median);
  assert.deepEqual(smoothed[2]!.host!.head, median);
  assert.notDeepEqual(median, segments[0]!.host!.head);
  const clustered = clusterCameras([
    hostObservation(1, rect(0.1, 0.55, 0.55, 0.4), rect(0.3, 0.62, 0.12, 0.18)),
    hostObservation(13, rect(0.12, 0.57, 0.53, 0.38), rect(0.31, 0.63, 0.11, 0.17)),
  ]);
  const insetSegments: ClusteredSceneSegment[] = clustered.observations.map((observation, index) => ({
    startSeconds: index * 12,
    endSeconds: (index + 1) * 12,
    host: observation.host,
    content: null,
    overlays: [],
    cameraClusterId: observation.cameraClusterId,
  }));
  const insetSmoothed = smoothSceneHeads(insetSegments);
  assert.deepEqual(insetSmoothed[0]!.host!.head, insetSmoothed[1]!.host!.head);
});
