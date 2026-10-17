export type StudioErrorCode = 'not_found' | 'conflict' | 'invalid' | 'unavailable';

export class StudioError extends Error {
  constructor(
    readonly code: StudioErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StudioError';
  }
}
