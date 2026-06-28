import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInstagramReelDescription, buildMallaryInstagramReelPayload, mallaryMimeType } from '../src/infra/mallary.js';

test('instagram reel description removes irrelevant platform/meta tags only', () => {
  const description = buildInstagramReelDescription({
    line_1: 'O neoliberalismo é hipócrita quando pede sacrifício só de quem já perdeu tudo',
    line_2: 'A regra muda na hora em que o prejuízo encosta em quem sempre mandou no jogo',
    hashtags: ['#Business', '#Neoliberalismo', '#InstagramReels', '#LutaDeClasses', '#FYP', '#PoliticaBrasileira', '#OpenAI', '#Mindset'],
  });
  const lines = description.split('\n');
  assert.equal(lines[0], 'O neoliberalismo é hipócrita quando pede sacrifício só de quem já perdeu tudo.');
  assert.equal(lines[1], 'A regra muda na hora em que o prejuízo encosta em quem sempre mandou no jogo.');
  assert.equal(lines[3], '#Business #Neoliberalismo #LutaDeClasses #PoliticaBrasileira #OpenAI #Mindset');
  assert.equal(description.includes('#InstagramReels'), false);
  assert.equal(description.includes('#FYP'), false);
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
