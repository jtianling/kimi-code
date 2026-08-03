/**
 * `sessionSecondaryModelWarningService` — the cached secondary-model
 * validation warning. Mirrors
 * `agent-core-v2/session/subagent/secondaryModelWarning.ts`
 * (`ISessionSecondaryModelWarningService`): the pull getter for reads, and
 * `recheckSecondaryModelWarning` for the facade's
 * `applyPersistedSecondaryModel` refresh path.
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
  recheckSecondaryModelWarning: {
    input: z.tuple([]),
    output: maybe(secondaryModelWarningSchema),
  },
} satisfies ServiceContract;
