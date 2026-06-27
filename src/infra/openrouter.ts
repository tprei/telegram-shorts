import { AppConfig } from './env.js';
import { Candidate, InstagramReelCopy, InstagramReelCopySchema, OpportunityPlanResponse, OpportunityPlanResponseSchema, PlannedCandidateResponse, PlannedCandidateResponseSchema, RevisionIntent, RevisionIntentSchema, SemanticBlockKind, SemanticBlockResponseSet, SemanticBlockResponseSetSchema, TranscriptSentence, TranscriptSpanLocate, TranscriptSpanLocateSchema } from '../domain/model.js';

const BLOCK_KINDS: SemanticBlockKind[] = ['hook', 'setup', 'turn', 'explain', 'evidence', 'payoff'];
const JSON_SCHEMA_BLOCK_KIND = { type: 'string', enum: BLOCK_KINDS, description: 'Semantic block kind.' };
const JSON_SCHEMA_RISK = { type: 'string', enum: ['low', 'medium', 'high'], description: 'Risk level.' };
const JSON_SCHEMA_STEP = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: JSON_SCHEMA_BLOCK_KIND,
    label: { type: 'string', minLength: 1 },
    block_ids: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
  },
  required: ['kind', 'label', 'block_ids'],
};
const JSON_SCHEMA_CANDIDATE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    opportunity_id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    hook: { type: 'string', minLength: 1 },
    payoff: { type: 'string', minLength: 1 },
    rationale: { type: 'string', minLength: 1 },
    thesis: { type: 'string', minLength: 1 },
    risk: JSON_SCHEMA_RISK,
    block_ids: { type: 'array', minItems: 2, items: { type: 'string', minLength: 1 } },
    steps: { type: 'array', minItems: 2, items: JSON_SCHEMA_STEP },
  },
  required: ['title', 'summary', 'hook', 'payoff', 'rationale', 'thesis', 'risk', 'block_ids', 'steps'],
};
const JSON_SCHEMA_OPPORTUNITY = {
  ...JSON_SCHEMA_CANDIDATE,
  properties: {
    ...JSON_SCHEMA_CANDIDATE.properties,
    id: { type: 'string', minLength: 1 },
    viewer_promise: { type: 'string', minLength: 1 },
    tension: { type: 'string', minLength: 1 },
    why_this_short: { type: 'string', minLength: 1 },
  },
  required: [...JSON_SCHEMA_CANDIDATE.required, 'id', 'viewer_promise', 'tension', 'why_this_short'],
};
const STRUCTURED_OUTPUT_SCHEMAS = {
  semanticBlocks: {
    name: 'semantic_blocks',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        blocks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1 },
              kind: JSON_SCHEMA_BLOCK_KIND,
              summary: { type: 'string', minLength: 1 },
              start_sentence_id: { type: 'string', minLength: 1 },
              end_sentence_id: { type: 'string', minLength: 1 },
            },
            required: ['id', 'kind', 'summary', 'start_sentence_id', 'end_sentence_id'],
          },
        },
      },
      required: ['blocks'],
    },
  },
  opportunities: {
    name: 'editorial_opportunities',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        opportunities: { type: 'array', minItems: 1, maxItems: 8, items: JSON_SCHEMA_OPPORTUNITY },
      },
      required: ['opportunities'],
    },
  },
  candidates: {
    name: 'planned_candidates',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        candidates: { type: 'array', minItems: 1, maxItems: 5, items: JSON_SCHEMA_CANDIDATE },
      },
      required: ['candidates'],
    },
  },
  revision: {
    name: 'revision_intent',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string', minLength: 1 },
        actions: {
          type: 'array',
          minItems: 1,
          items: {
            anyOf: [
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'retitle' }, title: { type: 'string', minLength: 1 } }, required: ['kind', 'title'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'caption_cleanup' } }, required: ['kind'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'trim_start' }, seconds: { type: 'number', exclusiveMinimum: 0 } }, required: ['kind', 'seconds'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'trim_end' }, seconds: { type: 'number', exclusiveMinimum: 0 } }, required: ['kind', 'seconds'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'extend_start' }, seconds: { type: 'number', exclusiveMinimum: 0 } }, required: ['kind', 'seconds'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'extend_end' }, seconds: { type: 'number', exclusiveMinimum: 0 } }, required: ['kind', 'seconds'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'insert_span' }, query: { type: 'string', minLength: 1 } }, required: ['kind', 'query'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'reorder_candidate' }, rank: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['kind', 'rank'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'set_speed' }, speed: { type: 'number', exclusiveMinimum: 0, maximum: 1.5 } }, required: ['kind', 'speed'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'enable_preview_end_card' } }, required: ['kind'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'disable_preview_end_card' } }, required: ['kind'] },
            ],
          },
        },
      },
      required: ['summary', 'actions'],
    },
  },
  instagramCopy: {
    name: 'instagram_reel_copy',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        line_1: { type: 'string', minLength: 1, maxLength: 180 },
        line_2: { type: 'string', minLength: 1, maxLength: 180 },
        hashtags: { type: 'array', minItems: 3, maxItems: 6, items: { type: 'string', minLength: 2, maxLength: 40 } },
      },
      required: ['line_1', 'line_2', 'hashtags'],
    },
  },
  locateSpan: {
    name: 'transcript_span_locate',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        start_sentence_id: { type: 'string', minLength: 1 },
        end_sentence_id: { type: 'string', minLength: 1 },
        why: { type: 'string', minLength: 1 },
      },
      required: ['start_sentence_id', 'end_sentence_id', 'why'],
    },
  },
} as const;

