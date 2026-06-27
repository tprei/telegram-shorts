import assert from 'node:assert/strict';
import test from 'node:test';
import { buildYtDlpArgs } from '../src/infra/youtube.js';

test('yt-dlp args include optional cookies and JS runtime before URL', () => {
  const args = buildYtDlpArgs('/tmp/source.%(ext)s', 'https://youtu.be/t1TFNy1VdGI', {
    cookiesPath: '/home/prei/youtube-cookies.txt',
    jsRuntime: 'node:/usr/bin/node',
  });
  assert.deepEqual(args.slice(0, 10), [
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '--format', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/best[ext=mp4]/best',
    '--write-info-json',
    '--output', '/tmp/source.%(ext)s',
    '--cookies', '/home/prei/youtube-cookies.txt',
  ]);
  assert.deepEqual(args.slice(10), ['--js-runtimes', 'node:/usr/bin/node', 'https://youtu.be/t1TFNy1VdGI']);
});

test('yt-dlp args can use browser cookies when no cookies file is configured', () => {
  const args = buildYtDlpArgs('/tmp/source.%(ext)s', 'https://youtu.be/t1TFNy1VdGI', {
    cookiesFromBrowser: 'chrome:Default',
  });
  assert.equal(args.includes('--cookies'), false);
  assert.deepEqual(args.slice(-3), ['--cookies-from-browser', 'chrome:Default', 'https://youtu.be/t1TFNy1VdGI']);
});

test('yt-dlp args omit auth/runtime options when unset', () => {
  const args = buildYtDlpArgs('/tmp/source.%(ext)s', 'https://youtu.be/t1TFNy1VdGI');
  assert.equal(args.includes('--cookies'), false);
  assert.equal(args.includes('--cookies-from-browser'), false);
  assert.equal(args.includes('--js-runtimes'), false);
  assert.equal(args.at(-1), 'https://youtu.be/t1TFNy1VdGI');
});
