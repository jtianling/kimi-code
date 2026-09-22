import {
  IAgentLifecycleService,
  IEventBus,
  type IAgentScopeHandle,
  type IDisposable,
  type ISessionScopeHandle,
} from '@moonshot-ai/agent-core-v2';

export function subscribeSessionAgentEvents(
  session: ISessionScopeHandle,
  handler: (data: unknown) => void,
): IDisposable {
  const lifecycle = session.accessor.get(IAgentLifecycleService);
  const subscriptions = new Map<string, IDisposable>();
  const detach = (agentId: string) => {
    subscriptions.get(agentId)?.dispose();
    subscriptions.delete(agentId);
  };
  const attach = (agent: IAgentScopeHandle) => {
    detach(agent.id);
    subscriptions.set(
      agent.id,
      agent.accessor.get(IEventBus).subscribe((event) => {
        handler({ agentId: agent.id, event });
      }),
    );
  };
  const created = lifecycle.onDidCreateScope(({ handle }) => attach(handle));
  const closed = lifecycle.onDidClose(({ agentId }) => detach(agentId));
  for (const context of lifecycle.list()) {
    const handle = lifecycle.handleOf(context.agentId);
    if (handle !== undefined) attach(handle);
  }
  return {
    dispose: () => {
      created.dispose();
      closed.dispose();
      for (const subscription of subscriptions.values()) subscription.dispose();
      subscriptions.clear();
    },
  };
}
