/**
 * `mcpCore` domain — remote (HTTP/SSE) server config guards and request-header builders.
 *
 * Header values support `${VAR}` templates resolved through the caller-provided
 * env lookup; a value whose any variable resolves to undefined or empty drops
 * the whole header, so a literal `${...}` never reaches the wire.
 */

import type { McpRemoteServerConfig, McpServerConfig } from './config-schema';
import { ErrorCodes, Error2 } from '#/errors';

const ENV_TEMPLATE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function buildMcpRemoteHeaders(
  config: McpRemoteServerConfig,
  envLookup: (name: string) => string | undefined,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.headers ?? {})) {
    const expanded = expandEnvTemplates(value, envLookup);
    if (expanded !== undefined) {
      headers[key] = expanded;
    }
  }
  if (config.bearerTokenEnvVar !== undefined) {
    const token = envLookup(config.bearerTokenEnvVar);
    if (token === undefined || token.length === 0) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `MCP ${config.transport.toUpperCase()} bearer token env var "${config.bearerTokenEnvVar}" is not set or is empty`,
      );
    }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization') {
        delete headers[key];
      }
    }
    headers['Authorization'] = `Bearer ${token}`;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function isRemoteMcpConfig(config: McpServerConfig): config is McpRemoteServerConfig {
  return config.transport === 'http' || config.transport === 'sse';
}

function expandEnvTemplates(
  value: string,
  envLookup: (name: string) => string | undefined,
): string | undefined {
  let unresolved = false;
  const expanded = value.replace(ENV_TEMPLATE_PATTERN, (_match, name: string) => {
    const resolved = envLookup(name);
    if (resolved === undefined || resolved.length === 0) {
      unresolved = true;
      return '';
    }
    return resolved;
  });
  return unresolved ? undefined : expanded;
}
