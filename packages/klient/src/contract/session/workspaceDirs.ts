/**
 * `workspaceDirs` — the Workspace-scoped additional-directory set. Mirrors
 * `agent-core-v2/workspace/workspaceDirs/workspaceDirs.ts` (`IWorkspaceDirs`).
 * Only `addDir` crosses the wire: `additionalDirs` / `sessionInfo()` are live
 * read views and `mergeAdditionalDirs` is the engine's own create/resume
 * path. Lives next to `lifecycle.ts`, which also hosts Workspace-scope
 * contracts. The set is shared by every session of the workspace handler;
 * `persist: true` (the engine default) appends to the project-local
 * `.kimi-code/local.toml`, `persist: false` joins the handler's in-memory
 * set.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

/** `WorkspaceAddDirInput` (`agent-core-v2/workspace/workspaceDirs/workspaceDirs.ts`). */
export const workspaceAddDirInputSchema = z.object({
  path: z.string(),
  persist: z.boolean().optional(),
});

/** `WorkspaceAdditionalDirsResult` (same module). */
export const workspaceAdditionalDirsResultSchema = z.object({
  projectRoot: z.string(),
  configPath: z.string(),
  additionalDirs: z.array(z.string()),
  persisted: z.boolean(),
});

export const workspaceDirsContract = {
  addDir: {
    input: z.tuple([workspaceAddDirInputSchema]),
    output: workspaceAdditionalDirsResultSchema,
  },
} satisfies ServiceContract;
