import { spawn } from 'node:child_process';

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  capture?: boolean;
  timeoutMs?: number;
}

export async function runProcess(command: string, args: string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ProcessResult>();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  let settled = false;
  const { timeoutMs } = options;
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  let stdout = '';
  let stderr = '';
  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
  }
  child.on('error', (error) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    reject(error);
  });
  child.on('close', (code) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    if (code === 0) {
      resolve({ stdout, stderr });
      return;
    }
    reject(new Error(`${command} exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr.trim()}` : ''}`));
  });
  return promise;
}
