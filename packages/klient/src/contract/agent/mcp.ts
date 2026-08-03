/**
 * `agentMcpService` — the agent-scope read view over the workspace handler's
 * one shared `McpConnectionManager`. Mirrors `agent-core-v2/agent/mcp/mcp.ts`
 * (`IAgentMcpService`); the entry schema mirrors `McpServerEntry`
 * (`agent-core-v2/mcpCore/connection-manager.ts`), which is field-identical
 * with the v1 `McpServerInfo` wire shape. `waitForInitialLoad` /
 * `initialLoadDurationMs` compose into the v1 `getMcpStartupMetrics`; the
 * optional `AbortSignal` parameters never cross the wire, so the input
 * tuples are empty. `reconnect` / `resolved` / the OAuth surface stay
 * off-contract until a facade needs them.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const mcpServerTransportSchema = z.enum(['stdio', 'http', 'sse']);

export const mcpServerStatusSchema = z.enum([
  'pending',
  'connected',
  'failed',
  'disabled',
  'needs-auth',
]);

/** `McpServerEntry` (`agent-core-v2/mcpCore/connection-manager.ts`). */
export const mcpServerEntrySchema = z.object({
  name: z.string(),
  transport: mcpServerTransportSchema,
  status: mcpServerStatusSchema,
  toolCount: z.number(),
  error: z.string().optional(),
});

export const agentMcpContract = {
  list: { input: z.tuple([]), output: z.array(mcpServerEntrySchema) },
  waitForInitialLoad: { input: z.tuple([]), output: noResult },
  initialLoadDurationMs: { input: z.tuple([]), output: z.number() },
} satisfies ServiceContract;