export class OpenRouterClient {
  constructor(private readonly config: AppConfig) {}

  async buildSemanticBlocks(input: { title: string | null; sentences: TranscriptSentence[] }): Promise<SemanticBlockResponseSet> {
    const raw = await callJson<unknown>(this.config, {
      title: 'semantic-block-builder',
      system: [
        'Você segmenta um vídeo de um único apresentador em blocos semânticos curtos para planejamento de shorts.',
        `Use apenas estes tipos de bloco: ${BLOCK_KINDS.join(', ')}.`,
        'Cada bloco deve cobrir um pequeno movimento argumentativo relevante, em ordem cronológica estrita, usando IDs de frases já fornecidos.',
        'Use payoff não só para encerramento final do vídeo, mas também para síntese, consequência, conclusão local, tese que aterrissa ou por-que-isso-importa.',
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
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.semanticBlocks,
      schema: { parse: (value: unknown) => value },
    });
    return SemanticBlockResponseSetSchema.parse(normalizeSemanticBlockPayload(raw, input.sentences));
  }

  async findOpportunities(input: { title: string | null; blocks: Array<{ id: string; kind: SemanticBlockKind; summary: string; start_seconds: number; end_seconds: number; text: string }> }): Promise<OpportunityPlanResponse> {
    const raw = await callJson<unknown>(this.config, {
      title: 'editorial-opportunity-planner',
      system: [
        'Você é diretor editorial de shorts em PT-BR.',
        'Objetivo: identificar de 3 a 6 oportunidades editoriais que realmente merecem virar short.',
        'Uma oportunidade é uma ideia publicável com promessa ao espectador, tensão, desenvolvimento e um ponto de chegada; não é um capítulo solto nem um resumo do assunto.',
        'Priorize tese, contraste, mecanismo, consequência, caso absurdo que revela a tese maior, ou payoff explicativo forte.',
        'Ordem cronológica estrita; use apenas os blocos fornecidos; poucos saltos; CTA, propaganda, housekeeping e glossário não entram.',
        'Cada oportunidade já deve vir como proposta de short: título, resumo, hook, payoff, rationale, thesis, viewer_promise, tension, why_this_short, risk, block_ids e steps.',
        'Retorne apenas JSON válido com a chave opportunities.',
      ].join(' '),
      payload: {
        source_title: input.title,
        blocks: input.blocks,
      },
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.opportunities,
      schema: { parse: (value: unknown) => value },
    });
    return OpportunityPlanResponseSchema.parse(normalizeOpportunityPlanPayload(raw));
  }

  async repairOpportunityPlan(input: {
    title: string | null;
    blocks: Array<{ id: string; kind: SemanticBlockKind; summary: string; start_seconds: number; end_seconds: number; text: string }>;
    opportunities: OpportunityPlanResponse['opportunities'];
    diagnostics: Array<{ title: string; reasons: string[]; durationSeconds: number | null }>;
  }): Promise<OpportunityPlanResponse> {
    const raw = await callJson<unknown>(this.config, {
      title: 'editorial-opportunity-repair',
      system: [
        'Você está reparando um plano de shorts que falhou no crítico local.',
        'Gere uma nova lista de oportunidades publicáveis a partir dos blocos, preservando ordem cronológica estrita e usando apenas os blocos fornecidos.',
        'Cada oportunidade deve aterrissar num ponto que resolve, sintetiza, revela a consequência ou responde por-que-isso-importa. Não dependa só de blocos explicitamente rotulados como payoff.',
        'Evite duplicar blocos, evite capítulos locais sem tese, evite terminar em abertura de lista, CTA, merchandising ou continuação.',
        'Cada oportunidade já deve vir como proposta de short: título, resumo, hook, payoff, rationale, thesis, viewer_promise, tension, why_this_short, risk, block_ids e steps.',
        'Retorne apenas JSON válido com a chave opportunities.',
      ].join(' '),
      payload: {
        source_title: input.title,
        blocks: input.blocks,
        rejected_opportunities: input.opportunities,
        critic_findings: input.diagnostics,
      },
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.opportunities,
      schema: { parse: (value: unknown) => value },
    });
    return OpportunityPlanResponseSchema.parse(normalizeOpportunityPlanPayload(raw));
  }

  async planCandidates(input: { title: string | null; blocks: Array<{ id: string; kind: SemanticBlockKind; summary: string; start_seconds: number; end_seconds: number; text: string }>; opportunities: OpportunityPlanResponse['opportunities'] }): Promise<PlannedCandidateResponse> {
    const raw = await callJson<unknown>(this.config, {
      title: 'argument-arc-planner',
      system: [
        'Você é diretor editorial de shorts em PT-BR.',
        'Objetivo: transformar oportunidades editoriais em no máximo 5 candidatos de short bem compostos.',
        'Regras obrigatórias: ordem cronológica estrita; usar apenas os blocos fornecidos; poucos saltos; priorizar transformação argumentativa completa por segundo; cada candidato deve cumprir claramente a promessa ao espectador da oportunidade escolhida.',
        'Não devolva capítulo local sem tese. Prefira ideias grandes do vídeo, bons casos reveladores, ou conclusões explicativas fortes.',
        'O título deve descrever o argumento do short, não apenas o assunto ou capítulo local.',
        'Retorne apenas JSON válido com a chave candidates.',
      ].join(' '),
      payload: {
        source_title: input.title,
        blocks: input.blocks,
        opportunities: input.opportunities,
      },
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.candidates,
      schema: { parse: (value: unknown) => value },
    });
    return PlannedCandidateResponseSchema.parse(normalizeArcPlanPayload(raw, input.opportunities));
  }

  async parseRevision(input: { candidate: Candidate; message: string }): Promise<RevisionIntent> {
    const raw = await callJson<unknown>(this.config, {
      title: 'revision-intent',
      system: [
        'Você converte pedidos do diretor em ações seguras para revisão de shorts.',
        'Ações permitidas: retitle, caption_cleanup, trim_start, trim_end, extend_start, extend_end, insert_span, reorder_candidate, set_speed, enable_preview_end_card, disable_preview_end_card.',
        'Para pedidos como incluir conclusão, fechar melhor, terminar menos abrupto, use extend_end com segundos ou insert_span com uma query de conclusão/payoff já falado no vídeo.',
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
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.revision,
      schema: { parse: (value: unknown) => value },
    });
    return RevisionIntentSchema.parse(normalizeRevisionPayload(raw));
  }

  async writeInstagramReelDescription(input: { candidate: Candidate }): Promise<InstagramReelCopy> {
    const raw = await callJson<unknown>(this.config, {
      title: 'instagram-reel-copy',
      system: [
        'Você escreve legenda curta para Reel em PT-BR.',
        'Objetivo: devolver exatamente 2 linhas que resumam o short sem truncar no meio da ideia e 3 a 6 hashtags relevantes.',
        'A linha 1 deve dizer do que o short trata. A linha 2 deve dizer por que isso importa ou qual é a conclusão.',
        'Hashtags devem ser úteis e naturais; evite hashtags genéricas demais, verbos soltos, palavras quebradas ou duplicadas.',
        'Retorne apenas JSON válido com line_1, line_2 e hashtags.',
      ].join(' '),
      payload: {
        candidate: {
          title: input.candidate.title,
          summary: input.candidate.summary,
          hook: input.candidate.hook,
          payoff: input.candidate.payoff,
          rationale: input.candidate.rationale,
        },
      },
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.instagramCopy,
      schema: { parse: (value: unknown) => value },
    });
    return InstagramReelCopySchema.parse(normalizeInstagramReelCopyPayload(raw));
  }

  async locateTranscriptSpan(input: { query: string; sentences: TranscriptSentence[] }): Promise<TranscriptSpanLocate> {
    const raw = await callJson<unknown>(this.config, {
      title: 'transcript-span-locator',
      system: [
        'Você recebe uma solicitação do diretor para incluir um trecho já falado no vídeo.',
        'Escolha apenas um intervalo cronológico contínuo de frases já existentes que melhor satisfaça a solicitação.',
        'Nunca invente texto.',
        'É obrigatório preencher start_sentence_id e end_sentence_id com IDs válidos da lista recebida.',
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
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.locateSpan,
      schema: { parse: (value: unknown) => value },
    });
    const normalized = normalizeLocatePayload(raw);
    const parsed = TranscriptSpanLocateSchema.safeParse(normalized);
    if (parsed.success) {
      return parsed.data;
    }
    const fallback = fallbackLocateTranscriptSpan(input.query, input.sentences);
    if (fallback) {
      return fallback;
    }
    throw parsed.error;
  }
}

async function callJson<T>(config: AppConfig, input: { title: string; system: string; payload: unknown; responseFormat?: { name: string; schema: Record<string, unknown> }; schema: { parse(value: unknown): T } }): Promise<T> {
  const content = await requestCompletionContent(config, {
    title: input.title,
    system: input.system,
    user: JSON.stringify(input.payload),
    temperature: 0.2,
    responseFormat: input.responseFormat,
  });
  try {
    return input.schema.parse(JSON.parse(extractJson(content)));
  } catch (error) {
    const repairedContent = await repairMalformedJson(config, input.title, content, error instanceof Error ? error.message : String(error));
    return input.schema.parse(JSON.parse(extractJson(repairedContent)));
  }
}

async function requestCompletionContent(config: AppConfig, input: { title: string; system: string; user: string; temperature: number; responseFormat?: { name: string; schema: Record<string, unknown> } }): Promise<string> {
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
      temperature: input.temperature,
      response_format: input.responseFormat
        ? {
            type: 'json_schema',
            json_schema: {
              name: input.responseFormat.name,
              strict: true,
              schema: input.responseFormat.schema,
            },
          }
        : { type: 'json_object' },
      plugins: [{ id: 'response-healing' }],
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
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
  return content;
}

async function repairMalformedJson(config: AppConfig, title: string, malformedContent: string, parseError: string): Promise<string> {
  return requestCompletionContent(config, {
    title: `${title}-json-repair`,
    system: [
      'Você corrige JSON malformado produzido por outro modelo.',
      'Preserve a estrutura e os valores pretendidos o máximo possível.',
      'Não explique nada. Retorne apenas um único objeto JSON válido.',
    ].join(' '),
    user: JSON.stringify({ parse_error: parseError, malformed_json: malformedContent }),
    temperature: 0,
    responseFormat: { name: `${title.replace(/[^a-z0-9_-]+/gi, '_')}_repair`, schema: { type: 'object' } },
  });
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

function normalizeOpportunityPlanPayload(raw: unknown): unknown {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const opportunities = Array.isArray(record.opportunities)
    ? record.opportunities
    : Array.isArray(record.candidates)
      ? record.candidates
      : Array.isArray(record.shorts)
        ? record.shorts
        : Array.isArray(record.items)
          ? record.items
          : [];
  return {
    opportunities: opportunities.map((opportunity, index) => normalizeOpportunityCandidate(opportunity, index)).filter((value): value is Record<string, unknown> => Boolean(value)),
  };
}

function normalizeOpportunityCandidate(raw: unknown, index: number): Record<string, unknown> | null {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const normalizedCandidate = normalizeArcCandidate(raw) as Record<string, unknown>;
  const viewerPromise = stringValue(record.viewer_promise) ?? stringValue(record.viewerPromise) ?? stringValue(record.promise) ?? stringValue(record.thesis) ?? stringValue(record.summary) ?? 'Ideia principal do short';
  const tension = stringValue(record.tension) ?? stringValue(record.conflict) ?? stringValue(record.problem) ?? stringValue(record.hook) ?? 'Há um conflito ou transformação relevante.';
  const whyThisShort = stringValue(record.why_this_short) ?? stringValue(record.whyThisShort) ?? stringValue(record.why) ?? stringValue(record.rationale) ?? 'É uma ideia forte, completa e publicável.';
  return {
    id: stringValue(record.id) ?? `opp_${String(index + 1).padStart(3, '0')}`,
    viewer_promise: viewerPromise,
    tension,
    why_this_short: whyThisShort,
    ...normalizedCandidate,
  };
}

function normalizeArcPlanPayload(raw: unknown, opportunities: OpportunityPlanResponse['opportunities'] = []): unknown {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const candidates = Array.isArray(record.candidates)
    ? record.candidates
    : Array.isArray(record.shorts)
      ? record.shorts
      : Array.isArray(record.items)
        ? record.items
        : [];
  const normalized = candidates.map((candidate) => normalizeArcCandidate(candidate, opportunities) as { block_ids: string[] });
  return {
    candidates: normalized.filter((candidate) => candidate.block_ids.length > 1),
  };
}

function normalizeArcCandidate(raw: unknown, opportunities: OpportunityPlanResponse['opportunities'] = []): unknown {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const opportunityId = stringValue(record.opportunity_id) ?? stringValue(record.opportunityId) ?? null;
  const sourceOpportunity = opportunityId ? opportunities.find((entry) => entry.id === opportunityId) : undefined;
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
  const fallbackBlockIds = normalizedBlockIds.length > 0 ? normalizedBlockIds : (sourceOpportunity?.block_ids ?? []);
  const fallbackSteps = steps.length > 0 ? steps : (sourceOpportunity?.steps ?? deriveFallbackSteps(fallbackBlockIds));
  return {
    opportunity_id: opportunityId ?? sourceOpportunity?.id,
    title: stringValue(record.title) ?? stringValue(record.candidate_title) ?? sourceOpportunity?.title ?? 'Sem título',
    summary: stringValue(record.summary) ?? stringValue(record.candidate_summary) ?? sourceOpportunity?.summary ?? 'Resumo',
    hook: stringValue(record.hook) ?? stringValue(record.first_words) ?? sourceOpportunity?.hook ?? stringValue(record.summary) ?? 'Hook',
    payoff: stringValue(record.payoff) ?? stringValue(record.last_words) ?? sourceOpportunity?.payoff ?? stringValue(record.summary) ?? 'Payoff',
    rationale: stringValue(record.rationale) ?? stringValue(record.reason) ?? sourceOpportunity?.rationale ?? stringValue(record.summary) ?? 'Racional',
    thesis: stringValue(record.thesis) ?? sourceOpportunity?.thesis ?? stringValue(record.summary) ?? 'Tese',
    risk: riskValue(record.risk ?? sourceOpportunity?.risk),
    block_ids: fallbackBlockIds,
    steps: fallbackSteps,
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
  const rawActions = Array.isArray(record.actions) ? record.actions : Array.isArray(record.edits) ? record.edits : [];
  return {
    actions: rawActions.map(normalizeRevisionAction).filter(Boolean),
    summary: stringValue(record.summary) ?? stringValue(record.reason) ?? 'Revisão aplicada',
  };
}

function normalizeRevisionAction(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const rawKind = stringValue(record.kind) ?? stringValue(record.action) ?? stringValue(record.type) ?? '';
  const kind = rawKind.toLowerCase().replace(/[-\s]+/g, '_');
  const seconds = positiveNumber(record.seconds) ?? positiveNumber(record.duration_seconds) ?? positiveNumber(record.amount_seconds);
  if (kind === 'retitle' || kind === 'change_title' || kind === 'rename') {
    return { kind: 'retitle', title: stringValue(record.title) ?? stringValue(record.value) ?? 'Novo título' };
  }
  if (kind === 'caption_cleanup' || kind === 'cleanup_caption' || kind === 'clean_caption') {
    return { kind: 'caption_cleanup' };
  }
  if (kind === 'trim_start' || kind === 'shorten_start') {
    return { kind: 'trim_start', seconds: seconds ?? 5 };
  }
  if (kind === 'trim_end' || kind === 'shorten_end') {
    return { kind: 'trim_end', seconds: seconds ?? 5 };
  }
  if (kind === 'extend_start' || kind === 'add_start' || kind === 'include_setup') {
    return { kind: 'extend_start', seconds: seconds ?? 20 };
  }
  if (kind === 'extend_end' || kind === 'add_end' || kind === 'extend_conclusion' || kind === 'include_conclusion' || kind === 'add_conclusion' || kind === 'conclusion' || kind === 'extend_payoff' || kind === 'add_payoff' || kind === 'close_better') {
    return { kind: 'extend_end', seconds: seconds ?? 30 };
  }
  if (kind === 'insert_span' || kind === 'insert' || kind === 'include_span' || kind === 'add_span') {
    return { kind: 'insert_span', query: stringValue(record.query) ?? stringValue(record.text) ?? stringValue(record.description) ?? 'conclusão ou payoff do argumento' };
  }
  if (kind === 'reorder_candidate' || kind === 'reorder') {
    return { kind: 'reorder_candidate', rank: Math.max(1, Math.min(5, Math.round(positiveNumber(record.rank) ?? 1))) };
  }
  if (kind === 'set_speed' || kind === 'speed' || kind === 'playback_speed') {
    return { kind: 'set_speed', speed: Math.max(0.1, Math.min(1.5, positiveNumber(record.speed) ?? positiveNumber(record.value) ?? 1.15)) };
  }
  if (kind === 'enable_preview_end_card' || kind === 'add_end_card' || kind === 'enable_end_card') {
    return { kind: 'enable_preview_end_card' };
  }
  if (kind === 'disable_preview_end_card' || kind === 'remove_end_card' || kind === 'disable_end_card') {
    return { kind: 'disable_preview_end_card' };
  }
  const freeText = [rawKind, stringValue(record.query), stringValue(record.text), stringValue(record.description), stringValue(record.reason)].filter(Boolean).join(' ').toLowerCase();
  if (/conclus|fech|payoff|final/.test(freeText)) {
    return { kind: 'extend_end', seconds: seconds ?? 30 };
  }
  return null;
}

function positiveNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizeInstagramReelCopyPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') {
    return raw;
  }
  const record = raw as Record<string, unknown>;
  const hashtags = Array.isArray(record.hashtags)
    ? record.hashtags
    : typeof record.hashtags === 'string'
      ? record.hashtags.split(/\s+/)
      : [];
  return {
    line_1: stringValue(record.line_1) ?? stringValue(record.line1) ?? stringValue(record.caption) ?? 'Assista ao short.',
    line_2: stringValue(record.line_2) ?? stringValue(record.line2) ?? stringValue(record.summary) ?? 'Vale pela ideia e pela conclusão.',
    hashtags: hashtags
      .map((value) => typeof value === 'string' ? value.trim() : '')
      .filter(Boolean)
      .map((value) => value.startsWith('#') ? value : `#${value}`)
      .slice(0, 6),
  };
}

function fallbackLocateTranscriptSpan(query: string, sentences: TranscriptSentence[]): TranscriptSpanLocate | null {
  const queryTerms = tokenizeForLocate(query);
  if (queryTerms.length === 0 || sentences.length === 0) {
    return null;
  }
  const scored = sentences
    .map((sentence) => ({ sentence, score: scoreSentenceForLocate(sentence.text, queryTerms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.sentence.index - right.sentence.index);
  const best = scored[0]?.sentence;
  if (!best) {
    return null;
  }
  let startIndex = best.index;
  let endIndex = best.index;
  while (startIndex > 0) {
    const previous = sentences[startIndex - 1]!;
    const score = scoreSentenceForLocate(previous.text, queryTerms);
    if (score <= 0 || best.endSeconds - previous.startSeconds > 35) {
      break;
    }
    startIndex -= 1;
  }
  while (endIndex < sentences.length - 1) {
    const next = sentences[endIndex + 1]!;
    const score = scoreSentenceForLocate(next.text, queryTerms);
    if (score <= 0 || next.endSeconds - sentences[startIndex]!.startSeconds > 35) {
      break;
    }
    endIndex += 1;
  }
  return {
    start_sentence_id: sentences[startIndex]!.id,
    end_sentence_id: sentences[endIndex]!.id,
    why: 'Fallback localizou o trecho por similaridade lexical com a solicitação.',
  };
}

function tokenizeForLocate(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length >= 4);
}

function scoreSentenceForLocate(text: string, queryTerms: string[]): number {
  const haystack = ` ${text.normalize('NFD').replace(/[^\p{L}\p{N}\s]+/gu, ' ').toLowerCase()} `;
  return queryTerms.reduce((score, term) => score + (haystack.includes(` ${term} `) ? 1 : haystack.includes(term) ? 0.5 : 0), 0);
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
