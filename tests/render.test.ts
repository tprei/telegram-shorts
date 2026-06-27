import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSubtitlesFilterArg } from '../src/infra/render.js';

test('subtitle filter arg quotes and escapes absolute paths for ffmpeg filter parsing', () => {
  const filter = buildSubtitlesFilterArg("/Users/thiago/repos/pinoquio/telegram-shorts/work/telegram-shorts/artifacts/job_1/cv_1/cand_1/draft/captions.ass");
  assert.equal(
    filter,
    "subtitles=filename='/Users/thiago/repos/pinoquio/telegram-shorts/work/telegram-shorts/artifacts/job_1/cv_1/cand_1/draft/captions.ass'",
  );
});

test('subtitle filter arg escapes ffmpeg-special characters', () => {
  const filter = buildSubtitlesFilterArg("/tmp/dir:one/it's,[weird];name.ass");
  assert.equal(filter, "subtitles=filename='/tmp/dir\\:one/it\\'s\\,\\[weird\\]\\;name.ass'");
});
