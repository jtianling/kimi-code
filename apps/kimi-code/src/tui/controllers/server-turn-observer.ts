/**
 * ServerTurnObserver — watches the active session for turns driven by a local
 * kimi server process (external REST prompt injection) and keeps the TUI in
 * sync with them.
 *
 * The interactive TUI runs its own in-process engine, so the server never sees
 * TUI-driven turns; consequently every turn event arriving on this WebSocket
 * is external by definition. Flow:
 *
 *   1. Discover a live local kap-server via the instance registry
 *      (`<home>/server/instances`) and the home bearer token
 *      (`<home>/server.token`).
 *   2. Connect to `/api/v1/ws` and subscribe to the active session. A session
 *      that is cold in the server process answers `not_found`; the subscribe
 *      is retried until an external injection makes it live.
 *   3. While an external turn runs, prompts are queued (the host gates on
 *      {@link externalTurnActive}); when it ends, the host reloads the session
 *      from disk and re-renders the transcript so the injected turn becomes
 *      visible and the in-process engine context includes it.
 *
 * Gated by the `tui-server-sync` experimental flag; with no live server (or
 * the flag off) the observer is inert and the TUI behaves exactly as before.
 */

import type { Session } from '@moonshot-ai/kimi-code-sdk';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isExperimentalFlagEnabled } from '../commands/experimental-flags';
import type { AppState } from '../types';

const SERVER_SYNC_FLAG = 'tui-server-sync';
const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';
/** Cold-session subscribe retry cadence (one small WS control frame). */
const SUBSCRIBE_RETRY_MS = 3_000;
/** Instance-registry re-scan cadence while no server is running. */
const DISCOVER_RETRY_MS = 15_000;
const RECONNECT_MAX_MS = 30_000;
/** After this long in one external turn, remind the user of the Esc escape hatch. */
const EXTERNAL_TURN_NUDGE_MS = 5 * 60_000;

/** Minimal structural view of the WHATWG WebSocket client (Node >= 22 global). */
export interface WsClient {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

export type WsCtor = new (url: string, protocols?: string | string[]) => WsClient;

/** Injection points for tests; production uses the real registry / fs / global. */
export interface ServerTurnObserverDeps {
  readonly listInstances?: (
    homeDir: string,
  ) => Promise<ReadonlyArray<{ readonly host: string; readonly port: number }>>;
  readonly readToken?: (homeDir: string) => Promise<string | undefined>;
  readonly webSocket?: WsCtor;
}

interface SessionCursor {
  seq: number;
  epoch?: string;
}

interface ServerFrame {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly seq?: unknown;
  readonly epoch?: unknown;
  readonly volatile?: unknown;
  readonly session_id?: unknown;
  readonly payload?: unknown;
}

export interface ServerTurnObserverHost {
  readonly harness: { readonly homeDir: string };
  readonly session: Session | undefined;
  readonly state: {
    readonly appState: Pick<AppState, 'streamingPhase' | 'isReplaying' | 'isCompacting'>;
  };
  showStatus(message: string, color?: 'warning'): void;
  /** Reload the session from disk and re-render; false = busy or failed. */
  refreshSessionFromServerTurn(): Promise<boolean>;
  /** Release one queued message (used after the input gate is released). */
  drainOneQueuedMessage(): void;
}

export class ServerTurnObserver {
  private sessionId: string | undefined;
  private ws: WsClient | undefined;
  private helloDone = false;
  private accepted = false;
  /** The session answered `not_found` at least once — it was cold in the
   * server process, so a later acceptance means an injection just landed. */
  private sawColdSession = false;
  private cursor: SessionCursor | undefined;
  private pendingSubscribeId: string | undefined;
  private msgSeq = 0;
  private reconnectAttempts = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  private externalActive = false;
  /** User pressed Esc to opt out of queueing for the current external turn. */
  private gateReleased = false;
  private pendingRefresh = false;
  private refreshing = false;
  private disposed = false;

  constructor(
    private readonly host: ServerTurnObserverHost,
    private readonly deps: ServerTurnObserverDeps = {},
  ) {}

  /** True while a server-driven turn is running and the input gate holds. */
  get externalTurnActive(): boolean {
    return this.externalActive && !this.gateReleased;
  }

  /**
   * Esc escape hatch: stop queueing input for the current external turn (the
   * turn keeps running server-side and may then run concurrently with the
   * user's own turns). Returns true when there was a gate to release.
   */
  releaseGate(): boolean {
    if (!this.externalActive || this.gateReleased) return false;
    this.gateReleased = true;
    this.clearNudge();
    this.host.showStatus(
      'External-turn input gate released; new input may run concurrently with the external turn.',
      'warning',
    );
    if (this.hostIdle()) this.host.drainOneQueuedMessage();
    return true;
  }

