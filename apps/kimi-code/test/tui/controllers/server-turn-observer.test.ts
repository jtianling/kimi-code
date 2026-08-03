import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ServerTurnObserver,
  type ServerTurnObserverHost,
  type WsClient,
} from '#/tui/controllers/server-turn-observer';
import { setExperimentalFeatures } from '#/tui/commands/experimental-flags';

class FakeWs implements WsClient {
  static instances: FakeWs[] = [];
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWs.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  lastOfType(type: string): Record<string, unknown> | undefined {
    return this.sent.toReversed().find((m) => m['type'] === type);
  }
}

interface HostAppState {
  streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing' | 'shell';
  isReplaying: boolean;
  isCompacting: boolean;
}

function makeHost() {
  const appState: HostAppState = {
    streamingPhase: 'idle',
    isReplaying: false,
    isCompacting: false,
  };
  const statuses: string[] = [];
  const spinner = {
    starts: 0,
    labels: [] as string[],
    stops: [] as Array<{ ok: boolean; label: string }>,
  };
  const refresh = vi.fn(async () => true);
  const drain = vi.fn();
  const host = {
    harness: { homeDir: '/tmp/kimi-home' },
    session: { id: 'sess-1' } as unknown as ServerTurnObserverHost['session'],
    state: { appState },
    showStatus: (message: string) => {
      statuses.push(message);
    },
    showProgressSpinner: (label: string) => {
      spinner.starts += 1;
      spinner.labels.push(label);
      return {
        setLabel: (next: string) => spinner.labels.push(next),
        stop: (opts: { ok: boolean; label: string }) => spinner.stops.push(opts),
      };
    },
    refreshSessionFromServerTurn: refresh,
    drainOneQueuedMessage: drain,
  };
  return {
    host: host as unknown as ServerTurnObserverHost,
    appState,
    statuses,
    spinner,
    refresh,
    drain,
  };
}

function makeObserver(host: ServerTurnObserverHost) {
  return new ServerTurnObserver(host, {
    listInstances: vi.fn(async () => [{ host: '127.0.0.1', port: 58627 }]),
    readToken: vi.fn(async () => 'tok-1'),
    webSocket: FakeWs as unknown as new (url: string, protocols?: string | string[]) => WsClient,
  });
}

/** Drive discovery (async) + handshake up to an established socket. */
async function connect(observer: ServerTurnObserver): Promise<FakeWs> {
  observer.setSessionId('sess-1');
  await vi.advanceTimersByTimeAsync(0);
  const ws = FakeWs.instances.at(-1);
  expect(ws).toBeDefined();
  ws!.receive({
    type: 'server_hello',
    timestamp: new Date().toISOString(),
    payload: { ws_connection_id: 'c1', protocol_version: 2, max_event_buffer_size: 1000 },
  });
  return ws!;
}

function ackSubscribe(
  ws: FakeWs,
  payload: { accepted?: string[]; not_found?: string[]; cursors?: Record<string, unknown> },
): void {
  const sub = ws.lastOfType('subscribe');
  expect(sub).toBeDefined();
  ws.receive({
    type: 'ack',
    id: sub!['id'],
    code: 0,
    msg: 'success',
    payload: { accepted: [], not_found: [], resync_required: [], ...payload },
  });
}

function envelope(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type,
    seq: 10,
    epoch: 'e1',
    session_id: 'sess-1',
    timestamp: new Date().toISOString(),
    payload: { type },
    ...extra,
  };
}

