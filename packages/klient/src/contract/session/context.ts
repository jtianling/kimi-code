/**
 * `sessionContext` / `sessionWorkspaceContext` — the session's path layout
 * and workspace view. Mirrors
 * `agent-core-v2/session/sessionContext/sessionContext.ts` and
 * `agent-core-v2/session/workspaceContext/workspaceContext.ts`. All three
 * reads are service properties, so the input tuples are empty.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const sessionContextContract = {
  cwd: { input: z.tuple([]), output: z.string() },
  sessionDir: { input: z.tuple([]), output: z.string() },
} satisfies ServiceContract;

export const sessionWorkspaceContextContract = {
  additionalDirs: { input: z.tuple([]), output: z.array(z.string()) },
} satisfies ServiceContract;
