import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizePlainText } from '../src/domain/text.js';
import { OpportunityPlanResponseSchema, PublishCopyResponseSchema } from '../src/domain/model.js';

test('sanitizePlainText strips zero-width and control runs and trims', () => {
  assert.equal(sanitizePlainText('Documento' + '\u200B'.repeat(630)), 'Documento');
  assert.equal(sanitizePlainText('T\u00EDtulo\u200C\u200D\u2060\u2061\u2062\u2063\u2064\uFEFF final'), 'Título final');
  assert.equal(sanitizePlainText('linha\u0007com\u001Fcontrole'), 'linhacomcontrole');
  assert.equal(sanitizePlainText('  espa\u00E7os    m\u00FAltiplos \n\t e quebras  '), 'espaços múltiplos e quebras');
  assert.equal(sanitizePlainText(''), '');
});

test('planner candidate schemas sanitize text before length bounds apply', () => {
  const raw = '\u200B'.repeat(630);
  const parsed = OpportunityPlanResponseSchema.parse({
    opportunities: [{
      id: 'opp_1',
      title: `Documento${raw}`,
      summary: 'Resumo',
      hook: 'Gancho',
      hook_text: `MANCHETE${raw}`,
      payoff: 'Payoff',
      rationale: 'Racional',
      thesis: 'Tese',
      viewer_promise: 'Promessa',
      tension: 'Tensão',
      why_this_short: 'Porque',
      risk: 'low',
      block_ids: ['b_001', 'b_002'],
      steps: [
        { kind: 'hook', label: 'gancho', block_ids: ['b_001'] },
        { kind: 'payoff', label: 'aterrissagem', block_ids: ['b_002'] },
      ],
    }],
  });
  assert.equal(parsed.opportunities[0]?.title, 'Documento');
  assert.equal(parsed.opportunities[0]?.title.length, 9);
  assert.equal(parsed.opportunities[0]?.hook_text, 'MANCHETE');
});

test('publish copy schema sanitizes lines and hashtags', () => {
  const parsed = PublishCopyResponseSchema.parse({
    line_1: 'Primeira linha\u200B',
    line_2: '\uFEFFSegunda   linha',
    hashtags: ['#mix\u200B', '#curiosidade', '#teste'],
  });
  assert.equal(parsed.line_1, 'Primeira linha');
  assert.equal(parsed.line_2, 'Segunda linha');
  assert.deepEqual(parsed.hashtags, ['#mix', '#curiosidade', '#teste']);
  assert.throws(() => PublishCopyResponseSchema.parse({ line_1: '\u200B'.repeat(200), line_2: 'x', hashtags: ['#a', '#b', '#c'] }), /too_small/);
});
