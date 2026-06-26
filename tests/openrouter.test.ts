import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenRouterClient } from '../src/infra/openrouter.js';

const baseConfig = {
  OPENROUTER_API_KEY: 'test-key',
  OPENROUTER_MODEL: 'test-model',
};

test('revision parser normalizes invented conclusion actions into safe extend_end', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          actions: [{ kind: 'extend_conclusion', reason: 'o vídeo acaba do nada' }],
          summary: 'Inclui uma conclusão estendendo o final.',
        }),
      },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as typeof fetch;
  try {
    const client = new OpenRouterClient(baseConfig as never);
    const intent = await client.parseRevision({
      candidate: {
        id: 'cand_1',
        title: 'Teste',
        durationSeconds: 80,
        segments: [{ startSeconds: 0, endSeconds: 15, text: 'começo' }, { startSeconds: 82, endSeconds: 171, text: 'meio' }],
      } as never,
      message: 'inclue uma conclusão, o vídeo acaba do nada',
    });
    assert.deepEqual(intent.actions, [{ kind: 'extend_end', seconds: 30 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('revision parser normalizes action/type aliases and default insert query', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          edits: [
            { action: 'add_span', description: 'fechamento do argumento' },
            { type: 'speed', value: '1.5' },
          ],
        }),
      },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as typeof fetch;
  try {
    const client = new OpenRouterClient(baseConfig as never);
    const intent = await client.parseRevision({
      candidate: {
        id: 'cand_1',
        title: 'Teste',
        durationSeconds: 80,
        segments: [{ startSeconds: 0, endSeconds: 80, text: 'texto' }],
      } as never,
      message: 'inclui o fechamento e deixa 1.5x',
    });
    assert.deepEqual(intent.actions, [
      { kind: 'insert_span', query: 'fechamento do argumento' },
      { kind: 'set_speed', speed: 1.5 },
    ]);
    assert.equal(intent.summary, 'Revisão aplicada');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
