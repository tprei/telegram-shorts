import { z } from 'zod';
import type { PublishingAccount, ShortVideoPlatform } from '../domain/model.js';

export const lenientRemoteString = z.unknown().optional().transform((value) => (typeof value === 'string' && value.trim().length > 0 ? value : null));

export interface ShortVideoPublishInput {
  platform: ShortVideoPlatform;
  account: PublishingAccount;
  filePath: string;
  message: string;
  idempotencyKey: string;
  scheduledAt: string | null;
  title?: string | null;
  thumbnailPath?: string | null;
  commentsUnderPost?: string[];
}

export interface ShortVideoPublishResult {
  provider: string;
  platform: ShortVideoPlatform;
  status: string;
  batchId: string | null;
  jobs: Array<{ platform: string; jobId: string }>;
}

export interface ShortVideoCheckPublicationInput {
  provider: string;
  platform: ShortVideoPlatform;
  remoteJobId: string;
}

export interface RemotePublicationState {
  status: 'pending' | 'live' | 'failed';
  url: string | null;
  error: string | null;
}

export type ShortVideoPublishErrorStage = 'configuration' | 'discovery' | 'upload' | 'create' | 'cancel';

const TRANSIENT_NETWORK_CODES: Record<string, true> = {
  ETIMEDOUT: true,
  ECONNRESET: true,
  ECONNREFUSED: true,
  ECONNABORTED: true,
  EPIPE: true,
  EAI_AGAIN: true,
  ENETUNREACH: true,
  EHOSTUNREACH: true,
  UND_ERR_CONNECT_TIMEOUT: true,
  UND_ERR_HEADERS_TIMEOUT: true,
  UND_ERR_BODY_TIMEOUT: true,
  UND_ERR_SOCKET: true,
};

export function isTransientNetworkError(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ('code' in current && typeof current.code === 'string' && TRANSIENT_NETWORK_CODES[current.code] === true) {
      return true;
    }
    if (current.name === 'TimeoutError') {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function isTransientCheckError(error: unknown): boolean {
  if (isTransientNetworkError(error)) {
    return true;
  }
  return error instanceof ShortVideoPublishError
    && error.httpStatus !== null
    && (error.httpStatus === 429 || error.httpStatus >= 500);
}

export class ShortVideoPublishError extends Error {
  readonly provider: string;
  readonly stage: ShortVideoPublishErrorStage;
  readonly safeToFailover: boolean;
  readonly retryAfterSeconds: number | null;
  readonly httpStatus: number | null;

  constructor(input: {
    provider: string;
    stage: ShortVideoPublishErrorStage;
    message: string;
    safeToFailover: boolean;
    retryAfterSeconds?: number | null;
    httpStatus?: number | null;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'ShortVideoPublishError';
    this.provider = input.provider;
    this.stage = input.stage;
    this.safeToFailover = input.safeToFailover;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
    this.httpStatus = input.httpStatus ?? null;
  }
}

export interface ShortVideoPublishProvider {
  readonly name: string;
  readonly supportedPlatforms: ShortVideoPlatform[];
  readonly supportsScheduling: boolean;
  supports(platform: ShortVideoPlatform): boolean;
  canPublish(input: { account: PublishingAccount; platform: ShortVideoPlatform; scheduled: boolean }): boolean;
  publishShortVideo(input: ShortVideoPublishInput): Promise<ShortVideoPublishResult>;
  checkPublication(input: ShortVideoCheckPublicationInput): Promise<RemotePublicationState>;
  cancelScheduled(input: ShortVideoCheckPublicationInput): Promise<void>;
}
