import { tmpdir } from 'node:os';
import { stdioFixture } from '../../mcpCore/stubs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, createServices, stubPair } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { LifecycleScope } from '#/app/scopes';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { ISessionEphemeralMcpServers } from '#/session/mcp/ephemeralMcpServers';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMcpService } from '#/session/sessionMcp/sessionMcp';
import { ISessionMcpServers } from '#/session/sessionMcp/sessionMcpServers';
import { SessionMcpService } from '#/session/sessionMcp/sessionMcpService';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import type {
  McpServersChange,
  McpTunables,
} from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';
import { stubAgentIdentity } from '../../app/agentIdentity/stubs';

import { stubLog } from '../../_base/log/stubs';
import {
  createMemoryMcpOAuthStore,
  startInProcessHttpMcpServer,
} from '../../mcpCore/stubs';

function runtimeResolver(): IRuntimeResolver {
  const runtime = Object.assign(
    new FakeRuntime(
      { workspaceId: 'ws_test', runtimeId: 'local', generation: 'test' },
      { capabilities: ['process'] },
    ),
    { process: new HostProcessService() },
  );
  return {
    _serviceBrand: undefined,
    inspect: () => runtime,
    acquire: () => ({ runtime, track: (resource) => resource, dispose: () => {} }),
  };
}

describe('SessionMcpService', () => {
  let disposables: DisposableStore;
  let httpServer: { url: string; close: () => Promise<void> } | undefined;
  let current: Record<string, McpServerConfig>;
  let tunablesValue: McpTunables;
  let changes: Emitter<McpServersChange>;

  beforeEach(() => {
    disposables = new DisposableStore();
    httpServer = undefined;
    current = {};
    tunablesValue = {};
    changes = new Emitter<McpServersChange>();
  });

  afterEach(async () => {
    disposables.dispose();
    await httpServer?.close();
  });

  function httpServerConfig(): McpServerConfig {
    if (httpServer === undefined) throw new Error('http server not started');
    return { transport: 'http', url: httpServer.url, scope: 'session' };
  }

  function seedStub(): ISessionMcpServers {
    return {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      servers: () => current,
      tunables: () => tunablesValue,
      onDidChange: changes.event,
    };
  }

  function sessionContextStub(): ISessionContext {
    return {
      _serviceBrand: undefined,
      sessionId: 'sess_test',
      workspaceId: 'ws_test',
      sessionDir: '/tmp/kimi-session-mcp-test',
      metaScope: 'test',
      cwd: '/tmp/kimi-session-mcp-test',
      scope: (subKey?: string) => (subKey === undefined ? 'test' : `test/${subKey}`),
    };
  }

  function createService(): ISessionMcpService {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(ISessionContext, sessionContextStub());
        reg.defineInstance(ISessionMcpServers, seedStub());
        reg.definePartialInstance(
          IMcpOAuthService,
          disposables.add(new McpOAuthService({ store: createMemoryMcpOAuthStore() })),
        );
        reg.defineInstance(IAgentIdentity, stubAgentIdentity());
        reg.defineInstance(IRuntimeResolver, runtimeResolver());
        reg.defineInstance(ISessionEphemeralMcpServers, {});
        reg.defineInstance(ILogService, stubLog());
        reg.define(ISessionMcpService, SessionMcpService);
      },
    });
    return ix.get(ISessionMcpService);
  }

  it('idles with zero connections when the seed has no session-scoped servers', async () => {
    const service = createService();
    await service.ready;
    expect(service.connectionManager.list()).toEqual([]);
  });

  it('connects the seeded session-scoped servers at initial load', async () => {
    httpServer = await startInProcessHttpMcpServer();
    current = { perSession: httpServerConfig() };

    const service = createService();
    await service.ready;

    const entry = service.connectionManager.get('perSession');
    expect(entry?.status).toBe('connected');
    expect(entry?.toolCount).toBe(1);
  }, 20000);

  it('resolves remote header templates against the per-session env overlay', async () => {
    const received: Array<Record<string, string | string[] | undefined>> = [];
    httpServer = await startInProcessHttpMcpServer({
      onRequest: (req) => received.push(req.headers),
    });
    const stale = process.env['KIMI_XATS_SESSION_ID'];
    process.env['KIMI_XATS_SESSION_ID'] = 'stale_session';
    try {
      if (httpServer === undefined) throw new Error('http server not started');
      current = {
        perSession: {
          transport: 'http',
          url: httpServer.url,
          scope: 'session',
          headers: {
            'X-Kimi-Session-Id': '${KIMI_XATS_SESSION_ID}',
            'X-Static': 'keep',
            'X-Missing': '${KIMI_TEST_DEFINITELY_MISSING}',
          },
        },
      };

      const service = createService();
      await service.ready;
      expect(service.connectionManager.get('perSession')?.status).toBe('connected');

      const hit = received.find((headers) => headers['x-static'] !== undefined);
      expect(hit?.['x-kimi-session-id']).toBe('sess_test');
      expect(hit?.['x-static']).toBe('keep');
      expect(hit?.['x-missing']).toBeUndefined();
    } finally {
      if (stale === undefined) delete process.env['KIMI_XATS_SESSION_ID'];
      else process.env['KIMI_XATS_SESSION_ID'] = stale;
    }
  }, 20000);

  it('connects session stdio servers through the configured runtime', async () => {
    current = {
      perSession: {
        transport: 'stdio',
        command: process.execPath,
        args: [stdioFixture],
        cwd: tmpdir(),
        scope: 'session',
      },
    };
    const service = createService();
    await service.ready;
    expect(service.connectionManager.get('perSession')?.status).toBe('connected');
    await service.connectionManager.shutdown();
  });

  it('reads timeout tunables from the seed at connect', async () => {
    httpServer = await startInProcessHttpMcpServer();
    tunablesValue = { startupTimeoutMs: 4321, toolTimeoutMs: 9876 };
    const tunables = vi.fn(() => tunablesValue);
    current = { perSession: httpServerConfig() };

    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(ISessionContext, sessionContextStub());
        reg.defineInstance(ISessionMcpServers, { ...seedStub(), tunables });
        reg.definePartialInstance(
          IMcpOAuthService,
          disposables.add(new McpOAuthService({ store: createMemoryMcpOAuthStore() })),
        );
        reg.defineInstance(IAgentIdentity, stubAgentIdentity());
        reg.defineInstance(IRuntimeResolver, runtimeResolver());
        reg.defineInstance(ISessionEphemeralMcpServers, {});
        reg.defineInstance(ILogService, stubLog());
        reg.define(ISessionMcpService, SessionMcpService);
      },
    });
    const service = ix.get(ISessionMcpService);
    await service.ready;

    expect(service.connectionManager.get('perSession')?.status).toBe('connected');
    expect(tunables).toHaveBeenCalled();
  }, 20000);

  it('applies upserts and removals from the seed change events', async () => {
    httpServer = await startInProcessHttpMcpServer();
    const service = createService();
    await service.ready;
    expect(service.connectionManager.list()).toEqual([]);

    changes.fire({ upsert: { perSession: httpServerConfig() }, remove: [] });
    await vi.waitFor(
      () => {
        expect(service.connectionManager.get('perSession')?.status).toBe('connected');
      },
      { timeout: 10000, interval: 50 },
    );

    changes.fire({ upsert: {}, remove: ['perSession'] });
    await vi.waitFor(
      () => {
        expect(service.connectionManager.get('perSession')).toBeUndefined();
      },
      { timeout: 10000, interval: 50 },
    );
  }, 20000);

  it('shuts the connections down when the session service is disposed', async () => {
    httpServer = await startInProcessHttpMcpServer();
    current = { perSession: httpServerConfig() };
    const service = createService();
    await service.ready;
    expect(service.connectionManager.get('perSession')?.status).toBe('connected');

    disposables.dispose();

    await vi.waitFor(
      () => {
        expect(service.connectionManager.list()).toEqual([]);
      },
      { timeout: 10000, interval: 50 },
    );
    disposables = new DisposableStore();
  }, 20000);
});

