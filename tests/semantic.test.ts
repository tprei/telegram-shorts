import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlannedCandidateResponse, TranscriptSentence, TranscriptWord } from '../src/domain/model.js';
import type { PlanningPace, SemanticBlock } from '../src/domain/semantic.js';
import { blockContinuesPrevious, blockOnScreenSeconds, buildPlannedShorts, diagnoseCandidatePlan, fallbackSemanticBlocks, materializeSemanticBlocks, opportunityPlanToCandidatePlan } from '../src/domain/semantic.js';
import { createInitialEdit } from '../src/domain/edit.js';
import { outputDurationSeconds } from '../src/domain/timeline.js';

const sentences: TranscriptSentence[] = [
  sentence('s_0001', 0, 0, 8, 0, 9, 'Todo mundo acha que isso é só um caso isolado.'),
  sentence('s_0002', 1, 8, 15, 10, 18, 'Mas na verdade isso revela um mecanismo bem maior.'),
  sentence('s_0003', 2, 15, 24, 19, 28, 'Por exemplo, a plataforma mede, distribui e monetiza esse comportamento.'),
  sentence('s_0004', 3, 24, 34, 29, 38, 'No fim, isso muda como a gente entende o problema.'),
  sentence('s_0005', 4, 34, 46, 39, 51, 'E é por isso que o caso importa além do episódio em si.'),
];

test('fallback semantic blocks preserve chronology and infer a turn block', () => {
  const blocks = fallbackSemanticBlocks(sentences);
  assert.ok(blocks.length >= 2);
  assert.equal(blocks[0]?.startSentenceId, 's_0001');
  assert.ok(blocks.some((block) => block.kind === 'turn'));
});

test('materialized semantic blocks fall back when invalid ordering is returned', () => {
  const blocks = materializeSemanticBlocks(sentences, {
    blocks: [
      {
        id: 'b_001',
        kind: 'hook',
        summary: 'inválido',
        start_sentence_id: 's_0003',
        end_sentence_id: 's_0001',
      },
    ],
  });
  assert.ok(blocks.length >= 2);
  assert.equal(blocks[0]?.startSentenceId, 's_0001');
});

test('candidate diagnostics explain validator rejection reasons', () => {
  const blocks = materializeSemanticBlocks(sentences, {
    blocks: [
      { id: 'b_001', kind: 'hook', summary: 'setup', start_sentence_id: 's_0001', end_sentence_id: 's_0001' },
      { id: 'b_002', kind: 'turn', summary: 'turn', start_sentence_id: 's_0002', end_sentence_id: 's_0002' },
    ],
  });
  const diagnostics = diagnoseCandidatePlan(sentences, blocks, {
    candidates: [{
      title: 'Curto demais',
      summary: 'x',
      hook: 'x',
      hook_text: 'x',
      payoff: 'x',
      rationale: 'x',
      thesis: 'x',
      risk: 'medium',
      block_ids: ['b_001', 'b_missing', 'b_001'],
      steps: [
        { kind: 'hook', label: 'setup', block_ids: ['b_001'] },
        { kind: 'turn', label: 'turn', block_ids: ['b_001'] },
      ],
    }],
  }, paceFor(sentences, 1, 46));
  assert.equal(diagnostics.length, 1);
  assert.ok(diagnostics[0]?.reasons.some((reason) => reason.includes('missing blocks')));
  assert.ok(diagnostics[0]?.reasons.some((reason) => reason.includes('duplicate')));
});

test('opportunity plans map cleanly into candidate plans', () => {
  const plan = opportunityPlanToCandidatePlan({
    opportunities: [{
      id: 'opp_001',
      title: 'Título',
      summary: 'Resumo',
      hook: 'Hook',
      hook_text: 'Manchete',
      payoff: 'Payoff',
      rationale: 'Racional',
      thesis: 'Tese',
      viewer_promise: 'Promessa',
      tension: 'Tensão',
      why_this_short: 'Por que esse short',
      risk: 'medium',
      block_ids: ['b_001', 'b_002'],
      steps: [
        { kind: 'hook', label: 'setup', block_ids: ['b_001'] },
        { kind: 'payoff', label: 'payoff', block_ids: ['b_002'] },
      ],
    }],
  });
  assert.deepEqual(plan.candidates[0]?.block_ids, ['b_001', 'b_002']);
  assert.equal(plan.candidates[0]?.title, 'Título');
  assert.equal(plan.candidates[0]?.hook_text, 'Manchete');
});

