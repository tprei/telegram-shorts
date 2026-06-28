import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInstagramReelDescription, buildMallaryInstagramReelPayload, mallaryMimeType } from '../src/infra/mallary.js';

test('instagram reel description uses two lines and hashtags', () => {
  const description = buildInstagramReelDescription({
    line_1: 'Como a Inteligência Artificial gamificou a autoestima masculina',
    line_2: 'Apps e rankings transformam aparência em pontuação e comparação social',
    hashtags: ['#InteligenciaArtificial', '#Autoestima', '#CulturaDigital'],
  });
  const lines = description.split('\n');
  assert.ok(lines[0]?.length);
  assert.ok(lines[1]?.length);
  assert.ok(lines.at(-1)?.includes('#'));
});

test('mallary instagram payload includes sanitized follow-up comments', () => {
  const payload = buildMallaryInstagramReelPayload({
    message: 'Legenda principal',
    mediaUrl: 'https://files.mallary.ai/video.mp4',
    mediaType: 'video/mp4',
    thumbnailUrl: 'https://files.mallary.ai/cover.jpg',
    commentsUnderPost: ['  Vídeo completo: https://youtube.com/watch?v=abc  ', '', 'Fonte: @canal  ', 'extra'],
  }) as {
    comments_under_post?: string[];
    media?: Array<{ thumbnail_url?: string }>;
  };

  assert.deepEqual(payload.comments_under_post, [
    'Vídeo completo: https://youtube.com/watch?v=abc',
    'Fonte: @canal',
    'extra',
  ]);
  assert.equal(payload.media?.[0]?.thumbnail_url, 'https://files.mallary.ai/cover.jpg');
});

test('mallary mime type supports video and image uploads', () => {
  assert.equal(mallaryMimeType('/tmp/video.mp4'), 'video/mp4');
  assert.equal(mallaryMimeType('/tmp/video.mov'), 'video/quicktime');
  assert.equal(mallaryMimeType('/tmp/cover.jpg'), 'image/jpeg');
  assert.equal(mallaryMimeType('/tmp/cover.png'), 'image/png');
});
