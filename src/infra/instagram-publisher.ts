export interface InstagramPublishInput {
  filePath: string;
  message: string;
  idempotencyKey: string;
  thumbnailPath?: string | null;
  commentsUnderPost?: string[];
}

export interface InstagramPublishResult {
  provider: string;
  status: string;
  batchId: string | null;
  jobs: Array<{ platform: string; jobId: string }>;
}

export type InstagramPublishErrorStage = 'configuration' | 'discovery' | 'upload' | 'create';

export class InstagramPublishError extends Error {
  readonly provider: string;
  readonly stage: InstagramPublishErrorStage;
  readonly safeToFailover: boolean;

  constructor(input: {
    provider: string;
    stage: InstagramPublishErrorStage;
    message: string;
    safeToFailover: boolean;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'InstagramPublishError';
    this.provider = input.provider;
    this.stage = input.stage;
    this.safeToFailover = input.safeToFailover;
  }
}

export interface InstagramPublishProvider {
  readonly name: string;
  readonly capabilities: {
    commentsUnderPostMax: number;
    customThumbnail: boolean;
  };
  publishInstagramReel(input: InstagramPublishInput): Promise<InstagramPublishResult>;
}
