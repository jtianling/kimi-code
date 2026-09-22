/**
 * `sessionInitService` — the `/init` AGENTS.md generator. Mirrors
 * `agent-core-v2/features/sessionInit/sessionInit.ts`.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const sessionInitContract = {
  cancelInit: { input: z.tuple([]), output: noResult },
  generateAgentsMd: { input: z.tuple([]), output: noResult },
} satisfies ServiceContract;

export const sessionWarningsContract = {
  get: { input: z.tuple([]), output: z.array(z.object({
    code: z.literal('agents-md-oversized'), message: z.string(), severity: z.literal('warning'),
  })) },
} satisfies ServiceContract;

export const pluginSessionStartsContract = {
  refresh: { input: z.tuple([z.string().optional()]), output: noResult },
} satisfies ServiceContract;
