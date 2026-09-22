import { skillSummarySchema } from '../session/skills.js';
import { z } from 'zod';

import { mcpServerEntrySchema } from '../agent/mcp.js';
import type { ServiceContract } from '../types.js';

export const workspaceFsContract = {
  suggest: {
    input: z.tuple([
      z.object({
        query: z.string(),
        limit: z.number().int().min(1).max(200),
        follow_gitignore: z.boolean(),
        show_hidden: z.boolean(),
        include_globs: z.array(z.string()).optional(),
        exclude_globs: z.array(z.string()).optional(),
      }),
    ]),
    output: z.object({
      items: z.array(
        z.object({
          path: z.string(),
          name: z.string(),
          kind: z.enum(['file', 'directory', 'symlink']),
          score: z.number().min(0).max(1),
          match_positions: z.array(z.number().int().nonnegative()),
        }),
      ),
      truncated: z.boolean(),
    }),
  },
} satisfies ServiceContract;

export const workspaceMcpContract = {
  list: { input: z.tuple([]), output: z.array(mcpServerEntrySchema) },
} satisfies ServiceContract;

export const workspaceSkillsContract = {
  list: { input: z.tuple([]), output: z.array(skillSummarySchema) },
} satisfies ServiceContract;
