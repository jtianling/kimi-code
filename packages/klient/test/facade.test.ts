import { describe, expect, it, vi } from 'vitest';

import type {
  EventSourceRef,
  IDisposable,
  KlientChannel,
  ScopeRef,
} from '../src/core/channel.js';
import { createKlientFromChannel } from '../src/core/klient.js';
import { KlientValidationError } from '../src/core/validation.js';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Records calls, replays scripted results, and captures listen subscriptions. */
class FakeChannel implements KlientChannel {
  readonly calls: Array<{ scope: ScopeRef; service: string; method: string; args: unknown[] }> = [];
  readonly subscriptions: Array<{ source: EventSourceRef; dispose: ReturnType<typeof vi.fn> }> =
    [];
  result: unknown;
  /** Keyed `${service}.${method}` result overrides. */
  readonly results = new Map<string, unknown>();
  private readonly handlers = new Map<number, (data: unknown) => void>();
  private nextSub = 0;

  call(scope: ScopeRef, service: string, method: string, args: unknown[]): Promise<unknown> {
    this.calls.push({ scope, service, method, args });
    const key = `${service}.${method}`;
    return Promise.resolve(this.results.has(key) ? this.results.get(key) : this.result);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(_scope: ScopeRef, _service: string, _method: string, _args: unknown[]): AsyncIterableIterator<unknown> {
    // stub — streaming is not exercised in facade tests
  }

  listen(_scope: ScopeRef, source: EventSourceRef, handler: (data: unknown) => void): IDisposable {
    const id = this.nextSub;
    this.nextSub += 1;
    this.handlers.set(id, handler);
    const dispose = vi.fn(() => {
      this.handlers.delete(id);
    });
    this.subscriptions.push({ source, dispose });
    return { dispose };
  }

  /** Push a raw payload into the Nth subscription (0-based). */
  emit(index: number, data: unknown): void {
    this.handlers.get(index)?.(data);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const SUMMARY = {
  id: 's1',
  workspaceId: 'w1',
  createdAt: 1,
  updatedAt: 2,
  archived: false,
};

describe('facade routing', () => {
  it('reshapes single-object params into positional wire args', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);

    channel.result = { id: 'w1', root: '/x', name: 'n', createdAt: 1, lastOpenedAt: 2 };
    await klient.global.workspaces.createOrTouch({ root: '/x', name: 'n' });
    expect(channel.calls[0]).toMatchObject({
      service: 'workspaceService',
      method: 'createOrTouch',
      args: ['/x', 'n'],
    });

    channel.result = undefined; // void output
    await klient.global.plugins.setMcpServerEnabled({ id: 'p', server: 's', enabled: true });
    expect(channel.calls[1]).toMatchObject({
      service: 'pluginService',
      method: 'setPluginMcpServerEnabled',
      args: [{ id: 'p', server: 's', enabled: true }],
    });

    channel.results.set('oauthService.status', { loggedIn: false });
    await klient.global.auth.status();
    expect(channel.calls[2]).toMatchObject({
      service: 'oauthService',
      method: 'status',
      args: [undefined],
    });
  });

  it('env() fans out property reads and merges them', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = 'v';
    channel.results.set('bootstrapService.clientIdentity', {
      productName: 'v',
      version: 'v',
      platform: 'v',
    });
    const env = await klient.global.env();
    expect(env.platform).toBe('v');
    expect(env.logsDir).toBe('v');
    expect(env.clientVersion).toBe('v');
    expect(channel.calls).toHaveLength(12);
    expect(channel.calls.every((call) => call.service === 'bootstrapService')).toBe(true);
  });

  it('env() resolves once and serves repeats from the cache', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = 'v';
    channel.results.set('bootstrapService.clientIdentity', {
      productName: 'v',
      version: 'v',
      platform: 'v',
    });
    await klient.global.env();
    expect(channel.calls).toHaveLength(12);

    const again = await klient.global.env();
    expect(again.platform).toBe('v');
    expect(channel.calls).toHaveLength(12);
  });
});

