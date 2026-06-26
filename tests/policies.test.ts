import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCandidateVersion, buildSentences, applyRevision, applyResolvedInsert } from '../src/domain/policies.js';
import type { TranscriptWord } from '../src/domain/model.js';

function words(): TranscriptWord[] {
  return [
    word('A primeira ideia fecha aqui.', 0, 14),
    word('A segunda ideia continua bem.', 15, 30),
    word('A terceira ideia fecha agora.', 31, 46),
    word('A quarta ideia traz o payoff final.', 47, 65),
  ];
}

function word(text: string, startSeconds: number, endSeconds: number): TranscriptWord {
  return {
    id: `w_${startSeconds}`,
    text,
    startSeconds,
    endSeconds,
    speakerId: 'speaker_0',
    confidence: 0.9,
  };
}

test('candidate builder rejects out-of-order ranges and keeps valid chronological candidates', () => {
  const sentences = buildSentences(words());
  const version = buildCandidateVersion('job_1', 1, null, 'initial', sentences, {
    candidates: [
      {
        title: 'Inválido',
        summary: 'Inválido',
        hook: 'Inválido',
        payoff: 'Inválido',
        rationale: 'Inválido',
        risk: 'medium',
        segments: [
          { start_sentence_id: sentences[2]!.id, end_sentence_id: sentences[3]!.id, why: 'x' },
          { start_sentence_id: sentences[0]!.id, end_sentence_id: sentences[1]!.id, why: 'y' },
        ],
      },
      {
        title: 'Válido',
        summary: 'Resumo',
        hook: 'Hook',
        payoff: 'Payoff',
        rationale: 'Racional',
        risk: 'low',
        segments: [
          { start_sentence_id: sentences[0]!.id, end_sentence_id: sentences[1]!.id, why: 'x' },
          { start_sentence_id: sentences[2]!.id, end_sentence_id: sentences[3]!.id, why: 'y' },
        ],
      },
    ],
  });
  assert.equal(version.candidates.length, 1);
  assert.equal(version.candidates[0]?.title, 'Válido');
  assert.equal(version.candidates[0]?.seamCount, 1);
});

test('revision creates a new version and invalidates previous draft readiness', () => {
  const sentences = buildSentences(words());
  const version = buildCandidateVersion('job_1', 1, null, 'initial', sentences, {
    candidates: [{
      title: 'Válido',
      summary: 'Resumo',
      hook: 'Hook',
      payoff: 'Payoff',
      rationale: 'Racional',
      risk: 'low',
      segments: [{ start_sentence_id: sentences[0]!.id, end_sentence_id: sentences[3]!.id, why: 'x' }],
    }],
  });
  version.candidates[0]!.draftReady = true;
  const revised = applyRevision(version, version.candidates[0]!.id, [{ kind: 'retitle', title: 'Novo título' }, { kind: 'trim_end', seconds: 4 }], sentences);
  assert.notEqual(revised.id, version.id);
  assert.equal(revised.number, 2);
  assert.equal(revised.candidates[0]?.title, 'Novo título');
  assert.equal(revised.candidates[0]?.draftReady, false);
  assert.ok((revised.candidates[0]?.durationSeconds ?? 0) < (version.candidates[0]?.durationSeconds ?? 0));
});

test('resolved insert keeps chronological order and produces a new seam', () => {
  const sentences = buildSentences(words());
  const version = buildCandidateVersion('job_1', 1, null, 'initial', sentences, {
    candidates: [{
      title: 'Válido',
      summary: 'Resumo',
      hook: 'Hook',
      payoff: 'Payoff',
      rationale: 'Racional',
      risk: 'low',
      segments: [
        { start_sentence_id: sentences[0]!.id, end_sentence_id: sentences[1]!.id, why: 'x' },
        { start_sentence_id: sentences[3]!.id, end_sentence_id: sentences[3]!.id, why: 'y' },
      ],
    }],
  });
  const revised = applyResolvedInsert(version, version.candidates[0]!.id, sentences[2]!.id, sentences[2]!.id, sentences);
  assert.equal(revised.candidates[0]?.segments.length, 3);
  assert.equal(revised.candidates[0]?.segments[1]?.startSentenceId, sentences[2]!.id);
});

test('speed and preview end card can be requested through revision actions', () => {
  const sentences = buildSentences(words());
  const version = buildCandidateVersion('job_1', 1, null, 'initial', sentences, {
    candidates: [{
      title: 'Válido',
      summary: 'Resumo',
      hook: 'Hook',
      payoff: 'Payoff',
      rationale: 'Racional',
      risk: 'low',
      segments: [{ start_sentence_id: sentences[0]!.id, end_sentence_id: sentences[3]!.id, why: 'x' }],
    }],
  });
  const revised = applyRevision(version, version.candidates[0]!.id, [
    { kind: 'set_speed', speed: 1.5 },
    { kind: 'enable_preview_end_card' },
  ], sentences);
  assert.equal(revised.candidates[0]?.playbackSpeed, 1.5);
  assert.equal(revised.candidates[0]?.previewEndCard, true);
  assert.ok((revised.candidates[0]?.durationSeconds ?? 0) < (version.candidates[0]?.durationSeconds ?? 0));
});
