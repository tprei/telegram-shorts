export type ShortVideoPlatform = 'instagram' | 'tiktok' | 'youtube_shorts';

export interface ShortVideoPublishInput {
  platform: ShortVideoPlatform;
  filePath: string;
  message: string;
  idempotencyKey: string;
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

export type ShortVideoPublishErrorStage = 'configuration' | 'discovery' | 'upload' | 'create';

export class ShortVideoPublishError extends Error {
  readonly provider: string;
  readonly stage: ShortVideoPublishErrorStage;
  readonly safeToFailover: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(input: {
    provider: string;
    stage: ShortVideoPublishErrorStage;
    message: string;
    safeToFailover: boolean;
    retryAfterSeconds?: number | null;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'ShortVideoPublishError';
    this.provider = input.provider;
    this.stage = input.stage;
    this.safeToFailover = input.safeToFailover;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
  }
}

export interface ShortVideoPublishProvider {
  readonly name: string;
  readonly supportedPlatforms: ShortVideoPlatform[];
  supports(platform: ShortVideoPlatform): boolean;
  publishShortVideo(input: ShortVideoPublishInput): Promise<ShortVideoPublishResult>;
}
