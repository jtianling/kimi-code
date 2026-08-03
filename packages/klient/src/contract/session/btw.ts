/**
 * `sessionBtwService` — the side-question ("by the way") child-agent contract.
 * Mirrors `agent-core-v2/session/btw/btw.ts` (`ISessionBtwService`). `start`
 * forks the main agent and returns the child's agent id; the engine requires
 * the main agent to be materialized first (session create/resume does that
 * eagerly, so a live session reached over the wire always satisfies it).
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const sessionBtwContract = {
  start: { input: z.tuple([]), output: z.string() },
} satisfies ServiceContract;
