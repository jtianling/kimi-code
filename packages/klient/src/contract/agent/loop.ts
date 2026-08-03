/**
 * `agentLoopService` — the agent loop's status read. Mirrors
 * `agent-core-v2/agent/loop/loop.ts` (`AgentLoopStatus`). Only `status`
 * crosses the wire; driving the loop stays on `agentRPCService`.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const agentLoopStatusSchema = z.object({
  state: z.enum(['idle', 'running']),
  activeTurnId: z.number().optional(),
  pendingTurnIds: z.array(z.number()),
  hasPendingRequests: z.boolean(),
  activeTraceId: z.string().optional(),
});

export const agentLoopContract = {
  status: { input: z.tuple([]), output: agentLoopStatusSchema },
} satisfies ServiceContract;