describe('SessionMcpService (scoped)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Session,
      ISessionMcpService,
      SessionMcpService,
      ScopeActivation.OnScopeCreated,
      'sessionMcp',
    );
  });

  it('resolves from the Session scope with the seed and ancestor deps injected', async () => {
    const changes = new Emitter<McpServersChange>();
    const host = createScopedTestHost([
      stubPair(ILogService, stubLog()),
      stubPair(
        IMcpOAuthService,
        new McpOAuthService({ store: createMemoryMcpOAuthStore() }),
      ),
      stubPair(IAgentIdentity, stubAgentIdentity()),
      stubPair(IRuntimeResolver, runtimeResolver()),
      stubPair(ISessionEphemeralMcpServers, {}),
    ]);
    try {
      const session = host.child(LifecycleScope.Session, 'sess_test', [
        stubPair(ISessionContext, {
          _serviceBrand: undefined,
          sessionId: 'sess_test',
          workspaceId: 'ws_test',
          sessionDir: '/tmp/kimi-session-mcp-test',
          metaScope: 'test',
          cwd: '/tmp/kimi-session-mcp-test',
          scope: (subKey?: string) =>
            subKey === undefined ? 'test' : `test/${subKey}`,
        }),
        stubPair(ISessionMcpServers, {
          _serviceBrand: undefined,
          ready: Promise.resolve(),
          servers: () => ({}),
          tunables: () => ({}),
          onDidChange: changes.event,
        }),
      ]);
      const service = session.accessor.get(ISessionMcpService);
      await service.ready;
      expect(service.connectionManager.list()).toEqual([]);
    } finally {
      host.dispose();
    }
  });
});
