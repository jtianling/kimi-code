import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defineKlientConformance } from './helpers/conformance.js';
import { getLiveSessionById } from '@moonshot-ai/agent-core-v2/app/workspaceLifecycle/sessionLookup';
import { ISessionCronService } from '@moonshot-ai/agent-core-v2/session/cron/sessionCronService';
import type { AgentHandle, Klient } from '../src/index.js';
import { createKlient } from '../src/transports/memory/index.js';
import { createMemoryDispatcher } from '../src/transports/memory/dispatcher.js';
import { RPCError } from '../src/core/errors.js';
import { makeEngine, type TestEngine } from './helpers/engine.js';

defineKlientConformance('memory', async () => {
  const { homeDir, app } = await makeEngine();
  const klient = createKlient({ scope: app });
  return {
    klient,
    cleanup: async () => {
      await klient.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    },
  };
});

describe('memory dispatcher specifics', () => {
  it('rejects unknown services and methods with RPCError(40001)', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(dispatcher.call({}, 'noSuchService', 'get', [])).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    await expect(dispatcher.call({}, 'sessionIndex', 'noSuchMethod', [])).rejects.toMatchObject({
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
          'agent-facade': { type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' },
        },
        models: {
          'agent-facade/m1': { provider: 'agent-facade', model: 'm1', maxContextSize: 8192 },
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
    await rm(engine.homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
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
    await expect(agent.activateSkill(activatable!.name)).resolves.toBeUndefined();
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
          'session-facade': { type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' },
        },
        models: {
          'session-facade/m1': { provider: 'session-facade', model: 'm1', maxContextSize: 8192 },
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
    await rm(engine.homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
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
      expect(['pending', 'connected', 'failed', 'disabled', 'needs-auth']).toContain(server.status);
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
      expect(result.additionalDirs.some((added) => added.endsWith(dir.split('/').pop()!))).toBe(
        true,
      );
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
          'cron-secondary': { type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' },
        },
        models: {
          'cron-secondary/m1': { provider: 'cron-secondary', model: 'm1', maxContextSize: 8192 },
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
    await rm(engine.homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('lists cron tasks with their next fire times', async () => {
    const session = klient.session(sessionId);
    expect((await session.getCronTasks()).tasks).toEqual([]);

    const live = getLiveSessionById(engine.app.accessor, sessionId);
    expect(live).toBeDefined();
    const cron = live!.accessor.get(ISessionCronService);
    const created = cron.addTask({ cron: '*/5 * * * *', prompt: 'ping', recurring: true });

    const { tasks } = await session.getCronTasks();
    const found = tasks.find((task) => task.id === created.id);
    expect(found).toBeDefined();
    expect(found!.cron).toBe('*/5 * * * *');
    expect(found!.prompt).toBe('ping');
    // A recurring every-5-minutes schedule always has a future fire.
    expect(typeof found!.nextFireAt).toBe('number');
  });

  it('rejects applyPersistedSecondaryModel without a persisted recipe', async () => {
    await expect(klient.session(sessionId).applyPersistedSecondaryModel()).rejects.toThrow(
      /persist its recipe/,
    );
  });

  it('rejects an unknown secondary model, then applies a configured one', async () => {
    const session = klient.session(sessionId);
    await klient.global.config.set({ domain: 'secondaryModel', patch: { model: 'no-such-model' } });
    await expect(session.applyPersistedSecondaryModel()).rejects.toThrow(/not configured/);

    await klient.global.config.set({
      domain: 'secondaryModel',
      patch: { model: 'cron-secondary/m1' },
    });
    await expect(session.applyPersistedSecondaryModel()).resolves.toBeUndefined();
  });
});
