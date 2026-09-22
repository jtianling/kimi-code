import { IAgentLifecycleService } from '@moonshot-ai/agent-core-v2';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getLiveSessionById } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionLookup';
import { IAgentCronService } from '@moonshot-ai/agent-core-v2/features/cron/cronService';
import { RPCError } from '../src/core/errors.js';
import type { AgentHandle, Klient } from '../src/index.js';
import { createMemoryDispatcher } from '../src/transports/memory/dispatcher.js';
import { createKlient } from '../src/transports/memory/index.js';
import { defineKlientConformance } from './helpers/conformance.js';
import { makeEngine, type TestEngine } from './helpers/engine.js';

defineKlientConformance('memory', async () => {
  const { homeDir, app } = await makeEngine();
  const klient = createKlient({ scope: app });
  return {
    klient,
    app,
    cleanup: async () => {
      await klient.close();
      app.dispose();
      await rm(homeDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 25,
      });
    },
  };
});

describe('memory dispatcher specifics', () => {
  it('rejects unknown services and methods with RPCError(40001)', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(dispatcher.call({}, 'noSuchService', 'get', [])).rejects.toMatchObject(
      {
        name: 'RPCError',
        code: 40001,
      },
    );
    await expect(
      dispatcher.call({}, 'sessionIndex', 'noSuchMethod', []),
    ).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('reads non-function members as properties', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(dispatcher.call({}, 'bootstrapService', 'platform', [])).resolves.toBe(
      process.platform,
    );
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('rejects session/agent scopes for now', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(
      dispatcher.call({ sessionId: 's1' }, 'sessionIndex', 'list', [{}]),
    ).rejects.toBeInstanceOf(RPCError);
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('delivers wire-cloned payloads (no live object identity)', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    const list = await klient.global.workspaces.list();
    // Mutating the result must not affect what a second call returns.
    (list as unknown[]).push({ id: 'polluted' });
    const again = await klient.global.workspaces.list();
    expect(again.some((w) => w.id === 'polluted')).toBe(false);
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('does not respond to interactions owned by another session', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    const dispatcher = createMemoryDispatcher(app);
    const first = await klient.global.sessions.create({ workDir: process.cwd() });
    const second = await klient.global.sessions.create({ workDir: process.cwd() });
    try {
      const parked = (await dispatcher.call(
        { sessionId: first.id },
        'sessionInteractionService',
        'enqueue',
        [
          {
            kind: 'approval',
            payload: {
              toolName: 'Bash',
              action: 'run',
              display: { kind: 'command', command: 'ls' },
            },
          },
        ],
      )) as { id: string };

      await dispatcher.call(
        { sessionId: second.id },
        'sessionInteractionService',
        'respond',
        [parked.id, { decision: 'approved' }],
      );
      const pendingAfterCross = (await dispatcher.call(
        { sessionId: first.id },
        'sessionInteractionService',
        'listPending',
        ['approval'],
      )) as readonly { id: string }[];
      expect(pendingAfterCross.map((i) => i.id)).toEqual([parked.id]);

      await dispatcher.call(
        { sessionId: first.id },
        'sessionInteractionService',
        'respond',
        [parked.id, { decision: 'approved' }],
      );
      const pendingAfterOwn = (await dispatcher.call(
        { sessionId: first.id },
        'sessionInteractionService',
        'listPending',
        ['approval'],
      )) as readonly { id: string }[];
      expect(pendingAfterOwn).toEqual([]);
    } finally {
      await klient.close();
      app.dispose();
      await rm(homeDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 25,
      });
    }
  });
});

/**
 * Agent-scope facade coverage against a real engine (memory transport). The
 * provider points at a dead loopback port — every method exercised here is a
 * pure state operation that never reaches the LLM, except `activateSkill`,
 * which is fire-and-forget by design.
 */
describe('agent facade (real engine)', () => {
  let engine: TestEngine;
  let klient: Klient;
  let agent: AgentHandle;
  let sessionId: string;

  beforeAll(async () => {
    engine = await makeEngine();
    klient = createKlient({ scope: engine.app });
    await klient.global.config.replaceSections({
      sections: {
        providers: {
          'agent-facade': {
            type: 'openai',
            baseUrl: 'http://127.0.0.1:1',
            apiKey: 'k',
          },
        },
        models: {
          'agent-facade/m1': {
            provider: 'agent-facade',
            model: 'm1',
            maxContextSize: 8192,
          },
        },
        defaultModel: 'agent-facade/m1',
      },
    });
    const created = await klient.global.sessions.create({
      workDir: process.cwd(),
      title: 'agent facade',
    });
    sessionId = created.id;
    agent = klient.session(sessionId).agent('main');
  });

  afterAll(async () => {
    await klient.close();
    engine.app.dispose();
    await rm(engine.homeDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    });
  });

  it('drives the goal lifecycle through create/get/pause/resume/cancel', async () => {
    const created = await agent.createGoal({ objective: 'klient goal test' });
    expect(created.status).toBe('active');
    expect(created.objective).toBe('klient goal test');

    const current = await agent.getGoal();
    expect(current.goal?.goalId).toBe(created.goalId);

    expect((await agent.pauseGoal()).status).toBe('paused');
    expect((await agent.resumeGoal()).status).toBe('active');

    const cancelled = await agent.cancelGoal();
    expect(cancelled.goalId).toBe(created.goalId);
    expect((await agent.getGoal()).goal).toBeNull();
  });

  it('toggles swarm mode on the domain service', async () => {
    const dispatcher = createMemoryDispatcher(engine.app);
    const scope = { sessionId, agentId: 'main' };
    const isActive = () => dispatcher.call(scope, 'agentSwarmService', 'isActive', []);

    await agent.setSwarmMode(true, 'manual');
    await expect(isActive()).resolves.toBe(true);
    await agent.setSwarmMode(false, 'manual');
    await expect(isActive()).resolves.toBe(false);
  });

  it('lists session skills as wire summaries', async () => {
    const skills = await agent.listSkills();
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(typeof skill.name).toBe('string');
      expect(typeof skill.description).toBe('string');
      expect(['project', 'user', 'extra', 'builtin']).toContain(skill.source);
    }
  });

  it('rejects manual compaction on an empty history and cancels quietly', async () => {
    // Dedicated fresh session: earlier tests in this suite leave the main
    // session's history non-empty (goal cancellation appends a reminder).
    const fresh = await klient.global.sessions.create({
      workDir: process.cwd(),
      title: 'agent facade compaction',
    });
    const freshAgent = klient.session(fresh.id).agent('main');
    await expect(freshAgent.compact()).rejects.toThrow(/No messages to compact/);
    await expect(freshAgent.cancelCompaction()).resolves.toBeUndefined();
  });

  it('reads tools and whole-set replaces the active set', async () => {
    await expect(agent.setThinking('off')).resolves.toBeUndefined();

    const tools = await agent.getTools();
    expect(tools.length).toBeGreaterThan(1);
    const keep = tools[0]!.name;
    const drop = tools.find((tool) => tool.name !== keep)!.name;

    await agent.setActiveTools([keep]);
    const after = await agent.getTools();
    expect(after.find((tool) => tool.name === keep)?.active).toBe(true);
    expect(after.find((tool) => tool.name === drop)?.active).toBe(false);
  });

  it('reports undo as unavailable on empty history and detaches unknown tasks to undefined', async () => {
    await expect(agent.undoHistory()).rejects.toThrow(/Nothing to undo/);
    await expect(agent.detachBackgroundTask('no-such-task')).resolves.toBeUndefined();
  });

  it('activates an existing skill fire-and-forget', async () => {
    const skills = await agent.listSkills();
    const activatable = skills.find(
      (skill) =>
        skill.isSubSkill !== true &&
        (skill.type === undefined || skill.type === 'prompt' || skill.type === 'flow'),
    );
    expect(activatable).toBeDefined();
    await expect(
      agent.activateSkill({ name: activatable!.name }),
    ).resolves.toBeDefined();
  });
});

