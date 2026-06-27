import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepgramSlowUploadError } from '../src/infra/transcript.js';

test('detects Deepgram slow upload errors for retry', () => {
  assert.equal(isDeepgramSlowUploadError(new Error('Deepgram transcription failed: 408 {"err_code":"SLOW_UPLOAD","err_msg":"Request upload timeout."}')), true);
  assert.equal(isDeepgramSlowUploadError(new Error('Deepgram transcription failed: 500 internal')), false);
});
