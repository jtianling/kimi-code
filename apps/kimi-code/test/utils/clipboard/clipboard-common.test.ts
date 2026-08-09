import { describe, expect, it } from 'vitest';

import { runCommandAsync } from '#/utils/clipboard/clipboard-common';

// Spawning node from a loaded vitest worker regularly costs more than the
// product's 1s default ceiling, so the behavioural cases pass an explicit,
// generous timeout; the ceiling itself is covered by the last case.
const SPAWN_TIMEOUT_MS = 20_000;

describe('runCommandAsync', () => {
  it('resolves with stdout for a successful command', async () => {
    const result = await runCommandAsync(
      process.execPath,
      ['-e', 'process.stdout.write("hello")'],
      { timeoutMs: SPAWN_TIMEOUT_MS },
    );
    expect(result.ok).toBe(true);
    expect(result.stdout.toString('utf-8')).toBe('hello');
  }, 30_000);

  it('resolves ok:false for a non-zero exit', async () => {
    const result = await runCommandAsync(process.execPath, ['-e', 'process.exit(3)'], {
      timeoutMs: SPAWN_TIMEOUT_MS,
    });
    expect(result.ok).toBe(false);
  }, 30_000);

  it('does not block when the command exceeds the timeout', async () => {
    const timeoutMs = 100;
    const start = Date.now();
    // The child would idle for 30s if left running; runCommandAsync must kill
    // it and resolve well before that so a wedged helper cannot freeze launch.
    const result = await runCommandAsync(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      timeoutMs,
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(5000);
  });
});
