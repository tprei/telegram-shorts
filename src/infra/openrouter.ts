import { setTimeout as sleep } from 'node:timers/promises';

import type { AppConfig, ReasoningEffort } from './env.js';
import { isTransientNetworkError } from './instagram-publisher.js';
import { HookSuggestionsResponse, HookSuggestionsResponseSchema, HostSpeakerChoice, HostSpeakerChoiceResponse, HostSpeakerChoiceResponseSchema, OpportunityPlanResponse, OpportunityPlanResponseSchema, PlannedCandidateResponse, PlannedCandidateResponseSchema, PublishCopyResponse, PublishCopyResponseSchema, RevisionIntent, RevisionIntentSchema, SemanticBlockKind, SemanticBlockResponseSet, SemanticBlockResponseSetSchema, TranscriptSentence, TranscriptSpanLocate, TranscriptSpanLocateSchema } from '../domain/model.js';
import { logError } from './util.js';
import { MAX_SHORT_SPANS, SHORT_DURATION } from '../domain/semantic.js';

type ImageInput = { mimeType: 'image/jpeg' | 'image/png'; base64: string };
type ResponseFormat = { name: string; schema: Record<string, unknown> };
type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type ReasoningOptions = { effort: ReasoningEffort; maxTokens: number };
type PlannerBlock = { id: string; kind: SemanticBlockKind; summary: string; start_seconds: number; on_screen_seconds: number; continues_previous: boolean; text: string };

const EDITORIAL_TEMPERATURE = 0.2;
const PROVIDER_ERROR_ATTEMPTS = 2;
const NETWORK_RETRY_DELAYS_MS = [2000, 5000];
const HOOK_STYLE_RULE = 'É uma afirmação direta, não um rótulo de assunto nem pergunta genérica: nomeie quem fez (Flávio, Lula, Bolsonaro, o governo) ou fale com o espectador (você, seu, sua) e traga um número concreto ou um contraste. Promete exatamente o que o short entrega.';
const HOOK_EXAMPLES = 'Exemplos do tom certo: "Quem aposta na sexta não compra no sábado"; "Flávio não disse quanto o mínimo vai valer em 2027"; "O mínimo é assinado por decreto"; "Seu voto vale por 2 netos". Exemplos do tom errado: "Agro vs. MEI: quem sobrevive ao corte?"; "Pronampe: reforço de R$ 750 mi dura 2 meses".';
const HOOK_TEXT_RULE = `hook_text: manchete da faixa no topo (ideal até 50 caracteres, máx. 70), em PT-BR. ${HOOK_STYLE_RULE} ${HOOK_EXAMPLES}`;
const SHORT_BRIEF = 'Um bom short deste canal é uma história curta e completa sobre uma ideia só, que faz o espectador pensar. Quem assiste sai com algo que consegue repetir para outra pessoa: um número que muda a conversa, um mecanismo de causa e consequência, uma contradição exposta ou uma pergunta difícil de responder. Os shorts que mais circulam mostram o efeito no bolso ou nos direitos de quem assiste (salário, aposentadoria, remédio, emprego, imposto), de preferência comparando o que cada lado fez ou promete, com números; ou expõem uma contradição de um político com as próprias palavras ou números dele. Táticas de campanha, aritmética eleitoral, bastidor e crédito para nicho de empresas rendem menos: só entram se a consequência para o espectador estiver no próprio short.';
const STORY_RULE = 'Estrutura obrigatória: (1) gancho nos primeiros 3 segundos com a tensão (afirmação surpreendente, número, contradição ou pergunta), sem aquecimento e sem depender de contexto anterior; (2) o raciocínio: o passo de mecanismo, evidência ou comparação que faz a ideia fazer sentido; (3) aterrissagem: a conclusão do próprio autor, que cumpre a promessa do gancho. Deixe o autor terminar o raciocínio: o erro mais comum é cortar antes da conclusão dele. Se o bloco seguinte ainda fecha o argumento (consequência, número final, comparação final), ele entra. A pergunta final do autor ao público ("o que você acha?") pode fechar o short quando vem logo depois da conclusão. Termine na frase mais forte; nunca em transição, lista aberta, "e aí" ou chamada para outro assunto.';
const CONCISION_RULE = `Concisão: cada bloco precisa merecer o lugar. Pule aquecimento, repetição, digressão, apartes, autorreferência ("como eu falei", "vou mostrar"), leitura longa de texto na tela e pedidos de like, inscrição, membros ou link. Prefira pular um bloco fraco a mantê-lo, desde que o corte continue fluido: nenhum pronome ou referência ("isso", "ele", "esse número") pode ficar sem o antecedente dentro do short. No máximo ${MAX_SHORT_SPANS} trechos contínuos; o ideal é 1 ou 2: prefira deixar um trecho correr a montar pedaços. Blocos com continues_previous true emendam no anterior sem corte; cada bloco escolhido com continues_previous false (ou cujo anterior não foi escolhido) abre um trecho novo.`;
const STANDALONE_RULE = 'O short precisa se sustentar sozinho para quem nunca viu o canal: quem é quem e do que se fala tem que estar no próprio short. Não corte qualificações que mudam o sentido (negações, ressalvas, condições, a base de um número) e não monte trechos que façam o autor parecer dizer o que não disse; se houver esse risco, marque risk high.';
const DIVERSITY_RULE = 'Cada proposta traz uma ideia diferente e não repete blocos de outra proposta. Ordene da mais compartilhável para a menos.';

