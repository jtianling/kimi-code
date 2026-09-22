import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const agentPluginCommandContract = {
  activate: {
    input: z.tuple([
      z.object({
        pluginId: z.string(),
        commandName: z.string(),
        args: z.string().optional(),
      }),
    ]),
    output: noResult,
  },
} satisfies ServiceContract;

export const agentConversationUndoContract = {
  undo: { input: z.tuple([z.number()]), output: z.number() },
} satisfies ServiceContract;

export const agentToolsContract = {
  list: {
    input: z.tuple([]),
    output: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        active: z.boolean(),
        source: z.enum(['builtin', 'user', 'mcp']),
      }),
    ),
  },
} satisfies ServiceContract;

export const agentTowerContract = {
  isActive: { input: z.tuple([]), output: z.boolean() },
  enter: {
    input: z.tuple([z.string().optional()]),
    output: z.union([
      z.object({ entered: z.literal(true) }),
      z.object({
        entered: z.literal(false),
        reason: z.enum(['not-main-agent', 'experiment-off', 'feature-not-assembled']),
      }),
      z.object({
        entered: z.literal(false),
        reason: z.literal('owned-by-live-session'),
        owner: z.string(),
        ownerTitle: z.string().optional(),
      }),
    ]),
  },
  exit: { input: z.tuple([]), output: noResult },
} satisfies ServiceContract;

export const agentTodoContract = {
  get: {
    input: z.tuple([]),
    output: z.array(
      z.object({
        title: z.string(),
        status: z.enum(['pending', 'in_progress', 'done']),
      }),
    ),
  },
} satisfies ServiceContract;

export const agentReminderContract = {
  reconcileWhenIdle: { input: z.tuple([z.string()]), output: noResult },
} satisfies ServiceContract;
