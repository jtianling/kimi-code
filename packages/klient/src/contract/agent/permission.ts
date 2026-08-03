/**
 * `agentPermissionModeService` / `agentPermissionRulesService` — the agent's
 * permission state. Mirrors `agent-core-v2/agent/permissionMode/permissionMode.ts`
 * and `agent-core-v2/agent/permissionRules/permissionRules.ts`. `mode` /
 * `rules` are service properties, not methods — the dispatcher reads
 * non-function members as property values, so the input tuples are empty.
 * `PermissionRule` is a deep engine union; mirrored as `unknown` entries
 * (parity pins the engine → wire direction only, like
 * `agentContextData.history`).
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { permissionModeSchema } from './rpc.js';

export const agentPermissionModeContract = {
  mode: { input: z.tuple([]), output: permissionModeSchema },
  setMode: { input: z.tuple([permissionModeSchema]), output: noResult },
} satisfies ServiceContract;

export const agentPermissionRulesContract = {
  rules: { input: z.tuple([]), output: z.array(z.unknown()) },
} satisfies ServiceContract;
