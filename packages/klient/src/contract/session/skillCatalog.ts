/**
 * `sessionSkillCatalog` — the session-scope skill catalog read view. The
 * engine interface (`agent-core-v2/session/sessionSkillCatalog/skillCatalog.ts`)
 * exposes the catalog as a property, not a wire-able method, so `listSkills`
 * is a facade-synthesized procedure: the dispatcher awaits `ready` and
 * projects `catalog.listSkills()` through `summarizeSkill` (the same
 * projection kap-server's `/skills` routes use). The output mirrors
 * `SkillSummary` in `agent-core-v2/app/skillCatalog/types.ts`.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const skillSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  source: z.enum(['project', 'user', 'extra', 'builtin']),
  type: z.string().optional(),
  disableModelInvocation: z.boolean().optional(),
  isSubSkill: z.boolean().optional(),
});

export const sessionSkillCatalogContract = {
  listSkills: { input: z.tuple([]), output: z.array(skillSummarySchema) },
} satisfies ServiceContract;
