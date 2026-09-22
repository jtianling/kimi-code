

import { createDecorator,type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpConnectionManager } from '#/mcpCore/connection-manager';

export interface ISessionMcpService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  readonly connectionManager: McpConnectionManager;
}

export const ISessionMcpService: ServiceIdentifier<ISessionMcpService> =
  createDecorator<ISessionMcpService>('sessionMcpService');
