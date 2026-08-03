/**
 * `sessionCronService` — per-session cron tasks. Only the read side the cron
 * panel needs crosses the wire (`list` + per-task next fire); mutations stay
 * tool-driven, and pure computation (`computeDisplayNextFire`,
 * `ParsedCronExpression`) stays client-side. Mirrors
 * `agent-core-v2/session/cron/sessionCronService.ts`.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

/** `CronTask` (`agent-core-v2/app/cron/cronTask.ts`). */
export const cronTaskSchema = z.object({
  id: z.string(),
  cron: z.string(),
  prompt: z.string(),
  createdAt: z.number(),
  recurring: z.boolean().optional(),
  lastFiredAt: z.number().optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

export const sessionCronContract = {
  list: { input: z.tuple([]), output: z.array(cronTaskSchema) },
  getNextFireForTask: { input: z.tuple([z.string()]), output: z.number().nullable() },
} satisfies ServiceContract;