function durationRule(speed: number): string {
  return `O vídeo final roda a ${speed}x com as pausas encurtadas; on_screen_seconds de cada bloco já é o tempo que ele ocupa na tela. Some on_screen_seconds dos blocos escolhidos: ideal de ${SHORT_DURATION.idealMinSeconds} a ${SHORT_DURATION.idealMaxSeconds} s; até ${SHORT_DURATION.stretchMaxSeconds} s só quando o raciocínio realmente exige; nunca menos de ${SHORT_DURATION.minSeconds} nem mais de ${SHORT_DURATION.maxSeconds} s. Como a fala é acelerada, cabe mais argumento por segundo: use o espaço para o raciocínio completo e para a conclusão do autor, nunca para aquecimento.`;
}
const JSON_REPAIR_SYSTEM = [
  'Você corrige JSON malformado produzido por outro modelo.',
  'Preserve a estrutura e os valores pretendidos o máximo possível.',
  'Não explique nada. Retorne apenas um único objeto JSON válido.',
].join(' ');

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
    hook_text: { type: 'string', minLength: 1, maxLength: 90 },
    payoff: { type: 'string', minLength: 1 },
    rationale: { type: 'string', minLength: 1 },
    thesis: { type: 'string', minLength: 1 },
    risk: JSON_SCHEMA_RISK,
    block_ids: { type: 'array', minItems: 2, items: { type: 'string', minLength: 1 } },
    steps: { type: 'array', minItems: 2, items: JSON_SCHEMA_STEP },
  },
  required: ['title', 'summary', 'hook', 'hook_text', 'payoff', 'rationale', 'thesis', 'risk', 'block_ids', 'steps'],
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
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'set_hook' }, text: { type: 'string', minLength: 1, maxLength: 90 } }, required: ['kind', 'text'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'trim_start' }, seconds: { type: 'number', exclusiveMinimum: 0 } }, required: ['kind', 'seconds'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'trim_end' }, seconds: { type: 'number', exclusiveMinimum: 0 } }, required: ['kind', 'seconds'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'extend_start' }, seconds: { type: 'number', exclusiveMinimum: 0 } }, required: ['kind', 'seconds'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'extend_end' }, seconds: { type: 'number', exclusiveMinimum: 0 } }, required: ['kind', 'seconds'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'insert_span' }, query: { type: 'string', minLength: 1 } }, required: ['kind', 'query'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'remove_span' }, query: { type: 'string', minLength: 1 } }, required: ['kind', 'query'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'set_speed' }, speed: { type: 'number', minimum: 1, maximum: 1.5 } }, required: ['kind', 'speed'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'enable_end_card' } }, required: ['kind'] },
              { type: 'object', additionalProperties: false, properties: { kind: { const: 'disable_end_card' } }, required: ['kind'] },
            ],
          },
        },
      },
      required: ['summary', 'actions'],
    },
  },
  publishCopy: {
    name: 'publish_copy',
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
  hookSuggestions: {
    name: 'hook_suggestions',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        options: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 90 } },
      },
      required: ['options'],
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
  hostSpeaker: {
    name: 'host_speaker_choice',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        speaker_id: { type: 'string', minLength: 1 },
        reason: { type: 'string', minLength: 1 },
      },
      required: ['speaker_id', 'reason'],
    },
  },
} as const;

