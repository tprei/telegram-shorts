import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAssSubtitles } from '../src/infra/subtitles.js';

test('subtitles render one dialogue event per cue to avoid stacking duplicates', () => {
  const ass = buildAssSubtitles({
    candidate: {
      playbackSpeed: 1,
      segments: [{ startSeconds: 0, endSeconds: 1.2 }],
    } as never,
    transcriptWords: [
      { text: 'cultura', startSeconds: 0, endSeconds: 0.45, speakerId: 'speaker_0' },
      { text: 'girava', startSeconds: 0.4, endSeconds: 0.8, speakerId: 'speaker_0' },
      { text: 'muito', startSeconds: 0.78, endSeconds: 1.1, speakerId: 'speaker_0' },
    ] as never,
    chosenSpeakerId: 'speaker_0',
    profile: 'draft',
    outputWidth: 480,
    outputHeight: 854,
  });
  const dialogueLines = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.equal(dialogueLines.length, 1);
});

test('subtitles use reduced default sizes after rollback from oversized setting', () => {
  const draftAss = buildAssSubtitles({
    candidate: { playbackSpeed: 1, segments: [{ startSeconds: 0, endSeconds: 1 }] } as never,
    transcriptWords: [{ text: 'teste', startSeconds: 0, endSeconds: 0.5, speakerId: 'speaker_0' }] as never,
    chosenSpeakerId: 'speaker_0',
    profile: 'draft',
    outputWidth: 480,
    outputHeight: 854,
  });
  const finalAss = buildAssSubtitles({
    candidate: { playbackSpeed: 1, segments: [{ startSeconds: 0, endSeconds: 1 }] } as never,
    transcriptWords: [{ text: 'teste', startSeconds: 0, endSeconds: 0.5, speakerId: 'speaker_0' }] as never,
    chosenSpeakerId: 'speaker_0',
    profile: 'final',
    outputWidth: 720,
    outputHeight: 1280,
  });
  assert.match(draftAss, /Style: Default,Arial,32,/);
  assert.match(finalAss, /Style: Default,Arial,40,/);
});
