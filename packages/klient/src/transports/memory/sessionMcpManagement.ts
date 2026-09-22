import { ISessionEphemeralMcpServers } from '@moonshot-ai/agent-core-v2/session/mcp/ephemeralMcpServers';
import {
  Error2,
  ErrorCodes,
  IBootstrapService,
  IHostFileSystem,
  IMcpManagementService,
  ISessionMcpHandle,
  ISessionMcpService,
  ISessionWorkspaceContext,
} from '@moonshot-ai/agent-core-v2';
import { loadMcpServers } from '@moonshot-ai/agent-core-v2/app/mcpConfig/configLoader';
import type { GlobalMcpServerConfig } from '@moonshot-ai/agent-core-v2/app/mcpManagement/mcpManagement';
import { McpServerConfigSchema } from '@moonshot-ai/agent-core-v2/mcpCore/config-schema';
import { McpConnectionManager } from '@moonshot-ai/agent-core-v2/mcpCore/connection-manager';

import type { ScopeLike } from './dispatcher.js';

function managerFor(
  session: ScopeLike,
  name: string,
  scope?: string,
): McpConnectionManager {
  if (name in session.accessor.get(ISessionEphemeralMcpServers)) {
    throw new Error2(
      ErrorCodes.NOT_IMPLEMENTED,
      'Ephemeral MCP configuration cannot be replaced',
    );
  }
  const own = session.accessor.get(ISessionMcpService).connectionManager;
  const shared = session.accessor.get(ISessionMcpHandle).connectionManager;
  if (
    (own.get(name) !== undefined && scope !== 'session') ||
    (shared.get(name) !== undefined && scope === 'session')
  ) {
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      'Cannot change the scope of a live MCP server',
    );
  }
  const manager =
    own.get(name) !== undefined || scope === 'session'
      ? own
      : session.accessor.get(ISessionMcpHandle).connectionManager;
  if (!(manager instanceof McpConnectionManager)) {
    throw new Error2(
      ErrorCodes.NOT_IMPLEMENTED,
      'Replacing MCP configuration is not supported for sessions with ephemeral servers',
    );
  }
  return manager;
}

async function persistServer(
  session: ScopeLike,
  server: GlobalMcpServerConfig,
): Promise<void> {
  const fs = session.accessor.get(IHostFileSystem);
  const homeDir = session.accessor.get(IBootstrapService).homeDir;
  const cwd = session.accessor.get(ISessionWorkspaceContext).workDir;
  const [withProject, userOnly] = await Promise.all([
    loadMcpServers({ fs, cwd, homeDir, includeProject: true }),
    loadMcpServers({ fs, cwd, homeDir, includeProject: false }),
  ]);
  if (withProject[server.name] !== undefined && userOnly[server.name] === undefined) {
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      `MCP server "${server.name}" is read-only: it is defined in the project MCP config`,
    );
  }
  await session.accessor.get(IMcpManagementService).addServer(server, { cwd });
}

export function sessionMcpManagement(session: ScopeLike): Record<string, unknown> {
  return {
    replace: async (name: string, input: GlobalMcpServerConfig) => {
      const config = McpServerConfigSchema.parse(input);
      if (config.enabled === false) {
        throw new Error2(
          ErrorCodes.MCP_SERVER_DISABLED,
          `MCP server is disabled: ${name}`,
        );
      }
      await managerFor(session, name, config.scope).connect(name, config);
    },
    add: async (input: GlobalMcpServerConfig, persist?: boolean) => {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'MCP server name cannot be empty');
      }
      const config = McpServerConfigSchema.parse(input);
      const manager = managerFor(session, name, config.scope);
      if (persist === true) await persistServer(session, { name, ...config });
      await manager.connect(name, config);
      const entry = manager.get(name);
      if (entry === undefined) {
        throw new Error2(
          ErrorCodes.MCP_SERVER_NOT_FOUND,
          `MCP server "${name}" was not connected`,
        );
      }
      return entry;
    },
  };
}