export class OpenRouterClient {
  constructor(private readonly config: AppConfig) {}

  private get reasoning(): ReasoningOptions {
    return { effort: this.config.OPENROUTER_REASONING_EFFORT, maxTokens: this.config.OPENROUTER_MAX_TOKENS };
  }

  async buildSemanticBlocks(input: { title: string | null; sentences: TranscriptSentence[] }): Promise<SemanticBlockResponseSet> {
    return requestStructuredJson<SemanticBlockResponseSet>(this.config, {
      title: 'semantic-block-builder',
      system: [
        'Você segmenta um vídeo de um único apresentador em blocos semânticos curtos para planejamento de shorts.',
        `Use apenas estes tipos de bloco: ${BLOCK_KINDS.join(', ')}.`,
        'Cada bloco deve cobrir um pequeno movimento argumentativo relevante, em ordem cronológica estrita, usando IDs de frases já fornecidos.',
        'Use payoff não só para encerramento final do vídeo, mas também para síntese, consequência, conclusão local, tese que aterrissa ou por-que-isso-importa.',
        'Ignore CTA, pedido de like, propaganda do canal e housekeeping, a menos que sejam realmente parte do argumento.',
        'Separe em blocos próprios digressões, repetições, apartes, leitura longa de texto e transições, para que o editor consiga pulá-los sem quebrar o raciocínio.',
        'Retorne apenas JSON válido com a chave blocks.',
      ].join(' '),
      userText: JSON.stringify({
        source_title: input.title,
        sentences: input.sentences.map((sentence) => ({
          id: sentence.id,
          start_seconds: sentence.startSeconds,
          end_seconds: sentence.endSeconds,
          text: sentence.text,
        })),
      }),
      reasoning: this.reasoning,
      temperature: EDITORIAL_TEMPERATURE,
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.semanticBlocks,
      parse: (value) => SemanticBlockResponseSetSchema.parse(normalizeSemanticBlockPayload(value, input.sentences)),
    });
  }

  async findOpportunities(input: { title: string | null; blocks: PlannerBlock[]; speed: number }): Promise<OpportunityPlanResponse> {
    return requestStructuredJson<OpportunityPlanResponse>(this.config, {
      title: 'editorial-opportunity-planner',
      system: [
        'Você é diretor editorial de shorts em PT-BR.',
        SHORT_BRIEF,
        'Objetivo: encontrar de 3 a 6 oportunidades que realmente merecem virar short. Uma oportunidade é uma ideia publicável com promessa ao espectador, tensão, raciocínio e ponto de chegada; não é um capítulo solto nem um resumo do assunto.',
        'Priorize, nesta ordem: efeito concreto no bolso ou nos direitos do espectador; comparação entre o que cada lado fez ou promete; contradição entre discurso e números do próprio político; mecanismo que explica um efeito; caso concreto que revela a tese maior.',
        STORY_RULE,
        CONCISION_RULE,
        STANDALONE_RULE,
        DIVERSITY_RULE,
        'Ordem cronológica estrita dentro de cada proposta; use apenas os blocos fornecidos.',
        'Cada oportunidade já deve vir como proposta de short: título, resumo, hook, hook_text, payoff, rationale, thesis, viewer_promise, tension, why_this_short, risk, block_ids e steps.',
        HOOK_TEXT_RULE,
        durationRule(input.speed),
        'Retorne apenas JSON válido com a chave opportunities.',
      ].join(' '),
      userText: JSON.stringify({
        source_title: input.title,
        playback_speed: input.speed,
        blocks: input.blocks,
      }),
      reasoning: this.reasoning,
      temperature: EDITORIAL_TEMPERATURE,
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.opportunities,
      parse: (value) => OpportunityPlanResponseSchema.parse(normalizeOpportunityPlanPayload(value)),
    });
  }

