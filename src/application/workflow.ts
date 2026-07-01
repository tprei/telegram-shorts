import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Candidate, CandidateVersion, CreatorPlatformPublishConfig, CreatorProfile, JobRecord, LayoutProfile, PendingReplyContext, QueueTask, RenderArtifact, TelegramUpdateEnvelope } from '../domain/model.js';
import { applyResolvedInsert, applyRevision, buildSentences, detectStrongSpeakers, markDraftReady, rejectCandidate } from '../domain/policies.js';
import { buildCandidateVersionFromBlocks, diagnoseCandidatePlan, fallbackSemanticBlocks, materializeSemanticBlocks, semanticBlocksAreUsable } from '../domain/semantic.js';
import { CallbackTokenPayload, ShortsStore } from '../infra/db.js';
import { AppConfig } from '../infra/env.js';
import { ShortVideoPublishError, type ShortVideoPlatform, type ShortVideoPublishProvider } from '../infra/instagram-publisher.js';
import { createInstagramPublishProvider } from '../infra/instagram-publisher-factory.js';
import { CreatorProfileRepository, publishConfigForPlatform, resolveLayoutProfileForJob, snapshotCreatorProfile, snapshotLayoutProfile } from '../infra/creator-profile-loader.js';
import { OpenRouterClient } from '../infra/openrouter.js';
import { writeArcPreview } from '../infra/arc-preview.js';
import { buildInstagramReelDescription, createInstagramCoverImage } from '../infra/mallary.js';
import { renderCandidate } from '../infra/render.js';
import { type TelegramGateway } from '../infra/telegram.js';
import { transcribeSource } from '../infra/transcript.js';
import { createId, logError, nowIso } from '../infra/util.js';
import { assertPublicYouTubeUrl, downloadSource } from '../infra/youtube.js';

export class ShortsWorkflow {
  private readonly shortVideoPublisher: ShortVideoPublishProvider | null;
  private readonly creatorProfiles: CreatorProfileRepository;

  constructor(
    private readonly config: AppConfig,
    private readonly store: ShortsStore,
    private readonly telegram: TelegramGateway | null,
    private readonly openRouter: OpenRouterClient,
  ) {
    this.shortVideoPublisher = createInstagramPublishProvider(config);
    this.creatorProfiles = new CreatorProfileRepository({
      rootDir: config.rootDir,
      manifestPath: config.TELEGRAM_SHORTS_CREATOR_PROFILES_PATH,
      defaultCreatorId: config.TELEGRAM_SHORTS_DEFAULT_CREATOR_ID,
      legacyLayoutPath: config.TELEGRAM_SHORTS_STATIC_LAYOUT_PATH,
    });
  }

  async handleUpdate(raw: unknown): Promise<void> {
    const update = raw as TelegramUpdateEnvelope;
    if (this.store.hasProcessedUpdate(update.update_id)) {
      return;
    }
    if (update.callback_query?.id) {
      await this.handleCallback(update);
      this.store.markProcessedUpdate(update.update_id);
      return;
    }
    if (update.message) {
      await this.handleMessage(update.message);
      this.store.markProcessedUpdate(update.update_id);
    }
  }

