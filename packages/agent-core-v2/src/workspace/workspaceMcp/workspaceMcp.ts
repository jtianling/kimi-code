import { createDecorator,type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { McpConnectionManager } from '#/mcpCore/connection-manager';
import type { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import type { ISessionMcpServers } from '#/session/sessionMcp/sessionMcpServers';

export interface ISessionMcpOverlay {
  readonly handle: ISessionMcpHandle;
  shutdown(): Promise<void>;
}

export interface SessionMcpOverlayOptions {
  readonly stdioCwd?: string;
}

export interface IWorkspaceMcpService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  connectionManager(): McpConnectionManager;

  sessionHandle(): ISessionMcpHandle;

  sessionServersData(): ISessionMcpServers;

  sessionOverlay(
    servers: Readonly<Record<string, McpServerConfig>>,
    opts?: SessionMcpOverlayOptions,
  ): ISessionMcpOverlay;
}

export const IWorkspaceMcpService: ServiceIdentifier<IWorkspaceMcpService> =
  createDecorator<IWorkspaceMcpService>('workspaceMcpService');