test('planned short validates structure without an explicit payoff block label', () => {
  const blocks = materializeSemanticBlocks(sentences, {
    blocks: [
      { id: 'b_001', kind: 'hook', summary: 'setup', start_sentence_id: 's_0001', end_sentence_id: 's_0001' },
      { id: 'b_002', kind: 'turn', summary: 'turn', start_sentence_id: 's_0002', end_sentence_id: 's_0002' },
      { id: 'b_003', kind: 'explain', summary: 'fechamento conceitual', start_sentence_id: 's_0003', end_sentence_id: 's_0005' },
    ],
  });
  const shorts = buildPlannedShorts({
    sentences,
    blocks,
    plan: {
      candidates: [{
        title: 'Ideia principal',
        summary: 'x',
        hook: 'x',
        hook_text: 'MANCHETE',
        payoff: 'x',
        rationale: 'x',
        thesis: 'x',
        risk: 'medium',
        block_ids: ['b_001', 'b_002', 'b_003'],
        steps: [
          { kind: 'hook', label: 'setup', block_ids: ['b_001'] },
          { kind: 'turn', label: 'virada', block_ids: ['b_002'] },
          { kind: 'explain', label: 'fechamento conceitual', block_ids: ['b_003'] },
        ],
      }],
    },
    pace: paceFor(sentences, 1, 46),
  });
  assert.equal(shorts.length, 1);
  assert.equal(shorts[0]?.arc?.steps.length, 3);
  assert.equal(shorts[0]?.hookText, 'MANCHETE');
});

test('planned short derives word ranges from the first and last block sentences', () => {
  const blocks = materializeSemanticBlocks(sentences, {
    blocks: [
      { id: 'b_001', kind: 'hook', summary: 'setup', start_sentence_id: 's_0001', end_sentence_id: 's_0001' },
      { id: 'b_002', kind: 'explain', summary: 'development', start_sentence_id: 's_0002', end_sentence_id: 's_0004' },
      { id: 'b_003', kind: 'payoff', summary: 'payoff', start_sentence_id: 's_0005', end_sentence_id: 's_0005' },
    ],
  });
  const shorts = buildPlannedShorts({ sentences, blocks, plan: argumentPlan(), pace: paceFor(sentences, 1, 46) });
  assert.equal(shorts.length, 1);
  assert.deepEqual(shorts[0]?.ranges, [{ startWord: 0, endWord: 51 }]);
  assert.equal(shorts[0]?.onScreenSeconds, 46);
});

test('planned short merges contiguous blocks into one range and keeps a gap as two ranges', () => {
  const gapped: TranscriptSentence[] = [
    sentence('g_0001', 0, 0, 8, 0, 9, 'Todo mundo acha que isso é só um caso isolado.'),
    sentence('g_0002', 1, 8, 15, 10, 17, 'Mas na verdade isso revela um mecanismo maior.'),
    sentence('g_0003', 2, 20, 32, 18, 30, 'Por exemplo, a plataforma mede e monetiza o comportamento.'),
    sentence('g_0004', 3, 32, 46, 31, 45, 'No fim, isso muda como a gente entende o problema.'),
  ];
  const blocks = materializeSemanticBlocks(gapped, {
    blocks: [
      { id: 'b_001', kind: 'hook', summary: 'setup', start_sentence_id: 'g_0001', end_sentence_id: 'g_0002' },
      { id: 'b_002', kind: 'explain', summary: 'development', start_sentence_id: 'g_0003', end_sentence_id: 'g_0003' },
      { id: 'b_003', kind: 'payoff', summary: 'payoff', start_sentence_id: 'g_0004', end_sentence_id: 'g_0004' },
    ],
  });
  const shorts = buildPlannedShorts({ sentences: gapped, blocks, plan: argumentPlan(), pace: paceFor(gapped, 1, 46) });
  assert.equal(shorts.length, 1);
  assert.deepEqual(shorts[0]?.ranges, [
    { startWord: 0, endWord: 17 },
    { startWord: 18, endWord: 45 },
  ]);
  assert.equal(shorts[0]?.onScreenSeconds, 41.2);
});

