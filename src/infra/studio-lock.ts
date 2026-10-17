import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { logError } from './util.js';

export interface StudioLock {
  release(): void;
}

const LOCK_ATTEMPTS = 3;

function errnoCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return null;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === 'EPERM';
  }
}

function lockIsStale(path: string): boolean {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return true;
    }
    throw error;
  }
  const pid = Number.parseInt(content, 10);
  return Number.isInteger(pid) && pid > 0 && !pidIsAlive(pid);
}

export function acquireStudioLock(dbPath: string): StudioLock {
  const path = `${dbPath}.lock`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') {
        throw error;
      }
      if (!lockIsStale(path)) {
        throw new Error('shorts studio is already running.');
      }
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if (errnoCode(unlinkError) !== 'ENOENT') {
          throw unlinkError;
        }
      }
      continue;
    }
    try {
      writeSync(fd, `${process.pid}\n`);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    return {
      release: () => {
        try {
          closeSync(fd);
        } catch (error) {
          logError('Lock release failed', error, { path });
        }
        try {
          unlinkSync(path);
        } catch (error) {
          logError('Lock unlink failed', error, { path });
        }
      },
    };
  }
  throw new Error('shorts studio is already running.');
}
