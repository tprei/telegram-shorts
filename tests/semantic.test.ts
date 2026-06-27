import assert from 'node:assert/strict';
import test from 'node:test';
import { TranscriptSentence } from '../src/domain/model.js';
import { buildCandidateVersionFromBlocks, diagnoseCandidatePlan, fallbackSemanticBlocks, materializeSemanticBlocks, opportunityPlanToCandidatePlan } from '../src/domain/semantic.js';

const sentences: TranscriptSentence[] = [
  sentence('s_0001', 0, 0, 8, 'Todo mundo acha que isso é só um caso isolado.'),
  sentence('s_0002', 1, 8, 15, 'Mas na verdade isso revela um mecanismo bem maior.'),
  sentence('s_0003', 2, 15, 24, 'Por exemplo, a plataforma mede, distribui e monetiza esse comportamento.'),
  sentence('s_0004', 3, 24, 34, 'No fim, isso muda como a gente entende o problema.'),
  sentence('s_0005', 4, 34, 46, 'E é por isso que o caso importa além do episódio em si.'),
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
});

test('terminal authored short can validate without explicit payoff block label', () => {
  const blocks = materializeSemanticBlocks(sentences, {
    blocks: [
      { id: 'b_001', kind: 'hook', summary: 'setup', start_sentence_id: 's_0001', end_sentence_id: 's_0001' },
      { id: 'b_002', kind: 'turn', summary: 'turn', start_sentence_id: 's_0002', end_sentence_id: 's_0002' },
      { id: 'b_003', kind: 'explain', summary: 'evidence', start_sentence_id: 's_0003', end_sentence_id: 's_0005' },
    ],
  });
  const version = buildCandidateVersionFromBlocks('job_1', 1, null, 'initial', sentences, blocks, {
    candidates: [{
      title: 'Ideia principal',
      summary: 'x',
      hook: 'x',
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
  });
  assert.equal(version.candidates.length, 1);
});

test('candidate version from semantic blocks prefers argument arc over chapter slice', () => {
  const blocks = materializeSemanticBlocks(sentences, {
    blocks: [
      { id: 'b_001', kind: 'hook', summary: 'setup', start_sentence_id: 's_0001', end_sentence_id: 's_0001' },
      { id: 'b_002', kind: 'turn', summary: 'turn', start_sentence_id: 's_0002', end_sentence_id: 's_0002' },
      { id: 'b_003', kind: 'evidence', summary: 'evidence', start_sentence_id: 's_0003', end_sentence_id: 's_0003' },
      { id: 'b_004', kind: 'payoff', summary: 'payoff', start_sentence_id: 's_0004', end_sentence_id: 's_0005' },
    ],
  });
  const version = buildCandidateVersionFromBlocks('job_1', 1, null, 'initial', sentences, blocks, {
    candidates: [
      {
        title: 'Capítulo simples',
        summary: 'x',
        hook: 'x',
        payoff: 'x',
        rationale: 'x',
        thesis: 'x',
        risk: 'medium',
        block_ids: ['b_001', 'b_002', 'b_003', 'b_004'],
        steps: [
          { kind: 'hook', label: 'setup', block_ids: ['b_001'] },
          { kind: 'turn', label: 'virada', block_ids: ['b_002'] },
          { kind: 'evidence', label: 'evidence', block_ids: ['b_003'] },
          { kind: 'payoff', label: 'payoff', block_ids: ['b_004'] },
        ],
      },
    ],
  });
  assert.equal(version.candidates.length, 1);
  assert.equal(version.candidates[0]?.arc?.steps.length, 4);
  assert.equal(version.candidates[0]?.seamCount, 0);
});

function sentence(id: string, index: number, startSeconds: number, endSeconds: number, text: string): TranscriptSentence {
  return { id, index, speakerId: 'speaker_0', startSeconds, endSeconds, text };
}
