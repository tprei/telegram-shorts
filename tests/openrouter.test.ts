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

test('opportunity planner repairs malformed model JSON with a second pass', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const content = calls === 1
      ? '{"opportunities":[{"id":"opp_1","title":"Teste" "summary":"Resumo","hook":"Hook","payoff":"Payoff","rationale":"Racional","thesis":"Tese","viewer_promise":"Promessa","tension":"Tensão","why_this_short":"Porque","risk":"medium","block_ids":["b_001","b_002"],"steps":[{"kind":"hook","label":"Abertura","block_ids":["b_001"]},{"kind":"payoff","label":"Fechamento","block_ids":["b_002"]}]}]}'
      : JSON.stringify({ opportunities: [{ id: 'opp_1', title: 'Teste', summary: 'Resumo', hook: 'Hook', payoff: 'Payoff', rationale: 'Racional', thesis: 'Tese', viewer_promise: 'Promessa', tension: 'Tensão', why_this_short: 'Porque', risk: 'medium', block_ids: ['b_001', 'b_002'], steps: [{ kind: 'hook', label: 'Abertura', block_ids: ['b_001'] }, { kind: 'payoff', label: 'Fechamento', block_ids: ['b_002'] }] }] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as Response;
  };
  try {
    const client = new OpenRouterClient(baseConfig as never);
    const plan = await client.findOpportunities({
      title: 'Teste',
      blocks: [
        { id: 'b_001', kind: 'hook', summary: 's1', start_seconds: 0, end_seconds: 5, text: 'Abertura' },
        { id: 'b_002', kind: 'payoff', summary: 's2', start_seconds: 5, end_seconds: 10, text: 'Fechamento' },
      ],
    });
    assert.equal(calls, 2);
    assert.equal(plan.opportunities[0]?.title, 'Teste');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('locator falls back to local sentence matching when model returns empty ids', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          start_sentence_id: '',
          end_sentence_id: '',
          why: 'não achei',
        }),
      },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as typeof fetch;
  try {
    const client = new OpenRouterClient(baseConfig as never);
    const located = await client.locateTranscriptSpan({
      query: 'terra digital e infraestrutura alugada',
      sentences: [
        { id: 's_1', index: 0, speakerId: 'speaker_0', startSeconds: 0, endSeconds: 5, text: 'A introdução do vídeo.' },
        { id: 's_2', index: 1, speakerId: 'speaker_0', startSeconds: 5, endSeconds: 12, text: 'Isso é independência vendida com infraestrutura alugada.' },
        { id: 's_3', index: 2, speakerId: 'speaker_0', startSeconds: 12, endSeconds: 18, text: 'No fim eles estão alugando um terreno digital.' },
      ],
    });
    assert.equal(located.start_sentence_id, 's_2');
    assert.equal(located.end_sentence_id, 's_3');
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
