import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlannedCandidateResponse, TranscriptSentence } from '../src/domain/model.js';
import { buildPlannedShorts, diagnoseCandidatePlan, fallbackSemanticBlocks, materializeSemanticBlocks, opportunityPlanToCandidatePlan } from '../src/domain/semantic.js';

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
  });
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
    speed: 1,
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
  const shorts = buildPlannedShorts({ sentences, blocks, plan: argumentPlan(), speed: 1 });
  assert.equal(shorts.length, 1);
  assert.deepEqual(shorts[0]?.ranges, [{ startWord: 0, endWord: 51 }]);
  assert.equal(shorts[0]?.rawDurationSeconds, 46);
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
  const shorts = buildPlannedShorts({ sentences: gapped, blocks, plan: argumentPlan(), speed: 1 });
  assert.equal(shorts.length, 1);
  assert.deepEqual(shorts[0]?.ranges, [
    { startWord: 0, endWord: 17 },
    { startWord: 18, endWord: 45 },
  ]);
  assert.equal(shorts[0]?.rawDurationSeconds, 41);
});

test('planned shorts enforce the 30 to 180 second raw duration window', () => {
  const shortBlocks = materializeSemanticBlocks(sentences, {
    blocks: [
      { id: 'b_001', kind: 'hook', summary: 'setup', start_sentence_id: 's_0001', end_sentence_id: 's_0001' },
      { id: 'b_002', kind: 'turn', summary: 'turn', start_sentence_id: 's_0002', end_sentence_id: 's_0002' },
      { id: 'b_003', kind: 'payoff', summary: 'payoff', start_sentence_id: 's_0003', end_sentence_id: 's_0003' },
    ],
  });
  const long: TranscriptSentence[] = [
    sentence('l_0001', 0, 0, 70, 0, 20, 'Todo mundo acha que isso é só um caso isolado hoje.'),
    sentence('l_0002', 1, 70, 140, 21, 40, 'Mas na verdade isso revela um mecanismo bem maior.'),
    sentence('l_0003', 2, 140, 200, 41, 60, 'E é por isso que o caso importa além do episódio em si.'),
  ];
  const longBlocks = materializeSemanticBlocks(long, {
    blocks: [
      { id: 'b_001', kind: 'hook', summary: 'setup', start_sentence_id: 'l_0001', end_sentence_id: 'l_0001' },
      { id: 'b_002', kind: 'turn', summary: 'turn', start_sentence_id: 'l_0002', end_sentence_id: 'l_0002' },
      { id: 'b_003', kind: 'payoff', summary: 'payoff', start_sentence_id: 'l_0003', end_sentence_id: 'l_0003' },
    ],
  });
  assert.equal(buildPlannedShorts({ sentences, blocks: shortBlocks, plan: argumentPlan(), speed: 1 }).length, 0);
  assert.equal(buildPlannedShorts({ sentences: long, blocks: longBlocks, plan: argumentPlan(), speed: 1 }).length, 0);
  const shortDiagnostics = diagnoseCandidatePlan(sentences, shortBlocks, argumentPlan());
  const longDiagnostics = diagnoseCandidatePlan(long, longBlocks, argumentPlan());
  assert.ok(shortDiagnostics[0]?.reasons.some((reason) => reason.includes('below minimum 30s')));
  assert.ok(longDiagnostics[0]?.reasons.some((reason) => reason.includes('exceeds maximum 180s')));
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
    speed: 1,
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

function sentence(id: string, index: number, startSeconds: number, endSeconds: number, startWord: number, endWord: number, text: string): TranscriptSentence {
  return { id, index, speakerId: 'speaker_0', startWord, endWord, startSeconds, endSeconds, text };
}