  async runNextTask(jobId?: string): Promise<boolean> {
    const task = this.store.claimNextTask(jobId);
    if (!task) {
      return false;
    }
    try {
      if (task.kind === 'process_source') {
        await this.processSource(task);
      } else if (task.kind === 'plan_candidates') {
        await this.planCandidates(task);
      } else if (task.kind === 'render_draft') {
        await this.renderDraft(task);
      } else if (task.kind === 'apply_revision') {
        await this.applyRevisionTask(task);
      } else if (task.kind === 'render_final') {
        await this.renderFinal(task);
      } else if (task.kind === 'publish_instagram') {
        await this.publishInstagram(task);
      } else if (task.kind === 'publish_short_video') {
        await this.publishShortVideo(task);
      }
      this.store.completeTask(task);
      return true;
    } catch (error) {
      const platform = typeof task.payload.platform === 'string' ? task.payload.platform : 'instagram';
      if ((task.kind === 'publish_instagram' || task.kind === 'publish_short_video') && error instanceof ShortVideoPublishError && error.provider === 'mallary' && error.retryAfterSeconds) {
        const availableAt = futureIso(error.retryAfterSeconds);
        this.store.setSetting(mallaryCooldownKey(platform), availableAt);
        this.store.rescheduleTask(task, availableAt, error.message);
        const job = this.store.getJob(task.jobId);
        if (job) {
          this.store.appendAction(job.id, 'short_video_publish_deferred', {
            provider: error.provider,
            platform,
            retryAfterSeconds: error.retryAfterSeconds,
            availableAt,
            payload: task.payload,
          });
          await this.safeSendMessage(job.operatorChatId, `${platformLabel(platform)} em fila no Mallary. Vou tentar de novo em ${formatDelay(error.retryAfterSeconds)}.`);
        }
        return true;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.store.failTask(task, message);
      if (task.kind === 'publish_instagram' || task.kind === 'publish_short_video') {
        const job = this.store.getJob(task.jobId);
        if (job) {
          this.store.appendAction(job.id, 'short_video_publish_failed', { error: message, payload: task.payload, platform });
          await this.safeSendMessage(job.operatorChatId, `Falha ao publicar em ${platformLabel(platform)}: ${message}`);
        }
        return true;
      }
      await this.failJob(task.jobId, message);
      if (this.telegram) {
        const job = this.store.getJob(task.jobId);
        if (job) {
          await this.safeSendMessage(job.operatorChatId, `Falha no job ${job.id}: ${message}`);
        }
      }
      return true;
    }
  }

  async processOnce(url: string, expectedSpeakerName: string): Promise<string> {
    const job = await this.createJob(url, 'local', 'local');
    while (true) {
      const didWork = await this.runNextTask(job.id);
      const current = this.store.getJob(job.id);
      if (!current) {
        throw new Error('Job disappeared.');
      }
      if (current.status === 'awaiting_speaker_confirmation') {
        if (current.strongSpeakers.length === 0) {
          throw new Error('No strong speaker could be confirmed.');
        }
        if (current.strongSpeakers.length > 1) {
          const chosen = current.strongSpeakers.find((speaker) => speaker.speakerId === expectedSpeakerName.trim());
          if (!chosen) {
            const summary = current.strongSpeakers.map((speaker) => `${speaker.speakerId} ${speaker.totalSeconds.toFixed(1)}s`).join(', ');
            throw new Error(`Multiple strong speakers detected for process-once. Re-run with an explicit speaker id. Candidates: ${summary}`);
          }
          current.chosenSpeakerId = chosen.speakerId;
        } else {
          current.chosenSpeakerId = current.strongSpeakers[0]?.speakerId ?? null;
        }
        current.status = 'planning_candidates';
        current.updatedAt = nowIso();
        this.store.updateJob(current);
        this.store.enqueueTask(current.id, 'plan_candidates', {});
        continue;
      }
      if (current.status === 'awaiting_review') {
        const version = current.currentCandidateVersionId ? this.store.getCandidateVersion(current.currentCandidateVersionId) : null;
        const topCandidate = version?.candidates.filter((candidate) => !candidate.rejected).sort((left, right) => left.rank - right.rank)[0];
        if (!topCandidate) {
          throw new Error('No candidate available for final render.');
        }
        current.approvedRenderId = this.store.listRendersForJob(current.id).find((render) => render.kind === 'draft' && render.candidateId === topCandidate.id && render.candidateVersionId === version?.id)?.id ?? null;
        current.status = 'rendering_final';
        current.updatedAt = nowIso();
        this.store.updateJob(current);
        this.store.enqueueTask(current.id, 'render_final', { candidateId: topCandidate.id, candidateVersionId: version?.id, renderId: current.approvedRenderId });
        continue;
      }
      if (current.status === 'completed' && current.finalRenderId) {
        const render = this.store.getRender(current.finalRenderId);
        if (!render) {
          throw new Error('Final render missing.');
        }
        return render.artifactPath;
      }
      if (current.status === 'failed') {
        throw new Error(current.error ?? 'Job failed.');
      }
      if (!didWork) {
        break;
      }
    }
    const current = this.store.getJob(job.id);
    if (!current || current.status !== 'completed' || !current.finalRenderId) {
      throw new Error('Process did not produce a completed final render.');
    }
    const render = this.store.getRender(current.finalRenderId);
    if (!render) {
      throw new Error('Final render missing.');
    }
    return render.artifactPath;
  }

  async createJob(url: string, chatId: string, userId: string): Promise<JobRecord> {
    assertPublicYouTubeUrl(url);
    const manifestConfigured = Boolean(this.config.TELEGRAM_SHORTS_CREATOR_PROFILES_PATH?.trim());
    const chatDefaultCreatorId = this.store.getDefaultCreatorProfileId(chatId);
    const resolvedProfile = await this.creatorProfiles.resolveCreatorProfile({
      chatDefaultCreatorId,
      strictChatDefault: manifestConfigured && chatId !== 'local' && chatDefaultCreatorId !== 'legacy_default',
      strictEnvDefault: manifestConfigured,
    });
    const creatorProfileSnapshot = snapshotCreatorProfile(resolvedProfile.profile);
    const layoutProfileSnapshot = snapshotLayoutProfile(resolvedProfile.layoutProfile);
    const job: JobRecord = {
      id: createId('job'),
      sourceUrl: url,
      sourceTitle: null,
      status: 'queued',
      operatorChatId: chatId,
      operatorUserId: userId,
      transcriptProvider: this.config.TELEGRAM_SHORTS_TRANSCRIPT_PROVIDER,
      creatorProfileId: resolvedProfile.profile.id,
      creatorProfileSnapshot,
      layoutProfileId: layoutProfileSnapshot?.layoutId ?? resolvedProfile.profile.render.layoutId ?? null,
      layoutProfileSnapshot,
      profileSelectionSource: resolvedProfile.source,
      sourceVideoPath: null,
      sourceAudioPath: null,
      sourceThumbnailPath: null,
      transcriptPath: null,
      sentencesPath: null,
      transcriptWords: [],
      transcriptSentences: [],
      semanticBlocksPath: null,
      semanticBlocks: [],
      chosenSpeakerId: null,
      strongSpeakers: [],
      currentCandidateVersionId: null,
      approvedRenderId: null,
      finalRenderId: null,
      messages: {
        overviewMessageId: null,
        speakerPromptMessageId: null,
      },
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.createJob(job);
    this.store.enqueueTask(job.id, 'process_source', {});
    this.store.appendAction(job.id, 'job_created', { url, creatorProfileId: job.creatorProfileId, layoutProfileId: job.layoutProfileId, profileSelectionSource: job.profileSelectionSource });
    return job;
  }

  private async handleMessage(message: NonNullable<TelegramUpdateEnvelope['message']>): Promise<void> {
    const chatId = String(message.chat?.id ?? '');
    const userId = String(message.from?.id ?? '');
    if (!chatId || !userId) {
      return;
    }
    if (this.config.TELEGRAM_SHORTS_ALLOWED_USER_ID && userId !== this.config.TELEGRAM_SHORTS_ALLOWED_USER_ID) {
      await this.safeSendMessage(chatId, 'Usuário não autorizado.');
      return;
    }
    const text = String(message.text ?? '').trim();
    if (!text) {
      return;
    }
    const pending = this.store.getPendingReply(chatId);
    const isCommand = text.startsWith('/');
    const matchesPendingAnchor = pending && message.reply_to_message?.message_id === pending.anchorMessageId;
    const acceptsPendingText = pending && !isCommand;
    if (pending && (matchesPendingAnchor || acceptsPendingText)) {
      const job = this.store.getJob(pending.jobId);
      if (!job || job.currentCandidateVersionId !== pending.candidateVersionId || (job.status !== 'awaiting_review' && job.status !== 'rendering_drafts')) {
        this.store.clearPendingReply(chatId);
        await this.safeSendMessage(chatId, 'Essa revisão ficou desatualizada. Peça uma nova revisão no draft atual.');
        return;
      }
      this.store.clearPendingReply(chatId);
      this.store.enqueueTask(pending.jobId, 'apply_revision', {
        candidateId: pending.candidateId,
        candidateVersionId: pending.candidateVersionId,
        message: text,
      });
      await this.safeSendMessage(chatId, 'Revisão recebida. Vou aplicar e renderizar de novo.');
      return;
    }
    if (text === '/start' || text === '/help') {
      await this.safeSendMessage(chatId, [
        'Comandos:',
        '/process <youtube-url>',
        '/profile',
        '/status',
      ].join('\n'));
      return;
    }
    if (text.startsWith('/profile')) {
      try {
        await this.sendProfileSelection(chatId, userId);
      } catch (error) {
        await this.safeSendMessage(chatId, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (text.startsWith('/status')) {
      const job = this.store.latestJobForChat(chatId);
      if (!job) {
        await this.safeSendMessage(chatId, 'Nenhum job encontrado.');
        return;
      }
      await this.safeSendMessage(chatId, this.renderOverviewText(job));
      return;
    }
    if (text.startsWith('/process ') || looksLikeUrl(text)) {
      const url = text.startsWith('/process ') ? text.slice('/process '.length).trim() : text;
      try {
        const job = await this.createJob(url, chatId, userId);
        const profileName = job.creatorProfileSnapshot?.displayName ?? job.creatorProfileId ?? 'legado';
        await this.safeSendMessage(chatId, `Recebi o vídeo. Job ${job.id} entrou na fila. Perfil: ${profileName}.`);
      } catch (error) {
        await this.safeSendMessage(chatId, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    await this.safeSendMessage(chatId, 'Use /process <youtube-url>, /profile ou /status.');
  }

  private async sendProfileSelection(chatId: string, userId: string): Promise<void> {
    const profiles = await this.creatorProfiles.getEnabledCreatorProfiles();
    const current = await this.creatorProfiles.resolveCreatorProfile({ chatDefaultCreatorId: this.store.getDefaultCreatorProfileId(chatId) });
    if (profiles.length === 0) {
      await this.safeSendMessage(chatId, `Perfil atual: ${current.profile.displayName}. Nenhum outro perfil habilitado.`);
      return;
    }
    const rows = profiles.map((profile) => [{
      text: `${profile.id === current.profile.id ? '✅ ' : ''}${profile.telegram?.buttonLabel ?? profile.displayName}`,
      callback_data: this.store.createCallbackToken({ kind: 'profile_select', chatId, userId, creatorId: profile.id }),
    }]);
    await this.safeSendMessage(chatId, [
      `Perfil atual: ${current.profile.displayName}`,
      'Escolha o perfil padrão para novos /process neste chat:',
    ].join('\n'), { inline_keyboard: rows });
  }

  private async handleProfileSelectCallback(callback: NonNullable<TelegramUpdateEnvelope['callback_query']>, payload: Extract<CallbackTokenPayload, { kind: 'profile_select' }>): Promise<void> {
    const callbackChatId = String(callback.message?.chat?.id ?? '');
    const callbackUserId = String(callback.from?.id ?? '');
    if (callbackChatId !== payload.chatId || callbackUserId !== payload.userId) {
      await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Seleção inválida para este chat/usuário.', show_alert: true });
      return;
    }
    const profiles = await this.creatorProfiles.getEnabledCreatorProfiles();
    const profile = profiles.find((entry) => entry.id === payload.creatorId);
    if (!profile) {
      await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Perfil indisponível.', show_alert: true });
      return;
    }
    this.store.setDefaultCreatorProfileId(payload.chatId, profile.id);
    await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: `Perfil: ${profile.displayName}` });
    const text = `Perfil padrão definido para ${profile.displayName}. Novos /process usarão esse perfil de render.`;
    if (callback.message?.message_id) {
      await this.safeEditMessage(payload.chatId, callback.message.message_id, text);
    } else {
      await this.safeSendMessage(payload.chatId, text);
    }
  }

  private async handleCallback(update: TelegramUpdateEnvelope): Promise<void> {
    const callback = update.callback_query;
    if (!callback?.id) {
      return;
    }
    const callbackUserId = String(callback.from?.id ?? '');
    if (this.config.TELEGRAM_SHORTS_ALLOWED_USER_ID && callbackUserId !== this.config.TELEGRAM_SHORTS_ALLOWED_USER_ID) {
      await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Usuário não autorizado.', show_alert: true });
      this.store.markProcessedCallback(callback.id);
      return;
    }
    if (this.store.hasProcessedCallback(callback.id)) {
      await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Já processado.' });
      return;
    }
    const token = String(callback.data ?? '');
    const payload = this.store.getCallbackToken(token);
    if (!payload) {
      await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Ação expirada.', show_alert: true });
      this.store.markProcessedCallback(callback.id);
      return;
    }
    if (payload.kind === 'profile_select') {
      await this.handleProfileSelectCallback(callback, payload);
      this.store.markProcessedCallback(callback.id);
      return;
    }
    const job = this.store.getJob(payload.jobId);
    if (!job) {
      await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Job não encontrado.', show_alert: true });
      this.store.markProcessedCallback(callback.id);
      return;
    }
    if (payload.kind === 'pick_speaker') {
      if (job.status !== 'awaiting_speaker_confirmation' || !payload.speakerId) {
        await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Confirmação inválida.', show_alert: true });
        this.store.markProcessedCallback(callback.id);
        return;
      }
      job.chosenSpeakerId = payload.speakerId;
      job.approvedRenderId = null;
      job.status = 'planning_candidates';
      job.updatedAt = nowIso();
      this.store.updateJob(job);
      this.store.enqueueTask(job.id, 'plan_candidates', {});
      this.store.appendAction(job.id, 'speaker_confirmed', { speakerId: payload.speakerId });
      await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Segmentos confirmados.' });
      if (job.messages.speakerPromptMessageId) {
        await this.safeEditMessage(job.operatorChatId, job.messages.speakerPromptMessageId, 'Segmentos do apresentador confirmados. Vou planejar os shorts agora.');
      }
      this.store.markProcessedCallback(callback.id);
      return;
    }
    if (!['publish_instagram', 'publish_everywhere'].includes(payload.kind) && payload.candidateVersionId && job.currentCandidateVersionId !== payload.candidateVersionId) {
      await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Essa versão está desatualizada.', show_alert: true });
      this.store.markProcessedCallback(callback.id);
      return;
    }
    if (payload.kind === 'request_revision' && payload.candidateId && callback.message?.chat?.id && callback.message.message_id) {
      const prompt = await this.safeSendMessage(String(callback.message.chat.id), 'Responda esta mensagem dizendo o que quer mudar nesse draft.');
      const pending: PendingReplyContext = {
        chatId: String(callback.message.chat.id),
        jobId: job.id,
        candidateId: payload.candidateId,
        candidateVersionId: payload.candidateVersionId ?? job.currentCandidateVersionId ?? '',
        anchorMessageId: prompt?.message_id ?? callback.message.message_id,
        kind: 'revision',
      };
      this.store.setPendingReply(pending);
      await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Envie a revisão em resposta.' });
      this.store.markProcessedCallback(callback.id);
      return;
    }
    if (payload.kind === 'approve_draft' && payload.candidateId && payload.renderId) {
      const render = this.store.getRender(payload.renderId);
      if (!render || render.candidateVersionId !== job.currentCandidateVersionId) {
        await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Draft desatualizado.', show_alert: true });
        this.store.markProcessedCallback(callback.id);
        return;
      }
      job.approvedRenderId = payload.renderId;
      job.updatedAt = nowIso();
      this.store.updateJob(job);
      this.store.enqueueTask(job.id, 'render_final', { candidateId: payload.candidateId, candidateVersionId: payload.candidateVersionId, renderId: payload.renderId });
      await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Gerando final.' });
      await this.safeDeleteDraftMessage(job.operatorChatId, render.telegramMessageId);
      this.store.markProcessedCallback(callback.id);
      return;
    }
    if (payload.kind === 'reject_candidate' && payload.candidateId && payload.candidateVersionId) {
      const version = this.store.getCandidateVersion(payload.candidateVersionId);
      if (!version) {
        await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Versão não encontrada.', show_alert: true });
        this.store.markProcessedCallback(callback.id);
        return;
      }
      await this.deleteDraftMessagesForVersion(job, version.id);
      const next = rejectCandidate(version, payload.candidateId);
      this.store.saveCandidateVersion(next);
      for (const candidate of next.candidates) {
        if (!candidate.arc) {
          continue;
        }
        const previewPath = join(await this.ensureJobDir(job.id), `${candidate.id}-arc-preview.svg`);
        await writeArcPreview(previewPath, candidate);
        candidate.arcPreviewPath = previewPath;
      }
      this.store.updateCandidateVersion(next);
      job.currentCandidateVersionId = next.id;
      job.approvedRenderId = null;
      const remaining = next.candidates.filter((entry) => !entry.rejected);
      if (remaining.length === 0) {
        job.status = 'failed';
        job.error = 'All candidates were rejected.';
        job.updatedAt = nowIso();
        this.store.updateJob(job);
        await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Todos os candidatos foram rejeitados.', show_alert: true });
        this.store.markProcessedCallback(callback.id);
        return;
      }
      job.status = 'rendering_drafts';
      job.updatedAt = nowIso();
      this.store.updateJob(job);
      for (const candidate of remaining.slice(0, 3)) {
        this.store.enqueueTask(job.id, 'render_draft', { candidateId: candidate.id, candidateVersionId: next.id });
      }
      await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Candidato rejeitado. Vou atualizar os drafts.' });
      this.store.markProcessedCallback(callback.id);
      return;
    }
    if (payload.kind === 'render_candidate' && payload.candidateId && payload.candidateVersionId) {
      this.store.enqueueTask(job.id, 'render_draft', { candidateId: payload.candidateId, candidateVersionId: payload.candidateVersionId });
      await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Renderizando draft.' });
      this.store.markProcessedCallback(callback.id);
      return;
    }
    if ((payload.kind === 'publish_instagram' || payload.kind === 'publish_everywhere') && payload.renderId && payload.candidateId && payload.candidateVersionId) {
      const render = this.store.getRender(payload.renderId);
      const force = payload.force === true;
      if (!this.shortVideoPublisher) {
        await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Nenhum provedor de publicação curto configurado.', show_alert: true });
        this.store.markProcessedCallback(callback.id);
        return;
      }
      const availablePlatforms = await this.availableShortVideoPlatforms(job);
      const platforms: ShortVideoPlatform[] = payload.kind === 'publish_everywhere'
        ? availablePlatforms
        : availablePlatforms.filter((platform) => platform === 'instagram');
      const unavailable = payload.kind === 'publish_everywhere'
        ? await this.unavailableShortVideoPlatforms(job)
        : platforms.includes('instagram')
          ? []
          : ['instagram'];
      const enqueued: string[] = [];
      const delayed: string[] = [];
      const skipped: string[] = [];
      for (const platform of platforms) {
        const enqueueResult = this.enqueueShortVideoPublish(job.id, {
          platform,
          renderId: payload.renderId,
          candidateId: payload.candidateId,
          candidateVersionId: payload.candidateVersionId,
          force,
        });
        if (enqueueResult === 'enqueued') {
          enqueued.push(platformLabel(platform));
        } else if (enqueueResult === 'delayed') {
          delayed.push(platformLabel(platform));
        } else {
          skipped.push(platformLabel(platform));
        }
      }
      const responseText = enqueued.length === 0 && delayed.length === 0
        ? unavailable.length > 0
          ? `Nada enfileirado. Indisponível: ${unavailable.map((platform) => platformLabel(platform)).join(', ')}.`
          : force
            ? 'Nada novo foi enfileirado; use um render diferente para repostar.'
            : 'Esses destinos já foram solicitados para esse render.'
        : [
            enqueued.length > 0 ? `Enfileirado: ${enqueued.join(', ')}.` : '',
            delayed.length > 0 ? `Na fila por limite temporário: ${delayed.join(', ')}.` : '',
            skipped.length > 0 ? `Já existia: ${skipped.join(', ')}.` : '',
            unavailable.length > 0 ? `Indisponível: ${unavailable.map((platform) => platformLabel(platform)).join(', ')}.` : '',
          ].filter(Boolean).join(' ');
      await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: responseText, show_alert: enqueued.length === 0 && delayed.length === 0 });
      if (enqueued.length > 0 || delayed.length > 0) {
        await this.safeDeleteDraftMessage(job.operatorChatId, render?.telegramMessageId ?? null);
      }
      this.store.markProcessedCallback(callback.id);
      return;
    }
    await this.safeAnswerCallbackQuery({ callback_query_id: callback.id, text: 'Ação inválida.', show_alert: true });
    this.store.markProcessedCallback(callback.id);
  }

  private async processSource(task: QueueTask): Promise<void> {
    const job = this.requireJob(task.jobId);
    job.status = 'acquiring_source';
    job.updatedAt = nowIso();
    this.store.updateJob(job);
    await this.syncOverview(job);
    const workDir = await this.ensureJobDir(job.id);
    const source = await downloadSource(workDir, job.sourceUrl, {
      cookiesPath: this.config.TELEGRAM_SHORTS_YTDLP_COOKIES_PATH ? resolve(this.config.rootDir, this.config.TELEGRAM_SHORTS_YTDLP_COOKIES_PATH) : undefined,
      cookiesFromBrowser: this.config.TELEGRAM_SHORTS_YTDLP_COOKIES_FROM_BROWSER,
      jsRuntime: this.config.TELEGRAM_SHORTS_YTDLP_JS_RUNTIME,
    });
    job.status = 'transcribing';
    job.sourceTitle = source.title;
    job.sourceVideoPath = source.sourceVideoPath;
    job.sourceAudioPath = source.sourceAudioPath;
    job.sourceThumbnailPath = source.sourceThumbnailPath;
    job.updatedAt = nowIso();
    this.store.updateJob(job);
    await this.syncOverview(job);
    const words = await transcribeSource(this.config, source.sourceAudioPath);
    job.transcriptWords = words;
    job.transcriptPath = join(workDir, 'transcript.words.json');
    await writeFile(job.transcriptPath, `${JSON.stringify(words, null, 2)}\n`, 'utf-8');
    job.strongSpeakers = detectStrongSpeakers(words);
    if (job.strongSpeakers.length > 1 && !job.chosenSpeakerId) {
      job.status = 'awaiting_speaker_confirmation';
      job.updatedAt = nowIso();
      this.store.updateJob(job);
      await this.sendSpeakerPrompt(job);
      return;
    }
    job.chosenSpeakerId = job.chosenSpeakerId ?? job.strongSpeakers[0]?.speakerId ?? words[0]?.speakerId ?? null;
    job.transcriptSentences = buildSentences(words, job.chosenSpeakerId ?? undefined);
    job.sentencesPath = join(workDir, 'transcript.sentences.json');
    await writeFile(job.sentencesPath, `${JSON.stringify(job.transcriptSentences, null, 2)}\n`, 'utf-8');
    job.semanticBlocks = [];
    job.semanticBlocksPath = null;
    job.status = 'planning_candidates';
    job.updatedAt = nowIso();
    this.store.updateJob(job);
    this.store.enqueueTask(job.id, 'plan_candidates', {});
  }

  private async planCandidates(task: QueueTask): Promise<void> {
    const job = this.requireJob(task.jobId);
    const chosenSpeakerId = job.chosenSpeakerId ?? job.strongSpeakers[0]?.speakerId ?? job.transcriptWords[0]?.speakerId ?? null;
    job.chosenSpeakerId = chosenSpeakerId;
    job.transcriptSentences = buildSentences(job.transcriptWords, chosenSpeakerId ?? undefined);
    if (job.transcriptSentences.length === 0) {
      throw new Error('Transcript did not produce any usable host sentences.');
    }
    let blocks = fallbackSemanticBlocks(job.transcriptSentences);
    try {
      const semanticBlockResponse = await this.openRouter.buildSemanticBlocks({
        title: job.sourceTitle,
        sentences: job.transcriptSentences,
      });
      const proposedBlocks = materializeSemanticBlocks(job.transcriptSentences, semanticBlockResponse);
      if (semanticBlocksAreUsable(proposedBlocks)) {
        blocks = proposedBlocks;
      }
    } catch {
      // fall back to local block segmentation
    }
    const jobDir = await this.ensureJobDir(job.id);
    job.semanticBlocks = blocks;
    job.semanticBlocksPath = join(jobDir, 'semantic-blocks.json');
    await writeFile(job.semanticBlocksPath, `${JSON.stringify(blocks, null, 2)}\n`, 'utf-8');
    this.store.updateJob(job);
    const blockPayload = blocks.map((block) => ({
      id: block.id,
      kind: block.kind,
      summary: block.summary,
      start_seconds: block.startSeconds,
      end_seconds: block.endSeconds,
      text: block.text,
    }));
    const layoutProfile = await this.resolveJobLayoutProfile(job);
    const defaultPlaybackSpeed = layoutProfile?.defaultPlaybackSpeed ?? 1;
    let opportunities = await this.openRouter.findOpportunities({
      title: job.sourceTitle,
      blocks: blockPayload,
    });
    const opportunitiesPath = join(jobDir, 'opportunity-plan.raw.json');
    await writeFile(opportunitiesPath, `${JSON.stringify(opportunities, null, 2)}\n`, 'utf-8');
    let plan = await this.openRouter.planCandidates({
      title: job.sourceTitle,
      blocks: blockPayload,
      opportunities: opportunities.opportunities,
    });
    const rawPlanPath = join(jobDir, 'candidate-plan.raw.json');
    await writeFile(rawPlanPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf-8');
    let diagnostics = diagnoseCandidatePlan(job.transcriptSentences, blocks, plan, defaultPlaybackSpeed);
    const diagnosticsPath = join(jobDir, 'candidate-plan.validation.json');
    await writeFile(diagnosticsPath, `${JSON.stringify({ candidates: diagnostics }, null, 2)}\n`, 'utf-8');
    let version = buildCandidateVersionFromBlocks(job.id, this.store.latestCandidateVersionNumber(job.id) + 1, job.currentCandidateVersionId, job.currentCandidateVersionId ? 'revision' : 'initial', job.transcriptSentences, blocks, plan, defaultPlaybackSpeed);
    if (version.candidates.length === 0) {
      opportunities = await this.openRouter.repairOpportunityPlan({
        title: job.sourceTitle,
        blocks: blockPayload,
        opportunities: opportunities.opportunities,
        diagnostics,
      });
      const repairedOpportunitiesPath = join(jobDir, 'opportunity-plan.repair.raw.json');
      await writeFile(repairedOpportunitiesPath, `${JSON.stringify(opportunities, null, 2)}\n`, 'utf-8');
      plan = await this.openRouter.planCandidates({
        title: job.sourceTitle,
        blocks: blockPayload,
        opportunities: opportunities.opportunities,
      });
      const repairedPlanPath = join(jobDir, 'candidate-plan.repair.raw.json');
      await writeFile(repairedPlanPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf-8');
      diagnostics = diagnoseCandidatePlan(job.transcriptSentences, blocks, plan, defaultPlaybackSpeed);
      const repairedDiagnosticsPath = join(jobDir, 'candidate-plan.repair.validation.json');
      await writeFile(repairedDiagnosticsPath, `${JSON.stringify({ candidates: diagnostics }, null, 2)}\n`, 'utf-8');
      version = buildCandidateVersionFromBlocks(job.id, this.store.latestCandidateVersionNumber(job.id) + 1, job.currentCandidateVersionId, job.currentCandidateVersionId ? 'revision' : 'initial', job.transcriptSentences, blocks, plan, defaultPlaybackSpeed);
    }
    if (version.candidates.length === 0) {
      const reasonSummary = diagnostics.map((entry) => `#${entry.index + 1} ${entry.title}: ${entry.reasons.join('; ') || 'no diagnostic reason'}`).join(' | ');
      throw new Error(`No valid short candidates were produced. See ${diagnosticsPath}. ${reasonSummary}`);
    }
    this.store.saveCandidateVersion(version);
    for (const candidate of version.candidates) {
      if (!candidate.arc) {
        continue;
      }
      const previewPath = join(await this.ensureJobDir(job.id), `${candidate.id}-arc-preview.svg`);
      await writeArcPreview(previewPath, candidate);
      candidate.arcPreviewPath = previewPath;
    }
    this.store.updateCandidateVersion(version);
    job.currentCandidateVersionId = version.id;
    job.approvedRenderId = null;
    job.status = 'rendering_drafts';
    job.updatedAt = nowIso();
    this.store.updateJob(job);
    this.store.appendAction(job.id, 'candidate_version_created', { versionId: version.id, count: version.candidates.length });
    await this.syncOverview(job, version);
    for (const candidate of version.candidates.filter((entry) => !entry.rejected).slice(0, 3)) {
      this.store.enqueueTask(job.id, 'render_draft', { candidateId: candidate.id, candidateVersionId: version.id });
    }
  }

  private async renderDraft(task: QueueTask): Promise<void> {
    const job = this.requireJob(task.jobId);
    const version = this.requireCandidateVersion(task.payload.candidateVersionId);
    if (job.currentCandidateVersionId !== version.id || (job.status !== 'rendering_drafts' && job.status !== 'awaiting_review')) {
      return;
    }
    const candidate = version.candidates.find((entry) => entry.id === task.payload.candidateId);
    if (!candidate || !job.sourceVideoPath) {
      throw new Error('Draft render target not found.');
    }
    const layoutProfile = await this.resolveJobLayoutProfile(job);
    const rendered = await renderCandidate({
      jobId: job.id,
      candidate,
      candidateVersionId: version.id,
      kind: 'draft',
      sourceVideoPath: job.sourceVideoPath,
      sourceTitle: job.sourceTitle ?? 'Vídeo original',
      sourceThumbnailPath: job.sourceThumbnailPath,
      transcriptWords: job.transcriptWords,
      chosenSpeakerId: job.chosenSpeakerId,
      layoutProfile,
      artifactsDir: this.config.artifactsDir,
    });
    if (rendered.sizeBytes > this.config.TELEGRAM_SHORTS_MAX_FILE_BYTES) {
      throw new Error(`Draft exceeds Telegram size cap: ${rendered.sizeBytes} bytes.`);
    }
    const render: RenderArtifact = {
      id: createId('rnd'),
      status: 'ready',
      telegramMessageId: null,
      createdAt: nowIso(),
      ...rendered,
    };
    this.store.saveRender(render);
    let updatedVersion = version;
    if (this.telegram) {
      const sent = await this.safeSendVideo(job.operatorChatId, render.artifactPath, this.renderDraftCaption(job, version, candidate), this.candidateButtons(job.id, version.id, candidate.id, render.id));
      if (sent) {
        render.telegramMessageId = sent.message_id;
        render.status = 'sent';
        this.store.updateRender(render);
        updatedVersion = markDraftReady(version, candidate.id);
        this.store.updateCandidateVersion(updatedVersion);
      } else {
        this.store.appendAction(job.id, 'draft_delivery_failed', { candidateId: candidate.id, renderId: render.id, artifactPath: render.artifactPath });
      }
    } else {
      updatedVersion = markDraftReady(version, candidate.id);
      this.store.updateCandidateVersion(updatedVersion);
    }
    updatedVersion = this.store.getCandidateVersion(updatedVersion.id) ?? updatedVersion;
    const topCandidates = updatedVersion.candidates.filter((entry) => !entry.rejected).slice(0, 3);
    if (topCandidates.every((entry) => entry.draftReady)) {
      job.status = 'awaiting_review';
      job.updatedAt = nowIso();
      this.store.updateJob(job);
    }
    await this.syncOverview(job, updatedVersion);
  }

  private async applyRevisionTask(task: QueueTask): Promise<void> {
    const job = this.requireJob(task.jobId);
    const version = this.requireCandidateVersion(task.payload.candidateVersionId);
    if (job.currentCandidateVersionId !== version.id || (job.status !== 'awaiting_review' && job.status !== 'rendering_drafts')) {
      return;
    }
    const candidate = version.candidates.find((entry) => entry.id === task.payload.candidateId);
    const message = String(task.payload.message ?? '').trim();
    if (!candidate || !message) {
      throw new Error('Revision target not found.');
    }
    const intent = await this.openRouter.parseRevision({ candidate, message });
    const nonInsertActions = intent.actions.filter((action) => action.kind !== 'insert_span');
    let next = applyRevision(version, candidate.id, nonInsertActions, job.transcriptSentences);
    const insertActions = intent.actions.filter((action) => action.kind === 'insert_span');
    const locateFailures: string[] = [];
    for (const action of insertActions) {
      try {
        const located = await this.openRouter.locateTranscriptSpan({ query: action.query, sentences: job.transcriptSentences });
        next = applyResolvedInsert(next, candidate.id, located.start_sentence_id, located.end_sentence_id, job.transcriptSentences);
      } catch (error) {
        locateFailures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (locateFailures.length > 0 && insertActions.length > 0 && nonInsertActions.length === 0) {
      throw new Error(locateFailures.join(' | '));
    }
    this.store.saveCandidateVersion(next);
    for (const item of next.candidates) {
      if (!item.arc) {
        continue;
      }
      const previewPath = join(await this.ensureJobDir(job.id), `${item.id}-arc-preview.svg`);
      await writeArcPreview(previewPath, item);
      item.arcPreviewPath = previewPath;
    }
    this.store.updateCandidateVersion(next);
    job.currentCandidateVersionId = next.id;
    job.approvedRenderId = null;
    job.status = 'rendering_drafts';
    job.updatedAt = nowIso();
    this.store.updateJob(job);
    this.store.appendAction(job.id, 'revision_applied', { candidateId: candidate.id, summary: intent.summary, locateFailures });
    const partialNote = locateFailures.length > 0 ? `\nObs.: não localizei com segurança um dos trechos pedidos, então apliquei o restante da revisão.` : '';
    await this.safeSendMessage(job.operatorChatId, `Revisão aplicada: ${intent.summary}${partialNote}`);
    await this.syncOverview(job, next);
    for (const item of next.candidates.filter((entry) => !entry.rejected).slice(0, 3)) {
      this.store.enqueueTask(job.id, 'render_draft', { candidateId: item.id, candidateVersionId: next.id });
    }
  }

  private async renderFinal(task: QueueTask): Promise<void> {
    const job = this.requireJob(task.jobId);
    const version = this.requireCandidateVersion(task.payload.candidateVersionId ?? job.currentCandidateVersionId);
    const matchesClassicFinalFlow = job.approvedRenderId === task.payload.renderId && (job.status === 'rendering_final' || job.status === 'final_uploading');
    const allowsIndependentFinal = this.telegram !== null && typeof task.payload.renderId === 'string' && ['awaiting_review', 'completed', 'rendering_final', 'final_uploading'].includes(job.status);
    if (job.currentCandidateVersionId !== version.id || (!matchesClassicFinalFlow && !allowsIndependentFinal)) {
      return;
    }
    const candidate = version.candidates.find((entry) => entry.id === task.payload.candidateId);
    if (!candidate || !job.sourceVideoPath) {
      throw new Error('Final render target not found.');
    }
    const layoutProfile = await this.resolveJobLayoutProfile(job);
    const rendered = await renderCandidate({
      jobId: job.id,
      candidate,
      candidateVersionId: version.id,
      kind: 'final',
      sourceVideoPath: job.sourceVideoPath,
      sourceTitle: job.sourceTitle ?? 'Vídeo original',
      sourceThumbnailPath: job.sourceThumbnailPath,
      transcriptWords: job.transcriptWords,
      chosenSpeakerId: job.chosenSpeakerId,
      layoutProfile,
      artifactsDir: this.config.artifactsDir,
    });
    if (rendered.sizeBytes > this.config.TELEGRAM_SHORTS_MAX_FILE_BYTES) {
      throw new Error(`Final exceeds Telegram size cap: ${rendered.sizeBytes} bytes.`);
    }
    const render: RenderArtifact = {
      id: createId('rnd'),
      status: 'ready',
      telegramMessageId: null,
      createdAt: nowIso(),
      ...rendered,
    };
    this.store.saveRender(render);
    job.finalRenderId = render.id;
    job.status = 'final_uploading';
    job.updatedAt = nowIso();
    this.store.updateJob(job);
    await this.syncOverview(job, version);
    if (this.telegram) {
      const sent = await this.safeSendDocument(job.operatorChatId, render.artifactPath, this.renderFinalCaption(job, candidate), await this.finalButtons(job, version.id, candidate.id, render.id));
      if (sent) {
        render.telegramMessageId = sent.message_id;
        render.status = 'sent';
        this.store.updateRender(render);
      } else {
        this.store.appendAction(job.id, 'final_delivery_failed', { candidateId: candidate.id, renderId: render.id, artifactPath: render.artifactPath });
      }
    }
    job.status = 'completed';
    job.updatedAt = nowIso();
    this.store.updateJob(job);
    await this.syncOverview(job, version);
  }

  private async publishInstagram(task: QueueTask): Promise<void> {
    await this.publishShortVideoTask(task, 'instagram');
  }

  private async publishShortVideo(task: QueueTask): Promise<void> {
    const platform = typeof task.payload.platform === 'string' ? task.payload.platform as ShortVideoPlatform : null;
    if (!platform) {
      throw new Error('Short-video publish target is incomplete.');
    }
    await this.publishShortVideoTask(task, platform);
  }

  private async publishShortVideoTask(task: QueueTask, platform: ShortVideoPlatform): Promise<void> {
    if (!this.shortVideoPublisher || !this.shortVideoPublisher.supports(platform)) {
      throw new Error(`No provider configured for ${platform}.`);
    }
    const job = this.requireJob(task.jobId);
    if (!(await this.isPublishingEnabledForJob(job, platform))) {
      throw new Error(`Publishing to ${platformLabel(platform)} is disabled for profile ${job.creatorProfileSnapshot?.displayName ?? job.creatorProfileId ?? 'legacy'}.`);
    }
    const renderId = typeof task.payload.renderId === 'string' ? task.payload.renderId : null;
    const candidateId = typeof task.payload.candidateId === 'string' ? task.payload.candidateId : null;
    const candidateVersionId = typeof task.payload.candidateVersionId === 'string' ? task.payload.candidateVersionId : null;
    if (!renderId || !candidateId || !candidateVersionId) {
      throw new Error(`${platform} publish target is incomplete.`);
    }
    const render = this.store.getRender(renderId);
    if (!render || render.kind !== 'final') {
      throw new Error('Final render not found for short-video publish.');
    }
    const version = this.requireCandidateVersion(candidateVersionId);
    const candidate = version.candidates.find((entry) => entry.id === candidateId);
    if (!candidate) {
      throw new Error('Candidate not found for short-video publish.');
    }
    const copy = await this.openRouter.writeInstagramReelDescription({ candidate });
    const layoutProfile = await this.resolveJobLayoutProfile(job);
    const publishRender = await renderCandidate({
      jobId: job.id,
      candidate,
      candidateVersionId: `${candidateVersionId}-social-prod`,
      kind: 'final',
      sourceVideoPath: job.sourceVideoPath ?? (() => { throw new Error('sourceVideoPath missing for short-video publish.'); })(),
      sourceTitle: job.sourceTitle ?? 'Vídeo original',
      sourceThumbnailPath: job.sourceThumbnailPath,
      transcriptWords: job.transcriptWords,
      chosenSpeakerId: job.chosenSpeakerId,
      layoutProfile,
      artifactsDir: this.config.artifactsDir,
      renderTier: 'prod',
    });
    const coverPath = platform === 'instagram'
      ? await createInstagramCoverImage({
          sourceVideoPath: job.sourceVideoPath ?? (() => { throw new Error('sourceVideoPath missing for Instagram cover.'); })(),
          sourceThumbnailPath: job.sourceThumbnailPath,
          candidate,
          outputPath: `${publishRender.artifactPath}.cover.jpg`,
        })
      : null;
    const message = buildInstagramReelDescription(copy);
    const result = await this.shortVideoPublisher.publishShortVideo({
      platform,
      filePath: publishRender.artifactPath,
      message,
      title: platform === 'youtube_shorts' ? candidate.title : null,
      idempotencyKey: `telegram-shorts-${platform}-${render.id}`,
      thumbnailPath: coverPath,
      commentsUnderPost: this.buildCommentsUnderPost(platform, job.sourceUrl),
    });
    this.store.appendAction(job.id, 'short_video_publish_enqueued', {
      platform,
      candidateId,
      renderId,
      forced: task.payload.force === true,
      artifactPath: publishRender.artifactPath,
      coverPath,
      provider: result.provider,
      batchId: result.batchId,
      jobs: result.jobs,
    });
    const jobIds = result.jobs.map((entry) => `${entry.platform}:${entry.jobId}`).join(', ');
    await this.safeSendMessage(job.operatorChatId, `${platformLabel(platform)} enviado via ${result.provider}. Batch ${result.batchId ?? 'n/a'}${jobIds ? ` · ${jobIds}` : ''}`);
  }

  private async sendSpeakerPrompt(job: JobRecord): Promise<void> {
    if (!this.telegram) {
      return;
    }
    const text = [
      `Detectei mais de um locutor forte em ${job.sourceTitle ?? 'seu vídeo'}.`,
      'Escolha quais segmentos representam o host principal:',
      ...job.strongSpeakers.map((speaker, index) => `${index + 1}. ${speaker.speakerId} — ${speaker.totalSeconds.toFixed(1)}s\n${speaker.sampleSentences.map((sentence) => `${formatSeconds(sentence.startSeconds)}-${formatSeconds(sentence.endSeconds)} ${sentence.text}`).join('\n')}`),
    ].join('\n\n');
    const rows = job.strongSpeakers.map((speaker) => [{
      text: `Usar ${speaker.speakerId}`,
      callback_data: this.store.createCallbackToken({
        kind: 'pick_speaker',
        jobId: job.id,
        speakerId: speaker.speakerId,
      }),
    }]);
    const sent = await this.telegram.sendMessage(job.operatorChatId, text, { inline_keyboard: rows });
    job.messages.speakerPromptMessageId = sent.message_id;
    job.updatedAt = nowIso();
    this.store.updateJob(job);
  }

  private async syncOverview(job: JobRecord, version?: CandidateVersion | null): Promise<void> {
    if (!this.telegram) {
      return;
    }
    const currentVersion = version ?? (job.currentCandidateVersionId ? this.store.getCandidateVersion(job.currentCandidateVersionId) : null);
    const text = this.renderOverviewText(job, currentVersion);
    const markup = this.overviewButtons(job, currentVersion);
    if (job.messages.overviewMessageId) {
      await this.safeEditMessage(job.operatorChatId, job.messages.overviewMessageId, text, markup);
      return;
    }
    const sent = await this.telegram.sendMessage(job.operatorChatId, text, markup);
    job.messages.overviewMessageId = sent.message_id;
    job.updatedAt = nowIso();
    this.store.updateJob(job);
  }

  private renderOverviewText(job: JobRecord, version?: CandidateVersion | null): string {
    const lines = [
      `Job ${job.id}`,
      `${job.sourceTitle ?? job.sourceUrl}`,
      `Status: ${job.status}`,
      `Perfil: ${job.creatorProfileSnapshot?.displayName ?? job.creatorProfileId ?? 'legado'}`,
    ];
    if (version) {
      lines.push(`Versão: ${version.number}`);
      for (const candidate of version.candidates) {
        lines.push(`${candidate.rank}. ${candidate.rejected ? '⛔ ' : ''}${candidate.title} · ${formatSeconds(candidate.durationSeconds)} · costuras ${candidate.seamCount} · risco ${candidate.risk}${candidate.draftReady ? ' · draft pronto' : ''}`);
      }
    }
    if (job.error) {
      lines.push(`Erro: ${job.error}`);
    }
    return lines.join('\n');
  }

  private overviewButtons(job: JobRecord, version?: CandidateVersion | null): Record<string, unknown> | undefined {
    if (!version) {
      return undefined;
    }
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const candidate of version.candidates.filter((entry) => !entry.rejected && !entry.draftReady).slice(0, 2)) {
      rows.push([{ text: `Renderizar #${candidate.rank}`, callback_data: this.store.createCallbackToken({ kind: 'render_candidate', jobId: job.id, candidateId: candidate.id, candidateVersionId: version.id }) }]);
    }
    return rows.length > 0 ? { inline_keyboard: rows } : undefined;
  }

  private candidateButtons(jobId: string, candidateVersionId: string, candidateId: string, renderId: string): Record<string, unknown> {
    return {
      inline_keyboard: [[
        { text: 'Aprovar final', callback_data: this.store.createCallbackToken({ kind: 'approve_draft', jobId, candidateId, candidateVersionId, renderId }) },
        { text: 'Revisar', callback_data: this.store.createCallbackToken({ kind: 'request_revision', jobId, candidateId, candidateVersionId, renderId }) },
        { text: 'Rejeitar', callback_data: this.store.createCallbackToken({ kind: 'reject_candidate', jobId, candidateId, candidateVersionId }) },
      ]],
    };
  }

  private async finalButtons(job: JobRecord, candidateVersionId: string, candidateId: string, renderId: string): Promise<Record<string, unknown> | undefined> {
    if (!this.shortVideoPublisher) {
      return undefined;
    }
    const availablePlatforms = await this.availableShortVideoPlatforms(job);
    const supportsInstagram = availablePlatforms.includes('instagram');
    const supportsAnywhere = availablePlatforms.length > 0;
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    if (supportsAnywhere) {
      rows.push([
        { text: 'Postar em todo lugar', callback_data: this.store.createCallbackToken({ kind: 'publish_everywhere', jobId: job.id, candidateId, candidateVersionId, renderId }) },
      ]);
      rows.push([
        { text: 'Forçar repost em todo lugar', callback_data: this.store.createCallbackToken({ kind: 'publish_everywhere', jobId: job.id, candidateId, candidateVersionId, renderId, force: true }) },
      ]);
    }
    if (supportsInstagram) {
      rows.push([
        { text: 'Postar Reel no Instagram', callback_data: this.store.createCallbackToken({ kind: 'publish_instagram', jobId: job.id, candidateId, candidateVersionId, renderId }) },
      ]);
      rows.push([
        { text: 'Forçar repost no Instagram', callback_data: this.store.createCallbackToken({ kind: 'publish_instagram', jobId: job.id, candidateId, candidateVersionId, renderId, force: true }) },
      ]);
    }
    return rows.length > 0 ? { inline_keyboard: rows } : undefined;
  }

  private enqueueShortVideoPublish(jobId: string, input: { platform: ShortVideoPlatform; candidateId: string; candidateVersionId: string; renderId: string; force: boolean }): 'enqueued' | 'delayed' | 'skipped' {
    if (!input.force && this.hasExistingShortVideoPublishRequest(jobId, input.renderId, input.platform)) {
      return 'skipped';
    }
    const cooldownUntil = this.activeMallaryCooldownUntil(input.platform);
    if (cooldownUntil) {
      this.store.enqueueTask(jobId, 'publish_short_video', input, { availableAt: cooldownUntil });
      return 'delayed';
    }
    this.store.enqueueTask(jobId, 'publish_short_video', input);
    return 'enqueued';
  }

  private hasExistingShortVideoPublishRequest(jobId: string, renderId: string, platform: ShortVideoPlatform): boolean {
    if (this.store.hasTaskForRenderPlatform(jobId, 'publish_short_video', renderId, platform, ['queued', 'running', 'done'])) {
      return true;
    }
    if (platform === 'instagram' && this.store.hasTaskForRender(jobId, 'publish_instagram', renderId, ['queued', 'running', 'done'])) {
      return true;
    }
    return false;
  }

  private async availableShortVideoPlatforms(job: JobRecord): Promise<ShortVideoPlatform[]> {
    const configured = this.configuredShortVideoPlatforms()
      .filter((platform) => this.shortVideoPublisher?.supports(platform));
    const enabled: ShortVideoPlatform[] = [];
    for (const platform of configured) {
      if (await this.isPublishingEnabledForJob(job, platform)) {
        enabled.push(platform);
      }
    }
    return enabled;
  }

  private async unavailableShortVideoPlatforms(job: JobRecord): Promise<ShortVideoPlatform[]> {
    const available = await this.availableShortVideoPlatforms(job);
    const all: ShortVideoPlatform[] = ['instagram', 'tiktok', 'youtube_shorts'];
    return all.filter((platform) => !available.includes(platform));
  }

  private async isPublishingEnabledForJob(job: JobRecord, platform: ShortVideoPlatform): Promise<boolean> {
    const config = await this.currentPublishConfigForJob(job, platform);
    if (!config) {
      return false;
    }
    return this.publishModeUsesGlobalProvider(config);
  }

  private async currentPublishConfigForJob(job: JobRecord, platform: ShortVideoPlatform): Promise<CreatorPlatformPublishConfig | null> {
    const creatorId = job.creatorProfileId?.trim();
    if (creatorId && creatorId !== 'legacy_default') {
      try {
        const currentProfile = await this.creatorProfiles.getCreatorProfileById(creatorId);
        if (!currentProfile?.enabled) {
          return { mode: 'disabled' };
        }
        return publishConfigForPlatform(currentProfile, platform) ?? { mode: 'disabled' };
      } catch (error) {
        logError('Creator profile publish lookup failed; disabling publishing for job', error, { jobId: job.id, creatorId, platform });
        return { mode: 'disabled' };
      }
    }
    if (!job.creatorProfileSnapshot) {
      return { mode: 'global', provider: 'global', fallbackToGlobal: true, configRef: null };
    }
    return publishConfigForPlatform(job.creatorProfileSnapshot, platform) ?? { mode: 'disabled' };
  }

  private publishModeUsesGlobalProvider(config: CreatorPlatformPublishConfig): boolean {
    if (config.mode === 'disabled') {
      return false;
    }
    if (config.mode === 'global') {
      return true;
    }
    return config.fallbackToGlobal === true;
  }

  private configuredShortVideoPlatforms(): ShortVideoPlatform[] {
    const configured: ShortVideoPlatform[] = [];
    if (this.shortVideoPublisher?.supports('instagram') && (this.config.MALLARY_AI_API_TOKEN || (this.config.BUFFER_API_KEY && this.config.BUFFER_INSTAGRAM_CHANNEL_ID))) {
      configured.push('instagram');
    }
    if (this.shortVideoPublisher?.supports('tiktok') && (this.config.BUFFER_API_KEY && this.config.BUFFER_TIKTOK_CHANNEL_ID)) {
      configured.push('tiktok');
    }
    if (this.shortVideoPublisher?.supports('youtube_shorts') && (this.config.BUFFER_API_KEY && this.config.BUFFER_YOUTUBE_CHANNEL_ID)) {
      configured.push('youtube_shorts');
    }
    return configured;
  }

  private activeMallaryCooldownUntil(platform: ShortVideoPlatform): string | null {
    if (!this.shouldUseMallaryCooldown(platform)) {
      return null;
    }
    const value = this.store.getSetting(mallaryCooldownKey(platform));
    if (!value) {
      return null;
    }
    return value > nowIso() ? value : null;
  }

  private shouldUseMallaryCooldown(platform: ShortVideoPlatform): boolean {
    return platform === 'instagram'
      && Boolean(this.config.MALLARY_AI_API_TOKEN)
      && preferredProvidersForPlatform(this.config, platform)[0] === 'mallary';
  }

  private buildCommentsUnderPost(platform: ShortVideoPlatform, sourceUrl: string | null): string[] {
    if (platform !== 'instagram') {
      return [];
    }
    const normalized = sourceUrl?.trim();
    if (!normalized) {
      return [];
    }
    return [`Vídeo completo: ${normalized}`];
  }

  private renderDraftCaption(job: JobRecord, version: CandidateVersion, candidate: Candidate): string {
    return trimCaption([
      `Draft v${version.number}`,
      `${candidate.rank}. ${candidate.title}`,
      `${formatSeconds(candidate.durationSeconds)} · costuras ${candidate.seamCount} · risco ${candidate.risk}`,
      candidate.summary,
      sourceRanges(candidate),
    ].join('\n'));
  }

  private renderFinalCaption(job: JobRecord, candidate: Candidate): string {
    return trimCaption([
      `Final`,
      candidate.title,
      `${formatSeconds(candidate.durationSeconds)} · costuras ${candidate.seamCount}`,
      job.sourceTitle ?? job.sourceUrl,
    ].join('\n'));
  }

  private async resolveJobLayoutProfile(job: JobRecord): Promise<LayoutProfile | null> {
    const hadSnapshot = Object.prototype.hasOwnProperty.call(job, 'layoutProfileSnapshot');
    const layoutProfile = await resolveLayoutProfileForJob(job, this.config.rootDir, this.config.TELEGRAM_SHORTS_STATIC_LAYOUT_PATH);
    if (!hadSnapshot) {
      job.layoutProfileSnapshot = snapshotLayoutProfile(layoutProfile);
      job.layoutProfileId = layoutProfile?.layoutId ?? null;
      if (!job.creatorProfileSnapshot) {
        const legacyProfile: CreatorProfile = {
          id: job.creatorProfileId ?? 'legacy_default',
          displayName: 'Legacy default',
          enabled: true,
          description: 'Backfilled legacy profile from TELEGRAM_SHORTS_STATIC_LAYOUT_PATH.',
          telegram: { buttonLabel: 'Legacy default', aliases: ['legacy'] },
          render: {
            layoutPath: this.config.TELEGRAM_SHORTS_STATIC_LAYOUT_PATH ?? null,
            layoutId: layoutProfile?.layoutId ?? null,
            snapshotLayoutInJobs: true,
          },
          publish: {
            instagram: { mode: 'global', provider: 'global', fallbackToGlobal: true, configRef: null },
            tiktok: { mode: 'global', provider: 'global', fallbackToGlobal: true, configRef: null },
            youtube_shorts: { mode: 'global', provider: 'global', fallbackToGlobal: true, configRef: null },
          },
        };
        job.creatorProfileId = legacyProfile.id;
        job.creatorProfileSnapshot = legacyProfile;
        job.profileSelectionSource = 'legacy_static_layout';
      }
      job.updatedAt = nowIso();
      this.store.updateJob(job);
    }
    return layoutProfile;
  }

  private requireJob(jobId: string): JobRecord {
    const job = this.store.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    return job;
  }

  private requireCandidateVersion(versionId: unknown): CandidateVersion {
    if (typeof versionId !== 'string' || versionId.length === 0) {
      throw new Error('Candidate version is required.');
    }
    const version = this.store.getCandidateVersion(versionId);
    if (!version) {
      throw new Error(`Candidate version not found: ${versionId}`);
    }
    return version;
  }

  private async ensureJobDir(jobId: string): Promise<string> {
    const path = resolve(this.config.artifactsDir, jobId);
    await mkdir(path, { recursive: true });
    return path;
  }

  private async failJob(jobId: string, errorMessage: string): Promise<void> {
    const job = this.store.getJob(jobId);
    if (!job) {
      return;
    }
    job.status = 'failed';
    job.error = errorMessage;
    job.updatedAt = nowIso();
    this.store.updateJob(job);
    await this.syncOverview(job);
  }

  private async safeSendMessage(chatId: string, text: string, replyMarkup?: Record<string, unknown>): Promise<{ message_id: number } | null> {
    if (!this.telegram) {
      return null;
    }
    try {
      return await this.telegram.sendMessage(chatId, text, replyMarkup);
    } catch (error) {
      logError('Telegram sendMessage failed', error, { chatId, textPreview: text.slice(0, 140) });
      return null;
    }
  }

  private async safeSendVideo(chatId: string, path: string, caption: string, replyMarkup?: Record<string, unknown>): Promise<{ message_id: number } | null> {
    if (!this.telegram) {
      return null;
    }
    try {
      return await this.telegram.sendVideo(chatId, path, caption, replyMarkup);
    } catch (error) {
      logError('Telegram sendVideo failed', error, { chatId, path, captionPreview: caption.slice(0, 140) });
      return null;
    }
  }

  private async safeSendDocument(chatId: string, path: string, caption: string, replyMarkup?: Record<string, unknown>): Promise<{ message_id: number } | null> {
    if (!this.telegram) {
      return null;
    }
    try {
      return await this.telegram.sendDocument(chatId, path, caption, replyMarkup);
    } catch (error) {
      logError('Telegram sendDocument failed', error, { chatId, path, captionPreview: caption.slice(0, 140) });
      return null;
    }
  }

  private async safeAnswerCallbackQuery(input: { callback_query_id: string; text?: string; show_alert?: boolean }): Promise<void> {
    if (!this.telegram) {
      return;
    }
    try {
      await this.telegram.answerCallbackQuery(input);
    } catch (error) {
      logError('Telegram answerCallbackQuery failed', error, { callbackQueryId: input.callback_query_id, text: input.text });
      return;
    }
  }

  private async safeDeleteDraftMessage(chatId: string, messageId: number | null): Promise<void> {
    if (!this.telegram || messageId === null) {
      return;
    }
    try {
      await this.telegram.deleteMessage(chatId, messageId);
    } catch (error) {
      logError('Telegram deleteMessage failed', error, { chatId, messageId });
      return;
    }
  }

  private async deleteDraftMessagesForVersion(job: JobRecord, candidateVersionId: string): Promise<void> {
    const renders = this.store.listRendersForJob(job.id)
      .filter((render) => render.kind === 'draft' && render.candidateVersionId === candidateVersionId);
    for (const render of renders) {
      await this.safeDeleteDraftMessage(job.operatorChatId, render.telegramMessageId);
    }
  }

  private async safeEditMessage(chatId: string, messageId: number, text: string, replyMarkup?: Record<string, unknown>): Promise<void> {
    if (!this.telegram) {
      return;
    }
    try {
      await this.telegram.editMessageText(chatId, messageId, text, replyMarkup);
    } catch (error) {
      logError('Telegram editMessageText failed', error, { chatId, messageId, textPreview: text.slice(0, 140) });
      return;
    }
  }
}

function futureIso(delaySeconds: number): string {
  return new Date(Date.now() + delaySeconds * 1000).toISOString();
}

function mallaryCooldownKey(platform: string): string {
  return `cooldown:mallary:${platform}`;
}

function preferredProvidersForPlatform(config: AppConfig, platform: ShortVideoPlatform): Array<'mallary' | 'buffer'> {
  if (platform === 'instagram') {
    const providers = config.TELEGRAM_SHORTS_INSTAGRAM_PUBLISH_PROVIDERS
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry): entry is 'mallary' | 'buffer' => entry === 'mallary' || entry === 'buffer');
    return providers.length > 0 ? providers : ['mallary', 'buffer'];
  }
  return ['buffer', 'mallary'];
}

function formatDelay(delaySeconds: number): string {
  const minutes = Math.floor(delaySeconds / 60);
  const seconds = delaySeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  if (seconds === 0) {
    return `${minutes} min`;
  }
  return `${minutes} min ${seconds}s`;
}

function trimCaption(text: string): string {
  return text.length <= 1024 ? text : `${text.slice(0, 1020)}...`;
}

function platformLabel(platform: string): string {
  if (platform === 'instagram') {
    return 'Instagram';
  }
  if (platform === 'tiktok') {
    return 'TikTok';
  }
  if (platform === 'youtube_shorts') {
    return 'YouTube Shorts';
  }
  return platform;
}

function sourceRanges(candidate: Candidate): string {
  return candidate.segments.map((segment) => `${formatSeconds(segment.startSeconds)}-${formatSeconds(segment.endSeconds)}`).join(' | ');
}

function formatSeconds(value: number): string {
  const total = Math.max(0, Math.round(value));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function looksLikeUrl(text: string): boolean {
  return text.startsWith('https://youtube.com/') || text.startsWith('https://www.youtube.com/') || text.startsWith('https://youtu.be/');
}
