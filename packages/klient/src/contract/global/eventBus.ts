/**
 * `eventService` (app scope) — the process-global event bus. Mirrors the
 * `publish` half of `agent-core-v2/app/event/event.ts`; subscriptions go
 * through the events hub (`contract/global/events.ts`), not this contract.
 * The payload is an open bus envelope (`{ type, payload }`) — bus events are
 * typed per producer, so the schema stays structural.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

/** `GlobalEvent`-shaped bus envelope (`{ type, payload }`). */
export const globalEventSchema = z.looseObject({
  type: z.string(),
  payload: z.unknown(),
});

export const eventServiceContract = {
  publish: { input: z.tuple([globalEventSchema]), output: noResult },
} satisfies ServiceContract;
