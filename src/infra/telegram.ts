import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { describeError, logError } from './util.js';

export interface TelegramMessage {
  message_id: number;
}

export interface TelegramCallbackAnswer {
  callback_query_id: string;
  text?: string;
  show_alert?: boolean;
}

export interface TelegramGateway {
  deleteWebhook(dropPendingUpdates?: boolean): Promise<void>;
  getUpdates(offset: number, timeoutSeconds: number): Promise<unknown[]>;
  sendMessage(chatId: string | number, text: string, replyMarkup?: Record<string, unknown>): Promise<TelegramMessage>;
  editMessageText(chatId: string | number, messageId: number, text: string, replyMarkup?: Record<string, unknown>): Promise<void>;
  deleteMessage(chatId: string | number, messageId: number): Promise<void>;
  sendVideo(chatId: string | number, path: string, caption: string, replyMarkup?: Record<string, unknown>): Promise<TelegramMessage>;
  sendDocument(chatId: string | number, path: string, caption: string, replyMarkup?: Record<string, unknown>): Promise<TelegramMessage>;
  answerCallbackQuery(input: TelegramCallbackAnswer): Promise<void>;
}

export class TelegramApi implements TelegramGateway {
  private readonly baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async deleteWebhook(dropPendingUpdates = false): Promise<void> {
    await this.callJson('deleteWebhook', {
      method: 'POST',
      body: JSON.stringify({ drop_pending_updates: dropPendingUpdates }),
    });
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<unknown[]> {
    const result = await this.callJson<{ result: unknown[] }>('getUpdates', {
      method: 'POST',
      body: JSON.stringify({ offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] }),
    });
    return result.result;
  }

  async sendMessage(chatId: string | number, text: string, replyMarkup?: Record<string, unknown>): Promise<TelegramMessage> {
    const result = await this.callJson<{ result: TelegramMessage }>('sendMessage', {
      method: 'POST',
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: replyMarkup,
        disable_web_page_preview: true,
      }),
    });
    return result.result;
  }

  async editMessageText(chatId: string | number, messageId: number, text: string, replyMarkup?: Record<string, unknown>): Promise<void> {
    await this.callJson('editMessageText', {
      method: 'POST',
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: replyMarkup,
        disable_web_page_preview: true,
      }),
    });
  }

  async deleteMessage(chatId: string | number, messageId: number): Promise<void> {
    await this.callJson('deleteMessage', {
      method: 'POST',
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
      }),
    });
  }

  async sendVideo(chatId: string | number, path: string, caption: string, replyMarkup?: Record<string, unknown>): Promise<TelegramMessage> {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('caption', caption);
    form.set('supports_streaming', 'true');
    if (replyMarkup) {
      form.set('reply_markup', JSON.stringify(replyMarkup));
    }
    const buffer = await readFile(path);
    form.set('video', new Blob([buffer], { type: 'video/mp4' }), basename(path));
    const result = await this.callForm<{ result: TelegramMessage }>('sendVideo', form);
    return result.result;
  }

  async sendDocument(chatId: string | number, path: string, caption: string, replyMarkup?: Record<string, unknown>): Promise<TelegramMessage> {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('caption', caption);
    if (replyMarkup) {
      form.set('reply_markup', JSON.stringify(replyMarkup));
    }
    const buffer = await readFile(path);
    form.set('document', new Blob([buffer], { type: 'video/mp4' }), basename(path));
    const result = await this.callForm<{ result: TelegramMessage }>('sendDocument', form);
    return result.result;
  }

  async answerCallbackQuery(input: TelegramCallbackAnswer): Promise<void> {
    await this.callJson('answerCallbackQuery', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  private async callJson<T>(method: string, init: RequestInit): Promise<T> {
    const url = `${this.baseUrl}/${method}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      if (!shouldSuppressTelegramRequestError(method, error)) {
        logError(`Telegram ${method} request failed`, error, { url });
      }
      throw error;
    }
    const payload = await response.json().catch(() => undefined) as { ok?: boolean; description?: string } & T;
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.description || `${method} failed with ${response.status}`);
    }
    return payload;
  }

  private async callForm<T>(method: string, form: FormData): Promise<T> {
    const url = `${this.baseUrl}/${method}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        body: form,
      });
    } catch (error) {
      if (!shouldSuppressTelegramRequestError(method, error)) {
        logError(`Telegram ${method} request failed`, error, { url });
      }
      throw error;
    }
    const payload = await response.json().catch(() => undefined) as { ok?: boolean; description?: string } & T;
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.description || `${method} failed with ${response.status}`);
    }
    return payload;
  }
}

function shouldSuppressTelegramRequestError(method: string, error: unknown): boolean {
  if (method !== 'getUpdates') {
    return false;
  }
  const message = describeError(error);
  return message.includes('UND_ERR_INFO') || message.includes('stream timeout') || message.includes('ECONNRESET');
}
