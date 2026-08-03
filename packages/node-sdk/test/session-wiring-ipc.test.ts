/**
 * `SessionEventWiring` over the ipc transport — the milestone-2 proof that
 * the facade-driven bridge is transport-agnostic. A real engine is served on
 * a unix socket via `serveKlientIpc`; the wiring runs against a socket
 * klient while the test drives the engine in-process (parking approval /
 * question interactions, publishing bus events) and asserts the round trip
 * crosses the wire.
 * Run: pnpm exec vitest run test/session-wiring-ipc.test.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrap,
  getLiveSessionById,
  ISessionApprovalService,
  ISessionQuestionService,
  logSeed,
  MAIN_AGENT_ID,
  resolveLoggingConfig,
} from '@moonshot-ai/agent-core-v2';
import { ensureMainAgent } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/mainAgent';
import { IEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';
import type { ApprovalResponse, Event } from '@moonshot-ai/agent-core';
import { createKlient, serveKlientIpc, type KlientIpcHost } from '@moonshot-ai/klient/ipc';
import type { Klient } from '@moonshot-ai/klient';

import { SessionEventWiring, type SessionEventSink } from '#/v2/session-wiring';

const TEST_CLIENT_IDENTITY = {
  productName: 'sdk-wiring-ipc-test',
  version: '0.0.0-test',
  platform: 'test',
} as const;

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`waitFor timed out: ${label}`);
}

describe('SessionEventWiring over ipc', () => {
  let homeDir: string;
  let workDir: string;
  let app: ReturnType<typeof bootstrap>['app'];
  let host: KlientIpcHost;
  let klient: Klient;
  let sessionId: string;
  let wiring: SessionEventWiring;
  const events: Event[] = [];
  const approvalTools: string[] = [];
  const questionTexts: string[] = [];

  const sink: SessionEventSink = {
    receiveEvent: (event) => {
      events.push(event);
    },
    requestApproval: (request) => {
      approvalTools.push(request.toolName);
      const response: ApprovalResponse = { decision: 'approved' };
      return Promise.resolve(response);
    },
    requestQuestion: (request) => {
      questionTexts.push(request.questions[0]?.question ?? '');
      return Promise.resolve({ answers: { 'pick one': 'a' } });
    },
    toolCall: () => Promise.resolve({ output: 'not supported', isError: true }),
  };

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'sdk-wiring-ipc-home-'));
    workDir = await mkdtemp(join(tmpdir(), 'sdk-wiring-ipc-work-'));
    ({ app } = bootstrap({ homeDir, clientIdentity: TEST_CLIENT_IDENTITY }, [
      ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
    ]));
    host = await serveKlientIpc({ scope: app, socketPath: join(homeDir, 'klient.sock') });
    klient = createKlient({ socketPath: host.socketPath });

    await klient.global.config.replaceSections({
      sections: {
        providers: {
          'wiring-ipc': { type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' },
        },
        models: {
          'wiring-ipc/m1': { provider: 'wiring-ipc', model: 'm1', maxContextSize: 8192 },
        },
        defaultModel: 'wiring-ipc/m1',
      },
    });
    const created = await klient.global.sessions.create({ workDir, title: 'wiring ipc' });
    sessionId = created.id;
    // Materialize the main agent before bus events are published.
    await klient.session(sessionId).agent(MAIN_AGENT_ID).getModel();
    wiring = new SessionEventWiring(klient.session(sessionId), sessionId, sink);
  }, 60_000);

  afterAll(async () => {
    wiring.dispose();
    await klient.close();
    await host.close();
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('bridges a parked approval across the socket and resolves the engine requester', async () => {
    const session = getLiveSessionById(app.accessor, sessionId);
    expect(session).toBeDefined();
    const approvals = session!.accessor.get(ISessionApprovalService);
    const requester = approvals.request({
      toolName: 'Bash',
      action: 'run',
      display: { kind: 'shell', command: 'ls' } as never,
    });
    const response = await requester;
    expect(response).toEqual({ decision: 'approved' });
    expect(approvalTools).toContain('Bash');
    expect(approvals.listPending()).toEqual([]);
  }, 30_000);

  it('bridges a parked question across the socket and resolves the engine requester', async () => {
    const session = getLiveSessionById(app.accessor, sessionId);
    const questions = session!.accessor.get(ISessionQuestionService);
    const result = await questions.request({
      questions: [{ question: 'pick one', options: [{ label: 'a' }] }] as never,
    });
    expect(result).toEqual({ answers: { 'pick one': 'a' } });
    expect(questionTexts).toContain('pick one');
  }, 30_000);

  it('forwards raw agent bus events across the socket with v1 stamping', async () => {
    const session = getLiveSessionById(app.accessor, sessionId);
    const agent = await ensureMainAgent(session!);
    const before = events.length;
    agent.accessor.get(IEventBus).publish({
      type: 'assistant.delta',
      turnId: 1,
      delta: 'over-the-wire',
    } as never);
    await waitFor(() => events.length > before, 10_000, 'assistant.delta over ipc');
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({
      type: 'assistant.delta',
      sessionId,
      agentId: MAIN_AGENT_ID,
      delta: 'over-the-wire',
    });
  }, 30_000);
});
