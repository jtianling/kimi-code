import type { IMcpManagementService } from '@moonshot-ai/agent-core-v2';
import type { Klient } from '@moonshot-ai/klient';

export function remoteMcpManagement(klient: Klient): IMcpManagementService {
  const mcp = klient.global.mcp;
  return {
    _serviceBrand: undefined,
    listServers: (query) => mcp.list(query),
    getServer: (name, query) => mcp.get({ name, cwd: query?.cwd }),
    addServer: (server, query) => mcp.add({ server, cwd: query?.cwd }),
    updateServer: (server, query) => mcp.update({ server, cwd: query?.cwd }),
    removeServer: (name, query) => mcp.remove({ name, cwd: query?.cwd }),
    testServer: (target) => mcp.test(target),
    listAuthStatuses: (query) => mcp.authStatuses(query),
    inspectServers: (targets, query) => mcp.inspect({ targets, cwd: query?.cwd }),
    resolveServerByName: (name, query) => mcp.resolveByName({ name, cwd: query?.cwd }),
    beginServerAuth: (locator, query) => mcp.beginAuth({ locator, cwd: query?.cwd }),
    completeServerAuth: (input, options) =>
      completeAuth(klient, input, options?.signal),
    cancelServerAuth: (input) => mcp.cancelAuth(input),
    resetServerAuth: (locator, query) => mcp.resetAuth({ locator, cwd: query?.cwd }),
  };
}

async function completeAuth(
  klient: Klient,
  input: { flowId: string; timeoutMs?: number },
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (signal === undefined) return klient.global.mcp.completeAuth(input);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      void klient.global.mcp
        .cancelAuth({ flowId: input.flowId })
        .then(() => reject(signal.reason), reject);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([klient.global.mcp.completeAuth(input), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
