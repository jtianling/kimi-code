/**
 * `SessionEventWiring` — the facade-driven v1 edge over the v2 event stream
 * and interaction kernel. Covers the status-snapshot fold (usage + context +
 * model merged into every `agent.status.updated`, per-agent order preserved
 * under async enrichment) and the approval/question/user-tool bridge
 * (pending interactions fed to the sink, outcomes written back through the
 * typed facades).
 * Run: pnpm exec vitest run test/session-event-wiring.test.ts
 */
import { describe, expect, it } from 'vitest';

import type {
  ApprovalRequest,
  ApprovalResponse,
  Event,
  QuestionResult,
} from '@moonshot-ai/agent-core';
import type { Interaction } from '@moonshot-ai/agent-core-v2';
import type { AgentHandle, SessionHandle } from '@moonshot-ai/klient';

import { SessionEventWiring, type SessionEventSink } from '#/v2/session-wiring';

// ---------------------------------------------------------------------------
// Fakes (structural — the wiring only touches these members)
// ---------------------------------------------------------------------------

type FakeBusEvent = { type: string } & Record<string, unknown>;
type Listener = (payload: never) => void;

class FakeEventHub {
  private readonly handlers = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): { dispose(): void } {
    let set = this.handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(listener);
    return {
      dispose: () => {
        set.delete(listener);
      },
    };
  }

  emit(event: string, payload: unknown): void {
    for (const listener of [...(this.handlers.get(event) ?? [])]) {
      (listener as (p: unknown) => void)(payload);
    }
  }
}

interface FakeAgentOptions {
  readonly model?: string;
  readonly incomplete?: boolean;
}

const USAGE = {
  total: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
};

function makeAgent(id: string, options: FakeAgentOptions = {}): AgentHandle {
  const events = new FakeEventHub();
  const incomplete = options.incomplete === true;
  return {
    id,
    events,
    getUsage: incomplete ? () => Promise.reject(new Error('dead')) : () => Promise.resolve(USAGE),
    getStatusContextSize: incomplete
      ? () => Promise.reject(new Error('dead'))
      : () => Promise.resolve(10),
    getModelCapabilities: incomplete
      ? () => Promise.reject(new Error('dead'))
      : () => Promise.resolve({ max_context_tokens: 128_000 }),
    getModel: incomplete
      ? () => Promise.reject(new Error('dead'))
      : () => Promise.resolve(options.model ?? 'agent-model'),
  } as unknown as AgentHandle & { id: string };
}

interface FakeSession {
  readonly handle: SessionHandle;
  readonly sessionEvents: FakeEventHub;
  readonly agentEvents: Map<string, FakeEventHub>;
  readonly approvalsDecided: Array<{ id: string; response: ApprovalResponse }>;
  readonly questionsAnswered: Array<{ id: string; result: QuestionResult }>;
  readonly questionsDismissed: string[];
  readonly interactionsResponded: Array<{ id: string; response: unknown }>;
  setPending(pending: readonly Interaction[]): void;
}

function makeSession(agentIds: string[], agentOptions: FakeAgentOptions = {}): FakeSession {
  const sessionEvents = new FakeEventHub();
  const agentEvents = new Map<string, FakeEventHub>();
  const agentHandles = new Map<string, AgentHandle>();
  for (const id of agentIds) {
    const handle = makeAgent(id, agentOptions);
    agentHandles.set(id, handle);
    agentEvents.set(id, (handle as unknown as { events: FakeEventHub }).events);
  }
  const fake: FakeSession = {
    sessionEvents,
    agentEvents,
    approvalsDecided: [],
    questionsAnswered: [],
    questionsDismissed: [],
    interactionsResponded: [],
    setPending(pending) {
      sessionEvents.emit('interactions.changed', pending);
    },
    handle: {
      events: sessionEvents,
      agents: () =>
        Promise.resolve(Object.fromEntries(agentIds.map((id) => [id, { id }]))),
      agent: (id: string) => agentHandles.get(id),
      interactions: {
        list: () => Promise.resolve([]),
        respond: (id: string, response: unknown) => {
          fake.interactionsResponded.push({ id, response });
          return Promise.resolve();
        },
      },
      approvals: {
        list: () => Promise.resolve([]),
        decide: (id: string, response: ApprovalResponse) => {
          fake.approvalsDecided.push({ id, response });
          return Promise.resolve();
        },
      },
      questions: {
        list: () => Promise.resolve([]),
        answer: (id: string, result: QuestionResult) => {
          fake.questionsAnswered.push({ id, result });
          return Promise.resolve();
        },
        dismiss: (id: string) => {
          fake.questionsDismissed.push(id);
          return Promise.resolve();
        },
      },
    } as unknown as SessionHandle,
  };
  return fake;
}

function collectingSink(overrides: Partial<SessionEventSink> = {}): {
  sink: SessionEventSink;
  events: Event[];
  approvalRequests: Array<ApprovalRequest & { sessionId: string; agentId: string }>;
} {
  const events: Event[] = [];
  const approvalRequests: Array<ApprovalRequest & { sessionId: string; agentId: string }> = [];
  return {
    events,
    approvalRequests,
    sink: {
      receiveEvent: (event) => {
        events.push(event);
      },
      requestApproval: (request) => {
        approvalRequests.push(request);
        return Promise.resolve({ decision: 'approved' });
      },
      requestQuestion: () => Promise.resolve(null),
      toolCall: () => Promise.resolve({ output: 'not supported', isError: true }),
      ...overrides,
    },
  };
}

