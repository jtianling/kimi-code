/**
 * `resolveRemoteConnection` — the KIMI_REMOTE / KIMI_REMOTE_SOCKET opt-in
 * resolution. Discovery against kap-server's instance registry is not
 * exercised here (it needs a live server); these cover the explicit failure
 * and fallback paths.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveRemoteConnection } from '#/cli/remote';

describe('resolveRemoteConnection', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-remote-test-'));
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('returns undefined when remote mode is not requested', async () => {
    await expect(resolveRemoteConnection(homeDir)).resolves.toBeUndefined();
  });

  it('falls back to undefined in auto mode when no server exists', async () => {
    vi.stubEnv('KIMI_REMOTE', 'auto');
    await expect(resolveRemoteConnection(homeDir)).resolves.toBeUndefined();
  });

  it('throws a clear error in required mode when no server exists', async () => {
    vi.stubEnv('KIMI_REMOTE', '1');
    await expect(resolveRemoteConnection(homeDir)).rejects.toThrow(/KIMI_REMOTE/);
  });

  it('throws when KIMI_REMOTE_SOCKET points at a missing socket', async () => {
    vi.stubEnv('KIMI_REMOTE_SOCKET', join(homeDir, 'server', 'klient-58627.sock'));
    await expect(resolveRemoteConnection(homeDir)).rejects.toThrow(/klient IPC socket/);
  });
});
