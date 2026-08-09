/**
 * Remote-mode harness (createKimiHarnessV2Remote) against a real kap-server —
 * the P2 acceptance proof. A scripted OpenAI mock drives a two-step turn
 * (tool call → follow-up text) with permission mode `manual`, so the parked
 * Bash approval must cross the unix socket to the SDK's handler and back
 * before the turn can complete. The turn's visibility on the server's REST
 * transcript proves the client and the REST surface share one engine.
 * Run: pnpm exec vitest run test/remote-harness.test.ts
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '@moonshot-ai/kap-server';
import type { Event } from '@moonshot-ai/agent-core';

import { createKimiHarnessV2Remote } from '#/sdk-rpc-client-v2';
import type { KimiHarness } from '#/kimi-harness';
import type { Session } from '#/session';

const TEST_IDENTITY = {
  productName: 'remote-harness-test',
  version: '0.0.0-test',
  platform: 'test',
} as const;

function sseLines(...events: readonly string[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    lines.push(`data: ${event}`, '');
  }
  return lines;
}

function chunk(delta: Record<string, unknown>, finishReason: string | null, usage?: unknown): string {
  return JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'mock',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  });
}

const USAGE = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };

function toolCallSse(name: string, args: string): string[] {
  return [
    ...sseLines(
      chunk({ role: 'assistant', content: null, tool_calls: [
        { index: 0, id: 'call_1', type: 'function', function: { name, arguments: args } },
      ] }, null),
      chunk({}, 'tool_calls', USAGE),
    ),
    'data: [DONE]',
    '',
  ];
}

function textSse(text: string): string[] {
  return [
    ...sseLines(
      chunk({ role: 'assistant', content: text }, null),
      chunk({}, 'stop', USAGE),
    ),
    'data: [DONE]',
    '',
  ];
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`waitFor timed out: ${label}`);
}

describe('remote harness (createKimiHarnessV2Remote)', () => {
  let homeDir: string;
  let workDir: string;
  let server: RunningServer;
  let harness: KimiHarness;
  let mockModel: Server;
  const mockSockets = new Set<Socket>();
  const modelCalls: string[] = [];

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'remote-harness-home-'));
    workDir = await mkdtemp(join(tmpdir(), 'remote-harness-work-'));

    // Scripted model: first call asks for the Bash tool, second replies text.
    mockModel = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        for await (const _chunk of req) {
          // drain
        }
        if (req.url === '/v1/chat/completions') {
          modelCalls.push('chat');
          const script = modelCalls.length === 1
            ? toolCallSse('Bash', JSON.stringify({ command: 'echo remote-ok' }))
            : textSse('remote done');
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          res.end(`${script.join('\n')}\n`);
          return;
        }
        res.writeHead(404).end();
      })().catch(() => {
        res.destroy();
      });
    });
    mockModel.on('connection', (socket) => {
      mockSockets.add(socket);
      socket.on('close', () => mockSockets.delete(socket));
    });
    await new Promise<void>((resolve) => mockModel.listen(0, '127.0.0.1', resolve));
    const mockBaseUrl = `http://127.0.0.1:${(mockModel.address() as AddressInfo).port}`;

    await writeFile(
      join(homeDir, 'config.toml'),
      [
        'default_model = "stub"',
        '',
        '[providers.stub]',
        'type = "openai"',
        `base_url = "${mockBaseUrl}/v1"`,
        'api_key = "stub"',
        '',
        '[models.stub]',
        'provider = "stub"',
        'model = "stub"',
        'max_context_size = 100000',
        '',
      ].join('\n'),
    );

    server = await startServer({ homeDir, port: 0, hostIdentity: TEST_IDENTITY });
    const socketPath = server.klientIpcSocketPath;
    if (socketPath === undefined) throw new Error('server did not expose a klient ipc socket');

    harness = createKimiHarnessV2Remote(
      { homeDir, identity: TEST_IDENTITY },
      {
        socketPath,
        token: server.authTokenService.getToken(),
      },
    );
  }, 60_000);

  afterAll(async () => {
    await harness.close();
    await server.close();
    for (const socket of mockSockets) socket.destroy();
    await new Promise<void>((resolve) => {
      mockModel.close(() => resolve());
    });
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('drives a full approval-gated turn over the socket, visible on the REST transcript', async () => {
    const session: Session = await harness.createSession({
      workDir,
      model: 'stub',
      metadata: { cwd: workDir },
    });
    let approvalCalls = 0;
    session.setApprovalHandler(() => {
      approvalCalls += 1;
      return Promise.resolve({ decision: 'approved' as const });
    });
    await session.setPermission('manual');

    const events: Event[] = [];
    session.onEvent((event) => {
      events.push(event);
    });
    await session.prompt('run the echo command');

    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'turn.ended' &&
            (event as { reason?: string }).reason === 'completed',
        ),
      60_000,
      'turn.ended completed',
    );

    // The parked Bash approval crossed the socket to the SDK handler.
    expect(approvalCalls).toBe(1);
    // The tool ran server-side and the model saw its output.
    expect(modelCalls.length).toBeGreaterThanOrEqual(2);
    const serialized = JSON.stringify(events);
    expect(serialized).toContain('remote-ok');

    // Same-engine proof: the turn is readable through the server's REST
    // transcript of the same session.
    const deadline = Date.now() + 15_000;
    let body = '';
    for (;;) {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/v1/sessions/${session.id}/transcript?agent_id=main`,
        { headers: { authorization: `Bearer ${server.authTokenService.getToken()}` } },
      );
      expect(response.status).toBe(200);
      body = await response.text();
      if (body.includes('remote-ok')) break;
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(body).toContain('remote-ok');
  }, 90_000);
});
