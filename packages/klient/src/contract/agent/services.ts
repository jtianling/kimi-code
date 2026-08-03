/**
 * Agent-scope domain service contracts. These mirror the positional-arg
 * signatures of the engine's domain Services (shellCommand / profile / usage /
 * plan / task) that the agent facade calls directly; payload and result
 * schemas are shared with `agent/rpc.ts` (they mirror the same wire shapes).
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import {
  agentTaskInfoSchema,
  planDataSchema,
  runShellCommandPayloadSchema,
  setModelResultSchema,
  shellCommandResultSchema,
  usageStatusSchema,
} from './rpc.js';

export const agentShellCommandContract = {
  run: {
    input: z.tuple([runShellCommandPayloadSchema]),
    output: shellCommandResultSchema,
  },
  cancel: { input: z.tuple([z.string()]), output: noResult },
} satisfies ServiceContract;

/**
 * `ProfileUpdateData` (`agent-core-v2/agent/profile/profile.ts`) — the facade
 * only ever sends the `activeToolNames` slice (whole-set tool replace); the
 * schema mirrors the full update payload so other slices stay wire-legal.
 */
export const profileUpdateDataSchema = z.object({
  modelAlias: z.string().optional(),
  profileName: z.string().optional(),
  thinkingLevel: z.string().optional(),
  systemPrompt: z.string().optional(),
  disallowedTools: z.array(z.string()).optional(),
  activeToolNames: z.array(z.string()).optional(),
});

export const agentProfileContract = {
  getModel: { input: z.tuple([]), output: z.string() },
  setModel: { input: z.tuple([z.string()]), output: setModelResultSchema },
  setThinking: { input: z.tuple([z.string()]), output: noResult },
  update: { input: z.tuple([profileUpdateDataSchema]), output: noResult },
  // The cached oversized-AGENTS.md notice (computed on every profile bind);
  // the session facade folds it into `getSessionWarnings`.
  getAgentsMdWarning: { input: z.tuple([]), output: maybe(z.string()) },
} satisfies ServiceContract;

export const agentUsageContract = {
  status: { input: z.tuple([]), output: usageStatusSchema },
} satisfies ServiceContract;

export const agentPlanContract = {
  status: { input: z.tuple([]), output: planDataSchema },
  enter: { input: z.tuple([]), output: noResult },
  clear: { input: z.tuple([]), output: noResult },
  cancel: { input: z.tuple([z.string().optional()]), output: noResult },
} satisfies ServiceContract;

export const agentTaskContract = {
  list: {
    input: z.tuple([z.boolean().optional(), z.number().optional()]),
    output: z.array(agentTaskInfoSchema),
  },
  stopByUser: { input: z.tuple([z.string()]), output: maybe(agentTaskInfoSchema) },
  stop: {
    input: z.tuple([z.string(), z.string().optional()]),
    output: maybe(agentTaskInfoSchema),
  },
  readOutput: {
    input: z.tuple([z.string(), z.number().optional()]),
    output: z.string(),
  },
  detach: { input: z.tuple([z.string()]), output: maybe(agentTaskInfoSchema) },
} satisfies ServiceContract;

/** `SwarmModeTrigger` (`agent-core-v2/agent/swarm/swarm.ts`). */
export const swarmModeTriggerSchema = z.enum(['manual', 'task', 'tool']);

export const agentSwarmContract = {
  enter: { input: z.tuple([swarmModeTriggerSchema]), output: noResult },
  exit: { input: z.tuple([]), output: noResult },
} satisfies ServiceContract;

/**
 * `FullCompactionInput` (`agent-core-v2/agent/fullCompaction/fullCompaction.ts`).
 * `begin` returns whether the compaction actually started (`false` when one is
 * already running); cancellation is not a method on this service — the engine
 * cancels through the in-flight task's `AbortController`, exposed on the wire
 * as `agentRPCService.cancelCompaction`.
 */
export const fullCompactionInputSchema = z.object({
  source: z.enum(['manual', 'auto']),
  instruction: z.string().optional(),
});

export const agentFullCompactionContract = {
  begin: { input: z.tuple([fullCompactionInputSchema]), output: z.boolean() },
} satisfies ServiceContract;