  async repairOpportunityPlan(input: {
    title: string | null;
    blocks: PlannerBlock[];
    opportunities: OpportunityPlanResponse['opportunities'];
    diagnostics: Array<{ title: string; reasons: string[]; durationSeconds: number | null }>;
    speed: number;
  }): Promise<OpportunityPlanResponse> {
    return requestStructuredJson<OpportunityPlanResponse>(this.config, {
      title: 'editorial-opportunity-repair',
      system: [
        'Você está reparando um plano de shorts que falhou no crítico local.',
        'Gere uma nova lista de oportunidades publicáveis a partir dos blocos, preservando ordem cronológica estrita e usando apenas os blocos fornecidos.',
        'Cada oportunidade deve aterrissar num ponto que resolve, sintetiza, revela a consequência ou responde por-que-isso-importa. Não dependa só de blocos explicitamente rotulados como payoff.',
        SHORT_BRIEF,
        STORY_RULE,
        CONCISION_RULE,
        STANDALONE_RULE,
        DIVERSITY_RULE,
        'Cada oportunidade já deve vir como proposta de short: título, resumo, hook, hook_text, payoff, rationale, thesis, viewer_promise, tension, why_this_short, risk, block_ids e steps.',
        HOOK_TEXT_RULE,
        durationRule(input.speed),
        'Retorne apenas JSON válido com a chave opportunities.',
      ].join(' '),
      userText: JSON.stringify({
        source_title: input.title,
        playback_speed: input.speed,
        blocks: input.blocks,
        rejected_opportunities: input.opportunities,
        critic_findings: input.diagnostics,
      }),
      reasoning: this.reasoning,
      temperature: EDITORIAL_TEMPERATURE,
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.opportunities,
      parse: (value) => OpportunityPlanResponseSchema.parse(normalizeOpportunityPlanPayload(value)),
    });
  }

  async planCandidates(input: { title: string | null; blocks: PlannerBlock[]; opportunities: OpportunityPlanResponse['opportunities']; speed: number }): Promise<PlannedCandidateResponse> {
    return requestStructuredJson<PlannedCandidateResponse>(this.config, {
      title: 'argument-arc-planner',
      system: [
        'Você é diretor editorial de shorts em PT-BR.',
        SHORT_BRIEF,
        'Objetivo: transformar as oportunidades em no máximo 5 shorts finais, prontos para publicar. Para cada um, escolha os blocos que entregam a promessa com o raciocínio completo e a conclusão do autor; corte só aquecimento, digressão e repetição.',
        STORY_RULE,
        CONCISION_RULE,
        STANDALONE_RULE,
        DIVERSITY_RULE,
        'Ordem cronológica estrita; use apenas os blocos fornecidos.',
        'O título é uma manchete com sujeito e verbo que diz o argumento, no tom de "Lula aprovou a regra da sua aposentadoria até 2030; Flávio só promete"; não é só o assunto.',
        HOOK_TEXT_RULE,
        durationRule(input.speed),
        'Retorne apenas JSON válido com a chave candidates.',
      ].join(' '),
      userText: JSON.stringify({
        source_title: input.title,
        playback_speed: input.speed,
        blocks: input.blocks,
        opportunities: input.opportunities,
      }),
      reasoning: this.reasoning,
      temperature: EDITORIAL_TEMPERATURE,
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.candidates,
      parse: (value) => PlannedCandidateResponseSchema.parse(normalizeArcPlanPayload(value, input.opportunities)),
    });
  }

  async parseRevision(input: {
    title: string;
    hookText: string;
    durationSeconds: number;
    segments: Array<{ start_seconds: number; end_seconds: number; text: string }>;
    message: string;
  }): Promise<RevisionIntent> {
    return requestStructuredJson<RevisionIntent>(this.config, {
      title: 'revision-intent',
      system: [
        'Você converte pedidos do diretor em ações seguras para revisão de shorts.',
        'Ações permitidas: retitle (title), set_hook (text, até 90 caracteres), trim_start (seconds), trim_end (seconds), extend_start (seconds), extend_end (seconds), insert_span (query), remove_span (query), set_speed (speed entre 1 e 1.5), enable_end_card, disable_end_card.',
        'Para pedidos como incluir conclusão, fechar melhor, terminar menos abrupto, use extend_end com segundos ou insert_span com uma query de conclusão/payoff já falado no vídeo.',
        'Para remover uma fala ou trecho já falado, use remove_span com uma query que identifique esse trecho.',
        'Para trocar a manchete do topo, use set_hook com o novo texto.',
        'Não invente ações fora dessa lista.',
        'Se o texto for ambíguo, escolha a interpretação mais conservadora.',
        'Retorne apenas JSON válido com actions e summary.',
      ].join(' '),
      userText: JSON.stringify({
        title: input.title,
        hook_text: input.hookText,
        duration_seconds: input.durationSeconds,
        segments: input.segments,
        message: input.message,
      }),
      reasoning: this.reasoning,
      temperature: EDITORIAL_TEMPERATURE,
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.revision,
      parse: (value) => RevisionIntentSchema.parse(normalizeRevisionPayload(value)),
    });
  }