/**
 * Session-scope facade coverage against a real engine (memory transport):
 * btw, session warnings, MCP reads, and the workspace-scope add-dir surface.
 * All pure state operations — no LLM round-trip.
 */
describe('session facade (real engine)', () => {
  let engine: TestEngine;
  let klient: Klient;
  let sessionId: string;

  beforeAll(async () => {
    engine = await makeEngine();
    klient = createKlient({ scope: engine.app });
    await klient.global.config.replaceSections({
      sections: {
        providers: {
          'session-facade': {
            type: 'openai',
            baseUrl: 'http://127.0.0.1:1',
            apiKey: 'k',
          },
        },
        models: {
          'session-facade/m1': {
            provider: 'session-facade',
            model: 'm1',
            maxContextSize: 8192,
          },
        },
        defaultModel: 'session-facade/m1',
      },
    });
    const created = await klient.global.sessions.create({
      workDir: process.cwd(),
      title: 'session facade',
    });
    sessionId = created.id;
  });

  afterAll(async () => {
    await klient.close();
    engine.app.dispose();
    await rm(engine.homeDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    });
  });

  it('starts a btw side-question agent off the main agent', async () => {
    const session = klient.session(sessionId);
    const btwId = await session.startBtw();
    expect(typeof btwId).toBe('string');
    expect(btwId).not.toBe('main');
    expect(await session.agents()).toHaveProperty(btwId);
  });

  it('composes session warnings from the profile and secondary-model caches', async () => {
    const warnings = await klient.session(sessionId).getSessionWarnings();
    expect(Array.isArray(warnings)).toBe(true);
    for (const warning of warnings) {
      expect(typeof warning.code).toBe('string');
      expect(typeof warning.message).toBe('string');
      expect(['info', 'warning', 'error']).toContain(warning.severity);
    }
  });

  it('lists MCP servers and reports startup metrics', async () => {
    const session = klient.session(sessionId);
    const servers = await session.listMcpServers();
    expect(Array.isArray(servers)).toBe(true);
    for (const server of servers) {
      expect(typeof server.name).toBe('string');
      expect(['stdio', 'http', 'sse']).toContain(server.transport);
      expect(['pending', 'connected', 'failed', 'disabled', 'needs-auth']).toContain(
        server.status,
      );
      expect(typeof server.toolCount).toBe('number');
    }

    const metrics = await session.getMcpStartupMetrics();
    expect(typeof metrics.durationMs).toBe('number');
    expect(metrics.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('adds a non-persisted additional dir through the workspace handler', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'klient-add-dir-'));
    try {
      const session = klient.session(sessionId);
      const result = await session.addAdditionalDir(dir, { persist: false });
      expect(result.persisted).toBe(false);
      // `projectRoot` is the engine-resolved project root — an ancestor of
      // the session's workDir (the repo root when tests run from the package).
      expect(process.cwd().startsWith(result.projectRoot)).toBe(true);
      // Path resolution may normalize (e.g. macOS /var symlinks) — compare on
      // the unique trailing segment.
      expect(
        result.additionalDirs.some((added) => added.endsWith(dir.split('/').pop()!)),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });
});

describe('session facade cron & secondary model (real engine)', () => {
  let engine: TestEngine;
  let klient: Klient;
  let sessionId: string;

  beforeAll(async () => {
    engine = await makeEngine();
    klient = createKlient({ scope: engine.app });
    await klient.global.config.replaceSections({
      sections: {
        providers: {
          'cron-secondary': {
            type: 'openai',
            baseUrl: 'http://127.0.0.1:1',
            apiKey: 'k',
          },
        },
        models: {
          'cron-secondary/m1': {
            provider: 'cron-secondary',
            model: 'm1',
            maxContextSize: 8192,
          },
        },
        defaultModel: 'cron-secondary/m1',
      },
    });
    const created = await klient.global.sessions.create({
      workDir: process.cwd(),
      title: 'cron & secondary',
    });
    sessionId = created.id;
  });

  afterAll(async () => {
    await klient.close();
    engine.app.dispose();
    await rm(engine.homeDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    });
  });

  it('lists cron tasks with their next fire times', async () => {
    const session = klient.session(sessionId);
    expect((await session.getCronTasks()).tasks).toEqual([]);

    const live = getLiveSessionById(engine.app.accessor, sessionId);
    expect(live).toBeDefined();
    const cron = live!.accessor
      .get(IAgentLifecycleService)
      .handleOf('main')!
      .accessor.get(IAgentCronService);
    const created = cron.addTask({
      cron: '*/5 * * * *',
      prompt: 'ping',
      recurring: true,
    });

    const { tasks } = await session.getCronTasks();
    const found = tasks.find((task) => task.id === created.id);
    expect(found).toBeDefined();
    expect(found!.cron).toBe('*/5 * * * *');
    expect(found!.prompt).toBe('ping');
    // A recurring every-5-minutes schedule always has a future fire.
    expect(typeof found!.nextFireAt).toBe('number');
  });
});