describe('agent facade routing', () => {
  it('maps the milestone-3 agent methods to their wire triples', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel, { validate: false });
    const agent = klient.session('s1').agent('main');
    const called = () => channel.calls.map((c) => `${c.service}.${c.method}`);

    await agent.createGoal({ objective: 'ship it' });
    await agent.getGoal();
    await agent.pauseGoal();
    await agent.resumeGoal();
    await agent.cancelGoal();
    await agent.listSkills();
    await agent.activateSkill('write-tui', 'arg');
    await agent.setSwarmMode(true, 'manual');
    await agent.setSwarmMode(false, 'manual');
    await agent.compact({ instruction: 'keep it short' });
    await agent.cancelCompaction();
    await agent.setThinking('on');
    await agent.getTools();
    await agent.setActiveTools(['Read']);
    await agent.undoHistory();
    await agent.detachBackgroundTask('t1');

    expect(called()).toEqual([
      'agentGoalService.createGoal',
      'agentGoalService.getGoal',
      'agentGoalService.pauseGoal',
      'agentGoalService.resumeGoal',
      'agentGoalService.cancelGoal',
      'sessionSkillCatalog.listSkills',
      'agentRPCService.activateSkill',
      'agentSwarmService.enter',
      'agentSwarmService.exit',
      'agentFullCompactionService.begin',
      'agentRPCService.cancelCompaction',
      'agentProfileService.setThinking',
      'agentRPCService.getTools',
      'agentProfileService.update',
      'agentRPCService.undoHistory',
      'agentTaskService.detach',
    ]);
    expect(channel.calls[0]?.args).toEqual([{ objective: 'ship it' }]);
    expect(channel.calls[2]?.args).toEqual([undefined]);
    expect(channel.calls[6]?.args).toEqual([{ name: 'write-tui', args: 'arg' }]);
    expect(channel.calls[7]?.args).toEqual(['manual']);
    expect(channel.calls[9]?.args).toEqual([{ source: 'manual', instruction: 'keep it short' }]);
    expect(channel.calls[11]?.args).toEqual(['on']);
    expect(channel.calls[13]?.args).toEqual([{ activeToolNames: ['Read'] }]);
    expect(channel.calls[14]?.args).toEqual([{ count: 1 }]);
    expect(channel.calls[15]?.args).toEqual(['t1']);
  });
});

describe('session facade routing', () => {
  it('maps the milestone-3 session methods to their wire triples', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel, { validate: false });
    const session = klient.session('s1');
    const called = () => channel.calls.map((c) => `${c.service}.${c.method}`);

    channel.result = 'btw-agent-1';
    await session.startBtw();
    channel.result = undefined; // both warning getters return undefined
    await session.getSessionWarnings();
    channel.result = [];
    await session.listMcpServers();
    channel.result = 0; // waitForInitialLoad (void) and initialLoadDurationMs
    await session.getMcpStartupMetrics();
    // addAdditionalDir resolves the workspace through the session index first.
    channel.results.set('sessionIndex.get', { id: 's1', workspaceId: 'w1' });
    channel.result = {
      projectRoot: '/x',
      configPath: '/x/.kimi-code/local.toml',
      additionalDirs: ['/extra'],
      persisted: false,
    };
    await session.addAdditionalDir('/extra', { persist: false });

    expect(called()).toEqual([
      'agentProfileService.data', // startBtw's main-agent materialization poke
      'sessionBtwService.start',
      'agentProfileService.getAgentsMdWarning',
      'sessionSecondaryModelWarningService.getSecondaryModelWarning',
      'agentMcpService.list',
      'agentMcpService.waitForInitialLoad',
      'agentMcpService.initialLoadDurationMs',
      'sessionIndex.get',
      'workspaceDirs.addDir',
    ]);
    // Session-scope call for btw; main-agent scope for warnings/MCP;
    // workspace scope for addDir.
    expect(channel.calls[0]?.scope).toEqual({ sessionId: 's1', agentId: 'main' });
    expect(channel.calls[1]?.scope).toEqual({ sessionId: 's1' });
    expect(channel.calls[2]?.scope).toEqual({ sessionId: 's1', agentId: 'main' });
    expect(channel.calls[3]?.scope).toEqual({ sessionId: 's1' });
    expect(channel.calls[4]?.scope).toEqual({ sessionId: 's1', agentId: 'main' });
    expect(channel.calls[7]?.scope).toEqual({});
    expect(channel.calls[8]?.scope).toEqual({ workspaceId: 'w1' });
    expect(channel.calls[8]?.args).toEqual([{ path: '/extra', persist: false }]);
  });

  it('composes getSessionWarnings from the two warning sources', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel, { validate: false });
    const session = klient.session('s1');

    channel.results.set('agentProfileService.getAgentsMdWarning', 'AGENTS.md too big');
    channel.results.set('sessionSecondaryModelWarningService.getSecondaryModelWarning', {
      code: 'secondary-model-invalid',
      message: 'no such model',
    });
    await expect(session.getSessionWarnings()).resolves.toEqual([
      { code: 'agents-md-oversized', message: 'AGENTS.md too big', severity: 'warning' },
      { code: 'secondary-model-invalid', message: 'no such model', severity: 'warning' },
    ]);
  });

  it('fails addAdditionalDir when the session is unknown', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel, { validate: false });
    channel.results.set('sessionIndex.get', undefined);
    await expect(klient.session('gone').addAdditionalDir('/extra')).rejects.toMatchObject({
      name: 'RPCError',
      code: 40404,
    });
  });
});

