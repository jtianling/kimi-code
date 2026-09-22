

import { mkdtemp,rm } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo,Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll,beforeAll,describe,expect,it } from 'vitest';

import type { AgentHandle,Klient } from '@moonshot-ai/klient';
import { createKlient } from '@moonshot-ai/klient/ipc';

import { startServer,type RunningServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const REPLY_TEXT = 'ipc-ok';
const MODEL_ID = 'ipc-stub';

function sseLines(...events: readonly string[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    lines.push(`data: ${event}`, '');
  }
  return lines;
}

function openAiSse(text: string): string[] {
  return [
    ...sseLines(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock',
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      }),
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    ),
    'data: [DONE]',
    '',
  ];
}

async function onceEvent(
  events: AgentHandle['events'],
  name: 'prompt.completed' | 'prompt.aborted',
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${name}`));
    }, timeoutMs);
    const sub = events.on(name, (payload) => {
      clearTimeout(timer);
      sub.dispose();
      resolve(payload as Record<string, unknown>);
    });
  });
}

describe('kap-server klient IPC mount', () => {
  let homeDir: string;
  let workDir: string;
  let server: RunningServer;
  let klient: Klient;
  let mockModel: Server;
  let mockBaseUrl: string;
  let chatCompletionsCalls = 0;
  const mockSockets = new Set<Socket>();

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kap-klient-ipc-home-'));
    workDir = await mkdtemp(join(tmpdir(), 'kap-klient-ipc-work-'));

    mockModel = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        for await (const _chunk of req) {

        }
        if (req.url === '/v1/chat/completions') chatCompletionsCalls += 1;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.end(`${openAiSse(REPLY_TEXT).join('\n')}\n`);
      })().catch(() => {
        res.destroy();
      });
    });
    mockModel.on('connection', (socket) => {
      mockSockets.add(socket);
      socket.on('close', () => mockSockets.delete(socket));
    });
    await new Promise<void>((resolve) => mockModel.listen(0, '127.0.0.1', resolve));
    mockBaseUrl = `http://127.0.0.1:${(mockModel.address() as AddressInfo).port}`;

    server = await startServer({
      homeDir,
      port: 0,
      hostIdentity: TEST_HOST_IDENTITY,
    });
  }, 60_000);

  afterAll(async () => {
    await klient?.close();
    await server?.close();
    for (const socket of mockSockets) socket.destroy();
    await new Promise<void>((resolve) => {
      mockModel.close(() => resolve());
    });
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('mounts the IPC socket named after the bound port', () => {
    expect(server.klientIpcSocketPath).toBe(
      join(homeDir, 'server', `klient-${server.port}.sock`),
    );
  });

  it('rejects a wrong hello token', async () => {
    const wrong = createKlient({ socketPath: server.klientIpcSocketPath!, token: 'wrong' });
    await expect(wrong.global.env()).rejects.toThrow();
    await wrong.close();
  });

  it('drives a full turn over IPC that is visible on the REST surface', async () => {
    klient = createKlient({
      socketPath: server.klientIpcSocketPath!,
      token: server.authTokenService.getToken(),
    });

    await klient.global.kosong.addProvider({
      id: MODEL_ID,
      model: 'stub',
      protocol: 'openai',
      baseUrl: `${mockBaseUrl}/v1`,
      auth: { method: 'api-key', apiKey: 'test-key' },
      maxContextSize: 8000,
    });

    const session = await klient.global.sessions.create({ workDir });
    const agent = klient.session(session.id).agent('main');
    await agent.setModel(MODEL_ID);




    const transcriptUrl = `/api/v1/sessions/${session.id}/transcript?agent_id=main`;
    const base = `http://127.0.0.1:${server.port}`;
    await authedFetch(server, base, transcriptUrl);

    const settled = Promise.race([
      onceEvent(agent.events, 'prompt.completed', 60_000),
      onceEvent(agent.events, 'prompt.aborted', 60_000).then((payload) => {
        throw new Error(`prompt aborted: ${JSON.stringify(payload)}`);
      }),
    ]);
    await agent.prompt({ input: [{ type: 'text', text: 'ping' }] });
    await settled;

    expect(chatCompletionsCalls).toBeGreaterThan(0);



    const deadline = Date.now() + 15_000;
    let body = '';
    for (;;) {
      const response = await authedFetch(server, base, transcriptUrl);
      expect(response.status).toBe(200);
      body = await response.text();
      if (body.includes(REPLY_TEXT)) break;
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(body).toContain(REPLY_TEXT);
  }, 90_000);
});
