import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const details: string[] = [];
    const maybeError = error as Error & {
      cause?: unknown;
      code?: string;
      errno?: number | string;
      syscall?: string;
      address?: string;
      port?: number;
    };
    if (maybeError.code) {
      details.push(`code=${maybeError.code}`);
    }
    if (maybeError.errno !== undefined) {
      details.push(`errno=${String(maybeError.errno)}`);
    }
    if (maybeError.syscall) {
      details.push(`syscall=${maybeError.syscall}`);
    }
    if (maybeError.address) {
      details.push(`address=${maybeError.address}`);
    }
    if (maybeError.port !== undefined) {
      details.push(`port=${String(maybeError.port)}`);
    }
    const cause = maybeError.cause ? ` cause=${describeError(maybeError.cause)}` : '';
    return `${error.name}: ${error.message}${details.length > 0 ? ` (${details.join(', ')})` : ''}${cause}`;
  }
  return String(error);
}

export function logError(context: string, error: unknown, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${safeJson(details)}` : '';
  process.stderr.write(`[${nowIso()}] ${context}: ${describeError(error)}${suffix}\n`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable details]';
  }
}
