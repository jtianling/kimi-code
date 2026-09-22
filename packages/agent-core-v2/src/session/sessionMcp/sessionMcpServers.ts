

import { createDecorator,type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { Event } from '#/_base/event';

import type { McpServerConfig } from '#/mcpCore/config-schema';
import type {
	McpServersChange,
	McpTunables,
} from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';

export interface ISessionMcpServers {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  servers(): Readonly<Record<string, McpServerConfig>>;
  tunables(): McpTunables;
  readonly onDidChange: Event<McpServersChange>;
}

export const ISessionMcpServers: ServiceIdentifier<ISessionMcpServers> =
  createDecorator<ISessionMcpServers>('sessionMcpServers');

export function sessionMcpServersSeed(data: ISessionMcpServers): ScopeSeed {
  return [[ISessionMcpServers as ServiceIdentifier<unknown>, data]];
}