test('a candidate with a raw span near 70 seconds is accepted at 1.5x and matches the editor duration', () => {
  const fast: TranscriptSentence[] = [
    sentence('f_0001', 0, 0, 24.5, 0, 6, 'Todo mundo subestima quanto dinheiro esse número movimenta por ano.'),
    sentence('f_0002', 1, 24.5, 49, 7, 13, 'Mas o mecanismo por trás da plataforma explica a escala toda.'),
    sentence('f_0003', 2, 49, 70, 14, 19, 'No fim, a consequência muda como o público entende o problema.'),
  ];
  const blocks = materializeSemanticBlocks(fast, {
    blocks: [
      { id: 'b_001', kind: 'hook', summary: 'gancho', start_sentence_id: 'f_0001', end_sentence_id: 'f_0001' },
      { id: 'b_002', kind: 'turn', summary: 'virada', start_sentence_id: 'f_0002', end_sentence_id: 'f_0002' },
      { id: 'b_003', kind: 'payoff', summary: 'aterrissagem', start_sentence_id: 'f_0003', end_sentence_id: 'f_0003' },
    ],
  });
  const pace = paceFor(fast, 1.5, 70);
  const shorts = buildPlannedShorts({ sentences: fast, blocks, plan: argumentPlan(), pace });
  assert.equal(shorts.length, 1);
  assert.equal(shorts[0]?.onScreenSeconds, 46.7);
  const edit = createInitialEdit({ ranges: shorts[0]!.ranges, words: pace.words, speed: pace.speed, hookText: '' });
  assert.equal(shorts[0]!.onScreenSeconds, Math.round(outputDurationSeconds(edit, pace.words, pace.sourceDurationSeconds) * 10) / 10);
});

test('long pauses inside a block shrink the on-screen seconds below raw over speed', () => {
  const pausedWords: TranscriptWord[] = [
    word('p_w0', 'A', 0, 1),
    word('p_w1', 'conta', 1, 4),
    word('p_w2', 'explica', 8, 11),
    word('p_w3', 'tudo', 11, 12),
  ];
  const paused: TranscriptSentence[] = [{
    id: 'p_0001',
    index: 0,
    speakerId: 'speaker_0',
    startWord: 0,
    endWord: 3,
    startSeconds: 0,
    endSeconds: 12,
    text: 'A conta explica tudo.',
  }];
  const blocks = materializeSemanticBlocks(paused, {
    blocks: [
      { id: 'b_001', kind: 'explain', summary: 'mecanismo', start_sentence_id: 'p_0001', end_sentence_id: 'p_0001' },
    ],
  });
  const pace: PlanningPace = { speed: 1, words: pausedWords, sourceDurationSeconds: 12 };
  const block = blocks[0]!;
  const onScreen = blockOnScreenSeconds(block, paused, pace);
  assert.equal(onScreen, 8.2);
  assert.ok(onScreen < (block.endSeconds - block.startSeconds) / pace.speed);
});

