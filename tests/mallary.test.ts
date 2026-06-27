import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInstagramReelDescription } from '../src/infra/mallary.js';

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
