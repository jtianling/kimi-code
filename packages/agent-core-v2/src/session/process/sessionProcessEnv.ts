/**
 * `process` domain — per-session env overlay for spawned tool processes.
 *
 * `KIMI_XATS_SESSION_ID` is the xats launcher contract: the launcher exports
 * it so the agent can register its exact session for cross-agent pokes. An
 * in-process TUI inherits the correct value from the launcher, but under a
 * remote (kap-server-hosted) engine the tool process is spawned by the
 * long-lived server, whose inherited value names whatever session the
 * server's launching shell pointed at — every session on that server would
 * read the same stale id and register it. Re-binding the variable to the
 * owning session at spawn time keeps the contract exact in both modes.
 */

import { type IProcess, type ISessionProcessRunner, type ProcessExecOptions } from './processRunner';

export function sessionProcessEnv(sessionId: string): Record<string, string> {
  return { KIMI_XATS_SESSION_ID: sessionId };
}

/**
 * Delegating `ISessionProcessRunner` that overlays a fixed per-session env
 * bag onto every `exec` call (a per-call `options.env` still wins). Used to
 * give a scope-agnostic inner runner — e.g. the handler-shared workspace
 * runner — the owning session's overlay.
 */
export class SessionEnvProcessRunner implements ISessionProcessRunner {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly inner: ISessionProcessRunner,
    private readonly env: Record<string, string>,
  ) {}

  exec(args: readonly string[], options?: ProcessExecOptions): Promise<IProcess> {
    return this.inner.exec(args, { ...options, env: { ...this.env, ...options?.env } });
  }
}
