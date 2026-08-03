/**
 * Per-live-session event/interaction wiring for the v2 client.
 *
 * One wiring instance per live session, created by `SDKRpcClientV2` when a
 * session materializes (create / resume / fork / reload) and disposed when it
 * closes. Everything goes through the klient facade (`SessionHandle`), so the
 * same wiring works unchanged over the memory transport (in-process engine)
 * and the ipc transport (kap-server over a unix socket) — the two are
 * byte-identical by construction. Two responsibilities:
 *
 * 1. Event forwarding: subscribe every live agent's raw event stream
 *    (`events.raw` — the agents present at wiring time plus every later one,
 *    discovered via `metadata.changed`, so subagents that appear mid-turn are
 *    covered) and push each event through {@link translateDomainEvent} into
 *    the client's `receiveEvent`. The raw stream preserves per-agent emission
 *    order; `agent.status.updated` enrichment is async, so delivery is
 *    serialized per agent to keep that order.
 * 2. The approval / question / user-tool bridge: v1's engine calls the
 *    client's `requestApproval` / `requestQuestion` / `toolCall` callbacks
 *    (push), where v2 parks a pending interaction in the session's interaction
 *    kernel and waits for a response (pull). The bridge watches
 *    `interactions.changed` (the kernel's full pending set on every change),
 *    feeds each new pending interaction to the client callback — the base
 *    class's own public method, so the v1 semantics (the no-handler
 *    cancellation, the handler-failure error event) are inherited verbatim —
 *    and writes the outcome back through the typed session facades. The
 *    kernel's `respond` no-ops on an id that is no longer pending, so a late
 *    answer after a turn cancellation is safe.
 */
import type {
  ApprovalRequest,
  ApprovalResponse,
  Event,
  QuestionRequest,
  QuestionResult,
  ToolCallRequest,
  ToolCallResponse,
  ToolInputDisplay,
} from '@moonshot-ai/agent-core';
import {
  MAIN_AGENT_ID,
  type DomainEvent,
  type IDisposable,
  type Interaction,
} from '@moonshot-ai/agent-core-v2';
import type { AgentHandle, SessionHandle } from '@moonshot-ai/klient';

import { translateDomainEvent } from '#/v2/event-mapper';

/**
 * The client surface the wiring drives — the base class's own public methods,
 * so the v1 handler semantics are reused rather than re-implemented.
 */
export interface SessionEventSink {
  receiveEvent(event: Event): void;
  requestApproval(
    request: ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<ApprovalResponse>;
  requestQuestion(
    request: QuestionRequest & { sessionId: string; agentId: string },
  ): Promise<QuestionResult>;
  toolCall(request: ToolCallRequest): Promise<ToolCallResponse>;
}

/**
 * The v2 approval payload (`agent-core-v2/src/session/approval/approval.ts` —
 * the package index exports only the service identifier, not the model). A
 * superset of v1's `ApprovalRequest`: the extra id/sessionId/agentId fields
 * are stripped when the handler is fed.
 */
interface ApprovalInteractionPayload {
  readonly id?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
}

/** The v2 question payload (`agent-core-v2/src/session/question/question.ts`). */
interface QuestionInteractionPayload {
  readonly id?: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly questions: QuestionRequest['questions'];
}

/** The v2 user-tool execution payload (`agent-core-v2/src/agent/userTool/userToolService.ts`). */
interface UserToolInteractionPayload {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
}

export class SessionEventWiring {
  private readonly disposables: IDisposable[] = [];
  private readonly agentSubscriptions = new Map<string, IDisposable>();
  /** Per-agent serialization tail — see enqueueAgentEvent. */
  private readonly agentEventChains = new Map<string, Promise<void>>();
  /** Pending interactions already handed to the sink (the kernel re-fires the full pending set on every change). */
  private readonly bridgedInteractionIds = new Set<string>();
  private disposed = false;

  constructor(
    private readonly session: SessionHandle,
    private readonly sessionId: string,
    private readonly sink: SessionEventSink,
  ) {
    this.disposables.push(
      this.session.events.on('interactions.changed', (pending) => {
        void this.bridgeNewPendingInteractions(pending);
      }),
      this.session.events.on('metadata.changed', () => {
        void this.syncAgents();
      }),
    );
    // Baselines: catch interactions parked and agents created before this
    // wiring attached (e.g. a resumed session with a pending approval).
    void this.bridgeNewPendingInteractions();
    void this.syncAgents();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    for (const subscription of this.agentSubscriptions.values()) {
      subscription.dispose();
    }
    this.agentSubscriptions.clear();
    this.agentEventChains.clear();
  }

  // ── agent discovery ───────────────────────────────────────────────────────

  /**
   * The wire has no agent-lifecycle stream; the metadata registry (surfaced
   * through `metadata.changed` + `agents()`) is the discovery channel. The
   * initial call doubles as the attach baseline.
   */
  private async syncAgents(): Promise<void> {
    if (this.disposed) return;
    const agents = await this.session.agents();
    if (this.disposed) return;
    for (const agentId of Object.keys(agents)) {
      this.attachAgent(agentId);
    }
    for (const agentId of [...this.agentSubscriptions.keys()]) {
      if (!(agentId in agents)) this.detachAgent(agentId);
    }
  }

  private attachAgent(agentId: string): void {
    if (this.disposed || this.agentSubscriptions.has(agentId)) return;
    const handle = this.session.agent(agentId);
    this.agentSubscriptions.set(
      agentId,
      handle.events.on('events.raw', (event) => {
        this.enqueueAgentEvent(handle, agentId, event as DomainEvent);
      }),
    );
  }

  private detachAgent(agentId: string): void {
    const subscription = this.agentSubscriptions.get(agentId);
    if (subscription === undefined) return;
    this.agentSubscriptions.delete(agentId);
    subscription.dispose();
  }

