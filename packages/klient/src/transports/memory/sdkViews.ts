import {
  ensureMainAgent,
  IAgentLifecycleService,
  IAgentPluginService,
  IAgentProfileService,
  IBootstrapService,
  IHostEnvironment,
  IHostFileSystem,
  ISessionContext,
  ISessionManager,
  ISessionWorkspaceContext,
  IWorkspaceInstanceManager,
  MAIN_AGENT_ID,
  prepareSystemPromptContext,
  type ISessionScopeHandle,
} from '@moonshot-ai/agent-core-v2';

import type { ScopeLike } from './dispatcher.js';

export async function sessionWarnings(session: ISessionScopeHandle) {
  await ensureMainAgent(session);
  const main = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
  if (main === undefined) throw new Error('Main agent was not materialized');
  const cached = main.accessor.get(IAgentProfileService).getAgentsMdWarning();
  const context = session.accessor.get(ISessionContext);
  const prepared =
    cached === undefined
      ? await prepareSystemPromptContext(
          {
            fs: session.accessor.get(IHostFileSystem),
            homeDir: session.accessor.get(IHostEnvironment).homeDir,
          },
          context.cwd,
          session.accessor.get(IBootstrapService).homeDir,
          {
            additionalDirs: session.accessor.get(ISessionWorkspaceContext)
              .additionalDirs,
          },
        )
      : undefined;
  const warning = cached ?? prepared?.agentsMdWarning;
  return warning === undefined
    ? []
    : [
        {
          code: 'agents-md-oversized',
          message: warning,
          severity: 'warning',
        },
      ];
}

export async function refreshPluginSessionStarts(
  root: ScopeLike,
  excludedSessionId?: string,
): Promise<void> {
  const workspaces = root.accessor.get(IWorkspaceInstanceManager);
  await Promise.all(
    workspaces.list().map(async (workspace) => {
      await workspace.program.skills.reload();
      const sessions = root.accessor
        .get(ISessionManager)
        .list()
        .filter(
          (session) =>
            session.id !== excludedSessionId &&
            session.accessor.get(ISessionContext).workspaceId === workspace.id,
        );
      await Promise.all(
        sessions.map(async (session) => {
          const main = session.accessor
            .get(IAgentLifecycleService)
            .handleOf(MAIN_AGENT_ID);
          await main?.accessor.get(IAgentPluginService).refreshSessionStart();
        }),
      );
    }),
  );
}