test('planned shorts enforce the 20 to 90 second on-screen window', () => {
  const shortBlocks = materializeSemanticBlocks(sentences, {
    blocks: [
      { id: 'b_001', kind: 'hook', summary: 'setup', start_sentence_id: 's_0001', end_sentence_id: 's_0001' },
      { id: 'b_002', kind: 'turn', summary: 'turn', start_sentence_id: 's_0002', end_sentence_id: 's_0002' },
      { id: 'b_003', kind: 'payoff', summary: 'payoff', start_sentence_id: 's_0003', end_sentence_id: 's_0003' },
    ],
  });
  const long: TranscriptSentence[] = [
    sentence('l_0001', 0, 0, 50, 0, 20, 'Todo mundo acha que esse caso isolado revela um mecanismo gigante.'),
    sentence('l_0002', 1, 50, 100, 21, 41, 'Mas a plataforma mede, distribui e monetiza cada reação do público.'),
    sentence('l_0003', 2, 100, 140, 42, 60, 'E é por isso que o caso importa muito além do episódio em si.'),
  ];
  const longBlocks = materializeSemanticBlocks(long, {
    blocks: [
      { id: 'b_001', kind: 'hook', summary: 'setup', start_sentence_id: 'l_0001', end_sentence_id: 'l_0001' },
      { id: 'b_002', kind: 'turn', summary: 'turn', start_sentence_id: 'l_0002', end_sentence_id: 'l_0002' },
      { id: 'b_003', kind: 'payoff', summary: 'payoff', start_sentence_id: 'l_0003', end_sentence_id: 'l_0003' },
    ],
  });
  const fastShort = paceFor(sentences, 1.5, 24);
  const fastLong = paceFor(long, 1.5, 140);
  assert.equal(buildPlannedShorts({ sentences, blocks: shortBlocks, plan: argumentPlan(), pace: fastShort }).length, 0);
  assert.equal(buildPlannedShorts({ sentences: long, blocks: longBlocks, plan: argumentPlan(), pace: fastLong }).length, 0);
  const shortDiagnostics = diagnoseCandidatePlan(sentences, shortBlocks, argumentPlan(), fastShort);
  const longDiagnostics = diagnoseCandidatePlan(long, longBlocks, argumentPlan(), fastLong);
  assert.ok(shortDiagnostics[0]?.reasons.some((reason) => reason.includes('on-screen duration 16s is below minimum 20s')));
  assert.ok(longDiagnostics[0]?.reasons.some((reason) => reason.includes('on-screen duration 93.3s exceeds maximum 90s')));
});

test('a continuous passage with long pauses counts as one cut and passes the critic', () => {
  const paused: TranscriptSentence[] = [
    cutSentence('c_0001', 0, 0),
    cutSentence('c_0002', 1, 13),
    cutSentence('c_0003', 2, 26),
    cutSentence('c_0004', 3, 39),
    cutSentence('c_0005', 4, 52),
  ];
  const blocks = materializeSemanticBlocks(paused, {
    blocks: [
      { id: 'b_001', kind: 'hook', summary: 'gancho', start_sentence_id: 'c_0001', end_sentence_id: 'c_0001' },
      { id: 'b_002', kind: 'turn', summary: 'virada', start_sentence_id: 'c_0002', end_sentence_id: 'c_0002' },
      { id: 'b_003', kind: 'evidence', summary: 'evidência', start_sentence_id: 'c_0003', end_sentence_id: 'c_0003' },
      { id: 'b_004', kind: 'evidence', summary: 'detalhe', start_sentence_id: 'c_0004', end_sentence_id: 'c_0004' },
      { id: 'b_005', kind: 'payoff', summary: 'aterrissagem', start_sentence_id: 'c_0005', end_sentence_id: 'c_0005' },
    ],
  });
  const plan = cutPlan(['b_001', 'b_002', 'b_003', 'b_004', 'b_005']);
  const pace = paceFor(paused, 1, 62);
  const shorts = buildPlannedShorts({ sentences: paused, blocks, plan, pace });
  assert.equal(shorts.length, 1);
  const edit = createInitialEdit({ ranges: shorts[0]!.ranges, words: pace.words, speed: pace.speed, hookText: '' });
  assert.equal(edit.ranges.length, 1);
  assert.deepEqual(shorts[0]?.ranges, [
    { startWord: 0, endWord: 9 },
    { startWord: 10, endWord: 19 },
    { startWord: 20, endWord: 29 },
    { startWord: 30, endWord: 39 },
    { startWord: 40, endWord: 49 },
  ]);
  assert.equal(shorts[0]?.onScreenSeconds, 50.8);
  assert.ok(shorts[0]!.onScreenSeconds < 62);
  assert.ok(!diagnoseCandidatePlan(paused, blocks, plan, pace)[0]?.reasons.some((reason) => reason.includes('separate cuts')));
});