  async suggestHooks(input: { title: string; summary: string; transcriptText: string; current: string }): Promise<string[]> {
    const response = await requestStructuredJson<HookSuggestionsResponse>(this.config, {
      title: 'hook-suggestions',
      system: [
        'Você escreve manchetes curtas para a faixa no topo de shorts em PT-BR.',
        'Devolva exatamente 3 opções distintas entre si.',
        `Cada opção deve ter idealmente até 50 caracteres (máximo 70). ${HOOK_STYLE_RULE} ${HOOK_EXAMPLES}`,
        'Não use as palavras vídeo, short, reel, corte, assista ou veja, nem frases que descrevam a edição.',
        'A manchete atual vem apenas como referência; não repita ela.',
        'Retorne apenas JSON válido com a chave options.',
      ].join(' '),
      userText: JSON.stringify({
        title: input.title,
        summary: input.summary,
        transcript_text: input.transcriptText,
        current_hook: input.current,
      }),
      reasoning: this.reasoning,
      temperature: EDITORIAL_TEMPERATURE,
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.hookSuggestions,
      parse: (value) => HookSuggestionsResponseSchema.parse(value),
    });
    return response.options;
  }

  async writePublishCopy(input: { title: string; summary: string; hook: string; payoff: string; rationale: string; quotes: string[] }): Promise<PublishCopyResponse> {
    return requestStructuredJson<PublishCopyResponse>(this.config, {
      title: 'publish-copy',
      system: [
        'Você escreve legenda curta para Reel em PT-BR com cara de fala nativa do próprio criador do vídeo.',
        'Objetivo: devolver exatamente 2 linhas fortes e 3 a 6 hashtags altamente compartilháveis.',
        'Escreva como tese, provocação ou conclusão direta — não como descrição neutra do conteúdo.',
        'Nunca deixe explícito que isso é um vídeo, short, reel, corte ou conteúdo editado.',
        'Evite frases como: esse vídeo, neste vídeo, aqui eu mostro, assista, veja, no corte, no short, no reel.',
        'A linha 1 deve abrir com a ideia mais forte, polêmica, útil ou surpreendente.',
        'A linha 2 deve aprofundar a consequência, o conflito, a crítica ou o payoff da tese.',
        'Hashtags devem ser específicas do tema, compartilháveis, orientadas a alcance e descoberta, com potencial de conversa e views.',
        'Priorize hashtags em português do Brasil. Só use inglês quando for nome próprio, sigla conhecida ou termo inevitável do assunto.',
        'Prefira hashtags de assunto, identidade, conflito, debate, tendência e busca. Evite hashtags genéricas, frias ou autoexplicativas como #reels, #instagramreels, #viral, #fyp e equivalentes.',
        'Evite palavras quebradas, duplicadas, vagas, burocráticas ou genéricas em inglês como #mindset, #business, #success e similares.',
        'Retorne apenas JSON válido com line_1, line_2 e hashtags.',
      ].join(' '),
      userText: JSON.stringify({
        title: input.title,
        summary: input.summary,
        hook: input.hook,
        payoff: input.payoff,
        rationale: input.rationale,
        source_quotes: input.quotes.slice(0, 4),
      }),
      reasoning: this.reasoning,
      temperature: EDITORIAL_TEMPERATURE,
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.publishCopy,
      parse: (value) => PublishCopyResponseSchema.parse(normalizePublishCopyPayload(value, input)),
    });
  }