/**
 * Facade additions for the node-sdk v1-surface migration (real engine,
 * memory transport): profile binding/state reads, permission state, context
 * mutation, activations, agent/session lifecycle, workspace trust, export,
 * skill discovery, and the event-bus publish. All pure state operations —
 * no LLM round-trip.
 */
describe('sdk-migration facade additions (real engine)', () => {
  let engine: TestEngine;
  let klient: Klient;
  let sessionId: string;

  beforeAll(async () => {
    engine = await makeEngine();
    klient = createKlient({ scope: engine.app });
    await klient.global.config.replaceSections({
      sections: {
        providers: {
          'sdk-migration': {
            type: 'openai',
            baseUrl: 'http://127.0.0.1:1',
            apiKey: 'k',
          },
        },
        models: {
          'sdk-migration/m1': {
            provider: 'sdk-migration',
            model: 'm1',
            maxContextSize: 8192,
          },
        },
        defaultModel: 'sdk-migration/m1',
      },
    });
    const created = await klient.global.sessions.create({
      workDir: process.cwd(),
      title: 'sdk migration',
    });
    sessionId = created.id;
  });

  afterAll(async () => {
    await klient.close();
    engine.app.dispose();
    await rm(engine.homeDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    });
  });

  it('binds the default profile and exposes the profile snapshot', async () => {
    const agent = klient.session(sessionId).agent('main');
    const before = await agent.getProfileData();
    await agent.bindProfile({ profile: 'agent' });
    const after = await agent.getProfileData();
    expect(after.profileName).toBe('agent');
    expect(after.modelAlias).toBe('sdk-migration/m1');
    expect(after.modelCapabilities.max_context_tokens).toBeGreaterThan(0);
    expect(typeof after.thinkingLevel).toBe('string');
    // A re-bind with an explicit model switches the alias.
    await agent.bindProfile({ profile: 'agent', model: 'sdk-migration/m1' });
    expect((await agent.getProfileData()).modelAlias).toBe('sdk-migration/m1');
    expect(before).toBeDefined();
  });

  it('reads and drives the permission mode, and lists the rules', async () => {
    const agent = klient.session(sessionId).agent('main');
    expect(await agent.getPermissionMode()).toBe('manual');
    await agent.setPermission('auto');
    expect(await agent.getPermissionMode()).toBe('auto');
    await agent.setPermission('manual');
    expect(Array.isArray(await agent.getPermissionRules())).toBe(true);
  });

  it('exposes swarm / loop / activity / compaction state reads', async () => {
    const agent = klient.session(sessionId).agent('main');
    expect(await agent.isSwarmActive()).toBe(false);
    await agent.setSwarmMode(true, 'manual');
    expect(await agent.isSwarmActive()).toBe(true);
    await agent.setSwarmMode(false, 'manual');

    expect((await agent.getLoopStatus()).state).toBe('idle');
    const activity = await agent.getActivityState();
    expect(activity.turn).toBeUndefined();
    expect(await agent.getCompacting()).toBeUndefined();
  });

  it('appends and clears context messages through the memory service', async () => {
    const fresh = await klient.global.sessions.create({
      workDir: process.cwd(),
      title: 'sdk migration context',
    });
    const agent = klient.session(fresh.id).agent('main');
    const before = await agent.getContext();
    await agent.appendContextMessage({
      role: 'user',
      content: [{ type: 'text', text: 'wire-appended' }],
      toolCalls: [],
      origin: { kind: 'user' },
    } as never);
    const after = await agent.getContext();
    expect(after.history.length).toBe(before.history.length + 1);
    await agent.clearContext();
    expect((await agent.getContext()).history.length).toBe(0);
  });

  it('activates a skill with synchronous validation and rejects an unknown one', async () => {
    const agent = klient.session(sessionId).agent('main');
    await expect(agent.activateSkillAwaited('no-such-skill')).rejects.toThrow(/skill/i);
    const skills = await klient.session(sessionId).listSkills();
    const activatable = skills.find(
      (skill) =>
        skill.isSubSkill !== true &&
        (skill.type === undefined || skill.type === 'prompt' || skill.type === 'flow'),
    );
    expect(activatable).toBeDefined();
    await expect(
      agent.activateSkillAwaited(activatable!.name),
    ).resolves.toBeUndefined();
  });

  it('rejects an unknown plugin command and reconnects an unknown MCP server', async () => {
    const agent = klient.session(sessionId).agent('main');
    await expect(
      agent.activatePluginCommand({ pluginId: 'no-such', commandName: 'no-such' }),
    ).rejects.toThrow();
    await expect(
      klient.session(sessionId).reconnectMcpServer('no-such-server'),
    ).rejects.toThrow(/Unknown MCP server|not found|disabled/i);
  });

  it('stops and waits for unknown tasks without stamping a reason', async () => {
    const agent = klient.session(sessionId).agent('main');
    await expect(
      agent.stopTaskWithReason({ taskId: 'no-such-task' }),
    ).resolves.toBeUndefined();
    await expect(agent.waitForTask('no-such-task', 25)).resolves.toBeUndefined();
    await expect(
      agent.suppressTaskTerminalNotification('no-such-task'),
    ).resolves.toBeUndefined();
  });

  it('materializes agents and lists the live roster', async () => {
    const session = klient.session(sessionId);
    await session.materializeAgent('sdk-migration-sub');
    const live = await session.listLiveAgents();
    expect(live).toContain('main');
    expect(live).toContain('sdk-migration-sub');
  });

  it('exposes the session context paths and additional dirs', async () => {
    const session = klient.session(sessionId);
    const ctx = await session.context();
    expect(ctx.cwd.length).toBeGreaterThan(0);
    expect(ctx.sessionDir.length).toBeGreaterThan(0);
    expect(Array.isArray(ctx.additionalDirs)).toBe(true);
  });

  it('resumes a closed session (isLive round-trip) and forks with an explicit id', async () => {
    const session = klient.session(sessionId);
    expect(await session.isLive()).toBe(true);
    await session.close();
    expect(await session.isLive()).toBe(false);
    expect(await session.resume()).toBe(true);
    expect(await session.isLive()).toBe(true);

    const forked = await session.fork({
      newSessionId: 'sdk-migration-fork',
      title: 'fork',
    });
    expect(forked.id).toBe('sdk-migration-fork');
    expect((await klient.global.sessions.get('sdk-migration-fork'))?.id).toBe(
      'sdk-migration-fork',
    );
  });

  it('creates a session with an explicit id', async () => {
    const meta = await klient.global.sessions.create({
      workDir: process.cwd(),
      id: 'sdk-migration-explicit',
      title: 'explicit',
    });
    expect(meta.id).toBe('sdk-migration-explicit');
    expect(meta.title).toBe('explicit');
  });

  it('resolves workspace trust and alias ids', async () => {
    const trustedBefore = await klient.global.workspaces.getTrust(process.cwd());
    await klient.global.workspaces.trust(process.cwd());
    expect(await klient.global.workspaces.getTrust(process.cwd())).toBe(true);
    expect(trustedBefore === true || trustedBefore === false).toBe(true);

    const workspaces = await klient.global.workspaces.list();
    const mine = workspaces.find((workspace) => workspace.root === process.cwd());
    expect(mine).toBeDefined();
    const aliasIds = await klient.global.workspaces.resolveAliasIds(mine!.id);
    expect(aliasIds).toContain(mine!.id);
  });

  it('discovers skills over caller-supplied roots', async () => {
    const home = await klient.global.env();
    const result = await klient.global.skills.discover([
      { path: join(home.osHomeDir, '.agents', 'skills'), source: 'user' },
    ]);
    expect(Array.isArray(result.skills)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
    for (const skill of result.skills) {
      expect(typeof skill.name).toBe('string');
      expect(typeof skill.content).toBe('string');
    }
  });

  it('exports a session as a zip archive', async () => {
    const result = await klient.global.sessions.export({
      sessionId,
      version: '0.0.0-klient-test',
    });
    expect(typeof result.zipPath).toBe('string');
    expect(result.manifest.sessionId).toBe(sessionId);
    await rm(result.zipPath, { force: true });
  });

  it('publishes a global bus event that the events hub delivers', async () => {
    const received: unknown[] = [];
    const sub = klient.events.on('session.metaUpdated', (payload) => {
      received.push(payload);
    });
    try {
      await klient.global.publishEvent({
        type: 'session.meta.updated',
        payload: {
          agentId: 'main',
          sessionId,
          title: 'published',
          patch: { title: 'published', isCustomTitle: false, lastPrompt: 'published' },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received.length).toBe(1);
      expect((received[0] as { sessionId: string }).sessionId).toBe(sessionId);
    } finally {
      sub.dispose();
    }
  });

  it('resolves the relative persistence scope names', async () => {
    expect(await klient.global.envScope('sessions')).toBe('sessions');
  });

  it('rejects replacing an ephemeral MCP name with a session-owned connection', async () => {
    const created = await klient.global.sessions.create({
      workDir: process.cwd(),
      mcpServers: {
        isolated: {
          transport: 'http',
          url: 'http://127.0.0.1:1/mcp',
          enabled: false,
        },
      },
    });
    const session = klient.session(created.id);
    try {
      await expect(
        session.replaceMcpServer('isolated', {
          name: 'isolated',
          transport: 'http',
          url: 'http://127.0.0.1:1/other',
          scope: 'session',
        }),
      ).rejects.toThrow(/Ephemeral/);
    } finally {
      await session.close();
    }
  });

  it('rejects a live MCP scope change before persisting the replacement', async () => {
    await klient.global.mcp.add({
      server: {
        name: 'scope-guard',
        transport: 'http',
        url: 'http://127.0.0.1:1/mcp',
        enabled: false,
      },
      cwd: process.cwd(),
    });
    const created = await klient.global.sessions.create({ workDir: process.cwd() });
    const session = klient.session(created.id);
    try {
      await session.getMcpStartupMetrics();
      await expect(
        session.addMcpServer(
          {
            name: 'scope-guard',
            transport: 'http',
            url: 'http://127.0.0.1:1/other',
            scope: 'session',
          },
          true,
        ),
      ).rejects.toThrow(/Cannot change the scope/);
      expect(
        (await klient.global.mcp.get({ name: 'scope-guard' })).config,
      ).toMatchObject({ url: 'http://127.0.0.1:1/mcp', enabled: false });
    } finally {
      await session.close();
      await klient.global.mcp.remove({ name: 'scope-guard' });
    }
  });
});
