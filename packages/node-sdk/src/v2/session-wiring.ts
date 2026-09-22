import { log } from '#/logging/index';
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
import {
  MAIN_AGENT_ID,
  type Event2,
  type IDisposable,
  type Interaction,
} from '@moonshot-ai/agent-core-v2';
import type { Event } from '@moonshot-ai/agent-core-v2/events';
import type { ToolInputDisplay } from '@moonshot-ai/agent-core-v2/tool/toolInputDisplay';
import type { AgentHandle, SessionHandle } from '@moonshot-ai/klient';

import type {
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
  ToolCallRequest,
  ToolCallResponse,
} from '#/interaction';
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
 * The v2 approval payload (`agent-core-v2/src/agent/interaction/approval.ts` —
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

/** The v2 question payload (`agent-core-v2/src/agent/interaction/question.ts`). */
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
  /** Per-agent serialization tail — see enqueueAgentEvent. */
  private readonly agentHandles = new Map<string, AgentHandle>();
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
      this.session.events.on('agents.raw', ({ agentId, event }) => {
        const agent = this.agentHandles.get(agentId) ?? this.session.agent(agentId);
        this.agentHandles.set(agentId, agent);
        this.enqueueAgentEvent(agent, agentId, event as unknown as Event2<any>);
      }),
      this.session.events.on('interactions.resolved', ({ id }) => {
        this.bridgedInteractionIds.delete(id);
      }),
      this.session.events.onError((error) => {
        log.warn('Session event subscription failed', {
          sessionId,
          error: String(error),
        });
      }),
    );
    // Baselines: catch interactions parked and agents created before this
    // wiring attached (e.g. a resumed session with a pending approval).
    void this.bridgeNewPendingInteractions().catch((error) => {
      log.warn('Session interaction baseline failed', {
        sessionId,
        error: String(error),
      });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.agentEventChains.clear();
    this.agentHandles.clear();
  }

  // ── event forwarding ──────────────────────────────────────────────────────

  /**
   * The v1 push model delivers synchronously in emission order. The raw
   * stream preserves order per agent, but `agent.status.updated` enrichment
   * is async over the facade — chain per agent so a slow snapshot cannot
   * overtake (or be overtaken by) later events.
   */
  private enqueueAgentEvent(
    agent: AgentHandle,
    agentId: string,
    event: Event2<any>,
  ): void {
    const previous = this.agentEventChains.get(agentId) ?? Promise.resolve();
    const next = previous.then(() => this.processAgentEvent(agent, agentId, event));
    this.agentEventChains.set(
      agentId,
      next.catch((error) => {
        log.warn('Session event forwarding failed', {
          sessionId: this.sessionId,
          agentId,
          error: String(error),
        });
      }),
    );
  }

  private async processAgentEvent(
    agent: AgentHandle,
    agentId: string,
    event: Event2<any>,
  ): Promise<void> {
    const enriched =
      event.type === 'agent.status.updated'
        ? await this.withStatusSnapshot(agent, event)
        : event;
    const translated = translateDomainEvent(enriched, this.sessionId, agentId);
    if (translated !== undefined && !this.disposed) this.sink.receiveEvent(translated);
  }

  /**
   * Facade edition of the in-process status enrichment: fold a usage +
   * context + model snapshot into every status event, restoring the v1
   * combined-payload contract. One deliberate degradation versus the
   * in-process version (recorded in the direction-B roadmap):
   * - the secondary-model derived alias is passed through unresolved; the
   *   catalog lookup that maps it to a display name is in-process only.
   * Missing reads (dead agent scope, mid-teardown) drop the enrichment for
   * that event instead of failing the stream.
   */
  private async withStatusSnapshot(
    agent: AgentHandle,
    event: Event2<any>,
  ): Promise<Event2<any>> {
    const [usage, contextTokens, capabilities, model] = await Promise.all([
      agent.getUsage().catch(() => undefined),
      agent.getStatusContextSize().catch(() => undefined),
      agent.getModelCapabilities().catch(() => undefined),
      agent.getModel().catch(() => undefined),
    ]);
    if (usage === undefined || contextTokens === undefined) return event;
    const maxContextTokens =
      capabilities?.max_input_tokens ?? capabilities?.max_context_tokens;
    const contextUsage =
      Number.isFinite(contextTokens) &&
      maxContextTokens !== undefined &&
      Number.isFinite(maxContextTokens) &&
      maxContextTokens > 0
        ? contextTokens / maxContextTokens
        : undefined;
    return {
      ...event,
      usage,
      contextUsage,
      contextTokens,
      maxContextTokens:
        capabilities?.max_input_tokens ?? capabilities?.max_context_tokens,
      model,
    } as unknown as Event2<any>;
  }

  // ── interaction bridge ────────────────────────────────────────────────────

  private async bridgeNewPendingInteractions(
    pending?: readonly Interaction[],
  ): Promise<void> {
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
        agentId:
          payload.agentId ??
          (typeof interaction.tags['agentId'] === 'string'
            ? interaction.tags['agentId']
            : undefined) ??
          MAIN_AGENT_ID,
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
        agentId:
          (typeof interaction.tags['agentId'] === 'string'
            ? interaction.tags['agentId']
            : undefined) ?? MAIN_AGENT_ID,
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