test('the critic counts real source jumps as cuts and accepts four of them', () => {
  const jumped: TranscriptSentence[] = [
    sentence('j_0001', 0, 0, 10, 0, 9, 'Primeiro trecho do argumento principal fica claro aqui.'),
    sentence('j_0002', 1, 12, 22, 12, 21, 'Segundo trecho do argumento principal termina nesse ponto.'),
    sentence('j_0003', 2, 24, 34, 24, 33, 'Terceiro trecho do argumento principal reforça o mecanismo.'),
    sentence('j_0004', 3, 36, 46, 36, 45, 'Quarto trecho do argumento principal traz a evidência.'),
    sentence('j_0005', 4, 48, 58, 48, 57, 'Quinto trecho do argumento principal aterrissa a tese.'),
  ];
  const jumpedWords: TranscriptWord[] = Array.from({ length: 58 }, (_, index) => word(`jw_${index + 1}`, `trecho${index + 1}`, index, index + 1));
  const blocksFor = (count: number): SemanticBlock[] =>
    materializeSemanticBlocks(jumped, {
      blocks: Array.from({ length: count }, (_, index) => ({
        id: `b_00${index + 1}`,
        kind: index === 0 ? 'hook' : index === count - 1 ? 'payoff' : index === 1 ? 'turn' : 'evidence',
        summary: `bloco ${index + 1}`,
        start_sentence_id: jumped[index]!.id,
        end_sentence_id: jumped[index]!.id,
      })),
    });
  const pace: PlanningPace = { speed: 1, words: jumpedWords, sourceDurationSeconds: 58 };
  const diagnostics = diagnoseCandidatePlan(jumped, blocksFor(5), cutPlan(['b_001', 'b_002', 'b_003', 'b_004', 'b_005']), pace);
  assert.ok(diagnostics[0]?.reasons.includes('uses 5 separate cuts; maximum is 4'));
  assert.equal(buildPlannedShorts({ sentences: jumped, blocks: blocksFor(5), plan: cutPlan(['b_001', 'b_002', 'b_003', 'b_004', 'b_005']), pace }).length, 0);
  assert.equal(buildPlannedShorts({ sentences: jumped, blocks: blocksFor(4), plan: cutPlan(['b_001', 'b_002', 'b_003', 'b_004']), pace }).length, 1);
});

test('blockContinuesPrevious detects word adjacency between neighbour blocks', () => {
  const continued = [cutSentence('c_0001', 0, 0), cutSentence('c_0002', 1, 13)];
  const continuedBlocks = materializeSemanticBlocks(continued, {
    blocks: [
      { id: 'b_001', kind: 'hook', summary: 'a', start_sentence_id: 'c_0001', end_sentence_id: 'c_0001' },
      { id: 'b_002', kind: 'turn', summary: 'b', start_sentence_id: 'c_0002', end_sentence_id: 'c_0002' },
    ],
  });
  const jumped = [sentence('j_0001', 0, 0, 10, 0, 9, 'Primeiro trecho do argumento fica claro aqui.'), sentence('j_0002', 1, 12, 22, 12, 21, 'Segundo trecho do argumento termina nesse ponto.')];
  const jumpedBlocks = materializeSemanticBlocks(jumped, {
    blocks: [
      { id: 'b_001', kind: 'hook', summary: 'a', start_sentence_id: 'j_0001', end_sentence_id: 'j_0001' },
      { id: 'b_002', kind: 'turn', summary: 'b', start_sentence_id: 'j_0002', end_sentence_id: 'j_0002' },
    ],
  });
  assert.equal(blockContinuesPrevious(continuedBlocks, 0, continued), false);
  assert.equal(blockContinuesPrevious(continuedBlocks, 1, continued), true);
  assert.equal(blockContinuesPrevious(jumpedBlocks, 1, jumped), false);
});

