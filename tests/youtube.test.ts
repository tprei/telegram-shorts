import assert from 'node:assert/strict';
import test from 'node:test';
import { buildYtDlpArgs, parseChannelUploads, parseFrameRate, youTubeVideoId } from '../src/infra/youtube.js';

test('yt-dlp args request avc1-first formats with cookies and JS runtime before the URL', () => {
  const args = buildYtDlpArgs('/tmp/source.%(ext)s', 'https://youtu.be/t1TFNy1VdGI', {
    cookiesPath: '/home/prei/youtube-cookies.txt',
    jsRuntime: 'node:/usr/bin/node',
  });
  assert.deepEqual(args.slice(0, 10), [
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '--format', 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]/bv*[height<=1080]+ba/b',
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

test('yt-dlp args omit auth and runtime options when unset', () => {
  const args = buildYtDlpArgs('/tmp/source.%(ext)s', 'https://youtu.be/t1TFNy1VdGI');
  assert.equal(args.includes('--cookies'), false);
  assert.equal(args.includes('--cookies-from-browser'), false);
  assert.equal(args.includes('--js-runtimes'), false);
  assert.equal(args.at(-1), 'https://youtu.be/t1TFNy1VdGI');
});

test('parseFrameRate parses integer and fractional frame rates', () => {
  assert.equal(parseFrameRate('30/1'), 30);
  assert.equal(parseFrameRate('60/1'), 60);
  assert.equal(parseFrameRate('25'), 25);
  assert.ok(Math.abs(parseFrameRate('30000/1001') - 29.97002997002997) < 1e-9);
});

test('parseFrameRate rejects zero, negative, and malformed rates', () => {
  assert.throws(() => parseFrameRate('0/1'));
  assert.throws(() => parseFrameRate('-30/1'));
  assert.throws(() => parseFrameRate('10/0'));
  assert.throws(() => parseFrameRate('abc'));
  assert.throws(() => parseFrameRate(''));
});

test('parseChannelUploads reads a flat-playlist JSON payload in listing order', () => {
  const payload = JSON.stringify({
    id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
    _type: 'playlist',
    title: 'Filipe Boni - Videos',
    entries: [
      { id: 'dQw4w9WgXcQ', title: 'Video novo', duration: 1500.5, live_status: 'not_live', view_count: 12 },
      { id: 'abcdefghijk', title: null, duration: null, live_status: 'is_upcoming' },
      { id: 'lmnopqrstuv' },
    ],
  });
  assert.deepEqual(parseChannelUploads(payload), [
    { videoId: 'dQw4w9WgXcQ', title: 'Video novo', durationSeconds: 1500.5, liveStatus: 'not_live' },
    { videoId: 'abcdefghijk', title: null, durationSeconds: null, liveStatus: 'is_upcoming' },
    { videoId: 'lmnopqrstuv', title: null, durationSeconds: null, liveStatus: null },
  ]);
});

test('parseChannelUploads rejects payloads without valid entries', () => {
  assert.throws(() => parseChannelUploads('{"id": "x"}'));
  assert.throws(() => parseChannelUploads('{"entries": [{"duration": 10}]}'));
  assert.throws(() => parseChannelUploads('not json'));
});

test('youTubeVideoId extracts ids from supported URL shapes', () => {
  assert.equal(youTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youTubeVideoId('https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s'), 'dQw4w9WgXcQ');
  assert.equal(youTubeVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youTubeVideoId('https://www.youtube.com/live/dQw4w9WgXcQ?feature=share'), 'dQw4w9WgXcQ');
  assert.equal(youTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youTubeVideoId('https://m.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('youTubeVideoId returns null for non-video URLs and malformed ids', () => {
  assert.equal(youTubeVideoId('https://www.youtube.com/@filipe_boni/videos'), null);
  assert.equal(youTubeVideoId('https://youtu.be/short'), null);
  assert.equal(youTubeVideoId('https://www.youtube.com/watch?v=tooshort'), null);
  assert.equal(youTubeVideoId('https://www.youtube.com/shorts/bad*chars11'), null);
  assert.equal(youTubeVideoId('not a url'), null);
});
