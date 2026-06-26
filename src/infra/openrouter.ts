import { AppConfig } from './env.js';
import { Candidate, PlannedCandidateResponse, PlannedCandidateResponseSchema, RevisionIntent, RevisionIntentSchema, SemanticBlockKind, SemanticBlockResponseSet, SemanticBlockResponseSetSchema, TranscriptSentence, TranscriptSpanLocate, TranscriptSpanLocateSchema } from '../domain/model.js';

const BLOCK_KINDS: SemanticBlockKind[] = ['hook', 'setup', 'turn', 'explain', 'evidence', 'payoff'];

export class OpenRouterClient {
  constructor(private readonly config: AppConfig) {}

  async buildSemanticBlocks(input: { title: string | null; sentences: TranscriptSentence[] }): Promise<SemanticBlockResponseSet> {
    const raw = await callJson<unknown>(this.config, {
      title: 'semantic-block-builder',
      system: [
        'Você segmenta um vídeo de um único apresentador em blocos semânticos curtos para planejamento de shorts.',
        `Use apenas estes tipos de bloco: ${BLOCK_KINDS.join(', ')}.`,
        'Cada bloco deve cobrir um pequeno movimento argumentativo relevante, em ordem cronológica estrita, usando IDs de frases já fornecidos.',
        'Ignore CTA, pedido de like, propaganda do canal e housekeeping, a menos que sejam realmente parte do argumento.',
        'Retorne apenas JSON válido com a chave blocks.',
      ].join(' '),
      payload: {
        source_title: input.title,
        sentences: input.sentences.map((sentence) => ({
          id: sentence.id,
          start_seconds: sentence.startSeconds,
          end_seconds: sentence.endSeconds,
          text: sentence.text,
        })),
      },
      schema: { parse: (value: unknown) => value },
    });
    return SemanticBlockResponseSetSchema.parse(normalizeSemanticBlockPayload(raw, input.sentences));
  }

  async planCandidates(input: { title: string | null; blocks: Array<{ id: string; kind: SemanticBlockKind; summary: string; start_seconds: number; end_seconds: number; text: string }> }): Promise<PlannedCandidateResponse> {
    const raw = await callJson<unknown>(this.config, {
      title: 'argument-arc-planner',
      system: [
        'Você é diretor editorial de shorts em PT-BR.',
        'Objetivo: gerar no máximo 5 candidatos que pareçam curtas argumentativos bem compostos, não apenas capítulos extraídos.',
        'Regras obrigatórias: ordem cronológica estrita; usar apenas os blocos fornecidos; poucos saltos; priorizar transformação argumentativa completa por segundo; preferir caminhos que incluam hook/setup, turn, explain/evidence e payoff.',
        'O título deve descrever o argumento do short, não apenas o assunto ou capítulo local.',
        'Retorne apenas JSON válido com a chave candidates.',
      ].join(' '),
      payload: {
        source_title: input.title,
        blocks: input.blocks,
      },
      schema: { parse: (value: unknown) => value },
    });
    return PlannedCandidateResponseSchema.parse(normalizeArcPlanPayload(raw));
  }

  async parseRevision(input: { candidate: Candidate; message: string }): Promise<RevisionIntent> {
    const raw = await callJson<unknown>(this.config, {
      title: 'revision-intent',
      system: [
        'Você converte pedidos do diretor em ações seguras para revisão de shorts.',
        'Ações permitidas: retitle, caption_cleanup, trim_start, trim_end, extend_start, extend_end, insert_span, reorder_candidate, set_speed, enable_preview_end_card, disable_preview_end_card.',
        'Não invente ações fora dessa lista.',
        'Se o texto for ambíguo, escolha a interpretação mais conservadora.',
        'Retorne apenas JSON válido com actions e summary.',
      ].join(' '),
      payload: {
        candidate: {
          id: input.candidate.id,
          title: input.candidate.title,
          duration_seconds: input.candidate.durationSeconds,
          segments: input.candidate.segments.map((segment) => ({
            start_seconds: segment.startSeconds,
            end_seconds: segment.endSeconds,
            text: segment.text,
          })),
        },
        message: input.message,
      },
      schema: { parse: (value: unknown) => value },
    });
    return RevisionIntentSchema.parse(normalizeRevisionPayload(raw));
  }