  async locateTranscriptSpan(input: { query: string; sentences: TranscriptSentence[] }): Promise<TranscriptSpanLocate> {
    return requestStructuredJson<TranscriptSpanLocate>(this.config, {
      title: 'transcript-span-locator',
      system: [
        'Você recebe uma solicitação do diretor para incluir um trecho já falado no vídeo.',
        'Escolha apenas um intervalo cronológico contínuo de frases já existentes que melhor satisfaça a solicitação.',
        'Nunca invente texto.',
        'É obrigatório preencher start_sentence_id e end_sentence_id com IDs válidos da lista recebida.',
        'Retorne apenas JSON válido.',
      ].join(' '),
      userText: JSON.stringify({
        query: input.query,
        sentences: input.sentences.map((sentence) => ({
          id: sentence.id,
          start_seconds: sentence.startSeconds,
          end_seconds: sentence.endSeconds,
          text: sentence.text,
        })),
      }),
      reasoning: this.reasoning,
      temperature: EDITORIAL_TEMPERATURE,
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.locateSpan,
      parse: (value) => parseLocatedSpan(value, input.query, input.sentences),
    });
  }

  async identifyHostSpeaker(input: {
    creatorName: string;
    hostDescription: string | null;
    videoTitle: string | null;
    speakers: Array<{ speakerId: string; totalSeconds: number; samples: string[] }>;
  }): Promise<HostSpeakerChoice> {
    const response = await requestStructuredJson<HostSpeakerChoiceResponse>(this.config, {
      title: 'host-speaker-identifier',
      system: [
        'Você identifica o apresentador titular do canal em um vídeo do YouTube com vários falantes.',
        'Um dos falantes é o apresentador do canal; os outros são convidados, entrevistadores ou trechos de vídeos de terceiros que o apresentador está reagindo ou citando.',
        'Identifique o apresentador pelo que ele diz: fala em primeira pessoa, conversa com "o chat" ou com a audiência, comenta os assuntos, reage aos vídeos alheios e apresenta ou introduz os trechos.',
        'O tempo de fala sozinho não decide: o trecho reagido pode ser o mais longo do vídeo.',
        'host_description, quando não for nulo, descreve o apresentador segundo o próprio criador do canal.',
        'Escolha apenas um speaker_id da lista recebida e explique a escolha em reason.',
        'Retorne apenas JSON válido com speaker_id e reason.',
      ].join(' '),
      userText: JSON.stringify({
        creator_name: input.creatorName,
        host_description: input.hostDescription,
        video_title: input.videoTitle,
        speakers: input.speakers.map((speaker) => ({
          speaker_id: speaker.speakerId,
          total_seconds: speaker.totalSeconds,
          samples: speaker.samples,
        })),
      }),
      reasoning: this.reasoning,
      temperature: EDITORIAL_TEMPERATURE,
      responseFormat: STRUCTURED_OUTPUT_SCHEMAS.hostSpeaker,
      parse: (value) => parseHostSpeakerChoice(value, input.speakers),
    });
    return { speakerId: response.speaker_id, reason: response.reason };
  }
}

export async function requestStructuredJson<T>(config: AppConfig, input: {
  title: string;
  system: string;
  userText: string;
  images?: ImageInput[];
  model?: string;
  reasoning?: ReasoningOptions;
  temperature: number;
  responseFormat: ResponseFormat;
  parse: (value: unknown) => T;
  signal?: AbortSignal;
}): Promise<T> {
  const model = input.model ?? config.OPENROUTER_MODEL;
  const content = await requestCompletionContent(config, {
    title: input.title,
    model,
    reasoning: input.reasoning,
    system: input.system,
    user: buildUserContent(input.userText, input.images),
    temperature: input.temperature,
    responseFormat: input.responseFormat,
    signal: input.signal,
  });
  try {
    return input.parse(JSON.parse(extractJson(content)));
  } catch (error) {
    const repairedContent = await requestCompletionContent(config, {
      title: `${input.title}-json-repair`,
      model,
      system: JSON_REPAIR_SYSTEM,
      user: JSON.stringify({ parse_error: error instanceof Error ? error.message : String(error), malformed_json: content }),
      temperature: 0,
      responseFormat: input.responseFormat,
      signal: input.signal,
    });
    return input.parse(JSON.parse(extractJson(repairedContent)));
  }
}

