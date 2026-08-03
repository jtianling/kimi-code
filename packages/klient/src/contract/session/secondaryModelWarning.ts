/**
 * `sessionSecondaryModelWarningService` — the cached secondary-model
 * validation warning. Mirrors
 * `agent-core-v2/session/subagent/secondaryModelWarning.ts`
 * (`ISessionSecondaryModelWarningService`); only the pull getter crosses the
 * wire (`recheckSecondaryModelWarning` is the engine's own refresh path).
 */

import { z } from 'zod';

import { maybe } from '../helpers.js';
import type { ServiceContract } from '../types.js';

/** `SecondaryModelWarning` (`agent-core-v2/session/subagent/secondaryModelWarning.ts`). */
export const secondaryModelWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const sessionSecondaryModelWarningContract = {
  getSecondaryModelWarning: {
    input: z.tuple([]),
    output: maybe(secondaryModelWarningSchema),
  },
} satisfies ServiceContract;
