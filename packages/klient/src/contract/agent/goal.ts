/**
 * `agentGoalService` — the main-agent goal lifecycle contract. Mirrors
 * `agent-core-v2/features/goal/goal.ts` (`IAgentGoalService`) and the wire types
 * in `agent/goal/types.ts`. The optional trailing `actor` parameter never
 * crosses the wire (the facade always acts as the default `'user'` actor), so
 * the input tuples stop at the payload argument.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const goalStatusSchema = z.enum(['active', 'paused', 'blocked', 'complete']);

export const goalBudgetReportSchema = z.object({
  tokenBudget: z.union([z.number(), z.null()]),
  turnBudget: z.union([z.number(), z.null()]),
  wallClockBudgetMs: z.union([z.number(), z.null()]),
  remainingTokens: z.union([z.number(), z.null()]),
  remainingTurns: z.union([z.number(), z.null()]),
  remainingWallClockMs: z.union([z.number(), z.null()]),
  tokenBudgetReached: z.boolean(),
  turnBudgetReached: z.boolean(),
  wallClockBudgetReached: z.boolean(),
  overBudget: z.boolean(),
});

export const goalSnapshotSchema = z.object({
  goalId: z.string(),
  objective: z.string(),
  completionCriterion: z.string().optional(),
  status: goalStatusSchema,
  turnsUsed: z.number(),
  tokensUsed: z.number(),
  wallClockMs: z.number(),
  budget: goalBudgetReportSchema,
  terminalReason: z.string().optional(),
});

export const goalToolResultSchema = z.object({
  goal: z.union([goalSnapshotSchema, z.null()]),
});

export const createGoalInputSchema = z.object({
  objective: z.string(),
  completionCriterion: z.string().optional(),
  replace: z.boolean().optional(),
});

export const goalReasonInputSchema = z.object({
  reason: z.string().optional(),
});

export const resumeGoalInputSchema = goalReasonInputSchema.extend({
  continueIfPaused: z.boolean().optional(),
  continueIfBlocked: z.boolean().optional(),
});

export const agentGoalContract = {
  getGoal: { input: z.tuple([]), output: goalToolResultSchema },
  createGoal: { input: z.tuple([createGoalInputSchema]), output: goalSnapshotSchema },
  pauseGoal: {
    input: z.tuple([goalReasonInputSchema.optional()]),
    output: goalSnapshotSchema,
  },
  resumeGoal: {
    input: z.tuple([resumeGoalInputSchema.optional()]),
    output: goalSnapshotSchema,
  },
  cancelGoal: {
    input: z.tuple([goalReasonInputSchema.optional()]),
    output: goalSnapshotSchema,
  },
} satisfies ServiceContract;
