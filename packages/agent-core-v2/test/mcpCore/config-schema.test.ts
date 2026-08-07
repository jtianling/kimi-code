/**
 * Scenario: MCP server config schema — transport inference and the optional
 * `scope` field selecting the connection lifetime (default workspace-shared,
 * opt-in per-session).
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/mcpCore/config-schema.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { McpServerConfigSchema } from '#/mcpCore/config-schema';

describe('McpServerConfigSchema', () => {
  it('parses a stdio server without scope and leaves it undefined (workspace default)', () => {
    const config = McpServerConfigSchema.parse({ command: 'npx', args: ['-y', 'server'] });
    expect(config.transport).toBe('stdio');
    expect(config.scope).toBeUndefined();
  });

  it('parses scope: "session" on a stdio server', () => {
    const config = McpServerConfigSchema.parse({ command: 'npx', scope: 'session' });
    expect(config.scope).toBe('session');
  });

  it('parses scope: "workspace" explicitly', () => {
    const config = McpServerConfigSchema.parse({ command: 'npx', scope: 'workspace' });
    expect(config.scope).toBe('workspace');
  });

  it('parses scope on remote servers inferred from url', () => {
    const config = McpServerConfigSchema.parse({
      url: 'https://example.com/mcp',
      scope: 'session',
    });
    expect(config.transport).toBe('http');
    expect(config.scope).toBe('session');
  });

  it('rejects an unknown scope value', () => {
    expect(() => McpServerConfigSchema.parse({ command: 'npx', scope: 'agent' })).toThrow();
  });
});