  async locateTranscriptSpan(input: { query: string; sentences: TranscriptSentence[] }): Promise<TranscriptSpanLocate> {
    const raw = await callJson<unknown>(this.config, {
      title: 'transcript-span-locator',
      system: [
        'Você recebe uma solicitação do diretor para incluir um trecho já falado no vídeo.',
        'Escolha apenas um intervalo cronológico contínuo de frases já existentes que melhor satisfaça a solicitação.',
        'Nunca invente texto.',
        'Retorne apenas JSON válido.',
      ].join(' '),
      payload: {
        query: input.query,
        sentences: input.sentences.map((sentence) => ({
          id: sentence.id,
          start_seconds: sentence.startSeconds,
          end_seconds: sentence.endSeconds,
          text: sentence.text,
        })),
      },
      schema: { parse: (value: unknown) => value },
    });
    return TranscriptSpanLocateSchema.parse(normalizeLocatePayload(raw));
  }
}

async function callJson<T>(config: AppConfig, input: { title: string; system: string; payload: unknown; schema: { parse(value: unknown): T } }): Promise<T> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/retirers/telegram-shorts',
      'X-Title': input.title,
    },
    body: JSON.stringify({
      model: config.OPENROUTER_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: JSON.stringify(input.payload) },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter request failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenRouter response was empty.');
  }
  return input.schema.parse(JSON.parse(extractJson(content)));
}

function normalizeSemanticBlockPayload(raw: unknown, sentences: TranscriptSentence[]): unknown {
  const bySentenceId = new Map(sentences.map((sentence) => [sentence.id, sentence]));
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const blocks = Array.isArray(record.blocks) ? record.blocks : [];
  return {
    blocks: blocks.map((block, index) => {
      const item = block && typeof block === 'object' ? block as Record<string, unknown> : {};
      const startSentenceId = stringValue(item.start_sentence_id) ?? stringValue(item.start_id) ?? stringValue(item.from_sentence_id) ?? '';
      const endSentenceId = stringValue(item.end_sentence_id) ?? stringValue(item.end_id) ?? stringValue(item.to_sentence_id) ?? startSentenceId;
      const start = bySentenceId.get(startSentenceId);
      const end = bySentenceId.get(endSentenceId);
      const fallbackSummary = start && end ? sentences.slice(start.index, end.index + 1).map((sentence) => sentence.text).join(' ') : '';
      return {
        id: stringValue(item.id) ?? `b_${String(index + 1).padStart(3, '0')}`,
        kind: normalizeBlockKind(item.kind),
        summary: stringValue(item.summary) ?? summarize(fallbackSummary, 120),
        start_sentence_id: startSentenceId,
        end_sentence_id: endSentenceId,
      };
    }).filter((block) => block.start_sentence_id.length > 0 && block.end_sentence_id.length > 0),
  };
}

function normalizeArcPlanPayload(raw: unknown): unknown {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const candidates = Array.isArray(record.candidates)
    ? record.candidates
    : Array.isArray(record.shorts)
      ? record.shorts
      : Array.isArray(record.items)
        ? record.items
        : [];
  const normalized = candidates.map((candidate) => normalizeArcCandidate(candidate) as { block_ids: string[] });
  return {
    candidates: normalized.filter((candidate) => candidate.block_ids.length > 1),
  };
}

