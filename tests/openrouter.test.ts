import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import type { AppConfig } from '../src/infra/env.js';
import { OpenRouterClient, requestStructuredJson } from '../src/infra/openrouter.js';

const baseConfig = {
  OPENROUTER_API_KEY: 'test-key',
  OPENROUTER_MODEL: 'test-model',
  OPENROUTER_REASONING_EFFORT: 'max',
  OPENROUTER_MAX_TOKENS: 128000,
  OPENROUTER_VISION_MODEL: 'test-vision-model',
} as AppConfig;

const ResponseFormatSchema = z.object({
  type: z.string(),
  json_schema: z.object({
    name: z.string(),
    strict: z.boolean().optional(),
    schema: z.object({
      type: z.string(),
      properties: z.record(z.string(), z.unknown()).optional(),
      required: z.array(z.string()).optional(),
    }),
  }),
});

const MessageSchema = z.object({ role: z.string(), content: z.unknown() });

const CapturedBodySchema = z.object({
  model: z.string(),
  reasoning: z.object({ effort: z.string() }).optional(),
  max_tokens: z.number().optional(),
  messages: z.array(MessageSchema),
  response_format: ResponseFormatSchema,
});

type CapturedBody = z.infer<typeof CapturedBodySchema>;

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: CapturedBody;
}

function installFetch(respond: (request: CapturedRequest) => string): { calls: CapturedRequest[]; restore(): void } {
  const calls: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const captured: CapturedRequest = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: CapturedBodySchema.parse(JSON.parse(rawBody)),
    };
    calls.push(captured);
    return new Response(JSON.stringify({ choices: [{ message: { content: respond(captured) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function userTextOf(request: CapturedRequest): string {
  const user = request.body.messages.find((message) => message.role === 'user');
  if (typeof user?.content !== 'string') {
    throw new Error('Expected user message with string content.');
  }
  return user.content;
}

const UserPartsSchema = z.array(z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string() }) }),
]));

function userPartsOf(request: CapturedRequest): z.infer<typeof UserPartsSchema> {
  const user = request.body.messages.find((message) => message.role === 'user');
  return UserPartsSchema.parse(user?.content);
}

function itemsRequired(request: CapturedRequest, key: 'opportunities' | 'candidates'): string[] {
  const schema = request.body.response_format.json_schema.schema;
  const arrayDescriptor = z.object({
    items: z.object({ required: z.array(z.string()).optional() }),
  }).parse(schema.properties?.[key]);
  return arrayDescriptor.items.required ?? [];
}