  /** Attach to a session (undefined detaches). Resets all connection state. */
  setSessionId(sessionId: string | undefined): void {
    if (this.disposed || sessionId === this.sessionId) return;
    this.teardown();
    this.sessionId = sessionId;
    if (sessionId === undefined || !isExperimentalFlagEnabled(SERVER_SYNC_FLAG)) return;
    this.schedule(0, () => this.discover());
  }

  /** Host busy-state changed; run a refresh that was deferred while busy. */
  onHostBusyChanged(): void {
    if (!this.pendingRefresh || this.externalActive || this.refreshing) return;
    if (!this.hostIdle()) return;
    void this.doRefresh();
  }

  dispose(): void {
    this.disposed = true;
    this.teardown();
    this.sessionId = undefined;
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  private teardown(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const ws = this.ws;
    this.ws = undefined;
    if (ws !== undefined) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close(1000);
      } catch {
        // best effort — the socket may already be closed.
      }
    }
    this.clearNudge();
    this.helloDone = false;
    this.accepted = false;
    this.sawColdSession = false;
    this.cursor = undefined;
    this.pendingSubscribeId = undefined;
    this.reconnectAttempts = 0;
    this.externalActive = false;
    this.gateReleased = false;
    this.pendingRefresh = false;
  }

  private schedule(delayMs: number, task: () => void): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      task();
    }, delayMs);
  }

  private async discover(): Promise<void> {
    const sessionId = this.sessionId;
    if (this.disposed || sessionId === undefined) return;
    const homeDir = this.host.harness.homeDir;
    let target: { readonly host: string; readonly port: number } | undefined;
    try {
      target = (await this.listInstances(homeDir))[0];
    } catch {
      target = undefined;
    }
    if (this.disposed || this.sessionId !== sessionId) return;
    if (target === undefined) {
      this.schedule(DISCOVER_RETRY_MS, () => void this.discover());
      return;
    }
    const token = await (this.deps.readToken ?? readHomeToken)(homeDir);
    if (this.disposed || this.sessionId !== sessionId) return;
    const host = target.host === '0.0.0.0' || target.host === '::' ? '127.0.0.1' : target.host;
    this.connect(`ws://${host}:${String(target.port)}/api/v1/ws`, token);
  }

  private async listInstances(
    homeDir: string,
  ): Promise<ReadonlyArray<{ readonly host: string; readonly port: number }>> {
    if (this.deps.listInstances !== undefined) return this.deps.listInstances(homeDir);
    // Deferred so the server package's module graph only loads when the flag
    // is on and a discovery tick actually runs.
    const { listLiveServerInstances } = await import('@moonshot-ai/kap-server');
    return listLiveServerInstances(homeDir);
  }

  private connect(url: string, token: string | undefined): void {
    const ctor = this.deps.webSocket ?? (globalThis as { WebSocket?: WsCtor }).WebSocket;
    if (ctor === undefined) return; // Node without a global WebSocket — feature off.
    let ws: WsClient;
    try {
      ws = new ctor(url, token !== undefined ? [`${WS_BEARER_PROTOCOL_PREFIX}${token}`] : undefined);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame;
      } catch {
        return;
      }
      this.handleFrame(frame);
    };
    ws.onerror = () => {
      // The close event follows; reconnect is scheduled there.
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.helloDone = false;
      this.accepted = false;
      this.pendingSubscribeId = undefined;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.sessionId === undefined) return;
    const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    // Rediscover: the server may have restarted on a different port.
    this.schedule(delay, () => void this.discover());
  }

  // ---------------------------------------------------------------------------
  // Protocol
  // ---------------------------------------------------------------------------

  private handleFrame(frame: ServerFrame): void {
    if (this.disposed || typeof frame.type !== 'string') return;
    switch (frame.type) {
      case 'server_hello': {
        this.reconnectAttempts = 0;
        this.send({
          type: 'client_hello',
          id: this.nextId(),
          payload: { client_id: `kimi-tui-${String(process.pid)}`, subscriptions: [] },
        });
        this.helloDone = true;
        this.trySubscribe();
        return;
      }
      case 'ping': {
        const nonce = (frame.payload as { nonce?: unknown } | undefined)?.nonce;
        this.send({ type: 'pong', payload: { nonce } });
        return;
      }
      case 'ack':
        this.handleAck(frame);
        return;
      case 'resync_required': {
        const payload = frame.payload as
          | { session_id?: unknown; current_seq?: unknown; epoch?: unknown }
          | undefined;
        if (payload === undefined || payload.session_id !== this.sessionId) return;
        const hadBaseline = this.cursor !== undefined;
        if (typeof payload.current_seq === 'number') {
          this.cursor = {
            seq: payload.current_seq,
            epoch: typeof payload.epoch === 'string' ? payload.epoch : undefined,
          };
        }
        // The gap contents are unknowable; with an established baseline the
        // safe move is one refresh from disk.
        if (hadBaseline) this.requestRefresh();
        return;
      }
      default:
        this.handleEventEnvelope(frame);
    }
  }

  private handleAck(frame: ServerFrame): void {
    if (frame.id !== this.pendingSubscribeId) return;
    this.pendingSubscribeId = undefined;
    const sessionId = this.sessionId;
    if (sessionId === undefined) return;
    const payload = frame.payload as
      | {
          accepted?: unknown;
          not_found?: unknown;
          cursors?: Record<string, SessionCursor>;
        }
      | undefined;
    const accepted = Array.isArray(payload?.accepted) && payload.accepted.includes(sessionId);
    if (!accepted) {
      this.sawColdSession = true;
      this.schedule(SUBSCRIBE_RETRY_MS, () => this.trySubscribe());
      return;
    }
    this.accepted = true;
    const hadCursor = this.cursor !== undefined;
    const serverCursor = payload?.cursors?.[sessionId];
    if (serverCursor !== undefined && !hadCursor) this.cursor = { ...serverCursor };
    // Cold → live transition with no replay baseline: the session was made
    // live by an external injection, and a fast turn may already be over —
    // refresh once so nothing is missed. With a baseline the subscribe replay
    // has already delivered the missed turn.* events instead.
    if (this.sawColdSession && !hadCursor && !this.externalActive) this.requestRefresh();
  }

  private trySubscribe(): void {
    if (this.disposed || this.accepted || !this.helloDone) return;
    const sessionId = this.sessionId;
    if (sessionId === undefined || this.ws === undefined) return;
    const id = this.nextId();
    this.pendingSubscribeId = id;
    this.send({
      type: 'subscribe',
      id,
      payload: {
        session_ids: [sessionId],
        cursors: this.cursor !== undefined ? { [sessionId]: this.cursor } : undefined,
      },
    });
    // Re-fire until the ack lands (or reports not_found and re-schedules).
    this.schedule(SUBSCRIBE_RETRY_MS, () => this.trySubscribe());
  }

  private handleEventEnvelope(frame: ServerFrame): void {
    if (frame.session_id !== this.sessionId) return;
    if (frame.volatile !== true && typeof frame.seq === 'number') {
      this.cursor = {
        seq: frame.seq,
        epoch: typeof frame.epoch === 'string' ? frame.epoch : this.cursor?.epoch,
      };
    }
    if (frame.type === 'turn.started') {
      if (!this.externalActive) {
        this.externalActive = true;
        this.gateReleased = false;
        this.host.showStatus(
          'Session is being driven by another client (server); input will be queued.',
        );
        this.scheduleNudge();
      }
      return;
    }
    if (frame.type === 'turn.ended') {
      // A turn.ended without a seen turn.started (subscribed mid-turn) still
      // means the on-disk session moved — refresh either way.
      this.externalActive = false;
      this.gateReleased = false;
      this.clearNudge();
      this.requestRefresh();
    }
  }

  /** One reminder per external turn that Esc unlocks the input gate. */
  private scheduleNudge(): void {
    this.clearNudge();
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = undefined;
      if (!this.externalActive || this.gateReleased) return;
      this.host.showStatus(
        'External turn still running after 5 minutes; press Esc to unlock input (it may then run concurrently).',
        'warning',
      );
    }, EXTERNAL_TURN_NUDGE_MS);
  }

  private clearNudge(): void {
    if (this.nudgeTimer !== undefined) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Refresh orchestration
  // ---------------------------------------------------------------------------

  private hostIdle(): boolean {
    const { streamingPhase, isReplaying, isCompacting } = this.host.state.appState;
    return streamingPhase === 'idle' && !isReplaying && !isCompacting;
  }

  private requestRefresh(): void {
    if (this.disposed || this.host.session === undefined) return;
    if (!this.hostIdle() || this.refreshing) {
      this.pendingRefresh = true;
      this.host.showStatus('Session was updated by another client; refreshing when idle.');
      return;
    }
    void this.doRefresh();
  }

  private async doRefresh(): Promise<void> {
    this.pendingRefresh = false;
    this.refreshing = true;
    let ok = false;
    try {
      ok = await this.host.refreshSessionFromServerTurn();
    } finally {
      this.refreshing = false;
    }
    // A refresh that lost a race (host became busy / reload rejected) retries
    // on the next idle transition.
    if (!ok && !this.disposed) this.pendingRefresh = true;
  }

  private send(msg: unknown): void {
    const ws = this.ws;
    if (ws === undefined) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket closing race — the close handler owns recovery.
    }
  }

  private nextId(): string {
    this.msgSeq += 1;
    return `tui_${String(this.msgSeq)}`;
  }
}

/** The home-wide bearer token (`<home>/server.token`); undefined when absent. */
async function readHomeToken(homeDir: string): Promise<string | undefined> {
  try {
    const token = (await readFile(join(homeDir, 'server.token'), 'utf8')).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}
