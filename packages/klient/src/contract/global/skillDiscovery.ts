/**
 * `skillDiscovery` (app scope) — stateless skill scanning over caller-supplied
 * roots. Mirrors `agent-core-v2/features/skill/catalog/skillDiscovery.ts` and the
 * `SkillRoot` / `SkillDefinition` / `SkippedSkill` types in
 * `agent-core-v2/features/skill/catalog/types.ts`. `SkillMetadata` is an open
 * front-matter map; mirrored loosely. The `SkillDefinition.content` (full
 * skill body) crosses the wire verbatim.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

const skillSourceSchema = z.enum(['project', 'user', 'extra', 'builtin']);

const skillPluginContextSchema = z.looseObject({
  id: z.string(),
});

/** `SkillRoot` (`agent-core-v2/features/skill/catalog/types.ts`). */
export const skillRootSchema = z.object({
  path: z.string(),
  source: skillSourceSchema,
  plugin: skillPluginContextSchema.optional(),
});

/** `SkillMetadata` — open front-matter map (`agent-core-v2/features/skill/catalog/types.ts`). */
export const skillMetadataSchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().optional(),
  type: z.string().optional(),
  whenToUse: z.string().optional(),
  disableModelInvocation: z.boolean().optional(),
  isSubSkill: z.boolean().optional(),
  safe: z.boolean().optional(),
  arguments: z.union([z.array(z.unknown()), z.string()]).optional(),
});

/** `SkillDefinition` (`agent-core-v2/features/skill/catalog/types.ts`). */
export const skillDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  dir: z.string(),
  content: z.string(),
  metadata: skillMetadataSchema,
  source: skillSourceSchema,
  plugin: skillPluginContextSchema.optional(),
});

/** `SkippedSkill` (`agent-core-v2/features/skill/catalog/types.ts`). */
export const skippedSkillSchema = z.object({
  path: z.string(),
  type: z.string(),
  reason: z.string(),
});

/** `SkillDiscoveryResult` (`agent-core-v2/features/skill/catalog/skillDiscovery.ts`). */
export const skillDiscoveryResultSchema = z.object({
  skills: z.array(skillDefinitionSchema),
  skipped: z.array(skippedSkillSchema),
  scannedRoots: z.array(z.string()),
  scannedDirectories: z.array(z.string()),
});

export const skillDiscoveryContract = {
  discover: {
    input: z.tuple([z.array(skillRootSchema)]),
    output: skillDiscoveryResultSchema,
  },
} satisfies ServiceContract;