  // ── event forwarding ──────────────────────────────────────────────────────

  /**
   * The v1 push model delivers synchronously in emission order. The raw
   * stream preserves order per agent, but `agent.status.updated` enrichment
   * is async over the facade — chain per agent so a slow snapshot cannot
   * overtake (or be overtaken by) later events.
   */
  private enqueueAgentEvent(agent: AgentHandle, agentId: string, event: DomainEvent): void {
    const previous = this.agentEventChains.get(agentId) ?? Promise.resolve();
    const next = previous.then(() => this.processAgentEvent(agent, agentId, event));
    this.agentEventChains.set(
      agentId,
      next.catch(() => undefined),
    );
  }

  private async processAgentEvent(
    agent: AgentHandle,
    agentId: string,
    event: DomainEvent,
  ): Promise<void> {
    const enriched =
      event.type === 'agent.status.updated' ? await this.withStatusSnapshot(agent, event) : event;
    const translated = translateDomainEvent(enriched, this.sessionId, agentId);
    if (translated !== undefined && !this.disposed) this.sink.receiveEvent(translated);
  }

  /**
   * Facade edition of the in-process status enrichment: fold a usage +
   * context + model snapshot into every status event, restoring the v1
   * combined-payload contract. Two deliberate degradations versus the
   * in-process version (both recorded in the direction-B roadmap):
   * - `contextTokens` is `contextSize.size` alone; the
   *   `IWireService.getModel(ContextSizeModel)` measured-token floor is not
   *   wire-exposable (a `ModelDef` cannot cross processes).
   * - the secondary-model derived alias is passed through unresolved; the
   *   catalog lookup that maps it to a display name is in-process only.
   * Missing reads (dead agent scope, mid-teardown) drop the enrichment for
   * that event instead of failing the stream.
   */
  private async withStatusSnapshot(agent: AgentHandle, event: DomainEvent): Promise<DomainEvent> {
    const [usage, contextSize, capabilities, model] = await Promise.all([
      agent.getUsage().catch(() => undefined),
      agent.getContextSize().catch(() => undefined),
      agent.getModelCapabilities().catch(() => undefined),
      agent.getModel().catch(() => undefined),
    ]);
    if (usage === undefined || contextSize === undefined) return event;
    return {
      ...event,
      usage,
      contextTokens: contextSize.size,
      maxContextTokens: capabilities?.max_input_tokens ?? capabilities?.max_context_tokens,
      model,
    } as unknown as DomainEvent;
  }

  // ── interaction bridge ────────────────────────────────────────────────────

  private async bridgeNewPendingInteractions(pending?: readonly Interaction[]): Promise<void> {
    if (this.disposed) return;
    const list = pending ?? (await this.session.interactions.list());
    for (const interaction of list) {
      if (this.bridgedInteractionIds.has(interaction.id)) continue;
      this.bridgedInteractionIds.add(interaction.id);
      switch (interaction.kind) {
        case 'approval':
          void this.bridgeApproval(interaction);
          break;
        case 'question':
          void this.bridgeQuestion(interaction);
          break;
        case 'user_tool':
          void this.bridgeUserTool(interaction);
          break;
      }
    }
  }

  /**
   * Feed a pending approval to the client's approval handler (through the
   * base-class `requestApproval`, which owns the no-handler cancellation and
   * the handler-failure error event) and decide the kernel request with the
   * outcome. The kernel notification fires synchronously at park time, so the
   * handler is invoked at the same relative moment as v1's push.
   */
  private async bridgeApproval(interaction: Interaction): Promise<void> {
    const payload = interaction.payload as ApprovalInteractionPayload;
    try {
      const response = await this.sink.requestApproval({
        turnId: payload.turnId,
        toolCallId: payload.toolCallId ?? interaction.id,
        toolName: payload.toolName,
        action: payload.action,
        display: payload.display,
        sessionId: this.sessionId,
        agentId: payload.agentId ?? interaction.origin.agentId ?? MAIN_AGENT_ID,
      });
      await this.session.approvals.decide(interaction.id, response);
    } catch {
      // The session died mid-bridge (close/reload): the parked engine request
      // died with it, and the kernel's `respond` no-ops on an unknown id.
    }
  }

  /**
   * Same bridge for a pending question: the base-class `requestQuestion`
   * answers `null` when no handler is registered or the handler failed —
   * mapped onto the kernel's dismiss, which is how both engines' ask-user
   * tool reads an unanswered question.
   */
  private async bridgeQuestion(interaction: Interaction): Promise<void> {
    const payload = interaction.payload as QuestionInteractionPayload;
    try {
      const result = await this.sink.requestQuestion({
        turnId: payload.turnId,
        toolCallId: payload.toolCallId,
        questions: payload.questions,
        sessionId: this.sessionId,
        agentId: interaction.origin.agentId ?? MAIN_AGENT_ID,
      });
      if (result === null) {
        await this.session.questions.dismiss(interaction.id);
      } else {
        await this.session.questions.answer(interaction.id, result);
      }
    } catch {
      // See bridgeApproval.
    }
  }

  /**
   * Same bridge for a user-tool execution: v1 routes custom tool calls to the
   * client's `toolCall` callback (the base class answers "not supported" with
   * an error output); without this the v2 tool would wait forever.
   */
  private async bridgeUserTool(interaction: Interaction): Promise<void> {
    const payload = interaction.payload as UserToolInteractionPayload;
    try {
      const result = await this.sink.toolCall({
        turnId: payload.turnId,
        toolCallId: payload.toolCallId,
        args: payload.args,
      });
      await this.session.interactions.respond(interaction.id, result);
    } catch {
      // See bridgeApproval.
    }
  }
}
