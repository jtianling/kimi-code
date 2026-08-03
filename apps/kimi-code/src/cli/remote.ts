/**
 * Remote (one-engine) mode — run the CLI against a kap-server-hosted engine
 * over a unix socket instead of bootstrapping an in-process engine. Opt-in:
 *
 * - `KIMI_REMOTE=1` (or `true`) — require a live server; fail clearly when
 *   none is found (no silent fallback to the in-process engine).
 * - `KIMI_REMOTE=auto` — use a live server when one is found, or when the
 *   xats launcher env (`KIMI_XATS_BASE_URL` + `KIMI_XATS_SESSION_ID`) names
 *   one; otherwise fall back to the normal engine selection.
 * - `KIMI_REMOTE_SOCKET` — explicit socket path (implies remote, takes
 *   precedence over the mode variable).
 *
 * The socket convention is `<home>/server/klient-<port>.sock` (mounted by
 * kap-server); auth is the home-wide bearer token at `<home>/server.token`.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface RemoteConnection {
  readonly socketPath: string;
  readonly token?: string;
}

/** The xats launcher names its server by base URL + session id; extract the port. */
function xatsServerPort(): number | undefined {
  const baseUrl = process.env['KIMI_XATS_BASE_URL'];
  const sessionId = process.env['KIMI_XATS_SESSION_ID'];
  if (baseUrl === undefined || sessionId === undefined) return undefined;
  try {
    const port = Number(new URL(baseUrl).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** The home-wide bearer token (`<home>/server.token`); undefined when absent. */
async function readHomeToken(homeDir: string): Promise<string | undefined> {
  try {
    const token = (await readFile(join(homeDir, 'server.token'), 'utf8')).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

async function socketExists(socketPath: string): Promise<boolean> {
  try {
    await stat(socketPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the server to attach to: the xats launcher env names an exact
 * instance and wins; otherwise the first live instance in the home registry.
 * Deferred kap-server import so the server module graph only loads when
 * remote discovery actually runs.
 */
async function discoverSocketPath(homeDir: string): Promise<string | undefined> {
  const xatsPort = xatsServerPort();
  if (xatsPort !== undefined) {
    return join(homeDir, 'server', `klient-${xatsPort}.sock`);
  }
  const { listLiveServerInstances } = await import('@moonshot-ai/kap-server');
  const [first] = await listLiveServerInstances(homeDir);
  return first === undefined
    ? undefined
    : join(homeDir, 'server', `klient-${first.port}.sock`);
}

/**
 * Resolve the remote connection for this launch, or `undefined` to run the
 * normal (in-process) engine selection. Throws when remote mode was
 * explicitly required (`KIMI_REMOTE=1` / `KIMI_REMOTE_SOCKET`) but the
 * server or its klient IPC socket is missing.
 */
export async function resolveRemoteConnection(
  homeDir: string,
): Promise<RemoteConnection | undefined> {
  const token = await readHomeToken(homeDir);

  const explicit = process.env['KIMI_REMOTE_SOCKET'];
  if (explicit !== undefined && explicit.length > 0) {
    if (!(await socketExists(explicit))) {
      throw new Error(
        `KIMI_REMOTE_SOCKET is set but no klient IPC socket exists at ${explicit}. ` +
          'Start the server with `kimi web --no-open` (klient IPC mounts by default).',
      );
    }
    return { socketPath: explicit, token };
  }

  const mode = process.env['KIMI_REMOTE'];
  if (mode === undefined || mode === '' || mode === '0' || mode === 'false') return undefined;
  const required = mode !== 'auto';

  let socketPath: string | undefined;
  try {
    socketPath = await discoverSocketPath(homeDir);
  } catch {
    socketPath = undefined;
  }
  if (socketPath !== undefined && !(await socketExists(socketPath))) {
    socketPath = undefined;
  }
  if (socketPath === undefined) {
    if (!required) return undefined;
    throw new Error(
      `KIMI_REMOTE=${mode} but no live kimi server with a klient IPC socket was found under ` +
        `${join(homeDir, 'server')}. Start one with \`kimi web --no-open\`, or unset KIMI_REMOTE.`,
    );
  }
  return { socketPath, token };
}
