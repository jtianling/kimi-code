/**
 * `sessionInitService` — the `/init` AGENTS.md generator. Mirrors
 * `agent-core-v2/session/sessionInit/sessionInit.ts`.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const sessionInitContract = {
  generateAgentsMd: { input: z.tuple([]), output: noResult },
} satisfies ServiceContract;