function normalizeArcCandidate(raw: unknown): unknown {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const rawBlockIds = Array.isArray(record.block_ids)
    ? record.block_ids
    : Array.isArray(record.blocks)
      ? record.blocks
      : Array.isArray(record.path)
        ? record.path
        : [];
  const normalizedBlockIds = rawBlockIds.map((value) => typeof value === 'string' ? value.trim() : '').filter(Boolean);
  const steps = Array.isArray(record.steps)
    ? record.steps.map((step) => normalizeArcStep(step)).filter((step) => step.block_ids.length > 0)
    : [];
  return {
    title: stringValue(record.title) ?? stringValue(record.candidate_title) ?? 'Sem título',
    summary: stringValue(record.summary) ?? stringValue(record.candidate_summary) ?? 'Resumo',
    hook: stringValue(record.hook) ?? stringValue(record.first_words) ?? stringValue(record.summary) ?? 'Hook',
    payoff: stringValue(record.payoff) ?? stringValue(record.last_words) ?? stringValue(record.summary) ?? 'Payoff',
    rationale: stringValue(record.rationale) ?? stringValue(record.reason) ?? stringValue(record.summary) ?? 'Racional',
    thesis: stringValue(record.thesis) ?? stringValue(record.summary) ?? 'Tese',
    risk: riskValue(record.risk),
    block_ids: normalizedBlockIds,
    steps: steps.length > 0 ? steps : deriveFallbackSteps(normalizedBlockIds),
  };
}

function normalizeArcStep(raw: unknown): { kind: SemanticBlockKind; label: string; block_ids: string[] } {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const rawIds = Array.isArray(record.block_ids) ? record.block_ids : Array.isArray(record.blocks) ? record.blocks : [];
  return {
    kind: normalizeBlockKind(record.kind),
    label: stringValue(record.label) ?? stringValue(record.summary) ?? 'Bloco',
    block_ids: rawIds.map((value) => typeof value === 'string' ? value.trim() : '').filter(Boolean),
  };
}

function deriveFallbackSteps(blockIds: string[]): Array<{ kind: SemanticBlockKind; label: string; block_ids: string[] }> {
  if (blockIds.length === 0) {
    return [];
  }
  if (blockIds.length === 2) {
    return [
      { kind: 'hook', label: 'Abertura', block_ids: [blockIds[0]!] },
      { kind: 'payoff', label: 'Conclusão', block_ids: [blockIds[1]!] },
    ];
  }
  return [
    { kind: 'hook', label: 'Abertura', block_ids: [blockIds[0]!] },
    { kind: 'turn', label: 'Virada', block_ids: [blockIds[Math.floor(blockIds.length / 2)]!] },
    { kind: 'payoff', label: 'Fechamento', block_ids: [blockIds[blockIds.length - 1]!] },
  ];
}

function normalizeRevisionPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') {
    return raw;
  }
  const record = raw as Record<string, unknown>;
  return {
    actions: Array.isArray(record.actions) ? record.actions : Array.isArray(record.edits) ? record.edits : [],
    summary: stringValue(record.summary) ?? stringValue(record.reason) ?? 'Revisão aplicada',
  };
}

function normalizeLocatePayload(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') {
    return raw;
  }
  const record = raw as Record<string, unknown>;
  return {
    start_sentence_id: stringValue(record.start_sentence_id) ?? stringValue(record.startSentenceId) ?? stringValue(record.from_sentence_id) ?? '',
    end_sentence_id: stringValue(record.end_sentence_id) ?? stringValue(record.endSentenceId) ?? stringValue(record.to_sentence_id) ?? stringValue(record.start_sentence_id) ?? stringValue(record.startSentenceId) ?? '',
    why: stringValue(record.why) ?? stringValue(record.reason) ?? 'Trecho localizado',
  };
}

function normalizeBlockKind(value: unknown): SemanticBlockKind {
  if (value === 'hook' || value === 'setup' || value === 'turn' || value === 'explain' || value === 'evidence' || value === 'payoff') {
    return value;
  }
  return 'setup';
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function riskValue(value: unknown): 'low' | 'medium' | 'high' {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return 'medium';
}

function summarize(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function extractJson(content: string): string {
  const trimmed = content.trim();
  const start = trimmed.indexOf('{');
  if (start === -1) {
    throw new Error('OpenRouter returned no JSON object.');
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, index + 1);
      }
    }
  }
  throw new Error('OpenRouter returned incomplete JSON.');
}
