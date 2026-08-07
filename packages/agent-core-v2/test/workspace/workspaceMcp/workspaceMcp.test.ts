/**
 * Scenario: workspace MCP — the shared connection manager is driven by the
 * config domain: the initial connect consumes its snapshot, and its diffed
 * change events are applied incrementally after the initial connect settles.
 *
 * Exercises the real `WorkspaceMcpService` against a stubbed
 * `IWorkspaceMcpConfigService` and real stdio fixture servers. Run:
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/workspace/workspaceMcp/workspaceMcp.test.ts`.
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { IMcpOAuthStore } from '#/app/mcpConfig/oauthStore';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import {
  IWorkspaceMcpConfigService,
  type McpServersChange,
  type McpTunables,
} from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';
import { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import { WorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcpService';

import { stubLog } from '../../_base/log/stubs';
import { createMemoryMcpOAuthStore, stdioFixture } from '../../mcpCore/stubs';

function stdioServer(): McpServerConfig {
  return { transport: 'stdio', command: process.execPath, args: [stdioFixture] };
}

function sessionStdioServer(): McpServerConfig {
  return { ...stdioServer(), scope: 'session' };
}

describe('WorkspaceMcpService', () => {
  let cwd: string;
  let disposables: DisposableStore;
  let current: Record<string, McpServerConfig>;
  let tunablesValue: McpTunables;
  let tunablesFn: Mock<() => McpTunables>;
  let configChanges: Emitter<McpServersChange>;
  let manager: InstanceType<typeof McpConnectionManager> | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'kimi-workspace-mcp-cwd-'));
    disposables = new DisposableStore();
    current = {};
    tunablesValue = {};
    tunablesFn = vi.fn(() => tunablesValue);
    configChanges = new Emitter<McpServersChange>();
    manager = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager?.shutdown();
    disposables.dispose();
    await rm(cwd, { recursive: true, force: true });
  });

  function mcpConfigStub(): IWorkspaceMcpConfigService {
    return {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      servers: () => current,
      tunables: () => tunablesFn() as McpTunables,
      onDidChange: configChanges.event,
    };
  }

  function createService(): IWorkspaceMcpService {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(IWorkspaceContext, { cwd });
        reg.defineInstance(IWorkspaceMcpConfigService, mcpConfigStub());
        reg.definePartialInstance(IMcpOAuthStore, createMemoryMcpOAuthStore());
        reg.defineInstance(ILogService, stubLog());
        reg.defineInstance(ITelemetryService, noopTelemetryService);
        reg.define(IWorkspaceMcpService, WorkspaceMcpService);
      },
    });
    return ix.get(IWorkspaceMcpService);
  }

  it('connects the config snapshot in the initial load', async () => {
    current = { alpha: stdioServer(), beta: stdioServer() };
    const connectAll = vi
      .spyOn(McpConnectionManager.prototype, 'connectAll')
      .mockResolvedValue(undefined);

    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    expect(connectAll).toHaveBeenCalledTimes(1);
    expect(Object.keys(connectAll.mock.calls[0]?.[0] ?? {}).toSorted()).toEqual(['alpha', 'beta']);
  });

  it('reads timeout tunables from the config domain at connect', async () => {
    tunablesValue = { startupTimeoutMs: 4321, toolTimeoutMs: 9876 };
    current = { alpha: stdioServer() };

    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    expect(manager.get('alpha')?.status).toBe('connected');
    expect(tunablesFn).toHaveBeenCalled();
  }, 20000);

  it('applies upserts and removals from config change events', async () => {
    current = { alpha: stdioServer() };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;
    expect(manager.get('alpha')?.status).toBe('connected');

    configChanges.fire({ upsert: { beta: stdioServer() }, remove: ['alpha'] });

    await vi.waitFor(
      () => {
        expect(manager?.get('alpha')).toBeUndefined();
        expect(manager?.get('beta')?.status).toBe('connected');
      },
      { timeout: 10000, interval: 50 },
    );
  }, 20000);

  it('queues change events until the initial connect settles', async () => {
    current = { alpha: stdioServer() };
    let settleConnectAll: () => void = () => undefined;
    vi.spyOn(McpConnectionManager.prototype, 'connectAll').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settleConnectAll = resolve;
        }),
    );
    const connect = vi
      .spyOn(McpConnectionManager.prototype, 'connect')
      .mockResolvedValue(undefined as never);
    const remove = vi
      .spyOn(McpConnectionManager.prototype, 'remove')
      .mockResolvedValue(undefined as never);

    const service = createService();
    manager = service.connectionManager();

    configChanges.fire({ upsert: { beta: stdioServer() }, remove: ['alpha'] });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    expect(connect).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();

    settleConnectAll();
    await service.ready;
    await vi.waitFor(
      () => {
        expect(remove).toHaveBeenCalledWith('alpha');
        expect(connect).toHaveBeenCalledWith('beta', stdioServer());
      },
      { timeout: 10000, interval: 50 },
    );
  }, 20000);

  it('keeps session-scoped servers out of the shared manager at initial load', async () => {
    current = { alpha: stdioServer(), perSession: sessionStdioServer() };
    const connectAll = vi
      .spyOn(McpConnectionManager.prototype, 'connectAll')
      .mockResolvedValue(undefined);

    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    expect(connectAll).toHaveBeenCalledTimes(1);
    expect(Object.keys(connectAll.mock.calls[0]?.[0] ?? {})).toEqual(['alpha']);
  });

  it('drops a server from the shared manager when its scope flips to session', async () => {
    current = { alpha: stdioServer() };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;
    expect(manager.get('alpha')?.status).toBe('connected');

    configChanges.fire({ upsert: { alpha: sessionStdioServer() }, remove: [] });

    await vi.waitFor(
      () => {
        expect(manager?.get('alpha')).toBeUndefined();
      },
      { timeout: 10000, interval: 50 },
    );
  }, 20000);

  it('connects a server when its scope flips from session back to workspace', async () => {
    current = { alpha: sessionStdioServer() };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;
    expect(manager.get('alpha')).toBeUndefined();

    configChanges.fire({ upsert: { alpha: stdioServer() }, remove: [] });

    await vi.waitFor(
      () => {
        expect(manager?.get('alpha')?.status).toBe('connected');
      },
      { timeout: 10000, interval: 50 },
    );
  }, 20000);

  it('projects only session-scoped servers through sessionServersData', async () => {
    current = { alpha: stdioServer(), perSession: sessionStdioServer() };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    const data = service.sessionServersData();
    expect(Object.keys(data.servers())).toEqual(['perSession']);

    const changes: McpServersChange[] = [];
    data.onDidChange((change) => changes.push(change));

    // Workspace-scoped upserts never reach the projection as upserts; they
    // are translated into removals (harmless no-ops for names the session
    // manager never had, and the drop signal for a scope flip away).
    configChanges.fire({
      upsert: { alpha: stdioServer(), perSession: stdioServer() },
      remove: [],
    });
    await vi.waitFor(
      () => {
        expect(changes).toEqual([{ upsert: {}, remove: ['alpha', 'perSession'] }]);
      },
      { timeout: 10000, interval: 50 },
    );

    // Session-scoped upserts and removals pass through.
    configChanges.fire({ upsert: { perSession: sessionStdioServer() }, remove: [] });
    configChanges.fire({ upsert: {}, remove: ['perSession'] });
    await vi.waitFor(
      () => {
        expect(changes).toHaveLength(3);
      },
      { timeout: 10000, interval: 50 },
    );
    expect(changes[1]).toEqual({ upsert: { perSession: sessionStdioServer() }, remove: [] });
    expect(changes[2]).toEqual({ upsert: {}, remove: ['perSession'] });
  }, 20000);
});
