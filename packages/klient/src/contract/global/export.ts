/**
 * `sessionExportService` (app scope) — the session zip export. Mirrors
 * `agent-core-v2/app/sessionExport/sessionExport.ts`. The optional
 * `ExportSessionOptions` (`webLog` / `signal`) never crosses the wire.
 * `ShellEnvironment` is a `Record<string, string | undefined>` — mirrored
 * loosely.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

const shellEnvironmentSchema = z.record(z.string(), z.string().optional());

/** `ExportSessionPayload` (`agent-core-v2/app/sessionExport/sessionExport.ts`). */
export const exportSessionPayloadSchema = z.object({
  sessionId: z.string(),
  outputPath: z.string().optional(),
  includeGlobalLog: z.boolean().optional(),
  includeDesktopLog: z.boolean().optional(),
  version: z.string(),
  desktopVersion: z.string().optional(),
  installSource: z.string().optional(),
  shellEnv: shellEnvironmentSchema.optional(),
});

/** `ExportSessionManifest` (`agent-core-v2/app/sessionExport/sessionExport.ts`). */
export const exportSessionManifestSchema = z.object({
  sessionId: z.string(),
  exportedAt: z.string(),
  kimiCodeVersion: z.string(),
  wireProtocolVersion: z.string(),
  os: z.string(),
  nodejsVersion: z.string(),
  sessionFirstActivity: z.string().optional(),
  sessionLastActivity: z.string().optional(),
  title: z.string().optional(),
  workspaceDir: z.string().optional(),
  sessionLogPath: z.string().optional(),
  globalLogPath: z.string().optional(),
  desktopLogPath: z.string().optional(),
  webLogPath: z.string().optional(),
  desktopVersion: z.string().optional(),
  installSource: z.string().optional(),
  shellEnv: shellEnvironmentSchema.optional(),
});

/** `ExportSessionResult` (`agent-core-v2/app/sessionExport/sessionExport.ts`). */
export const exportSessionResultSchema = z.object({
  zipPath: z.string(),
  entries: z.array(z.string()),
  sessionDir: z.string(),
  manifest: exportSessionManifestSchema,
});

export const sessionExportContract = {
  export: { input: z.tuple([exportSessionPayloadSchema]), output: exportSessionResultSchema },
} satisfies ServiceContract;