test('requestStructuredJson defaults to OPENROUTER_MODEL and sends studio headers', async () => {
  const fetchStub = installFetch(() => JSON.stringify({ ok: true }));
  try {
    const result = await requestStructuredJson<unknown>(baseConfig, {
      title: 'task-title',
      system: 'sistema',
      userText: 'pedido',
      temperature: 0.2,
      responseFormat: { name: 'probe', schema: { type: 'object' } },
      parse: (value) => value,
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(fetchStub.calls.length, 1);
    const request = fetchStub.calls[0]!;
    assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer test-key');
    assert.equal(request.headers['http-referer'], 'http://127.0.0.1');
    assert.equal(request.headers['x-title'], 'task-title');
    assert.equal(request.body.model, 'test-model');
    assert.equal(userTextOf(request), 'pedido');
  } finally {
    fetchStub.restore();
  }
});

test('requestStructuredJson overrides the model and sends images as data URLs', async () => {
  const fetchStub = installFetch(() => JSON.stringify({ box: [0, 0, 100, 100] }));
  try {
    const result = await requestStructuredJson<unknown>(baseConfig, {
      title: 'vision-probe',
      system: 'sistema',
      userText: 'descreva o quadro',
      images: [{ mimeType: 'image/png', base64: 'aGVsbG8=' }],
      model: baseConfig.OPENROUTER_VISION_MODEL,
      temperature: 0.1,
      responseFormat: { name: 'vision_probe', schema: { type: 'object' } },
      parse: (value) => value,
    });
    assert.deepEqual(result, { box: [0, 0, 100, 100] });
    const request = fetchStub.calls[0]!;
    assert.equal(request.body.model, 'test-vision-model');
    assert.equal(request.body.reasoning, undefined);
    assert.equal(request.body.max_tokens, undefined);
    assert.deepEqual(userPartsOf(request), [
      { type: 'text', text: 'descreva o quadro' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ]);
  } finally {
    fetchStub.restore();
  }
});

test('editorial client calls send the configured reasoning effort and token ceiling', async () => {
  const fetchStub = installFetch(() => JSON.stringify({ options: ['Um', 'Dois', 'Três'] }));
  try {
    const client = new OpenRouterClient(baseConfig);
    await client.suggestHooks({ title: 'Título', summary: 'Resumo', transcriptText: 'texto', current: 'atual' });
    assert.deepEqual(fetchStub.calls[0]!.body.reasoning, { effort: 'max' });
    assert.equal(fetchStub.calls[0]!.body.max_tokens, 128000);
  } finally {
    fetchStub.restore();
  }
});

test('requestStructuredJson repairs malformed JSON with exactly one extra pass', async () => {
  let calls = 0;
  const fetchStub = installFetch(() => {
    calls += 1;
    return calls === 1 ? '{"value": 42 "extra": true}' : JSON.stringify({ value: 42 });
  });
  try {
    const result = await requestStructuredJson<{ value: number }>(baseConfig, {
      title: 'repair-probe',
      system: 'sistema',
      userText: 'pedido',
      temperature: 0.2,
      responseFormat: { name: 'repair_probe', schema: { type: 'object' } },
      parse: (value) => value as { value: number },
    });
    assert.deepEqual(result, { value: 42 });
    assert.equal(calls, 2);
    assert.equal(fetchStub.calls[1]!.headers['x-title'], 'repair-probe-json-repair');
    assert.match(userTextOf(fetchStub.calls[1]!), /parse_error/);
    assert.match(userTextOf(fetchStub.calls[1]!), /malformed_json/);
  } finally {
    fetchStub.restore();
  }
});

test('planner request schemas require hook_text on opportunities and candidates', async () => {
  const opportunityContent = JSON.stringify({
    opportunities: [{
      id: 'opp_001', title: 'T', summary: 'S', hook: 'H', hook_text: 'MANCHETE', payoff: 'P',
      rationale: 'R', thesis: 'T', viewer_promise: 'V', tension: 'X', why_this_short: 'W',
      risk: 'medium', block_ids: ['b_001', 'b_002'],
      steps: [
        { kind: 'hook', label: 'Abertura', block_ids: ['b_001'] },
        { kind: 'payoff', label: 'Fechamento', block_ids: ['b_002'] },
      ],
    }],
  });
  const fetchStub = installFetch(() => opportunityContent);
  try {
    const client = new OpenRouterClient(baseConfig);
    const blocks = [
      { id: 'b_001', kind: 'hook' as const, summary: 's1', start_seconds: 0, on_screen_seconds: 5, continues_previous: false, text: 'Abertura' },
      { id: 'b_002', kind: 'payoff' as const, summary: 's2', start_seconds: 5, on_screen_seconds: 10, continues_previous: true, text: 'Fechamento' },
    ];
    const opportunities = await client.findOpportunities({ title: 'Teste', blocks, speed: 1.5 });
    assert.ok(itemsRequired(fetchStub.calls[0]!, 'opportunities').includes('hook_text'));
    assert.equal(JSON.parse(userTextOf(fetchStub.calls[0]!)).playback_speed, 1.5);
    assert.equal(opportunities.opportunities[0]?.hook_text, 'MANCHETE');

    await client.planCandidates({ title: 'Teste', blocks, opportunities: opportunities.opportunities, speed: 1.5 });
    assert.ok(itemsRequired(fetchStub.calls[1]!, 'candidates').includes('hook_text'));
    assert.equal(JSON.parse(userTextOf(fetchStub.calls[1]!)).playback_speed, 1.5);
  } finally {
    fetchStub.restore();
  }
});

test('opportunity planner repairs malformed model JSON and fills missing hook_text', async () => {
  let calls = 0;
  const fetchStub = installFetch(() => {
    calls += 1;
    if (calls === 1) {
      return '{"opportunities":[{"id":"opp_1" "title":"Teste"}]}';
    }
    return JSON.stringify({
      opportunities: [{
        id: 'opp_1', title: 'Teste', summary: 'Resumo', hook: 'Gancho', payoff: 'Payoff',
        rationale: 'Racional', thesis: 'Tese', viewer_promise: 'Promessa', tension: 'Tensão',
        why_this_short: 'Porque', risk: 'medium', block_ids: ['b_001', 'b_002'],
        steps: [
          { kind: 'hook', label: 'Abertura', block_ids: ['b_001'] },
          { kind: 'payoff', label: 'Fechamento', block_ids: ['b_002'] },
        ],
      }],
    });
  });
  try {
    const client = new OpenRouterClient(baseConfig);
    const plan = await client.findOpportunities({
      title: 'Teste',
      speed: 1.5,
      blocks: [
        { id: 'b_001', kind: 'hook', summary: 's1', start_seconds: 0, on_screen_seconds: 5, continues_previous: false, text: 'Abertura' },
        { id: 'b_002', kind: 'payoff', summary: 's2', start_seconds: 5, on_screen_seconds: 10, continues_previous: true, text: 'Fechamento' },
      ],
    });
    assert.equal(calls, 2);
    assert.equal(plan.opportunities[0]?.title, 'Teste');
    assert.equal(plan.opportunities[0]?.hook_text, 'Gancho');
  } finally {
    fetchStub.restore();
  }
});

test('opportunity planner drops opportunities with fewer than two blocks instead of failing the plan', async () => {
  const opportunity = (id: string, blockIds: string[]) => ({
    id, title: `Título ${id}`, summary: 'Resumo', hook: 'Gancho', hook_text: 'Manchete', payoff: 'Payoff',
    rationale: 'Racional', thesis: 'Tese', viewer_promise: 'Promessa', tension: 'Tensão',
    why_this_short: 'Porque', risk: 'low', block_ids: blockIds,
    steps: blockIds.map((blockId, index) => ({ kind: index === 0 ? 'hook' : 'payoff', label: `Passo ${index + 1}`, block_ids: [blockId] })),
  });
  let calls = 0;
  const fetchStub = installFetch(() => {
    calls += 1;
    return JSON.stringify({ opportunities: [opportunity('opp_1', ['b_001']), opportunity('opp_2', ['b_001', 'b_002'])] });
  });
  try {
    const client = new OpenRouterClient(baseConfig);
    const plan = await client.findOpportunities({
      title: 'Teste',
      speed: 1.5,
      blocks: [
        { id: 'b_001', kind: 'hook', summary: 's1', start_seconds: 0, on_screen_seconds: 5, continues_previous: false, text: 'Abertura' },
        { id: 'b_002', kind: 'payoff', summary: 's2', start_seconds: 5, on_screen_seconds: 10, continues_previous: true, text: 'Fechamento' },
      ],
    });
    assert.equal(calls, 1);
    assert.deepEqual(plan.opportunities.map((entry) => entry.id), ['opp_2']);
  } finally {
    fetchStub.restore();
  }
});

test('revision parser normalizes invented conclusion actions into safe extend_end', async () => {
  const fetchStub = installFetch(() => JSON.stringify({
    actions: [{ kind: 'extend_conclusion', reason: 'o vídeo acaba do nada' }],
    summary: 'Inclui uma conclusão estendendo o final.',
  }));
  try {
    const client = new OpenRouterClient(baseConfig);
    const intent = await client.parseRevision({
      title: 'Teste',
      hookText: 'Manchete atual',
      durationSeconds: 80,
      segments: [{ start_seconds: 0, end_seconds: 15, text: 'começo' }, { start_seconds: 82, end_seconds: 171, text: 'meio' }],
      message: 'inclue uma conclusão, o vídeo acaba do nada',
    });
    assert.deepEqual(intent.actions, [{ kind: 'extend_end', seconds: 30 }]);
  } finally {
    fetchStub.restore();
  }
});

test('revision parser maps end-card aliases and clamps speed into [1, 1.5]', async () => {
  const fetchStub = installFetch(() => JSON.stringify({
    edits: [
      { action: 'enable_preview_end_card' },
      { type: 'speed', value: '3' },
      { kind: 'set_speed', speed: '0.5' },
      { kind: 'set_speed' },
    ],
  }));
  try {
    const client = new OpenRouterClient(baseConfig);
    const intent = await client.parseRevision({
      title: 'Teste',
      hookText: 'Manchete atual',
      durationSeconds: 80,
      segments: [{ start_seconds: 0, end_seconds: 80, text: 'texto' }],
      message: 'ativa o cartão final e acelera',
    });
    assert.deepEqual(intent.actions, [
      { kind: 'enable_end_card' },
      { kind: 'set_speed', speed: 1.5 },
      { kind: 'set_speed', speed: 1 },
      { kind: 'set_speed', speed: 1.15 },
    ]);
  } finally {
    fetchStub.restore();
  }
});

test('revision parser normalizes span and hook aliases and drops removed actions', async () => {
  const fetchStub = installFetch(() => JSON.stringify({
    edits: [
      { action: 'add_span', description: 'fechamento do argumento' },
      { kind: 'caption_cleanup' },
      { kind: 'reorder_candidate', rank: 2 },
      { kind: 'set_hook', text: 'Nova manchete' },
    ],
  }));
  try {
    const client = new OpenRouterClient(baseConfig);
    const intent = await client.parseRevision({
      title: 'Teste',
      hookText: 'Manchete atual',
      durationSeconds: 80,
      segments: [{ start_seconds: 0, end_seconds: 80, text: 'texto' }],
      message: 'inclui o fechamento e troca a manchete',
    });
    assert.deepEqual(intent.actions, [
      { kind: 'insert_span', query: 'fechamento do argumento' },
      { kind: 'set_hook', text: 'Nova manchete' },
    ]);
    assert.equal(intent.summary, 'Revisão aplicada');
  } finally {
    fetchStub.restore();
  }
});

test('suggestHooks returns exactly three options', async () => {
  const fetchStub = installFetch(() => JSON.stringify({
    options: ['A regra que ninguém te conta', 'O erro que custa caro', 'Por que isso mudou tudo'],
  }));
  try {
    const client = new OpenRouterClient(baseConfig);
    const hooks = await client.suggestHooks({
      title: 'Teste',
      summary: 'Resumo',
      transcriptText: 'transcrição',
      current: 'Manchete atual',
    });
    assert.deepEqual(hooks, ['A regra que ninguém te conta', 'O erro que custa caro', 'Por que isso mudou tudo']);
  } finally {
    fetchStub.restore();
  }
});

test('publish copy normalizes hashtags and prefixes them with #', async () => {
  const fetchStub = installFetch(() => JSON.stringify({
    line_1: 'A tese é mais incômoda do que parece.',
    line2: 'Seguindo a lógica até o fim, a contradição aparece.',
    hashtags: ['economia', 'brasil', 'debate'],
  }));
  try {
    const client = new OpenRouterClient(baseConfig);
    const copy = await client.writePublishCopy({
      title: 'Teste',
      summary: 'Resumo',
      hook: 'Gancho',
      payoff: 'Payoff',
      rationale: 'Racional',
      quotes: ['citação 1', 'citação 2'],
    });
    assert.deepEqual(copy, {
      line_1: 'A tese é mais incômoda do que parece.',
      line_2: 'Seguindo a lógica até o fim, a contradição aparece.',
      hashtags: ['#economia', '#brasil', '#debate'],
    });
  } finally {
    fetchStub.restore();
  }
});

test('locator falls back to local sentence matching when model returns empty ids', async () => {
  const fetchStub = installFetch(() => JSON.stringify({
    start_sentence_id: '',
    end_sentence_id: '',
    why: 'não achei',
  }));
  try {
    const client = new OpenRouterClient(baseConfig);
    const located = await client.locateTranscriptSpan({
      query: 'terra digital e infraestrutura alugada',
      sentences: [
        { id: 's_1', index: 0, speakerId: 'speaker_0', startWord: 0, endWord: 5, startSeconds: 0, endSeconds: 5, text: 'A introdução do vídeo.' },
        { id: 's_2', index: 1, speakerId: 'speaker_0', startWord: 6, endWord: 12, startSeconds: 5, endSeconds: 12, text: 'Isso é independência vendida com infraestrutura alugada.' },
        { id: 's_3', index: 2, speakerId: 'speaker_0', startWord: 13, endWord: 18, startSeconds: 12, endSeconds: 18, text: 'No fim eles estão alugando um terreno digital.' },
      ],
    });
    assert.equal(located.start_sentence_id, 's_2');
    assert.equal(located.end_sentence_id, 's_3');
  } finally {
    fetchStub.restore();
  }
});

test('identifyHostSpeaker sends the editorial settings and returns the chosen speaker', async () => {
  const fetchStub = installFetch(() => JSON.stringify({ speaker_id: 'speaker_0', reason: 'Fala com o chat em primeira pessoa.' }));
  try {
    const client = new OpenRouterClient(baseConfig);
    const choice = await client.identifyHostSpeaker({
      creatorName: 'Creator A',
      hostDescription: null,
      videoTitle: 'Título do vídeo',
      speakers: [
        { speakerId: 'speaker_0', totalSeconds: 247, samples: ['Lula abriu os sigilos porque é corrupto.'] },
        { speakerId: 'speaker_8', totalSeconds: 266, samples: ['Você sabia que se alguém te convidar hoje para ir trabalhar no garimpo…'] },
      ],
    });
    assert.deepEqual(choice, { speakerId: 'speaker_0', reason: 'Fala com o chat em primeira pessoa.' });
    assert.equal(fetchStub.calls.length, 1);
    const request = fetchStub.calls[0]!;
    assert.deepEqual(request.body.reasoning, { effort: 'max' });
    assert.equal(request.body.max_tokens, 128000);
    assert.equal(request.body.response_format.json_schema.name, 'host_speaker_choice');
    assert.deepEqual(JSON.parse(userTextOf(request)), {
      creator_name: 'Creator A',
      host_description: null,
      video_title: 'Título do vídeo',
      speakers: [
        { speaker_id: 'speaker_0', total_seconds: 247, samples: ['Lula abriu os sigilos porque é corrupto.'] },
        { speaker_id: 'speaker_8', total_seconds: 266, samples: ['Você sabia que se alguém te convidar hoje para ir trabalhar no garimpo…'] },
      ],
    });
  } finally {
    fetchStub.restore();
  }
});

test('host speaker identifier rejects a speaker_id outside the given speakers', async () => {
  const fetchStub = installFetch(() => JSON.stringify({ speaker_id: 'speaker_9', reason: 'motivo qualquer' }));
  try {
    const client = new OpenRouterClient(baseConfig);
    await assert.rejects(client.identifyHostSpeaker({
      creatorName: 'Creator A',
      hostDescription: null,
      videoTitle: null,
      speakers: [
        { speakerId: 'speaker_0', totalSeconds: 247, samples: ['Falo com o chat.'] },
        { speakerId: 'speaker_1', totalSeconds: 281, samples: ['Trecho reagido.'] },
      ],
    }));
    assert.equal(fetchStub.calls.length, 2);
    assert.equal(fetchStub.calls[1]!.body.response_format.json_schema.name, 'host_speaker_choice');
  } finally {
    fetchStub.restore();
  }
});

test('planCandidates inherits hook_text and payoff from the source opportunity', async () => {
  const fetchStub = installFetch(() => JSON.stringify({
    candidates: [{
      opportunity_id: 'opp_1', block_ids: ['b_001', 'b_002'],
      steps: [
        { kind: 'hook', label: 'Abertura', block_ids: ['b_001'] },
        { kind: 'payoff', label: 'Fechamento', block_ids: ['b_002'] },
      ],
    }],
  }));
  try {
    const client = new OpenRouterClient(baseConfig);
    const planned = await client.planCandidates({
      title: 'Teste',
      speed: 1.5,
      blocks: [
        { id: 'b_001', kind: 'hook', summary: 's1', start_seconds: 0, on_screen_seconds: 5, continues_previous: false, text: 'Abertura' },
        { id: 'b_002', kind: 'payoff', summary: 's2', start_seconds: 5, on_screen_seconds: 10, continues_previous: true, text: 'Fechamento' },
      ],
      opportunities: [{
        id: 'opp_1', title: 'Argumento central', summary: 'Resumo', hook: 'Gancho', hook_text: 'Manchete da oportunidade',
        payoff: 'Payoff da oportunidade', rationale: 'Racional', thesis: 'Tese', viewer_promise: 'Promessa', tension: 'Tensão',
        why_this_short: 'Porque', risk: 'low', block_ids: ['b_001', 'b_002'],
        steps: [
          { kind: 'hook', label: 'Abertura', block_ids: ['b_001'] },
          { kind: 'payoff', label: 'Fechamento', block_ids: ['b_002'] },
        ],
      }],
    });
    assert.equal(planned.candidates[0]?.hook_text, 'Manchete da oportunidade');
    assert.equal(planned.candidates[0]?.payoff, 'Payoff da oportunidade');
  } finally {
    fetchStub.restore();
  }
});

test('suggestHooks repairs a response with fewer than three options', async () => {
  let calls = 0;
  const fetchStub = installFetch(() => {
    calls += 1;
    return calls === 1
      ? JSON.stringify({ options: ['Só uma opção'] })
      : JSON.stringify({ options: ['A regra que ninguém te conta', 'O erro que custa caro', 'Por que isso mudou tudo'] });
  });
  try {
    const client = new OpenRouterClient(baseConfig);
    const hooks = await client.suggestHooks({
      title: 'Teste',
      summary: 'Resumo',
      transcriptText: 'transcrição',
      current: 'Manchete atual',
    });
    assert.equal(hooks.length, 3);
    assert.equal(calls, 2);
    assert.equal(fetchStub.calls[1]!.headers['x-title'], 'hook-suggestions-json-repair');
  } finally {
    fetchStub.restore();
  }
});

test('publish copy falls back to hook and payoff and splits hashtag strings', async () => {
  const fetchStub = installFetch(() => JSON.stringify({ hashtags: '#economia brasil debate' }));
  try {
    const client = new OpenRouterClient(baseConfig);
    const copy = await client.writePublishCopy({
      title: 'Teste',
      summary: 'Resumo',
      hook: 'Gancho do argumento',
      payoff: 'Payoff do argumento',
      rationale: 'Racional',
      quotes: ['citação 1'],
    });
    assert.deepEqual(copy, {
      line_1: 'Gancho do argumento',
      line_2: 'Payoff do argumento',
      hashtags: ['#economia', '#brasil', '#debate'],
    });
  } finally {
    fetchStub.restore();
  }
});

test('revision parser keeps retitle, trim and extend defaults and drops a retitle without a title', async () => {
  const fetchStub = installFetch(() => JSON.stringify({
    edits: [
      { kind: 'retitle', title: 'Novo título' },
      { kind: 'retitle' },
      { kind: 'trim_start' },
      { kind: 'trim_end' },
      { kind: 'extend_start' },
      { kind: 'cut_span', query: 'a digressão sobre o preço' },
      { kind: 'add_span' },
    ],
  }));
  try {
    const client = new OpenRouterClient(baseConfig);
    const intent = await client.parseRevision({
      title: 'Teste',
      hookText: 'Manchete atual',
      durationSeconds: 80,
      segments: [{ start_seconds: 0, end_seconds: 80, text: 'texto' }],
      message: 'renomeia, corta e estende o começo',
    });
    assert.deepEqual(intent.actions, [
      { kind: 'retitle', title: 'Novo título' },
      { kind: 'trim_start', seconds: 5 },
      { kind: 'trim_end', seconds: 5 },
      { kind: 'extend_start', seconds: 20 },
      { kind: 'remove_span', query: 'a digressão sobre o preço' },
      { kind: 'insert_span', query: 'conclusão ou payoff do argumento' },
    ]);
  } finally {
    fetchStub.restore();
  }
});

test('a provider that fails mid-response is retried once, and requests require capable providers', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<{ provider?: { require_parameters?: boolean } }> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
    const choice = bodies.length === 1
      ? { finish_reason: 'error', message: { content: '' } }
      : { finish_reason: 'stop', message: { content: JSON.stringify({ options: ['Um', 'Dois', 'Três'] }) } };
    return new Response(JSON.stringify({ provider: 'Somewhere', choices: [choice] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const options = await new OpenRouterClient(baseConfig).suggestHooks({ title: 'Título', summary: 'Resumo', transcriptText: 'texto', current: 'atual' });
    assert.deepEqual(options, ['Um', 'Dois', 'Três']);
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every((body) => body.provider?.require_parameters === true));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a token-limit empty response is not retried', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await assert.rejects(new OpenRouterClient(baseConfig).suggestHooks({ title: 'Título', summary: 'Resumo', transcriptText: 'texto', current: 'atual' }), /finish_reason length/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HTTP failures propagate without a repair request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('limite excedido', { status: 429 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => new OpenRouterClient(baseConfig).suggestHooks({ title: 'Teste', summary: 'Resumo', transcriptText: 'transcrição', current: 'Manchete atual' }),
      /OpenRouter request failed: 429/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a transient connect timeout is retried once and the retry succeeds', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('connect timed out');
      (error as Error & { code: string }).code = 'ETIMEDOUT';
      throw error;
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"options":["Um","Dois","Três"]}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const options = await new OpenRouterClient(baseConfig).suggestHooks({ title: 'Título', summary: 'Resumo', transcriptText: 'texto', current: 'atual' });
    assert.deepEqual(options, ['Um', 'Dois', 'Três']);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a transient error hidden in a cause chain is retried, a non-transient code is not', { timeout: 30_000 }, async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error('fetch failed', { cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) });
    }
    if (calls === 2) {
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"options":["Um","Dois","Três"]}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const error = new Error('name resolution failed');
    (error as Error & { code: string }).code = 'ENOTFOUND';
    throw error;
  }) as typeof fetch;
  try {
    const options = await new OpenRouterClient(baseConfig).suggestHooks({ title: 'Título', summary: 'Resumo', transcriptText: 'texto', current: 'atual' });
    assert.deepEqual(options, ['Um', 'Dois', 'Três']);
    await assert.rejects(
      () => new OpenRouterClient(baseConfig).suggestHooks({ title: 'Título', summary: 'Resumo', transcriptText: 'texto', current: 'atual' }),
      /ENOTFOUND|name resolution failed/,
    );
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an HTTP 4xx response is never retried', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('chave inválida', { status: 401 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => new OpenRouterClient(baseConfig).suggestHooks({ title: 'Título', summary: 'Resumo', transcriptText: 'texto', current: 'atual' }),
      /OpenRouter request failed: 401/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('aborted caller signal stops repair and network retry', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const { promise, reject } = Promise.withResolvers<Response>();
    const signal = init?.signal;
    if (signal !== undefined && !signal.aborted) {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      return promise;
    }
    reject(signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    return promise;
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => requestStructuredJson(baseConfig, {
        title: 'scene_layout',
        system: 'sistema',
        userText: 'pedido',
        temperature: 0.1,
        responseFormat: { name: 'scene_layout', schema: { type: 'object' } },
        parse: (value) => value,
        signal: controller.signal,
      }),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const retryController = new AbortController();
  let retryCalls = 0;
  globalThis.fetch = (async () => {
    retryCalls += 1;
    retryController.abort();
    const error = new Error('connect timed out');
    (error as Error & { code: string }).code = 'ETIMEDOUT';
    throw error;
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => requestStructuredJson(baseConfig, {
        title: 'scene_layout',
        system: 'sistema',
        userText: 'pedido',
        temperature: 0.1,
        responseFormat: { name: 'scene_layout', schema: { type: 'object' } },
        parse: (value) => value,
        signal: retryController.signal,
      }),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(retryCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
