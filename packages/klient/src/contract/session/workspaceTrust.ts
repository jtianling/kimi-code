/**
 * `workspaceTrust` (workspace scope) — the trust marker gating project-level
 * MCP config. Mirrors `agent-core-v2/workspace/workspaceTrust/workspaceTrust.ts`.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const workspaceTrustContract = {
  get: { input: z.tuple([]), output: z.boolean() },
  trust: { input: z.tuple([]), output: noResult },
  untrust: { input: z.tuple([]), output: noResult },
} satisfies ServiceContract;
