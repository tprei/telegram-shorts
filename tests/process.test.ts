import assert from 'node:assert/strict';
import test from 'node:test';
import { runProcess } from '../src/infra/process.js';

test('runProcess timeout kills the child and rejects with a timed-out error', async () => {
  // Exercises the real SIGKILL timer against the platform clock; fake timers cannot kill a child process.
  await assert.rejects(
    runProcess('node', ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 700 }),
    (error: unknown) => error instanceof Error && error.message === 'node timed out after 1s',
  );
});

test('runProcess still resolves when the timeout is not hit', async () => {
  const result = await runProcess('node', ['-e', 'process.stdout.write("ok")'], { timeoutMs: 60_000 });
  assert.equal(result.stdout, 'ok');
});
