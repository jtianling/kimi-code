/**
 * `agentSkillService` — the awaited skill-activation path. Mirrors
 * `agent-core-v2/agent/skill/skill.ts`. Unlike
 * `agentRPCService.activateSkill` (fire-and-forget), `activate` awaits the
 * activation and rejects synchronously (`skill.not_found` /
 * `skill.type_unsupported`). The engine returns the launched `Turn` — a
 * handle full of promises/abort signals that does not survive the wire
 * meaningfully, so the output is mirrored as `unknown` and facades drop it.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

/** `SkillActivationInput` (`agent-core-v2/agent/skill/skill.ts`). */
export const skillActivationInputSchema = z.object({
  name: z.string(),
  args: z.string().optional(),
});

export const agentSkillContract = {
  activate: { input: z.tuple([skillActivationInputSchema]), output: z.unknown() },
} satisfies ServiceContract;
