/**
 * `agentContextMemoryService` — direct context mutation (clear / append).
 * Mirrors `agent-core-v2/agent/contextMemory/contextMemory.ts`. The engine's
 * `append` is variadic over `ContextMessage`; the wire carries one message per
 * call. `ContextMessage` is a deep `Message` union; mirrored structurally with
 * `unknown` leaves (parity pins the engine → wire direction only, like
 * `agentContextData.history`).
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

/** Structural mirror of the `ContextMessage` fields the wire must carry. */
export const contextMessageSchema = z.looseObject({
  role: z.string(),
  content: z.array(z.unknown()),
});

export const agentContextMemoryContract = {
  clear: { input: z.tuple([]), output: noResult },
  append: { input: z.tuple([contextMessageSchema]), output: noResult },
} satisfies ServiceContract;
