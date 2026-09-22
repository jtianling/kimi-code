/**
 * `agentLifecycleService` (session scope) — agent materialization and the
 * live-agent roster. Mirrors
 * `agent-core-v2/session/agentLifecycle/agentLifecycle.ts`. `create` is
 * create-or-get and cold-restores a persisted agent's wire; `list` returns
 * the live handles. Handles cross the wire as `{ id, kind }` (loose — extra
 * fields may appear in-process), same as the session-lifecycle handles.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';
const handleWireSchema = z.object({ agentId: z.string() });

/** `CreateAgentOptions` — only the slices a wire caller may pass. */
export const createAgentOptionsSchema = z.object({
  agentId: z.string().optional(),
});

export const agentLifecycleContract = {
  create: { input: z.tuple([createAgentOptionsSchema.optional()]), output: handleWireSchema },
  list: { input: z.tuple([]), output: z.array(handleWireSchema) },
} satisfies ServiceContract;