describe('contract validation', () => {
  it('rejects invalid input before the call leaves the client', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    await expect(
      klient.global.sessions.list({ limit: '20' as unknown as number }),
    ).rejects.toBeInstanceOf(KlientValidationError);
    expect(channel.calls).toHaveLength(0);
  });

  it('rejects drifted output payloads', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = { id: 's1' }; // missing required SessionSummary fields
    await expect(klient.global.sessions.get('s1')).rejects.toBeInstanceOf(KlientValidationError);
  });

  it('passes valid payloads through and returns parsed output', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = SUMMARY;
    await expect(klient.global.sessions.get('s1')).resolves.toEqual(SUMMARY);
  });

  it('validate:false skips both directions', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel, { validate: false });
    channel.result = { anything: true };
    await expect(
      klient.global.sessions.list({ limit: '20' as unknown as number }),
    ).resolves.toEqual({ anything: true });
  });
});

describe('event hub', () => {
  it('maps public names to emitter sources and validates payloads', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const seen: unknown[] = [];
    const errors: Error[] = [];
    klient.events.onError((error) => {
        errors.push(error);
      });

    klient.events.on('kosong.providers.changed', (event) => seen.push(event));
    expect(channel.subscriptions[0]?.source).toEqual({
      kind: 'emitter',
      service: 'providerService',
      event: 'onDidChangeProviders',
    });

    channel.emit(0, { added: ['p1'], removed: [], changed: [] });
    channel.emit(0, { added: 'not-an-array' });
    await tick();
    expect(seen).toEqual([{ added: ['p1'], removed: [], changed: [] }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(KlientValidationError);
  });

  it('shares one bus subscription across bus-derived events and filters by type', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const archived: unknown[] = [];
    const catalog: unknown[] = [];

    const subA = klient.events.on('session.archived', (event) => archived.push(event));
    const subB = klient.events.on('kosong.changed', (event) => catalog.push(event));
    expect(channel.subscriptions).toHaveLength(1);
    expect(channel.subscriptions[0]?.source).toEqual({ kind: 'stream', name: 'events' });

    channel.emit(0, { type: 'event.session.archived', payload: { sessionId: 's1' } });
    channel.emit(0, { type: 'event.model_catalog.changed', payload: { changed: [], unchanged: [], failed: [] } });
    channel.emit(0, { type: 'unrelated.type', payload: {} });
    await tick();
    expect(archived).toEqual([{ sessionId: 's1' }]);
    expect(catalog).toEqual([{ changed: [], unchanged: [], failed: [] }]);

    subA.dispose();
    expect(channel.subscriptions[0]?.dispose).not.toHaveBeenCalled();
    subB.dispose();
    expect(channel.subscriptions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the emitter subscription when the last listener detaches', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const a = klient.events.on('config.changed', () => undefined);
    const b = klient.events.on('config.changed', () => undefined);
    expect(channel.subscriptions).toHaveLength(1);
    a.dispose();
    expect(channel.subscriptions[0]?.dispose).not.toHaveBeenCalled();
    b.dispose();
    expect(channel.subscriptions[0]?.dispose).toHaveBeenCalledTimes(1);
  });
});