test('planned shorts dedupe candidates that resolve to identical ranges', () => {
  const blocks = materializeSemanticBlocks(sentences, {
    blocks: [
      { id: 'b_001', kind: 'hook', summary: 'setup', start_sentence_id: 's_0001', end_sentence_id: 's_0001' },
      { id: 'b_002', kind: 'turn', summary: 'turn', start_sentence_id: 's_0002', end_sentence_id: 's_0002' },
      { id: 'b_003', kind: 'explain', summary: 'evidence', start_sentence_id: 's_0003', end_sentence_id: 's_0003' },
      { id: 'b_004', kind: 'payoff', summary: 'payoff', start_sentence_id: 's_0004', end_sentence_id: 's_0005' },
    ],
  });
  const candidate = (title: string): PlannedCandidateResponse['candidates'][number] => ({
    title,
    summary: 'x',
    hook: 'x',
    hook_text: 'x',
    payoff: 'x',
    rationale: 'x',
    thesis: 'x',
    risk: 'medium',
    block_ids: ['b_001', 'b_002', 'b_003', 'b_004'],
    steps: [
      { kind: 'hook', label: 'setup', block_ids: ['b_001'] },
      { kind: 'turn', label: 'virada', block_ids: ['b_002'] },
      { kind: 'payoff', label: 'payoff', block_ids: ['b_003', 'b_004'] },
    ],
  });
  const shorts = buildPlannedShorts({
    sentences,
    blocks,
    plan: { candidates: [candidate('Primeiro'), candidate('Segundo')] },
    pace: paceFor(sentences, 1, 46),
  });
  assert.equal(shorts.length, 1);
  assert.equal(shorts[0]?.title, 'Primeiro');
});

function argumentPlan(): PlannedCandidateResponse {
  return {
    candidates: [{
      title: 'Argumento completo',
      summary: 'x',
      hook: 'x',
      hook_text: 'x',
      payoff: 'x',
      rationale: 'x',
      thesis: 'x',
      risk: 'medium',
      block_ids: ['b_001', 'b_002', 'b_003'],
      steps: [
        { kind: 'hook', label: 'setup', block_ids: ['b_001'] },
        { kind: 'explain', label: 'desenvolvimento do argumento', block_ids: ['b_002'] },
        { kind: 'payoff', label: 'payoff', block_ids: ['b_003'] },
      ],
    }],
  };
}

function cutPlan(blockIds: string[]): PlannedCandidateResponse {
  return {
    candidates: [{
      title: 'Cortes',
      summary: 'x',
      hook: 'x',
      hook_text: 'x',
      payoff: 'x',
      rationale: 'x',
      thesis: 'x',
      risk: 'medium',
      block_ids: blockIds,
      steps: [
        { kind: 'hook', label: 'gancho', block_ids: [blockIds[0]!] },
        { kind: 'turn', label: 'virada', block_ids: [blockIds[1]!] },
        { kind: 'payoff', label: 'aterrissagem', block_ids: [blockIds[blockIds.length - 1]!] },
      ],
    }],
  };
}

function sentence(id: string, index: number, startSeconds: number, endSeconds: number, startWord: number, endWord: number, text: string): TranscriptSentence {
  return { id, index, speakerId: 'speaker_0', startWord, endWord, startSeconds, endSeconds, text };
}

function cutSentence(id: string, index: number, startSeconds: number): TranscriptSentence {
  return sentence(id, index, startSeconds, startSeconds + 10, index * 10, index * 10 + 9, `Ponto número ${index + 1} do argumento principal fica claro aqui.`);
}

function word(id: string, text: string, startSeconds: number, endSeconds: number): TranscriptWord {
  return { id, text, startSeconds, endSeconds, speakerId: 'speaker_0', confidence: 1 };
}

function paceFor(sentences: TranscriptSentence[], speed: number, sourceDurationSeconds: number): PlanningPace {
  return { speed, words: tiledWords(sentences), sourceDurationSeconds };
}

function tiledWords(sentences: TranscriptSentence[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const sentence of sentences) {
    const tokens = sentence.text.split(/\s+/);
    const count = sentence.endWord - sentence.startWord + 1;
    const step = (sentence.endSeconds - sentence.startSeconds) / count;
    for (let offset = 0; offset < count; offset += 1) {
      words.push({
        id: `${sentence.id}_w${offset}`,
        text: tokens[offset % tokens.length] ?? 'palavra',
        startSeconds: sentence.startSeconds + step * offset,
        endSeconds: sentence.startSeconds + step * (offset + 1),
        speakerId: sentence.speakerId,
        confidence: 1,
      });
    }
  }
  return words;
}