/** The wiring delivers asynchronously (per-agent chains + facade calls). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionEventWiring status snapshot fold', () => {
  it('folds a consistent usage + context + model snapshot into every status event, in order', async () => {
    const session = makeSession(['agent-1'], { model: 'sub-model' });
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(session.handle, 's1', sink);
    try {
      await flush();
      session.agentEvents.get('agent-1')!.emit('events.raw', {
        type: 'agent.status.updated',
        usage: USAGE,
      });
      session.agentEvents.get('agent-1')!.emit('events.raw', { type: 'assistant.delta', delta: 'Hi' });
      await flush();
    } finally {
      wiring.dispose();
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'agent.status.updated',
      sessionId: 's1',
      agentId: 'agent-1',
      usage: USAGE,
      contextTokens: 10,
      maxContextTokens: 128_000,
      model: 'sub-model',
    });
    expect(events[1]).toMatchObject({ type: 'assistant.delta', delta: 'Hi' });
    expect(events[1]).not.toHaveProperty('model');
  });

  it('passes the model alias through unresolved (the catalog display-name lookup is in-process only)', async () => {
    const session = makeSession(['agent-1'], { model: 'secondary:derived' });
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(session.handle, 's1', sink);
    try {
      await flush();
      session.agentEvents.get('agent-1')!.emit('events.raw', { type: 'agent.status.updated' });
      await flush();
    } finally {
      wiring.dispose();
    }

    expect(events[0]).toMatchObject({ model: 'secondary:derived' });
  });

  it('passes status events through unchanged when the facade reads fail', async () => {
    const session = makeSession(['agent-1'], { incomplete: true });
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(session.handle, 's1', sink);
    try {
      await flush();
      session.agentEvents.get('agent-1')!.emit('events.raw', {
        type: 'agent.status.updated',
        usage: USAGE,
      });
      await flush();
    } finally {
      wiring.dispose();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'agent.status.updated', usage: USAGE });
    expect(events[0]).not.toHaveProperty('model');
  });
});

describe('SessionEventWiring interaction bridge', () => {
  const approvalInteraction: Interaction = {
    id: 'appr-1',
    kind: 'approval',
    createdAt: 1,
    origin: { agentId: 'main', turnId: 7 },
    payload: {
      toolName: 'Bash',
      action: 'run',
      toolCallId: 'call-1',
      display: { kind: 'generic', detail: { command: 'ls' } },
    },
  } as unknown as Interaction;

  it('feeds a pending approval to the sink and writes the decision back', async () => {
    const session = makeSession([]);
    const { sink, approvalRequests } = collectingSink();
    const wiring = new SessionEventWiring(session.handle, 's1', sink);
    try {
      session.setPending([approvalInteraction]);
      await flush();
    } finally {
      wiring.dispose();
    }

    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({
      sessionId: 's1',
      agentId: 'main',
      toolName: 'Bash',
      toolCallId: 'call-1',
    });
    expect(session.approvalsDecided).toEqual([{ id: 'appr-1', response: { decision: 'approved' } }]);
  });

  it('bridges each pending interaction exactly once across repeated full-set pushes', async () => {
    const session = makeSession([]);
    const { sink, approvalRequests } = collectingSink();
    const wiring = new SessionEventWiring(session.handle, 's1', sink);
    try {
      session.setPending([approvalInteraction]);
      session.setPending([approvalInteraction]);
      await flush();
    } finally {
      wiring.dispose();
    }

    expect(approvalRequests).toHaveLength(1);
    expect(session.approvalsDecided).toHaveLength(1);
  });

  it('dismisses a question when the sink answers null, and answers otherwise', async () => {
    const questionInteraction = {
      id: 'q-1',
      kind: 'question',
      createdAt: 1,
      origin: { agentId: 'main', turnId: 7 },
      payload: { turnId: 7, questions: [{ question: 'pick one', options: [] }] },
    } as unknown as Interaction;

    const nullSession = makeSession([]);
    const nullWiring = new SessionEventWiring(nullSession.handle, 's1', collectingSink().sink);
    nullSession.setPending([questionInteraction]);
    await flush();
    nullWiring.dispose();
    expect(nullSession.questionsDismissed).toEqual(['q-1']);

    const answeredSession = makeSession([]);
    const answeredWiring = new SessionEventWiring(
      answeredSession.handle,
      's1',
      collectingSink({
        requestQuestion: () => Promise.resolve({ answers: { 'pick one': 'a' } }),
      }).sink,
    );
    answeredSession.setPending([questionInteraction]);
    await flush();
    answeredWiring.dispose();
    expect(answeredSession.questionsAnswered).toEqual([
      { id: 'q-1', result: { answers: { 'pick one': 'a' } } },
    ]);
  });

  it('routes user-tool executions to the sink toolCall callback and responds', async () => {
    const userToolInteraction = {
      id: 'ut-1',
      kind: 'user_tool',
      createdAt: 1,
      origin: { agentId: 'main', turnId: 7 },
      payload: { turnId: 7, toolCallId: 'call-9', name: 'custom', args: {} },
    } as unknown as Interaction;

    const session = makeSession([]);
    const wiring = new SessionEventWiring(session.handle, 's1', collectingSink().sink);
    try {
      session.setPending([userToolInteraction]);
      await flush();
    } finally {
      wiring.dispose();
    }

    expect(session.interactionsResponded).toEqual([
      { id: 'ut-1', response: { output: 'not supported', isError: true } },
    ]);
  });
});