function buildUserContent(userText: string, images: ImageInput[] | undefined): string | ChatPart[] {
  if (!images || images.length === 0) {
    return userText;
  }
  return [
    { type: 'text', text: userText },
    ...images.map((image): ChatPart => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } })),
  ];
}

async function requestCompletionContent(config: AppConfig, input: {
  title: string;
  model: string;
  reasoning?: ReasoningOptions;
  system: string;
  user: string | ChatPart[];
  temperature: number;
  responseFormat: ResponseFormat;
  signal?: AbortSignal;
}): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await postCompletion(config, input);
    if (!response.ok) {
      throw new Error(`OpenRouter request failed: ${response.status} ${await response.text()}`);
    }
    const payload = await response.json() as { provider?: string; choices?: Array<{ finish_reason?: string; message?: { content?: string } }>; usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } };
    const choice = payload.choices?.[0];
    const content = choice?.message?.content;
    if (content) {
      return content;
    }
    const finishReason = choice?.finish_reason ?? 'missing';
    const message = `OpenRouter response was empty (${input.title}, provider ${payload.provider ?? 'unknown'}, finish_reason ${finishReason}, completion tokens ${payload.usage?.completion_tokens ?? 'n/a'}, reasoning tokens ${payload.usage?.completion_tokens_details?.reasoning_tokens ?? 'n/a'}).`;
    if (finishReason === 'error' && attempt < PROVIDER_ERROR_ATTEMPTS) {
      logError('OpenRouter provider failed mid-response; retrying', new Error(message), { title: input.title, model: input.model, attempt });
      continue;
    }
    throw new Error(message);
  }
}

function isAbortOrTimeout(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'TimeoutError' || error.name === 'AbortError';
  }
  return error instanceof Error && error.name === 'AbortError';
}

async function postCompletion(config: AppConfig, input: {
  title: string;
  model: string;
  reasoning?: ReasoningOptions;
  system: string;
  user: string | ChatPart[];
  temperature: number;
  responseFormat: ResponseFormat;
  signal?: AbortSignal;
}): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://127.0.0.1',
          'X-Title': input.title,
        },
        signal: input.signal ?? AbortSignal.timeout(20 * 60_000),
        body: JSON.stringify({
          model: input.model,
          temperature: input.temperature,
          ...(input.reasoning ? { reasoning: { effort: input.reasoning.effort }, max_tokens: input.reasoning.maxTokens } : {}),
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: input.responseFormat.name,
              strict: true,
              schema: input.responseFormat.schema,
            },
          },
          provider: { require_parameters: true },
          plugins: [{ id: 'response-healing' }],
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
        }),
      });
    } catch (error) {
      if (isAbortOrTimeout(error)) {
        logError('OpenRouter request aborted', error, { title: input.title, model: input.model });
        throw error;
      }
      const delay = NETWORK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientNetworkError(error)) {
        logError('OpenRouter request failed', error, { title: input.title, model: input.model });
        throw error;
      }
      logError(`OpenRouter request failed; retrying in ${delay / 1000}s`, error, { title: input.title, model: input.model, attempt: attempt + 1 });
      await sleep(delay, undefined, { signal: input.signal });
    }
  }
}

function parseLocatedSpan(raw: unknown, query: string, sentences: TranscriptSentence[]): TranscriptSpanLocate {
  const parsed = TranscriptSpanLocateSchema.safeParse(normalizeLocatePayload(raw));
  if (parsed.success) {
    return parsed.data;
  }
  const fallback = fallbackLocateTranscriptSpan(query, sentences);
  if (fallback) {
    return fallback;
  }
  throw parsed.error;
}

function parseHostSpeakerChoice(raw: unknown, speakers: Array<{ speakerId: string }>): HostSpeakerChoiceResponse {
  return HostSpeakerChoiceResponseSchema
    .refine(
      (choice) => speakers.some((speaker) => speaker.speakerId === choice.speaker_id),
      { message: 'speaker_id precisa ser um dos falantes recebidos' },
    )
    .parse(raw);
}