describe('ServerTurnObserver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWs.instances = [];
    setExperimentalFeatures([{ id: 'tui-server-sync', enabled: true }]);
  });

  afterEach(() => {
    vi.useRealTimers();
    setExperimentalFeatures([]);
  });

  it('does nothing when the flag is disabled', async () => {
    setExperimentalFeatures([{ id: 'tui-server-sync', enabled: false }]);
    const { host } = makeHost();
    const observer = makeObserver(host);
    observer.setSessionId('sess-1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWs.instances).toHaveLength(0);
    observer.dispose();
  });

  it('handshakes with bearer subprotocol and subscribes to the session', async () => {
    const { host } = makeHost();
    const observer = makeObserver(host);
    const ws = await connect(observer);
    expect(ws.protocols).toEqual(['kimi-code.bearer.tok-1']);
    expect(ws.lastOfType('client_hello')).toBeDefined();
    const sub = ws.lastOfType('subscribe');
    expect(sub?.['payload']).toMatchObject({ session_ids: ['sess-1'] });
    observer.dispose();
  });

  it('retries a not_found (cold) subscription and refreshes once accepted', async () => {
    const { host, refresh } = makeHost();
    const observer = makeObserver(host);
    const ws = await connect(observer);
    ackSubscribe(ws, { not_found: ['sess-1'] });
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(ws.sent.filter((m) => m['type'] === 'subscribe').length).toBeGreaterThanOrEqual(2);
    ackSubscribe(ws, { accepted: ['sess-1'], cursors: { 'sess-1': { seq: 5, epoch: 'e1' } } });
    await vi.advanceTimersByTimeAsync(0);
    // Cold → live transition means an injection just landed; one refresh
    // covers a turn that finished before the subscription was accepted.
    expect(refresh).toHaveBeenCalledTimes(1);
    observer.dispose();
  });

  it('flags an external turn, queues via the gate, and refreshes on turn end', async () => {
    const { host, refresh, statuses } = makeHost();
    const observer = makeObserver(host);
    const ws = await connect(observer);
    ackSubscribe(ws, { accepted: ['sess-1'], cursors: { 'sess-1': { seq: 5, epoch: 'e1' } } });

    ws.receive(envelope('turn.started'));
    expect(observer.externalTurnActive).toBe(true);
    expect(statuses.some((s) => s.includes('another client'))).toBe(true);

    ws.receive(envelope('turn.ended', { seq: 12 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.externalTurnActive).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    observer.dispose();
  });

  it('defers the refresh while the host is busy and runs it on idle', async () => {
    const { host, appState, refresh } = makeHost();
    const observer = makeObserver(host);
    const ws = await connect(observer);
    ackSubscribe(ws, { accepted: ['sess-1'], cursors: { 'sess-1': { seq: 5, epoch: 'e1' } } });

    appState.streamingPhase = 'thinking';
    ws.receive(envelope('turn.started'));
    ws.receive(envelope('turn.ended', { seq: 12 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();

    appState.streamingPhase = 'idle';
    observer.onHostBusyChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    observer.dispose();
  });

  it('ignores frames for other sessions', async () => {
    const { host, refresh } = makeHost();
    const observer = makeObserver(host);
    const ws = await connect(observer);
    ackSubscribe(ws, { accepted: ['sess-1'], cursors: { 'sess-1': { seq: 5, epoch: 'e1' } } });

    ws.receive(envelope('turn.started', { session_id: 'other' }));
    expect(observer.externalTurnActive).toBe(false);
    ws.receive(envelope('turn.ended', { session_id: 'other' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
    observer.dispose();
  });

  it('resubscribes with the tracked cursor after a reconnect', async () => {
    const { host } = makeHost();
    const observer = makeObserver(host);
    const ws = await connect(observer);
    ackSubscribe(ws, { accepted: ['sess-1'], cursors: { 'sess-1': { seq: 5, epoch: 'e1' } } });
    ws.receive(envelope('turn.started', { seq: 7 }));

    ws.onclose?.();
    await vi.advanceTimersByTimeAsync(1_000);
    const ws2 = FakeWs.instances.at(-1)!;
    expect(ws2).not.toBe(ws);
    ws2.receive({
      type: 'server_hello',
      timestamp: new Date().toISOString(),
      payload: { ws_connection_id: 'c2', protocol_version: 2, max_event_buffer_size: 1000 },
    });
    const sub = ws2.lastOfType('subscribe');
    expect(sub?.['payload']).toMatchObject({
      session_ids: ['sess-1'],
      cursors: { 'sess-1': { seq: 7, epoch: 'e1' } },
    });
    observer.dispose();
  });

  it('nudges about the Esc escape hatch after five minutes of one external turn', async () => {
    const { host, statuses } = makeHost();
    const observer = makeObserver(host);
    const ws = await connect(observer);
    ackSubscribe(ws, { accepted: ['sess-1'], cursors: { 'sess-1': { seq: 5, epoch: 'e1' } } });

    ws.receive(envelope('turn.started'));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(statuses.some((s) => s.includes('press Esc to unlock input'))).toBe(true);

    ws.receive(envelope('turn.ended', { seq: 12 }));
    await vi.advanceTimersByTimeAsync(0);
    observer.dispose();
  });

  it('Esc releases the gate, drains a queued message, and re-engages next turn', async () => {
    const { host, statuses, drain, refresh } = makeHost();
    const observer = makeObserver(host);
    const ws = await connect(observer);
    ackSubscribe(ws, { accepted: ['sess-1'], cursors: { 'sess-1': { seq: 5, epoch: 'e1' } } });

    expect(observer.releaseGate()).toBe(false);

    ws.receive(envelope('turn.started'));
    expect(observer.externalTurnActive).toBe(true);
    expect(observer.releaseGate()).toBe(true);
    expect(observer.externalTurnActive).toBe(false);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(statuses.some((s) => s.includes('gate released'))).toBe(true);
    expect(observer.releaseGate()).toBe(false);

    // The still-running turn ends: refresh happens as usual.
    ws.receive(envelope('turn.ended', { seq: 12 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);

    // A fresh external turn re-engages the gate.
    ws.receive(envelope('turn.started', { seq: 14 }));
    expect(observer.externalTurnActive).toBe(true);
    observer.dispose();
  });

  it('shows a live progress line across step/tool events and finalizes on turn end', async () => {
    const { host, spinner } = makeHost();
    const observer = makeObserver(host);
    const ws = await connect(observer);
    ackSubscribe(ws, { accepted: ['sess-1'], cursors: { 'sess-1': { seq: 5, epoch: 'e1' } } });

    ws.receive(envelope('turn.started'));
    expect(spinner.starts).toBe(1);

    ws.receive(envelope('turn.step.started', { payload: { step: 1 } }));
    expect(spinner.labels.at(-1)).toBe('External turn · step 1 · thinking…');

    ws.receive(envelope('tool.call.started', { payload: { name: 'Bash', args: {} } }));
    expect(spinner.labels.at(-1)).toBe('External turn · step 1 · Bash…');

    ws.receive(envelope('tool.call.started', { payload: { name: 'Read', args: {} } }));
    ws.receive(envelope('turn.step.started', { payload: { step: 2 } }));
    expect(spinner.labels.at(-1)).toBe('External turn · step 2 · thinking…');

    ws.receive(
      envelope('turn.step.retrying', {
        payload: { nextAttempt: 2, maxAttempts: 3, errorName: 'ETIMEDOUT' },
      }),
    );
    expect(spinner.labels.at(-1)).toBe('External turn · step 2 · retrying 2/3: ETIMEDOUT…');

    ws.receive(envelope('turn.ended', { seq: 12, payload: { reason: 'completed' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(spinner.stops).toEqual([{ ok: true, label: 'External turn completed (2 tool calls).' }]);
    observer.dispose();
  });

  it('a mid-turn subscribe raises the gate and progress line from a tool event', async () => {
    const { host, spinner, statuses } = makeHost();
    const observer = makeObserver(host);
    const ws = await connect(observer);
    ackSubscribe(ws, { accepted: ['sess-1'], cursors: { 'sess-1': { seq: 5, epoch: 'e1' } } });

    ws.receive(envelope('tool.call.started', { payload: { name: 'Bash', args: {} } }));
    expect(observer.externalTurnActive).toBe(true);
    expect(statuses.some((s) => s.includes('another client'))).toBe(true);
    expect(spinner.starts).toBe(1);
    expect(spinner.labels.at(-1)).toBe('External turn · Bash…');

    ws.receive(envelope('turn.ended', { seq: 12, payload: { reason: 'failed' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(spinner.stops).toEqual([{ ok: false, label: 'External turn failed (1 tool call).' }]);
    observer.dispose();
  });

  it('re-creates the progress line after a mid-turn resync refresh', async () => {
    const { host, spinner, refresh } = makeHost();
    const observer = makeObserver(host);
    const ws = await connect(observer);
    ackSubscribe(ws, { accepted: ['sess-1'], cursors: { 'sess-1': { seq: 5, epoch: 'e1' } } });

    ws.receive(envelope('turn.started'));
    ws.receive(envelope('tool.call.started', { payload: { name: 'Bash', args: {} } }));
    expect(spinner.starts).toBe(1);

    // The refresh clears the transcript and disposes the live spinner.
    ws.receive({
      type: 'resync_required',
      payload: { session_id: 'sess-1', current_seq: 20, epoch: 'e2' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(observer.externalTurnActive).toBe(true);

    // The next intermediate event resurrects the line instead of updating a
    // disposed component; the tool count survives.
    ws.receive(envelope('tool.call.started', { seq: 21, payload: { name: 'Read', args: {} } }));
    expect(spinner.starts).toBe(2);
    expect(spinner.labels.at(-1)).toBe('External turn · Read…');

    ws.receive(envelope('turn.ended', { seq: 22, payload: { reason: 'completed' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(spinner.stops).toEqual([{ ok: true, label: 'External turn completed (2 tool calls).' }]);
    observer.dispose();
  });

  it('finalizes a cancelled turn with a neutral tone', async () => {
    const { host, spinner } = makeHost();
    const observer = makeObserver(host);
    const ws = await connect(observer);
    ackSubscribe(ws, { accepted: ['sess-1'], cursors: { 'sess-1': { seq: 5, epoch: 'e1' } } });

    ws.receive(envelope('turn.started'));
    ws.receive(envelope('turn.ended', { seq: 12, payload: { reason: 'cancelled' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(spinner.stops).toEqual([
      { ok: true, label: 'External turn cancelled (0 tool calls).' },
    ]);
    observer.dispose();
  });

  it('dispose closes the socket and stops all timers', async () => {
    const { host } = makeHost();
    const observer = makeObserver(host);
    const ws = await connect(observer);
    observer.dispose();
    expect(ws.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWs.instances).toHaveLength(1);
  });
});

describe('remote (one-engine) mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWs.instances.length = 0;
    setExperimentalFeatures([{ id: 'tui-server-sync', enabled: true }]);
  });

  afterEach(() => {
    vi.useRealTimers();
    setExperimentalFeatures([]);
  });

  it('stays inert even with the sync flag enabled', async () => {
    const { host } = makeHost();
    (host as { remoteEngine: boolean }).remoteEngine = true;
    const observer = makeObserver(host);
    observer.setSessionId('sess-1');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWs.instances).toHaveLength(0);
    observer.dispose();
  });
});