function normalizeSemanticBlockPayload(raw: unknown, sentences: TranscriptSentence[]): unknown {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const blocks = Array.isArray(record.blocks) ? record.blocks : [];
  return {
    blocks: blocks.map((block, index) => {
      const item = block && typeof block === 'object' ? block as Record<string, unknown> : {};
      const startSentenceId = stringValue(item.start_sentence_id) ?? stringValue(item.start_id) ?? stringValue(item.from_sentence_id) ?? '';
      const endSentenceId = stringValue(item.end_sentence_id) ?? stringValue(item.end_id) ?? stringValue(item.to_sentence_id) ?? startSentenceId;
      const start = sentences.find((sentence) => sentence.id === startSentenceId);
      const end = sentences.find((sentence) => sentence.id === endSentenceId);
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
    opportunities: opportunities
      .map((opportunity, index) => normalizeOpportunityCandidate(opportunity, index))
      .filter((opportunity) => opportunity.block_ids.length > 1),
  };
}

function normalizeOpportunityCandidate(raw: unknown, index: number): Record<string, unknown> & { block_ids: string[] } {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const normalizedCandidate = normalizeArcCandidate(raw) as Record<string, unknown> & { block_ids: string[] };
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
  const title = stringValue(record.title) ?? stringValue(record.candidate_title) ?? sourceOpportunity?.title ?? 'Sem título';
  return {
    opportunity_id: opportunityId ?? sourceOpportunity?.id,
    title,
    summary: stringValue(record.summary) ?? stringValue(record.candidate_summary) ?? sourceOpportunity?.summary ?? 'Resumo',
    hook: stringValue(record.hook) ?? stringValue(record.first_words) ?? sourceOpportunity?.hook ?? stringValue(record.summary) ?? 'Hook',
    hook_text: summarize(stringValue(record.hook_text) ?? stringValue(record.hookText) ?? sourceOpportunity?.hook_text ?? stringValue(record.hook) ?? sourceOpportunity?.hook ?? stringValue(record.title) ?? 'Hook', 90),
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
    const title = stringValue(record.title) ?? stringValue(record.value);
    return title ? { kind: 'retitle', title } : null;
  }
  if (kind === 'set_hook' || kind === 'hook' || kind === 'headline' || kind === 'change_hook' || kind === 'update_hook' || kind === 'hook_text') {
    const text = stringValue(record.text) ?? stringValue(record.hook_text) ?? stringValue(record.value) ?? stringValue(record.title);
    return text ? { kind: 'set_hook', text: summarize(text, 90) } : null;
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
  if (kind === 'remove_span' || kind === 'cut_span' || kind === 'remove' || kind === 'delete_span' || kind === 'exclude_span') {
    const query = stringValue(record.query) ?? stringValue(record.text) ?? stringValue(record.description);
    return query ? { kind: 'remove_span', query } : null;
  }
  if (kind === 'set_speed' || kind === 'speed' || kind === 'playback_speed') {
    return { kind: 'set_speed', speed: Math.max(1, Math.min(1.5, positiveNumber(record.speed) ?? positiveNumber(record.value) ?? 1.15)) };
  }
  if (kind === 'enable_end_card' || kind === 'enable_preview_end_card' || kind === 'add_end_card') {
    return { kind: 'enable_end_card' };
  }
  if (kind === 'disable_end_card' || kind === 'disable_preview_end_card' || kind === 'remove_end_card') {
    return { kind: 'disable_end_card' };
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

function normalizePublishCopyPayload(raw: unknown, fallback: { hook: string; payoff: string }): unknown {
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
    line_1: stringValue(record.line_1) ?? stringValue(record.line1) ?? stringValue(record.caption) ?? summarize(fallback.hook, 180),
    line_2: stringValue(record.line_2) ?? stringValue(record.line2) ?? stringValue(record.summary) ?? summarize(fallback.payoff, 180),
    hashtags: hashtags
      .map((value) => typeof value === 'string' ? value.trim() : '')
      .filter(Boolean)
      .map((value) => value.startsWith('#') ? value : `#${value}`)
      .slice(0, 6),
  };
}

function fallbackLocateTranscriptSpan(query: string, sentences: TranscriptSentence[]): TranscriptSpanLocate | null {
  const queryTerms = query
    .normalize('NFD')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length >= 4);
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
