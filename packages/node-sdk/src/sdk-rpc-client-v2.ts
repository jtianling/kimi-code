import { log } from '#/logging/index';
import { RegistryImportError } from '#/catalog';
import { remoteMcpManagement } from '#/v2/remote-mcp';
import type { Event2 } from '@moonshot-ai/agent-core-v2';
import {
  IFlagService,
  IMcpManagementService,
  IMcpOAuthService,
  isError2,
  ISessionManager,
  towerEnterFailureMessage,
  Error2 as V2Error2,
  ErrorCodes as V2ErrorCodes,
  type HostUiCapability,
  type McpManagedServer,
} from '@moonshot-ai/agent-core-v2';
import {
  type ImportCustomRegistryOptions,
  type ImportCustomRegistryResult,
} from '@moonshot-ai/klient';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  bootstrap,
  DEFAULT_AGENT_PROFILE_NAME,
  drainLogCloses,
  drainQueryStoreDisposals,
  drainSessionIndexMirror,
  ensureKimiHome,
  getLiveSessionById,
  IConfigService,
  IHostEnvironment,
  IHostFileSystem,
  IModelService,
  IProviderService,
  ISessionActivityView,
  ISessionIndexMirror,
  ITelemetryService,
  logSeed,
  MAIN_AGENT_ID,
  PRINT_MAX_TURNS_DEFAULT,
  PRINT_WAIT_CEILING_S_DEFAULT,
  resolveAgentTaskConfig,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  resolvePrintBackgroundMode,
  sessionDirOf,
  workspacePersistenceScope,
  type IDisposable,
  type Scope,
  type ServicesAccessor,
} from '@moonshot-ai/agent-core-v2';
import { encodeWorkDirKey } from '@moonshot-ai/agent-core-v2/_base/utils/workdir-slug';
import {
  LEGACY_BACKGROUND_SECTION,
  TASK_SECTION,
} from '@moonshot-ai/agent-core-v2/agent/task/configSection';
import {
  loadMcpServersDetailed,
  resolveMcpJsonPaths,
} from '@moonshot-ai/agent-core-v2/app/mcpConfig/configLoader';
import type { McpServerConfig as WorkspaceMcpServerConfig } from '@moonshot-ai/agent-core-v2/mcpCore/config-schema';
import {
  HostFsError,
  OsFsErrors,
} from '@moonshot-ai/agent-core-v2/os/interface/hostFsErrors';
import { IAppendLogStore } from '@moonshot-ai/agent-core-v2/persistence/interface/appendLogStore';
import { fsSuggestRequestSchema } from '@moonshot-ai/agent-core-v2/workspace/workspaceFs/fs';
import {
  assertKimiHostIdentity,
  createKimiDefaultHeaders,
} from '@moonshot-ai/kimi-code-oauth';
import type { AgentHandle, Klient, SessionHandle } from '@moonshot-ai/klient';
import { RPCError } from '@moonshot-ai/klient';
import { createKlient as createIpcKlient } from '@moonshot-ai/klient/ipc';
import { createKlient } from '@moonshot-ai/klient/memory';

import { KimiAuthFacade } from '#/auth';
import { ensureConfigFile, HookDefSchema } from '#/config/index';
import type { AgentContextData } from '#/context';
import { ErrorCodes, isKimiErrorCode, KimiError, type KimiErrorCode } from '#/errors';
import type { ExperimentalFeatureState } from '#/flag';
import { KimiHarness } from '#/kimi-harness';
import type { BeginGlobalMcpServerAuthResult } from '#/mcp';
import {
  SDKRpcClientBase,
  type ActivatePluginCommandRpcInput,
  type ActivateSkillRpcInput,
  type ImportContextRpcInput,
  type ReconnectMcpServerRpcInput,
  type ReloadSessionRpcInput,
  type RunCommandRpcInput,
  type SessionIdRpcInput,
  type SessionPromptRpcInput,
  type SessionPromptWithSkillsRpcInput,
  type SetSessionModelRpcInput,
  type SetSessionModelRpcResult,
  type SetSessionPermissionRpcInput,
  type SetSessionPlanModeRpcInput,
  type SetSessionSwarmModeRpcInput,
  type SetSessionThinkingRpcInput,
  type SetSessionTowerModeRpcInput,
  type SwitchSessionRuntimeRpcInput,
  type UpdateSessionMetadataRpcInput,
} from '#/rpc';
import { noopTelemetryClient } from '#/telemetry';
import type {
  AddAdditionalDirInput,
  AddAdditionalDirResult,
  AgentCommandInfo,
  AgentRuntimeBinding,
  AppMcpServerInspection,
  BackgroundTaskInfo,
  CapabilityStatus,
  CompactOptions,
  ConfigDiagnostics,
  CreateGoalInput,
  CreateSessionOptions,
  ExportSessionInput,
  ExportSessionResult,
  FileMeta,
  ForkSessionInput,
  GenerateSessionTitleInput,
  GetConfigOptions,
  GetCronTasksResult,
  GlobalMcpServerAuthStatus,
  GoalSnapshot,
  GoalToolResult,
  JsonObject,
  KimiConfig,
  KimiConfigPatch,
  KimiHarnessOptions,
  KimiHostIdentity,
  ListSessionsOptions,
  McpManagedServerInfo,
  McpServerConfig,
  McpServerInfo,
  McpServerLocator,
  McpStartupMetrics,
  McpTestResult,
  OAuthRefreshOutcome,
  PluginCommandDef,
  PluginInfo,
  PluginSummary,
  ReloadSummary,
  RenameSessionInput,
  ResumedAgentState,
  ResumedSessionSummary,
  ResumeSessionInput,
  SessionPlan,
  SessionStatus,
  SessionSummary,
  SessionSummaryPage,
  SessionTodoItem,
  SessionUsage,
  SkillSummary,
  SuggestFilesInput,
  SuggestFilesResult,
  TelemetryClient,
  UploadFileOptions,
  WorkspaceTrustInfo,
} from '#/types';
import {
  diagnosticsToConfigDiagnostics,
  planProviderRemoval,
  resolvedConfigToKimiConfig,
} from '#/v2/config-mapper';
import { translateGlobalEvent } from '#/v2/event-mapper';
import {
  normalizeServerName,
  parseInlineMcpServer,
  parseReconnectMcpServerConfig,
} from '#/v2/global-mcp';
import { assertImportFits, buildImportContextMessage } from '#/v2/import-context';
import { foldAgentWireReplay, type FoldedAgentReplay } from '#/v2/resume-replay';
import {
  normalizeWorkDir,
  v2MetaToSessionMeta,
  v2SummaryToSessionSummary,
} from '#/v2/session-mapper';
import { SessionEventWiring } from '#/v2/session-wiring';

export interface SDKRpcClientV2Options {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly identity?: KimiHostIdentity;
  /**
   * Explicit skill directories for this process (v1's SDK `skillDirs` /
   * the CLI's `--skills-dir`): when non-empty, default user / project skill
   * discovery is skipped and these directories serve as the user skill
   * source. Passed into the engine through `BootstrapInput.args.skillDirs`.
   */
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient;
  readonly onOAuthRefresh?: (outcome: OAuthRefreshOutcome) => void;
  readonly uiMode?: string;
  /**
   * Remote (ipc) mode: a pre-built klient over a unix-socket connection to a
   * kap-server-hosted engine. When set, the client does NOT bootstrap an
   * in-process engine — every session method crosses the socket instead.
   * In-process-only capabilities degrade explicitly: `engineAccessor` throws,
   * engine-side telemetry install and workspace-handler lifecycle tracking
   * are skipped, and the user-global MCP OAuth store (built on the app-scope
   * document store) is unavailable.
   */
  readonly remoteKlient?: Klient;
  readonly uiCapabilities?: readonly HostUiCapability[];
}

/**
 * The largest `setTimeout` delay before Node's timer overflows into an
 * immediate fire (2^31 - 1 ms ≈ 24.8 days) — the same bound v1's
 * `timeoutOutcome` clamps to.
 */
const MAX_TIMER_DELAY_MS = 0x7fffffff;

/** The klient dispatcher's wire code for a failed scope resolution. */
const WIRE_NOT_FOUND = 40404;

/** A mid-iteration agent exit (the dispatcher's `agent not found`). */
function isAgentGone(error: unknown): boolean {
  return (
    error instanceof RPCError &&
    error.code === WIRE_NOT_FOUND &&
    error.message.startsWith('agent not found')
  );
}

/** Drop a rejected per-agent wait/suppress when the agent exited mid-drain. */
function swallowAgentGone(error: unknown): undefined {
  if (isAgentGone(error)) return undefined;
  throw error;
}

export class SDKRpcClientV2 extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
  readonly auth: KimiAuthFacade;
  readonly klient: Klient;

  private readonly app: Scope | undefined;
  /** `skillDirs` captured at construction (mirrors `BootstrapInput.args.skillDirs`). */
  private readonly skillDirs: readonly string[];
  /**
   * The engine's config reads (`get`/`getAll`/`inspect`/`diagnostics`) are
   * synchronous over state that only exists once the initial load settles;
   * unlike the mutating methods they do not await `IConfigService.ready`
   * internally, so every config override below awaits this first. Awaiting
   * the engine's own ready handle (via the accessor) instead of issuing a
   * dummy facade call keeps the reads honest no-ops.
   */
  private readonly configReady: Promise<void>;
  /**
   * Per-session print-steer state for `handlePrintMainTurnCompleted`: v1
   * keeps the deadline/turn counters on the `Session` object, so they reset
   * when the session closes (a resume builds a fresh `Session`); mirrored
   * here by deleting the entry in {@link unwireSession}, which every close
   * path (client, engine, delete) funnels through.
   */
  private readonly printSteerStates = new Map<
    string,
    { deadline?: number; turns: number }
  >();
  /**
   * The model/provider registries (`IModelService` / `IProviderService`)
   * share the config service's ready trap: their `get`/`list` reads are
   * synchronous over state that only exists after hydration, and every
   * agent-side model operation (profile bind, `setModel`, capability reads)
   * flows through them. Agent-interaction overrides await this before
   * touching a profile.
   */
  private readonly modelReady: Promise<void>;
  /**
   * Per-live-session event/interaction wirings (`src/v2/session-wiring.ts`):
   * created when a session materializes through this client (create / resume /
   * fork / reload), dropped on close (ours or the engine's). Each wiring feeds
   * the base class's event listeners from the session's per-agent event buses
   * and bridges its pending approvals / questions / user-tool calls to the
   * registered handlers.
   */
  private readonly sessionWirings = new Map<string, SessionEventWiring>();
  /**
   * Per-session serialization for the operations that change a session's
   * live ownership: the temporary resume→act→close paths (`renameSession`,
   * `generateSessionTitle`) and the public `resumeSession` / `closeSession`
   * / `reloadSession`. Chaining them through one queue per session id makes
   * the handoff atomic — a public resume either lands first (the temporary
   * path then reuses the live handle and leaves it open) or waits for the
   * temporary close to finish and materializes a fresh scope, so a caller
   * can never receive a handle whose close is already in flight.
   */
  private readonly sessionAccessQueues = new Map<string, Promise<void>>();
  /** App-scope subscriptions (global event forwarding, lifecycle tracking), disposed in {@link close}. */
  private readonly appSubscriptions: IDisposable[] = [];

  constructor(options: SDKRpcClientV2Options = {}) {
    super();
    this.identity =
      options.identity === undefined
        ? undefined
        : assertKimiHostIdentity(options.identity);
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    ensureKimiHome(this.homeDir);
    this.skillDirs = options.skillDirs ?? [];
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.auth = new KimiAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      onRefresh: options.onOAuthRefresh,
    });

    const identity = assertKimiHostIdentity(this.identity);

    // Remote (ipc) mode: the engine lives in the kap-server process that
    // serves this klient's socket — skip bootstrap entirely. The local
    // harness bread (identity/homeDir/configPath/auth) is unchanged: same
    // machine, same homeDir. In-process-only pieces degrade here:
    // - config/model "ready" traps are in-process sync primitives; the wire
    //   reads are served by the already-running server, so they resolve
    //   immediately;
    // - engine telemetry install and workspace-handler lifecycle tracking
    //   stay server-side / are skipped (session wirings are disposed
    //   wholesale on close()).
    if (options.remoteKlient !== undefined) {
      this.app = undefined;
      this.klient = options.remoteKlient;
      this.configReady = Promise.resolve();
      this.modelReady = Promise.resolve();
      this.appSubscriptions.push(
        this.klient.events.on('session.metaUpdated', (payload) => {
          const translated = translateGlobalEvent({
            type: 'session.meta.updated',
            payload,
          } as unknown as Event2<any>);
          if (translated !== undefined) this.receiveEvent(translated);
        }),
      );
      return;
    }

    const { app } = bootstrap(
      {
        homeDir: this.homeDir,
        configPath: this.configPath,
        clientIdentity: identity,
        args: {
          // Host identity headers for the engine's outbound requests (model,
          // WebSearch, registry refresh). Without them the managed vendors go
          // out with the SDK's default User-Agent and no X-Msh-* at all.
          requestHeaders: createKimiDefaultHeaders({
            homeDir: this.homeDir,
            ...identity,
          }),
          // `--skills-dir` (v1 parity): explicit skill dirs replace default
          // user / project discovery for every session this client hosts.
          skillDirs: options.skillDirs,
          uiCapabilities: options.uiCapabilities,
        },
      },
      [...logSeed(resolveLoggingConfig({ homeDir: this.homeDir, env: process.env }))],
    );
    this.app = app;
    this.klient = createKlient({ scope: app });
    this.configReady = app.accessor.get(IConfigService).ready;
    this.installEngineTelemetry(options.telemetry);
    this.modelReady = Promise.all([
      this.configReady,
      app.accessor.get(IModelService).ready,
      app.accessor.get(IProviderService).ready,
    ]).then(() => undefined);
    this.appSubscriptions.push(
      // v1's stream carries `session.meta.updated` (the prompt metadata
      // path) — the one v1-visible fact the v2 engine publishes on the
      // process-global bus. Forwarded through the klient global events hub
      // (whose registry exposes exactly that bus type); every other
      // global-bus type is a daemon/WS-edge event the in-process v1 client
      // never saw.
      this.klient.events.on('session.metaUpdated', (payload) => {
        const translated = translateGlobalEvent({
          type: 'session.meta.updated',
          payload,
        } as unknown as Event2<any>);
        if (translated !== undefined) this.receiveEvent(translated);
      }),
      // A session closed without going through this client (archive, an
      // engine-initiated close) drops its wiring with the scope. Close events
      // fire per workspace handler, so follow every handler — present and
      // future — through the App-scope registry. NOT wire-expressible (the
      // handler set is lazy and unbounded, and the klient events hub has no
      // workspace-scope lifecycle registrations), so this subscription stays
      // on the in-process accessor; it only drives local wiring disposal.
      app.accessor.get(ISessionManager).onDidCloseSession!((closed) => {
        this.unwireSession(closed.sessionId);
      }),
    );
  }

  async ensureConfigFile(): Promise<void> {
    await ensureConfigFile(this.configPath);
    // Surface a missing Git Bash early, before the TUI starts. The wait is
    // Windows-only: the failure cannot happen on POSIX, and `ready` also
    // covers the login-shell PATH enrichment, which spawns the user's login
    // shell (5s timeout) — config-only commands must not block on that.
    if (process.platform === 'win32') {
      await this.app?.accessor.get(IHostEnvironment).ready;
    }
  }

  async close(): Promise<void> {
    for (const wiring of this.sessionWirings.values()) {
      wiring.dispose();
    }
    this.sessionWirings.clear();
    for (const subscription of this.appSubscriptions) {
      subscription.dispose();
    }
    await this.klient.close();
    if (this.app === undefined) return;
    // Same shutdown order as kap-server: drain the session-index mirror while
    // the query store is still open, then await the asynchronous closes that
    // disposal fires — a host that removes homeDir right after close() must
    // not race an in-flight shard close (ENOTEMPTY on teardown).
    await this.app.accessor.get(ISessionIndexMirror).drain();
    // Await the OAuth service shutdown directly rather than after dispose():
    // its ledger-teardown dispose can queue behind slow async disposables, and
    // the accessor throws once the scope is disposed. shutdown() is
    // idempotent, so the ledger's own teardown turns into a no-op.
    await this.app.accessor.get(IMcpOAuthService).shutdown();
    const appendLogStore = this.app.accessor.get(IAppendLogStore);
    this.app.dispose();
    await appendLogStore.drainRetirements();
    await drainSessionIndexMirror();
    await drainQueryStoreDisposals();
    await drainLogCloses();
  }

  /**
   * Forward engine telemetry to the host-supplied client. Without this the
   * client only served `KimiHarness`-level events and every engine-side event
   * (`track2` facts from agent/session scopes) was dropped on the v2 route.
   * The v1 `TelemetryClient` is wrapped into the engine appender record shape
   * (event + ambient context + final properties). The `telemetry` config
   * section gates engine events the same way the v2 print runner gates them;
   * the host keeps owning the client's lifecycle (flush / shutdown stay with
   * the host, matching the v1 core's arrangement).
   *
   * The engine's own `session_started` is forwarded unless
   * {@link suppressEngineSessionStarted} was called — see its doc for why the
   * harness-assembled client drops that row.
   */
  private installEngineTelemetry(client: TelemetryClient | undefined): void {
    if (client === undefined) return;
    if (this.app === undefined) return;
    const telemetry = this.app.accessor.get(ITelemetryService);
    telemetry.addAppender({
      track: (record) => {
        if (this.engineSessionStartedSuppressed && record.event === 'session_started')
          return;
        client.track(record.event, record.properties);
      },
    });
    void this.configReady.then(() => {
      telemetry.setEnabled(
        this.engineAccessor.get(IConfigService).get('telemetry') !== false,
      );
    });
  }

  private engineSessionStartedSuppressed = false;

  /**
   * Drop the engine's own `session_started` from telemetry forwarding. Called
   * by `createKimiHarness` at assembly time: the harness emits that event
   * for every session it opens (create / resume / reload / fork) with the
   * richer client-attribution schema, so the engine's
   * `{resumed, experimental_flags}` copy would double-count every open.
   * Direct `SDKRpcClientV2` consumers never call this and keep the engine row
   * — it is their only `session_started` producer. Hosts without a harness
   * (run-v2-print, kap-server) wire their own appenders and are unaffected
   * either way.
   */
  suppressEngineSessionStarted(): void {
    this.engineSessionStartedSuppressed = true;
  }

  /**
   * Exposed experimental flag ids in the `session_started` wire shape (sorted,
   * comma-joined), read live from the in-process engine's flag service. The
   * harness-side `session_started` row merges this so both producers of the
   * event carry the same flag dimension. Exposure is the flag system's own
   * notion (`IFlagService.exposedIds`): a flag that is enabled but not yet
   * active in this process (e.g. its feature assembles at App construction)
   * does not count.
   */
  enabledExperimentalFlags(): string {
    if (this.app === undefined) return '';
    return this.engineAccessor.get(IFlagService).exposedIds().toSorted().join(',');
  }

  /**
   * Escape hatch to the in-process engine's app-scope service accessor, for
   * SDK methods whose capability exists in agent-core-v2 but is not (yet)
   * exposed through the klient facade. This is a deliberate migration
   * pressure valve, not a new public API direction:
   * - it only exists because this client owns the bootstrapped `Scope` —
   *   there is nothing equivalent on a remote (ipc) transport, so anything
   *   built on it is in-process-only by construction;
   * - it resolves App-scope services only. Session/agent services need their
   *   own scope handles (via the lifecycle services), not this accessor;
   * - every use should name the klient facade method it stands in for, and
   *   move onto the facade once one exists. Remove when the migration ends.
   */
  get engineAccessor(): ServicesAccessor {
    if (this.app === undefined) {
      throw new KimiError(
        ErrorCodes.NOT_IMPLEMENTED,
        'engineAccessor is in-process only; the remote (ipc) client does not own an engine scope.',
      );
    }
    return this.app.accessor;
  }

  override async getExperimentalFeatures(): Promise<
    readonly ExperimentalFeatureState[]
  > {
    return this.klient.global.flags.list();
  }

  /**
   * Facade (`global.skills.discover`): the roots are resolved client-side
   * from the v2 root helpers (user + project roots — pure path/fs probes on
   * the same host on both transports) and the code-defined `BUILTIN_SKILLS`
   * merge stays local; only the scan itself crosses the wire. `skillDirs`
   * (explicit dirs, captured at construction) replaces the default user /
   * project roots, matching the engine's session skill catalog. Gap vs the
   * v1 implementation: plugin skills are not included.
   */
  override async listWorkspaceSkills(
    workDir: string,
  ): Promise<readonly SkillSummary[]> {
    return this.klient.global.workspaces.listSkills(
      normalizeRequiredWorkDir('listWorkspaceSkills', workDir),
    );
  }

  /**
   * Facade (`global.workspaces.getTrust` — the same `handlerFor({ root })`
   * path `createSession` takes; materializing the workspace handler is a
   * no-op cost here: session creation does it anyway). The gated-server list
   * is what the pure config loader sees with project files included vs
   * skipped (the workspaceTrust gate inside the engine's
   * `workspaceMcpConfig`), computed locally over a node-fs read shim (the
   * loader only ever calls `readText`), best-effort: an unreadable/invalid
   * project file degrades to an empty list rather than failing the caller.
   */
  override async getWorkspaceTrustInfo(workDir: string): Promise<WorkspaceTrustInfo> {
    const trusted = await this.klient.global.workspaces.getTrust(workDir);
    if (trusted) return { trusted: true, gatedMcpServers: [] };
    try {
      // The loader only ever calls `readText`; the shim translates node
      // fs errors into the engine's `HostFsError` taxonomy so the loader's
      // own not-found handling applies verbatim.
      const fs = {
        readText: async (path: string): Promise<string> => {
          try {
            return await readFile(path, 'utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              throw new HostFsError(
                OsFsErrors.codes.OS_FS_NOT_FOUND,
                `not found: ${path}`,
              );
            }
            throw error;
          }
        },
      } as IHostFileSystem;
      const paths = await resolveMcpJsonPaths({
        fs,
        cwd: workDir,
        homeDir: this.homeDir,
      });
      const loaded = await loadMcpServersDetailed({
        fs,
        cwd: workDir,
        homeDir: this.homeDir,
        includeProject: true,
      });
      const projectPaths = new Set([paths.projectRoot, paths.project]);
      const gatedMcpServers = Object.entries(loaded.servers)
        .filter(([name]) => projectPaths.has(loaded.origins[name] ?? ''))
        .map(([name, config]) => describeWorkspaceMcpServer(name, config))
        .toSorted((a, b) => a.name.localeCompare(b.name));
      return { trusted: false, gatedMcpServers };
    } catch {
      return { trusted: false, gatedMcpServers: [] };
    }
  }

  /**
   * Facade (`global.workspaces.trust`); see {@link getWorkspaceTrustInfo}.
   * The flip fires `IWorkspaceTrust.onDidChange`, which makes the engine's
   * `workspaceMcpConfig` reload with project files included — project MCP
   * servers connect live, no restart needed.
   */
  override async trustWorkspace(workDir: string): Promise<void> {
    return this.klient.global.workspaces.trust(workDir);
  }

  /**
   * v1 returns the whole config.toml document as one `KimiConfig`; v2
   * resolves the same file per config domain. `getAll()` is the effective
   * view (file + env overlays + section defaults), which matches v1's
   * runtime config (`loadRuntimeConfigSafe` + the KIMI_MODEL_* overlay);
   * `reload` mirrors v1's re-read-from-disk option.
   */
  override async getConfig(options?: GetConfigOptions): Promise<KimiConfig> {
    await this.configReady;
    if (options?.reload) {
      await this.klient.global.config.reload();
    }
    return resolvedConfigToKimiConfig(await this.klient.global.config.getAll());
  }

  override async getConfigDiagnostics(): Promise<ConfigDiagnostics> {
    await this.configReady;
    return diagnosticsToConfigDiagnostics(
      await this.klient.global.config.diagnostics(),
    );
  }

  /**
   * A v1 patch is one deep-merge over the whole document; v2 deep-merges
   * per domain with the same plain-object-recursive / array-replace
   * semantics, so the patch fans out one `config.set` per top-level field.
   * Unknown-to-v2 fields (`yolo`, `planMode`, `telemetry`, ...) persist as
   * unregistered pass-through domains, like v1's schema keeping them.
   */
  override async setConfig(patch: KimiConfigPatch): Promise<KimiConfig> {
    await this.configReady;
    for (const [domain, domainPatch] of Object.entries(patch)) {
      if (domainPatch === undefined) continue;
      await this.klient.global.config.set({ domain, patch: domainPatch });
    }
    return this.getConfig();
  }

  /**
   * v1's removal cascades: the provider entry, every model pointing at it,
   * and the default pointers when they dangle. The engine's own
   * `kosong.removeProvider` only clears the default-provider pointer, so the
   * full v1 cascade is computed from the user-layer values (see
   * `planProviderRemoval`) and persisted as ONE atomic multi-section
   * replace — the same single-write shape as v1's `removeKimiProvider`, so a
   * process exit can never leave the file in a halfway-cascaded state. The
   * `[secondary_model]` section is left alone on purpose: an entry whose
   * model no longer resolves fails pool validation on the next session
   * create, surfacing a named error instead of silently rewriting the
   * user's configuration.
   */
  override async removeProvider(providerId: string): Promise<KimiConfig> {
    await this.configReady;
    const [providers, models, defaultModel, defaultProvider] = await Promise.all([
      this.klient.global.config.inspect<Record<string, unknown>>('providers'),
      this.klient.global.config.inspect<Record<string, Record<string, unknown>>>(
        'models',
      ),
      this.klient.global.config.inspect<string>('defaultModel'),
      this.klient.global.config.inspect<string>('defaultProvider'),
    ]);
    const plan = planProviderRemoval({
      providers: providers.userValue,
      models: models.userValue,
      defaultModel: defaultModel.userValue,
      defaultProvider: defaultProvider.userValue,
      providerId,
    });
    const sections: Record<string, unknown> = {
      providers: plan.providers,
      models: plan.models,
    };
    if (plan.clearDefaultModel) {
      sections['defaultModel'] = undefined;
    }
    if (plan.clearDefaultProvider) {
      sections['defaultProvider'] = undefined;
    }
    await this.klient.global.config.replaceSections({ sections });
    return this.getConfig();
  }

  override supportsAtomicSectionReplace(): boolean {
    return true;
  }

  override async importCustomRegistry(
    options: ImportCustomRegistryOptions,
  ): Promise<ImportCustomRegistryResult> {
    await this.configReady;
    try {
      return await this.klient.global.kosong.importCustomRegistry(options);
    } catch (error) {
      if (!(error instanceof RPCError)) throw error;
      const details = error.details as Record<string, unknown> | undefined;
      const phase = details?.['phase'];
      throw new RegistryImportError(
        error.message,
        phase === 'fetch' || phase === 'empty' ? phase : 'apply',
        typeof details?.['status'] === 'number' ? details['status'] : undefined,
      );
    }
  }

  override async replaceConfigSections(
    sections: Record<string, unknown>,
  ): Promise<void> {
    await this.configReady;
    await this.klient.global.config.replaceSections({ sections });
  }

  override async listPlugins(): Promise<readonly PluginSummary[]> {
    return this.klient.global.plugins.list();
  }

  override async installPlugin(source: string): Promise<PluginSummary> {
    return this.klient.global.plugins.install(source);
  }

  override async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    return this.klient.global.plugins.setEnabled({ id, enabled });
  }

  override async setPluginMcpServerEnabled(
    id: string,
    server: string,
    enabled: boolean,
  ): Promise<void> {
    return this.klient.global.plugins.setMcpServerEnabled({ id, server, enabled });
  }

  override async removePlugin(id: string): Promise<void> {
    return this.klient.global.plugins.remove(id);
  }

  override async reloadPlugins(): Promise<ReloadSummary> {
    const summary = await this.klient.global.plugins.reload();
    await this.refreshPluginSessionStarts();
    return summary;
  }

  override async getPluginInfo(id: string): Promise<PluginInfo> {
    // The v2 engine's hook-event union is a superset of v1's (`TurnStarted`,
    // `UserPromptQueued`, `TaskStarted`, `SessionHeartbeat` are v2-only). The
    // SDK contract keeps the v1 `PluginInfo` shape, so hooks using v2-only
    // events are dropped from the projection — mirroring how the config
    // mapper drops config domains v1 does not know.
    const info = await this.klient.global.plugins.info(id);
    const manifest =
      info.manifest === undefined
        ? undefined
        : {
            ...info.manifest,
            hooks: info.manifest.hooks?.filter((hook) =>
              (HookDefSchema.shape.event.options as readonly string[]).includes(
                hook.event,
              ),
            ) as NonNullable<PluginInfo['manifest']>['hooks'],
          };
    return { ...info, manifest };
  }

  /**
   * Capability surface (v2-only): built-in product capabilities (kimi-cu,
   * kimi-webbridge) with layered readiness and idempotent installs. v1 has
   * no capability domain, so these stay off the shared base — callers
   * feature-detect via `in` before use.
   */
  async listCapabilities(): Promise<readonly CapabilityStatus[]> {
    return this.klient.global.capabilities.list();
  }

  async getCapability(id: string): Promise<CapabilityStatus> {
    return this.klient.global.capabilities.get(id);
  }

  async installCapability(id: string): Promise<CapabilityStatus> {
    return this.klient.global.capabilities.install(id);
  }

  /**
   * Scope gap: v1 answers from the session's creation-time snapshot of the
   * enabled plugin commands, while the v2 engine only exposes the app-global
   * live view (`pluginService.listPluginCommands`), so the sessionId is
   * ignored here. The two agree for any session created after the last
   * plugin change; a v1 session predating an install/toggle goes stale where
   * v2 stays live.
   */
  override async listPluginCommands(
    input: SessionIdRpcInput,
  ): Promise<readonly PluginCommandDef[]> {
    void input;
    return this.listPluginCommandsGlobal();
  }

  /** App-global live view of the enabled plugin commands, no session required. */
  override async listPluginCommandsGlobal(): Promise<readonly PluginCommandDef[]> {
    return this.klient.global.plugins.listCommands();
  }

  // -----------------------------------------------------------------------
  // Session lifecycle
  //
  // The v2 engine splits what v1's SessionStore + in-memory session map did
  // across the app-scope `ISessionIndex` (persisted read model),
  // `IWorkspaceLifecycleService` (live workspace handlers and, under them, the
  // live session scopes), and the session-scope
  // metadata/workspace services. The klient facade covers all of it:
  // `global.sessions.*` for the index + create/export, and the
  // `klient.session(id)` facade for live checks, resume, fork (with an
  // explicit target id), and the metadata mutations.
  //
  // `createSessionWithKaos` / `resumeSessionWithKaos` are deliberately NOT
  // overridden: agent-core-v2 has no kaos injection point (its fs/process
  // abstraction is the engine-internal hostFs domain, resolved at bootstrap),
  // so the base class's degradation — ignore the kaos arguments and run a
  // plain local create/resume — is the honest behavior, the same one every
  // daemon-transport client settles for. Failing loudly instead would break
  // hosts that pass kaos opportunistically (the harness forwards it whenever
  // the host supplies one).
  // -----------------------------------------------------------------------

  /** v1's `requireSession` / store lookup failure shape. */
  private static sessionNotFound(sessionId: string): KimiError {
    return new KimiError(
      ErrorCodes.SESSION_NOT_FOUND,
      `Session "${sessionId}" was not found`,
      {
        details: { sessionId },
      },
    );
  }

  /**
   * v1's `AGENT_NOT_FOUND` for a non-main `interactiveAgentId` that does not
   * exist on the live session.
   */
  private agentNotFound(): KimiError {
    return new KimiError(
      ErrorCodes.AGENT_NOT_FOUND,
      `Agent "${this.interactiveAgentId}" was not found`,
    );
  }

  /**
   * Map the wire's scope-resolution failures back onto v1's error shapes: the
   * dispatcher rejects a dead session / unknown agent with
   * `RPCError(40404, 'session not found: …' | 'agent not found: …')`, which v1
   * hosts never see — they get `SESSION_NOT_FOUND` / `AGENT_NOT_FOUND`.
   */
  private translateScopeError(error: unknown, sessionId: string): unknown {
    if (error instanceof RPCError && error.code === WIRE_NOT_FOUND) {
      if (error.message.startsWith('session not found')) {
        return SDKRpcClientV2.sessionNotFound(sessionId);
      }
      if (error.message.startsWith('agent not found')) {
        return this.agentNotFound();
      }
    }
    return error;
  }

  /** Run a session-facade call with v1's `SESSION_NOT_FOUND` error shape. */
  private async callSession<T>(
    sessionId: string,
    fn: (session: SessionHandle) => Promise<T>,
  ): Promise<T> {
    try {
      return await fn(this.klient.session(sessionId));
    } catch (error) {
      throw this.translateScopeError(error, sessionId);
    }
  }

  /** v1's `requireSession`: reject unless the session is currently live. */
  private async requireLiveSessionId(sessionId: string): Promise<void> {
    if (!(await this.klient.session(sessionId).isLive())) {
      throw SDKRpcClientV2.sessionNotFound(sessionId);
    }
  }

  /**
   * The klient agent facade for the target agent, with v1's eager semantics
   * applied first: the main agent is materialized with its default binding
   * (the channel's own materialization would leave the profile unbound), and
   * scope failures surface as `SESSION_NOT_FOUND` / `AGENT_NOT_FOUND`.
   */
  private async agentFacade(sessionId: string): Promise<AgentHandle> {
    const facade = this.klient.session(sessionId).agent(this.interactiveAgentId);
    try {
      if (this.interactiveAgentId === MAIN_AGENT_ID) {
        await this.materializeMainAgent(sessionId);
      } else {
        // Non-main agents must already exist (v1's `AGENT_NOT_FOUND`); the
        // cheapest agent-scope probe materializes nothing.
        await facade.getProfileData();
      }
      return facade;
    } catch (error) {
      throw this.translateScopeError(error, sessionId);
    }
  }

  /**
   * Attach the event/interaction wiring to a freshly materialized session
   * (idempotent). Unwiring needs no call site of its own: every close path
   * goes through the engine's lifecycle close, whose `onDidCloseSession`
   * subscription (constructor) drops the wiring.
   */
  private wireSession(sessionId: string): void {
    if (this.sessionWirings.has(sessionId)) return;
    this.sessionWirings.set(
      sessionId,
      new SessionEventWiring(this.klient.session(sessionId), sessionId, this),
    );
  }

  private unwireSession(sessionId: string): void {
    // v1's print-steer counters die with the Session object; drop ours with
    // every close path (ours, the engine's, or a delete).
    this.printSteerStates.delete(sessionId);
    const wiring = this.sessionWirings.get(sessionId);
    if (wiring === undefined) return;
    this.sessionWirings.delete(sessionId);
    wiring.dispose();
  }

  /**
   * The v1 summary of a live session, read through the facade (metadata
   * document + the session's context paths and workspace additional dirs) —
   * no disk round-trip, and the additional dirs only exist on the live
   * session in both engines.
   */
  private async liveSessionSummary(sessionId: string): Promise<SessionSummary> {
    return this.callSession(sessionId, async (session) => {
      const [meta, ctx, activity] = await Promise.all([
        session.get(),
        session.context(),
        session.activityState(),
      ]);
      return {
        id: meta.id,
        title: meta.title,
        titleKind: meta.titleKind,
        lastTurnReason: activity.lastTurnReason,
        lastPrompt: meta.lastPrompt,
        workDir: ctx.cwd,
        sessionDir: ctx.sessionDir,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        archived: meta.archived,
        metadata: meta.custom as JsonObject | undefined,
        additionalDirs: ctx.additionalDirs,
      };
    });
  }

  /**
   * The `ResumedSessionSummary` of a just-materialized session, including the
   * per-agent snapshot v1 serves: the live slices are read through the klient
   * agent facade (profile / permission / swarm state + context / plan / usage
   * / background tasks), while `replay` and `toolStore` are folded from the
   * agent's `wire.jsonl` by {@link foldAgentWireReplay} (v2 has no replay
   * builder of its own — a same-host file read, identical on the memory and
   * unix-socket ipc transports). `warning` stays undefined — v2's resume has
   * no migration-warning channel.
   */
  private async resumedSessionSummary(
    sessionId: string,
    replay?: {
      readonly includeSubagents?: boolean;
      readonly replayTurnLimit?: number;
      readonly mainWireFold?: Promise<FoldedAgentReplay | undefined>;
    },
  ): Promise<ResumedSessionSummary> {
    return this.callSession(sessionId, async (session) => {
      const [meta, ctx, activity] = await Promise.all([
        session.get(),
        session.context(),
        session.activityState(),
      ]);
      const agents: Record<string, ResumedAgentState> = {};
      // v1 resumes the main agent eagerly; materializing here cold-restores
      // its wire into the scope (create-or-get) and applies the default
      // binding.
      await this.materializeMainAgent(sessionId);
      agents[MAIN_AGENT_ID] = await this.resumedAgentState(
        sessionId,
        MAIN_AGENT_ID,
        'main',
        ctx,
        replay?.replayTurnLimit,
        replay?.mainWireFold,
      );
      if (replay?.includeSubagents === true) {
        const agentsDir = join(ctx.sessionDir, 'agents');
        let subagentIds: readonly string[] = [];
        try {
          subagentIds = (await readdir(agentsDir, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && entry.name !== MAIN_AGENT_ID)
            .map((entry) => entry.name);
        } catch {
          // No agents directory at all → the main agent is the whole roster.
        }
        for (const agentId of subagentIds) {
          try {
            // `create` is create-or-get and cold-restores the persisted wire.
            await session.materializeAgent(agentId);
            agents[agentId] = await this.resumedAgentState(
              sessionId,
              agentId,
              'sub',
              ctx,
              replay.replayTurnLimit,
            );
          } catch {
            // Best-effort, same as v1: a subagent whose restore fails is left
            // out of the map (v1 logs a warning and continues with the rest).
          }
        }
      }
      return {
        id: meta.id,
        title: meta.title,
        titleKind: meta.titleKind,
        lastTurnReason: activity.lastTurnReason,
        lastPrompt: meta.lastPrompt,
        workDir: ctx.cwd,
        sessionDir: ctx.sessionDir,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        archived: meta.archived,
        metadata: meta.custom as JsonObject | undefined,
        additionalDirs: ctx.additionalDirs,
        sessionMetadata: v2MetaToSessionMeta(meta),
        agents,
        warning: undefined,
      };
    });
  }

  /**
   * One agent's v1 `ResumedAgentState`, read fully through the klient agent
   * facade; the casts only bridge the two packages' type declarations (the
   * wire shapes are the documented-identical ports, same as the `getContext`
   * / `listBackgroundTasks` overrides). One deliberate gap: `config.provider`
   * is always undefined — v1 resolves the full runtime `ProviderConfig` into
   * the snapshot, agent-core-v2 has no equivalent read, and the TUI only
   * falls back to `provider?.model` when `modelAlias` is unset (pinned in the
   * parity KNOWN_DIFFS).
   */
  private async resumedAgentState(
    sessionId: string,
    agentId: string,
    type: 'main' | 'sub',
    ctx: { readonly cwd: string; readonly sessionDir: string },
    replayTurnLimit?: number,
    earlyWireFold?: Promise<FoldedAgentReplay | undefined>,
  ): Promise<ResumedAgentState> {
    const facade = this.klient.session(sessionId).agent(agentId);
    const foldWire = () =>
      foldAgentWireReplay(
        join(ctx.sessionDir, 'agents', agentId, 'wire.jsonl'),
        replayTurnLimit,
      );
    const [
      context,
      plan,
      usage,
      background,
      folded,
      profile,
      permissionMode,
      rules,
      swarmMode,
      tools,
    ] = await Promise.all([
      facade.getContext(),
      facade.getPlan(),
      facade.getUsage(),
      facade.getTasks({ activeOnly: false }),
      earlyWireFold?.then((early) => early ?? foldWire()) ?? foldWire(),
      facade.getProfileData(),
      facade.getPermissionMode(),
      facade.getPermissionRules(),
      facade.isSwarmActive(),
      facade.getTools(),
    ]);
    return {
      type,
      config: {
        cwd: ctx.cwd,
        provider: undefined,
        modelAlias: profile.modelAlias,
        modelCapabilities: profile.modelCapabilities,
        profileName: profile.profileName,
        thinkingEffort: profile.thinkingLevel,
        systemPrompt: profile.systemPrompt,
      },
      context: context as AgentContextData,
      replay: folded.replay,
      permission: {
        mode: permissionMode,
        rules: [...rules],
      } as ResumedAgentState['permission'],
      plan: plan as ResumedAgentState['plan'],
      swarmMode,
      usage: usage as ResumedAgentState['usage'],
      tools: tools as ResumedAgentState['tools'],
      toolStore: folded.toolStore,
      background: background as readonly BackgroundTaskInfo[],
    };
  }

  /**
   * Every v2 workspace-id bucket addressing `workDir` (already normalized):
   * the registered workspace's alias set when the catalog knows the root, or
   * the freshly minted bucket key for index-only sessions (mirrors how v1's
   * store lists a bucket that never touched the workspace registry).
   */
  private async workspaceIdsFor(workDir: string): Promise<readonly string[]> {
    const workspaces = await this.klient.global.workspaces.list();
    const match = workspaces.find(
      (workspace) => normalizeWorkDir(workspace.root) === workDir,
    );
    if (match === undefined) return [encodeWorkDirKey(workDir)];
    return this.klient.global.workspaces.resolveAliasIds(match.id);
  }

  override async listSessions(
    input: ListSessionsOptions = {},
  ): Promise<readonly SessionSummary[]> {
    // Full-set semantics: drain keyset pages until the listing is exhausted
    // (an unpaged query currently answers in one page, but a backend may cap
    // it — never silently truncate the unpaged contract).
    const all: SessionSummary[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.listSessionsPage({
        workDir: input.workDir,
        sessionId: input.sessionId,
        includeArchived: input.includeArchived,
        before,
      });
      all.push(...page.items);
      if (page.nextCursor === undefined) return all;
      before = page.nextCursor;
    }
  }

  override async listSessionsPage(
    input: ListSessionsOptions = {},
  ): Promise<SessionSummaryPage> {
    // v1 rejects an empty workDir and bucket-filters by the normalized path;
    // the v2 index filters by workspace-id set instead.
    const workspaceIds =
      input.workDir === undefined
        ? undefined
        : await this.workspaceIdsFor(
            normalizeRequiredWorkDir('listSessions', input.workDir),
          );
    const page = await this.klient.global.sessions.list({
      workspaceIds,
      sessionId: input.sessionId,
      limit: input.limit,
      before: input.before,
      includeArchived: input.includeArchived,
    });
    const [env, sessionsScope, workspacesById] = await Promise.all([
      this.klient.global.env(),
      this.klient.global.envScope('sessions'),
      this.klient.global.workspaces
        .list()
        .then((list) => new Map(list.map((workspace) => [workspace.id, workspace]))),
    ]);
    const summaries: SessionSummary[] = [];
    for (const item of page.items) {
      const workDir = item.cwd ?? workspacesById.get(item.workspaceId)?.root;
      // A session whose workDir is unrecoverable (corrupt metadata, deleted
      // workspace) cannot be resumed on either engine; v1's store never lists
      // one in the first place, so drop it here too.
      if (workDir === undefined) continue;
      // A live session reports its own outcome; the index may still carry a
      // stale one while the mirror's clear is queued (a fresh turn just
      // started after a failure).
      // In-process only: the remote route has no engine scope to read, so it
      // keeps the index's own (possibly queued) outcome.
      const liveHandle =
        this.app === undefined
          ? undefined
          : getLiveSessionById(this.app.accessor, item.id);
      const effectiveItem =
        liveHandle === undefined
          ? item
          : {
              ...item,
              lastTurnReason: liveHandle.accessor.get(ISessionActivityView).state()
                .lastTurnReason,
            };
      summaries.push(
        v2SummaryToSessionSummary(effectiveItem, {
          workDir,
          sessionDir: sessionDirOf(
            env.homeDir,
            workspacePersistenceScope(sessionsScope, item.workspaceId),
            item.id,
          ),
        }),
      );
    }
    return { items: summaries, nextCursor: page.nextCursor };
  }

  /**
   * v1 semantics: register the workDir as a workspace and create the session
   * (the facade's `global.sessions.create` drives the same handler chain; it
   * takes the explicit session id but not caller metadata, which is applied
   * through the session facade below). The `model` / `thinking` /
   * `permission` options are the main-agent configuration v1 applies eagerly
   * at creation: supplying any of them materializes the main agent here (v2
   * otherwise keeps it lazy) and binds the default profile with the
   * requested model/thinking. v1 never validates either at create time — an
   * unknown alias is recorded verbatim and an unlisted effort normalizes to
   * the model default — so the bind is deliberately NOT `strictThinking`,
   * and the v2-only create-time rejections that still leak through (unknown
   * alias → `config.invalid`, no configured default model →
   * `model.not_configured`) are pinned in the parity tests.
   */
  override async createSession(input: CreateSessionOptions): Promise<SessionSummary> {
    // An explicit id takes the per-session queue so the check-then-create
    // below is atomic against another create/close of the same id; a random
    // id has no contenders and needs no serialization.
    if (input.id !== undefined) {
      return this.runSessionAccess(input.id, () => this.doCreateSession(input));
    }
    return this.doCreateSession(input);
  }

  private async doCreateSession(input: CreateSessionOptions): Promise<SessionSummary> {
    const workDir = normalizeRequiredWorkDir('createSession', input.workDir);
    if (input.id !== undefined) {
      const existing = await this.klient.global.sessions.get(input.id);
      if (existing !== undefined) {
        throw new KimiError(
          ErrorCodes.SESSION_ALREADY_EXISTS,
          `Session "${input.id}" already exists`,
        );
      }
    }
    const meta = await this.klient.global.sessions.create({
      workDir,
      additionalDirs: input.additionalDirs,
      id: input.id,
    });
    // Wired before the optional main-agent materialization so a profile-bind
    // warning (oversized AGENTS.md) reaches the listeners like v1's create.
    this.wireSession(meta.id);
    if (
      input.model !== undefined ||
      input.thinking !== undefined ||
      input.permission !== undefined
    ) {
      await this.materializeMainAgent(meta.id, {
        model: input.model,
        thinking: input.thinking,
      });
      if (input.permission !== undefined) {
        await this.klient
          .session(meta.id)
          .agent(MAIN_AGENT_ID)
          .setPermission(input.permission);
      }
    }
    if (input.metadata !== undefined) {
      await this.klient.session(meta.id).update({ custom: { ...input.metadata } });
    }
    // v1 returns the caller's metadata verbatim on create (not the merged
    // custom map a later listing would report), so override it here too.
    return { ...(await this.liveSessionSummary(meta.id)), metadata: input.metadata };
  }

  /**
   * v1 renames through the live session when there is one and at the store
   * level otherwise. The v2 metadata service is session-scoped (and the
   * klient session facade 404s on a non-live session), so a closed session is
   * resumed, renamed, and closed again to land in the same state. The v2
   * `setTitle` does no validation, so v1's trim + empty-title rejection lives
   * here.
   */
  override async renameSession(input: RenameSessionInput): Promise<void> {
    return this.runSessionAccess(input.id, async () => {
      const title = input.title.trim();
      if (title.length === 0) {
        throw new KimiError(
          ErrorCodes.SESSION_TITLE_EMPTY,
          'Session title cannot be empty',
        );
      }
      const session = this.klient.session(input.id);
      if (await session.isLive()) {
        await session.setTitle(title);
        return;
      }
      if (!(await session.resume())) throw SDKRpcClientV2.sessionNotFound(input.id);
      try {
        await session.setTitle(title);
      } finally {
        await session.close();
      }
    });
  }

  /**
   * Facade (`sessionLifecycleService.fork` with the explicit target id).
   * Known gaps vs v1: the engine's fork is unconditional — it never rejects
   * an in-flight source turn (v1's SESSION_FORK_ACTIVE_TURN) — and
   * `turnIndex` truncation has no v2 counterpart at all, so it fails loudly.
   * The default title also differs by design (v1: "New Session", v2:
   * "Fork: <source>") — pass an explicit title for identical results.
   */
  override async forkSession(input: ForkSessionInput): Promise<SessionSummary> {
    return this.runSessionAccessAll(
      input.forkId === undefined ? [input.id] : [input.id, input.forkId],
      async () => {
        const meta = await this.callSession(input.id, (session) =>
          session.fork({
            newSessionId: input.forkId,
            turnIndex: input.turnIndex,
            title: input.title,
            metadata: input.metadata,
          }),
        );
        if (!(await this.klient.session(meta.id).resume())) {
          throw SDKRpcClientV2.sessionNotFound(meta.id);
        }
        this.wireSession(meta.id);
        return this.resumedSessionSummary(meta.id);
      },
    );
  }

  override async closeSession(input: SessionIdRpcInput): Promise<void> {
    await this.runSessionAccess(input.sessionId, async () => {
      await this.klient.session(input.sessionId).close();
      this.unwireSession(input.sessionId);
    });
  }

  /**
   * Through `engineAccessor` (the handler chain's
   * `ISessionLifecycleService.delete`) because the klient facade's
   * `session(id).delete()` reports a missing session with its own
   * `RPCError(NOT_FOUND)` where v1's store failure is a
   * `KimiError(SESSION_NOT_FOUND)` — the pre-check here keeps the v1 shape.
   * The engine's delete mirrors v1's order: close the live session first
   * (which also drops this client's wiring via the close subscription), then
   * remove the session dir, the index entry, and journal the deletion.
   */
  override async deleteSession(input: SessionIdRpcInput): Promise<void> {
    // Same per-session queue as close/reload: a delete serializes against
    // every other lifecycle operation on the session.
    return this.runSessionAccess(input.sessionId, async () => {
      try {
        await this.callSession(input.sessionId, (session) => session.delete());
        this.unwireSession(input.sessionId);
      } catch (error) {
        // The session vanished between the index check and the delete: the
        // engine's own not-found crosses as an Error2 — restate it in v1's shape.
        if (
          error instanceof Error &&
          (error as { code?: unknown }).code === ErrorCodes.SESSION_NOT_FOUND
        ) {
          throw SDKRpcClientV2.sessionNotFound(input.sessionId);
        }
        throw error;
      }
    });
  }

  /**
   * Materializes the session through the facade (`session.resume` — unlike
   * `restore`, it leaves the archived flag untouched, matching v1's resume).
   * `includeSubagents` / `replayTurnLimit` shape the returned per-agent
   * snapshot exactly like v1: subagent states are folded best-effort from
   * each persisted agent wire, and every agent's replay is trimmed to the
   * most recent N user turns via the shared `limitAgentReplayByTurns`.
   */
  override async resumeSession(
    input: ResumeSessionInput,
  ): Promise<ResumedSessionSummary> {
    return this.runSessionAccess(input.id, async () => {
      // v1 re-resolves caller-provided additional dirs on every resume and
      // merges them over the workspace-local set; the engine's resume options
      // union them into the handler's shared in-memory set while the session
      // scope is materialized. Unlike v1, the v2
      // engine has no caller `mcpServers` channel on create/resume (caller
      // servers are an ACP-side concern to be designed separately).
      const mainWireFold = this.startMainWireFold(input.id, input.replayTurnLimit);
      const resumed = await this.klient
        .session(input.id)
        .resume({ additionalDirs: input.additionalDirs });
      if (!resumed) throw SDKRpcClientV2.sessionNotFound(input.id);
      this.wireSession(input.id);
      return this.resumedSessionSummary(input.id, {
        mainWireFold,
        includeSubagents: input.includeSubagents,
        replayTurnLimit: input.replayTurnLimit,
      });
    });
  }

  /**
   * Starts the main agent's wire fold as soon as its path is known — a live
   * session's own context, or the bucket computed from the index summary —
   * so the read-only fold overlaps the engine's restore instead of waiting
   * for it. The returned promise never rejects: the fold swallows its own
   * failures into an empty fold, and the path lookup degrades to `undefined`,
   * which makes {@link resumedAgentState} fold from the materialized handle
   * exactly as it would without the early start.
   */
  private startMainWireFold(
    sessionId: string,
    replayTurnLimit?: number,
  ): Promise<FoldedAgentReplay | undefined> {
    return Promise.all([
      this.klient.global.sessions.get(sessionId),
      this.klient.global.envScope('sessions'),
    ])
      .then(([summary, scope]) => {
        if (summary === undefined) return undefined;
        const sessionDir = sessionDirOf(
          this.homeDir,
          workspacePersistenceScope(scope, summary.workspaceId),
          sessionId,
        );
        return foldAgentWireReplay(
          join(sessionDir, 'agents', MAIN_AGENT_ID, 'wire.jsonl'),
          replayTurnLimit,
        );
      })
      .catch((error) => {
        log.warn('Early session replay read failed', {
          sessionId,
          error: String(error),
        });
        return undefined;
      });
  }

  /**
   * v1's reload: refuse while a turn runs, re-read config + plugins, close
   * the live session, resume from disk. The v2 busy check reads each live
   * agent's loop status (turn lane only — background tasks do not block,
   * matching v1's `hasActiveTurn`). `forcePluginSessionStartReminder` has no
   * v2 channel (the engine owns plugin session-start injection), so reload
   * refreshes the durable guidance snapshot through the Agent service.
   */
  override async reloadSession(
    input: ReloadSessionRpcInput,
  ): Promise<ResumedSessionSummary> {
    return this.runSessionAccess(input.sessionId, async () => {
      const sessionId = input.sessionId;
      const session = this.klient.session(sessionId);
      const live = await session.isLive();
      if (live) {
        for (const agentId of await session.listLiveAgents()) {
          const activity = await session.agent(agentId).getActivityState();
          if (activity.turn !== undefined) {
            throw new KimiError(
              ErrorCodes.TURN_AGENT_BUSY,
              `Session "${sessionId}" cannot be reloaded while a turn is running`,
              { details: { sessionId } },
            );
          }
        }
      } else if ((await this.klient.global.sessions.get(sessionId)) === undefined) {
        throw SDKRpcClientV2.sessionNotFound(sessionId);
      }
      await this.configReady;
      await this.klient.global.config.reload();
      await this.klient.global.plugins.reload();
      await this.refreshPluginSessionStarts(sessionId);
      if (live) {
        await session.close();
        this.unwireSession(sessionId);
      }
      // Same print-steer reset as closeSession: v1's reload rebuilds the
      // Session, and with it the counters.
      this.printSteerStates.delete(sessionId);
      if (!(await session.resume())) throw SDKRpcClientV2.sessionNotFound(sessionId);
      this.wireSession(sessionId);
      return this.resumedSessionSummary(sessionId);
    });
  }

  /**
   * The base-class contract merges the patch into the session's `custom` map
   * (v1 routes through the live session and 404s on a closed one; mirrored
   * here by {@link requireLiveSessionId}).
   */
  override async updateSessionMetadata(
    input: UpdateSessionMetadataRpcInput,
  ): Promise<void> {
    await this.requireLiveSessionId(input.sessionId);
    const current = await this.klient.session(input.sessionId).get();
    const custom = { ...current.custom, ...input.metadata };
    await this.klient.session(input.sessionId).update({ custom });
  }

  /**
   * Facade (`workspaceDirs.addDir` through the session's handler) — the
   * workspace-level add-dir surface: `persist: true` (default) appends to the
   * project-local `.kimi-code/local.toml`, `persist: false` joins the
   * handler's shared in-memory set. The set is shared by every session of
   * the workspace (a v1 `persist: false` dir was session-scoped and written
   * into session metadata to survive a resume; the v2 handler keeps it for
   * every session of the workspace until the process exits). Returns the
   * same `{additionalDirs, projectRoot, configPath, persisted}` shape as v1.
   */
  override async addAdditionalDir(
    input: AddAdditionalDirInput,
  ): Promise<AddAdditionalDirResult> {
    await this.requireLiveSessionId(input.id);
    return this.klient
      .session(input.id)
      .addAdditionalDir(input.path, { persist: input.persist });
  }

  /**
   * Facade (`sessionExportService.export`, app scope) — the v2 port of v1's
   * export: same payload fields, same zip writer layout, same live-session
   * flush before the read, and the same `SESSION_EXPORT_NOT_FOUND` for a
   * session without an exportable directory. Works on closed sessions on
   * both engines (v1 reads the store, v2 the index). Gaps, pinned in the
   * migration tracker: v2 additionally validates the host `version`
   * (`SESSION_EXPORT_MISSING_VERSION` on blank — v1 records it unchecked),
   * the manifest's activity timestamps come from v2's per-agent wire scan
   * (v1 scans only the root `wire.jsonl`), and the manifest carries v2's
   * extra `webLogPath` field (absent unless the host passes a web log, which
   * this client never does). The zip ENTRY LIST is not part of the parity
   * surface: the two engines lay their session directories out differently
   * by design.
   */
  override async exportSession(
    input: ExportSessionInput,
  ): Promise<ExportSessionResult> {
    return this.klient.global.sessions.export({
      sessionId: input.id,
      outputPath: input.outputPath,
      includeGlobalLog: input.includeGlobalLog,
      version: input.version,
      installSource: input.installSource,
      shellEnv: input.shellEnv,
    });
  }

  /**
   * Facade (`sessionSkillCatalog.listSkills`, dispatcher-synthesized with the
   * catalog's readiness awaited). Same merged view v1's `Session.listSkills`
   * serves (builtin + user + project + plugin skills through the same
   * `summarizeSkill` mapping), with the same snapshot-vs-live caveat as
   * `listPluginCommands`: v1 loads the registry once at session creation
   * while the v2 catalog re-merges on source changes mid-session; the two
   * agree for any session created after the last skill change.
   */
  override async listSkills(
    input: SessionIdRpcInput,
  ): Promise<readonly SkillSummary[]> {
    return this.callSession(input.sessionId, (session) => session.listSkills());
  }

  // -----------------------------------------------------------------------
  // Agent interaction
  //
  // v1 serves these from the session's eagerly-created main agent, already
  // configured with the model/thinking defaults. The v2 engine splits them
  // across the klient agent facade (model / permission / plan / context /
  // usage / cancel — validated contract calls) and agent-scope services the
  // facade does not cover (thinking, compaction, undo, context mutation),
  // reached through the live session handle. Every override requires a live
  // session (v1's `requireSession`) and resolves the target agent from
  // `interactiveAgentId`: the main agent materializes on first use with the
  // default profile bound (v1's eager equivalent); any other agent must
  // already exist (v1's `AGENT_NOT_FOUND`).
  // -----------------------------------------------------------------------

  /**
   * Materialize the session's main agent with v1's eager default binding
   * applied: a freshly created agent whose profile is still unbound gets the
   * default profile + configured default model (the same bind kap-server's
   * prompt route performs on first use). A home with no configured model
   * leaves the agent unbound instead of failing — v1's model-less session
   * reads (`model: undefined`, `'off'` thinking, zero capabilities) map onto
   * the unbound state exactly. The model-less case is PRE-CHECKED through the
   * config facade (`bind` resolves `input.model ?? defaultModel` and rejects
   * with `model.not_configured` when both are absent — a `ProfileError`
   * subclass that does not survive the ipc error mapping, so it cannot be
   * caught reliably over the wire).
   */
  private async materializeMainAgent(
    sessionId: string,
    binding?: { readonly model?: string; readonly thinking?: string },
  ): Promise<void> {
    await this.modelReady;
    const agent = this.klient.session(sessionId).agent(MAIN_AGENT_ID);
    if (binding !== undefined) {
      await agent.bindProfile({
        profile: DEFAULT_AGENT_PROFILE_NAME,
        model: binding.model,
        thinking: binding.thinking,
      });
      return;
    }
    const profile = await agent.getProfileData();
    if (profile.profileName !== undefined) return;
    const defaultModel = await this.klient.global.config.get<string>('defaultModel');
    if (defaultModel === undefined || defaultModel === '') return;
    await agent.bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME });
  }

  /**
   * Facade (`agentProfileService.setModel`). Both engines resolve the alias
   * up front, report the resolved provider name, and reject an unknown alias
   * with `config.invalid` (only the trailing message wording differs).
   */
  override async setModel(
    input: SetSessionModelRpcInput,
  ): Promise<SetSessionModelRpcResult> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.setModel(input.model);
  }

  /**
   * Facade (`agentProfileService.setThinking`). Same registry-driven
   * strictness as v1's `setThinkingEffort`: an unlisted effort on a
   * strict-thinking model rejects with `model.config_invalid` and the same
   * message on both engines; anything else normalizes through the same
   * resolution.
   */
  override async setThinking(input: SetSessionThinkingRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.setThinking(input.effort);
  }

  override async setPermission(input: SetSessionPermissionRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.setPermission(input.mode);
  }

  /** v1 maps the toggle onto two RPCs (`enterPlan` / `cancelPlan`); so does v2. */
  override async setPlanMode(input: SetSessionPlanModeRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    if (!input.enabled) return agent.cancelPlan();
    return agent.enterPlan();
  }

  override async getPlan(input: SessionIdRpcInput): Promise<SessionPlan> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getPlan();
  }

  override async clearPlan(input: SessionIdRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.clearPlan();
  }

  /** Facade (`agentCommandService.list`) — the v2-only contributed-command seam. */
  override async listCommands(
    input: SessionIdRpcInput,
  ): Promise<readonly AgentCommandInfo[]> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.listCommands();
  }

  /** Facade (`agentCommandService.run`) — runs the contribution engine-side. */
  override async runCommand(input: RunCommandRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.runCommand({ name: input.name, args: input.args });
  }

  override async getRuntime(input: SessionIdRpcInput): Promise<AgentRuntimeBinding> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getRuntime();
  }

  override async switchRuntime(
    input: SwitchSessionRuntimeRpcInput,
  ): Promise<AgentRuntimeBinding> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.switchRuntime(input.runtimeId);
  }

  /**
   * Facade (`getContext`, merged client-side from `agentContextMemoryService.get`
   * and `agentTokenCountingService.statusSize`). The v2 `AgentContextData` is the
   * same wire shape as v1's — the cast only bridges the two packages' type
   * declarations (v2's origin union carries kinds a v1 client never sees in
   * practice); the data itself crossed the same JSON boundary on both sides.
   * Token-count semantics differ by design: v1 reports the running estimate,
   * v2 the provider-measured prefix (`0` until the first LLM round) — pinned
   * in the parity KNOWN_DIFFS.
   */
  override async getContext(input: SessionIdRpcInput): Promise<AgentContextData> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getContext() as Promise<AgentContextData>;
  }

  override async getUsage(input: SessionIdRpcInput): Promise<SessionUsage> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getUsage();
  }

  /**
   * The base class aggregates v1's per-agent `getConfig` / `getContext` /
   * `getPermission` / `getPlan` / `getSwarmMode` / `getUsage` RPCs. The v2
   * rebuild reads the same six slices through the facade: the profile's bound
   * model alias and resolved thinking level + capabilities (v1's agent
   * `getConfig` — its `provider?.model` fallback is unreachable without an
   * alias), the facade's context/plan/usage, and the permission-mode and
   * swarm state reads.
   */
  override async getStatus(input: SessionIdRpcInput): Promise<SessionStatus> {
    const agent = await this.agentFacade(input.sessionId);
    const [context, plan, usage, profile, permission, swarmMode, towerMode] =
      await Promise.all([
        agent.getContext(),
        agent.getPlan(),
        agent.getUsage(),
        agent.getProfileData(),
        agent.getPermissionMode(),
        agent.isSwarmActive(),
        agent.isTowerActive(),
      ]);
    const capability = profile.modelCapabilities;
    const maxContextTokens =
      capability.max_input_tokens ?? capability.max_context_tokens;
    const contextTokens = context.tokenCount;
    // Deliberately unclamped, same as the base class (>100% is the documented
    // overflow signal on this path).
    const contextUsage = maxContextTokens > 0 ? contextTokens / maxContextTokens : 0;
    const hasUsage =
      usage.byModel !== undefined ||
      usage.total !== undefined ||
      usage.currentTurn !== undefined;
    return {
      model: profile.modelAlias,
      thinkingEffort: profile.thinkingLevel,
      permission,
      planMode: plan !== null,
      swarmMode,
      towerMode,
      contextTokens,
      maxContextTokens,
      contextUsage,
      usage: hasUsage ? usage : undefined,
    };
  }

  /**
   * Facade (`agentLoopService.cancelFromUser`) plus the session-level init
   * run: v1's cancel cascades from the agent's turn to every foreground
   * subagent run of the session, and /init is the one session-level run v2
   * keeps off the agent turn lane — its abort controller lives in
   * `ISessionInitService` (a silent no-op when no init is running).
   */
  override async cancel(input: SessionIdRpcInput): Promise<void> {
    await this.callSession(input.sessionId, (session) => session.cancelInit());
    const agent = await this.agentFacade(input.sessionId);
    return agent.cancel();
  }

  /**
   * Facade (`agentFullCompactionService.begin`). Same semantics as v1's
   * `beginCompaction`: a manual compaction launches the summarizer
   * immediately in the background, is a silent no-op while one is already
   * running, and rejects with `compaction.unable` on an empty history or an
   * active turn.
   */
  override async compact(input: SessionIdRpcInput & CompactOptions): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    // `begin` reports whether the compaction started (`false` = one is
    // already running); the v1 surface is `void`, so the flag is dropped.
    await agent.compact({ instruction: input.instruction });
  }

  /**
   * Facade (`agentRPCService.cancelCompaction`, the v2 RPC surface's own
   * cancel). Aborts the in-flight compaction; a no-op when idle, like v1.
   */
  override async cancelCompaction(input: SessionIdRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.cancelCompaction();
  }

  /**
   * Facade (`agentRPCService.undoHistory`, the v2 RPC surface's own undo);
   * the returned count is dropped (v1 returns void). Failure semantics
   * differ by design: v2 prechecks and rejects atomically with
   * `session.undo_unavailable`, while v1 splices a partial suffix out of the
   * live history and then throws `request.invalid` — pinned in the parity
   * KNOWN_DIFFS.
   */
  override async getTodos(
    input: SessionIdRpcInput,
  ): Promise<readonly SessionTodoItem[]> {
    await this.requireLiveSessionId(input.sessionId);
    const session = this.klient.session(input.sessionId);
    if (!(await session.listLiveAgents()).includes(MAIN_AGENT_ID)) return [];
    return session.agent(MAIN_AGENT_ID).getTodos();
  }

  override async undoHistory(
    input: SessionIdRpcInput & { count: number },
  ): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await agent.undoHistory(input.count);
  }

  /**
   * Facade (`agentContextMemoryService.clear`). v1's `context.clear` has no
   * busy check and does not touch queued or running prompts; the
   * memory-service clear matches that exactly (the prompt service's own
   * `clear` would additionally abort prompts).
   */
  override async clearContext(input: SessionIdRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.clearContext();
  }

  /**
   * No v2 engine capability exists for import-context (nothing under
   * agent-core-v2 builds this message), so the SDK composes v1's exact
   * behavior over v2 primitives: the same busy rejection
   * (`turn.agent_busy`), the byte-identical import message and validations
   * (`src/v2/import-context.ts`), the same overflow gate, then the same wire
   * `context.append_message` Op v1 persists. Known gap: v1 also adopts the
   * post-import estimate as its reported token count, while v2's reported
   * count is provider-measured and has no public setter — post-import
   * `getContext().tokenCount` diverges (pinned in the parity KNOWN_DIFFS).
   */
  override async importContext(input: ImportContextRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    const [loop, compacting] = await Promise.all([
      agent.getLoopStatus(),
      agent.getCompacting(),
    ]);
    if (loop.state === 'running' || compacting !== undefined) {
      throw new KimiError(
        ErrorCodes.TURN_AGENT_BUSY,
        'Cannot import context while the agent is busy',
      );
    }
    const message = buildImportContextMessage(input.content, input.source);
    const [capability, size] = await Promise.all([
      agent.getModelCapabilities(),
      agent.getContextSize(),
    ]);
    assertImportFits(
      message,
      size.size,
      capability.max_input_tokens ?? capability.max_context_tokens,
    );
    await agent.appendContextMessage(message);
  }

  /**
   * Facade (`agentPromptService.submit`). The launch result (`{turn_id}`, or
   * `undefined` when the prompt queued behind a running turn) is dropped —
   * v1's RPC returns void. The pre-provider surface matches v1: the metadata
   * update (title/lastPrompt) runs through the same shared helpers before the
   * turn launches, and a model-less turn fails asynchronously exactly like
   * v1's. One enqueue-semantics gap vs v1, pinned in the migration tracker:
   * v1 drops a prompt submitted while a turn is active (error event only)
   * where v2 queues it FIFO.
   */
  override async prompt(input: SessionPromptRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await agent.prompt({
      input: input.input,
      promptId: input.promptId,
    });
  }

  /**
   * Facade (`agentSkillService.promptWithSkills`) — bundled skill submission:
   * the engine renders every skill activation into the prompt's own user
   * message, so the bundle launches as one turn and undoes as a single
   * anchor. v2-only: the base class rejects this method on the v1 engine.
   * The launch result is dropped like `prompt` (v1's RPC shape returns void).
   */
  override async promptWithSkills(
    input: SessionPromptWithSkillsRpcInput,
  ): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await agent.promptWithSkills({
      input: input.input,
      skills: input.skills,
    });
  }

  /**
   * Facade (`agentPromptService.submitSteer`). Matches v1 on both paths: mid-turn
   * steers join the running turn, and an idle-session steer degrades to
   * launching a fresh turn (the enqueue launches it directly) while
   * title/lastPrompt are updated like a prompt's.
   */
  override async steer(input: SessionPromptRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await agent.steer({ input: input.input });
  }

  /**
   * Facade (`agentShellCommandService.run`) — the same builtin-Bash execution
   * and `shell_command`-origin history records as v1, with an identical
   * `{stdout, stderr, isError?, backgrounded?}` result shape. The `commandId`
   * event stream (`shell.output` / `shell.started` / `shell.completed`) is
   * engine-side on both; translating it into SDK events is the event batch's
   * job, not this one's. Model-less gap, not pinned: v1's builtin tools only
   * exist on a profiled agent, so a model-less v1 session answers "Bash tool
   * is not available." where v2 runs the command.
   */
  override async runShellCommand(input: {
    sessionId: string;
    command: string;
    commandId?: string;
  }): Promise<{
    stdout: string;
    stderr: string;
    isError?: boolean;
    backgrounded?: boolean;
  }> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.runShellCommand({
      command: input.command,
      commandId: input.commandId,
    });
  }

  /** Facade (`agentShellCommandService.cancel`) — an unknown id is a silent no-op on both engines. */
  override async cancelShellCommand(input: {
    sessionId: string;
    commandId: string;
  }): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.cancelShellCommand({ commandId: input.commandId });
  }

  /**
   * Facade (`agentSkillService.activate` via `activateSkillAwaited`) —
   * deliberately NOT the RPC `activateSkill`, whose fire-and-forget turns
   * v1's synchronous rejections (`skill.not_found` / `skill.type_unsupported`)
   * into unhandled rejections. The awaited call keeps v1's semantics:
   * validate first, then render the skill prompt and launch a turn with it.
   * v1's session layer then updates title/lastPrompt for the MAIN agent only;
   * replicated here over the facade ({@link updatePromptMetadata}). Busy-turn
   * gap vs v1, pinned in the migration tracker: v1 drops the activation into
   * an error event while a turn runs; v2's activate awaits the queued
   * prompt's launch.
   */
  override async activateSkill(input: ActivateSkillRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await agent.activateSkillAwaited(input.name, input.args);
    if (this.interactiveAgentId === MAIN_AGENT_ID) {
    }
  }

  /**
   * Facade (`agentRPCService.activatePluginCommand`) — the v2 RPC surface's
   * own implementation: the same `request.invalid` rejection text for an
   * unknown command, the same argument expansion, the activation event, the
   * prompt enqueue, and the metadata update. Two gaps vs v1, pinned in the
   * migration tracker: v1 resolves the command against the session's
   * creation-time snapshot (v2 uses the app-global live view), and v1 drops
   * the activation while a turn runs where v2 queues it. v1 also updates
   * title/lastPrompt for the main agent only, where the v2 RPC does it
   * unconditionally — only observable through a non-main
   * `interactiveAgentId`.
   */
  override async activatePluginCommand(
    input: ActivatePluginCommandRpcInput,
  ): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.activatePluginCommand({
      pluginId: input.pluginId,
      commandName: input.commandName,
      args: input.args,
    });
  }

  /**
   * Facade (`sessionInitService.generateAgentsMd`, the engine's port of v1's
   * `Session.generateAgentsMd`) — a session-level operation pinned to the
   * main agent on both engines, so `interactiveAgentId` does not apply; the
   * main agent is materialized first (v1 creates it eagerly at
   * createSession). The success path is a real subagent LLM round (`/init`
   * brief), so parity covers only the model-less rejection: both engines
   * fail with `session.init_failed`, with different messages (v1 wraps the
   * provider-resolution failure, v2 preflights the missing binding) — pinned
   * in the parity tests.
   */
  override async generateAgentsMd(input: SessionIdRpcInput): Promise<void> {
    await this.requireLiveSessionId(input.sessionId);
    await this.materializeMainAgent(input.sessionId);
    await this.callSession(input.sessionId, (session) => session.generateAgentsMd());
  }

  /**
   * No v2 service implements the session-warnings aggregate, so the SDK rebuilds v1's
   * `Session.getSessionWarnings` over v2 primitives: the profile's cached
   * `agentsMdWarning` (computed on every bind, v1's bootstrap-time cache),
   * recomputed through the engine's own `prepareSystemPromptContext` when the
   * cache is empty — v1 recomputes on demand whenever no warning is cached,
   * so an AGENTS.md that outgrows the budget mid-session surfaces on both
   * engines. The single warning shape (`agents-md-oversized`, severity
   * `warning`) mirrors v1's assembly.
   */
  /**
   * The cached half rides the facade (`session.getSessionWarnings` — the
   * profile's `agentsMdWarning` + the secondary-model warning, the same fold
   * kap-server's warnings route performs). The on-demand recompute has NO
   * wire capability (it reads AGENTS.md through the engine's host fs), so
   * when the cache reports no AGENTS.md warning the SDK recomputes through
   * the engine's own `prepareSystemPromptContext` via {@link engineAccessor}
   * — v1 recomputes on demand whenever no warning is cached, so an AGENTS.md
   * that outgrows the budget mid-session surfaces on both engines. The
   * secondary-model half (v1's `computeSecondaryModelWarnings`): v1 computes
   * it from the session's config snapshot while v2 caches the live-config
   * check at main-agent creation, so the two agree on recipes applied
   * through `applyPersistedSecondaryModel` (which refreshes the v2 cache)
   * and on recipes present at session creation; a recipe persisted but never
   * applied surfaces only on v2 (live config vs v1's snapshot).
   */
  override async getSessionWarnings(input: SessionIdRpcInput) {
    await this.agentFacade(input.sessionId);
    return this.callSession(input.sessionId, (session) => session.getSessionWarnings());
  }

  /**
   * Through the session scope (`ISessionBtwService`) — no klient facade
   * exists. The v2 service is the port of v1's btw fork: same inherited
   * profile/context, same byte-identical side-question reminder, same
   * tool-call deny, and the same return (the forked child's agent id). The
   * main agent is materialized first — both engines fork it as the source,
   * and v2's `fork('main')` throws on a missing source. Gaps, pinned in the
   * migration tracker: v2 always forks MAIN where v1 forks the agent
   * `interactiveAgentId` addresses (SDK hosts only ever btw the main agent),
   * and the v2 child is a regular persisted agent where v1's is memory-only
   * (`InMemoryAgentRecordPersistence`, no metadata).
   */
  override async startBtw(input: SessionIdRpcInput): Promise<string> {
    await this.requireLiveSessionId(input.sessionId);
    await this.materializeMainAgent(input.sessionId);
    return this.callSession(input.sessionId, (session) => session.startBtw());
  }

  /**
   * Facade (`agentSwarmService.enter` / `.exit`). The v2 service is the port
   * of v1's `SwarmMode`: enter is idempotent and injects the byte-identical
   * enter reminder for non-`tool` triggers, exit pops that reminder when it
   * is the last message (appending the exit reminder otherwise), and `task` /
   * `tool` triggers auto-exit on turn end. The base class's private
   * enter/exit pair is replaced wholesale; `swarm()` below recomposes it
   * over this override.
   */
  override async setSwarmMode(input: SetSessionSwarmModeRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await agent.setSwarmMode(input.enabled, input.enabled ? input.trigger : 'manual');
    await agent.reconcileReminder('swarm_mode');
  }

  /** v1's `swarm()` composition: enter with the one-shot `task` trigger, then prompt. */
  override async swarm(input: SessionPromptRpcInput): Promise<void> {
    await this.setSwarmMode({
      sessionId: input.sessionId,
      enabled: true,
      trigger: 'task',
    });
    return this.prompt(input);
  }

  /** Through the agent scope (`IAgentTowerService.enter` / `.exit`) — no klient facade exists. */
  override async setTowerMode(input: SetSessionTowerModeRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    if (input.enabled) {
      const result = await agent.enterTower(input.base);
      if (!result.entered) {
        throw new V2Error2(
          V2ErrorCodes.SESSION_TOWER_MODE_INVALID,
          towerEnterFailureMessage(result),
        );
      }
    } else {
      await agent.exitTower();
    }
    await agent.reconcileReminder('tower_mode');
  }

  // -----------------------------------------------------------------------
  // Goal / cron / background tasks / print policy
  //
  // The goal service is the v2 port of v1's `GoalMode` (same state machine,
  // same validations, same error codes), so the goal overrides are thin
  // forwards through the agent scope. Cron and the task manager moved from
  // per-agent (v1) to session/agent-scope services with field-identical
  // wire shapes; the two print-policy methods have no v2 service at all
  // (the native v2 print runner re-implements the same policy inline), so
  // they are rebuilt here over the engine's config helpers and the session's
  // per-agent task services.
  // -----------------------------------------------------------------------

  /**
   * Facade (`agentGoalService.createGoal`). Gap: v2 rejects every goal
   * command on a non-main agent (`goal.unsupported_agent`) where v1 keeps a
   * `GoalMode` on every agent; only reachable through a non-main
   * `interactiveAgentId` (tracked in the migration tracker).
   */
  override async createGoal(
    input: SessionIdRpcInput & CreateGoalInput,
  ): Promise<GoalSnapshot> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.createGoal({ objective: input.objective, replace: input.replace });
  }

  override async getGoal(input: SessionIdRpcInput): Promise<GoalToolResult> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getGoal();
  }

  override async pauseGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.pauseGoal();
  }

  override async resumeGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.resumeGoal();
  }

  override async cancelGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.cancelGoal();
  }

  /**
   * Facade (`sessionCronService.list` + `getNextFireForTask`, composed by
   * `session.getCronTasks`). v1's cron manager is per-agent: the main
   * agent's manager is what the v2 session-level service ports (it borrows
   * the main agent to steer fires), and a v1 subagent reports `[]` (`cron`
   * is null) — mirrored here for a non-main `interactiveAgentId`. The v1
   * snapshot shape is restored field-by-field: `recurring` defaults to true,
   * and the post-jitter `nextFireAt` comes from the same scheduler read
   * v1's `listTaskSnapshots` forwards to.
   */
  override async getCronTasks(input: SessionIdRpcInput): Promise<GetCronTasksResult> {
    await this.agentFacade(input.sessionId);
    if (this.interactiveAgentId !== MAIN_AGENT_ID) return { tasks: [] };
    const { tasks } = await this.callSession(input.sessionId, (session) =>
      session.getCronTasks(),
    );
    return {
      tasks: tasks.map((task) => ({
        id: task.id,
        cron: task.cron,
        recurring: task.recurring !== false,
        createdAt: task.createdAt,
        lastFiredAt: task.lastFiredAt,
        nextFireAt: task.nextFireAt,
      })),
    };
  }

  /**
   * Facade (`agentTaskService.list`). The v2 `AgentTaskInfo` union is the
   * same wire shape as v1's `BackgroundTaskInfo` — the process / agent /
   * question kinds are field-identical ports — so the cast only bridges the
   * two packages' type declarations. One content gap, pinned in the parity
   * KNOWN_DIFFS: after a detach, v2 rewrites the reported `timeoutMs` to the
   * detach deadline where v1 keeps the foreground one.
   */
  override async listBackgroundTasks(
    input: SessionIdRpcInput & { activeOnly?: boolean; limit?: number },
  ): Promise<readonly BackgroundTaskInfo[]> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getTasks({
      activeOnly: input.activeOnly,
      limit: input.limit,
    }) as Promise<readonly BackgroundTaskInfo[]>;
  }

  /**
   * Facade (`agentTaskService.readOutput`) — same unknown-id-returns-`''`
   * behavior and the same trailing-characters `tail` semantics as v1.
   */
  override async getBackgroundTaskOutput(
    input: SessionIdRpcInput & { taskId: string; tail?: number },
  ): Promise<string> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getTaskOutput({ taskId: input.taskId, tail: input.tail });
  }

  /**
   * Facade (`agentTaskService.stop` via `stopTaskWithReason`) — deliberately
   * NOT `stopTask`, whose no-reason path routes to `stopByUser` and stamps a
   * user-cancellation `stopReason` where v1's `background.stop(taskId,
   * reason)` records none. The direct call matches v1 in both shapes (reason
   * trimmed, blank → undefined). Timing gap: v1 fire-and-forgets the stop so
   * its RPC returns before the kill settles; the v2 service awaits the
   * termination — a strictly stronger guarantee.
   */
  override async stopBackgroundTask(
    input: SessionIdRpcInput & { taskId: string; reason?: string },
  ): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.stopTaskWithReason({ taskId: input.taskId, reason: input.reason });
  }

  /**
   * Facade (`agentTaskService.detach`). Same semantics as v1's
   * `background.detach`: releases the foreground tool-call waiter, returns
   * the live info (or the ghost / live info for an already-terminal task,
   * `undefined` for an unknown id).
   */
  override async detachBackgroundTask(
    input: SessionIdRpcInput & { taskId: string },
  ): Promise<BackgroundTaskInfo | undefined> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.detachBackgroundTask(input.taskId) as Promise<
      BackgroundTaskInfo | undefined
    >;
  }

  /**
   * v1's `Session.waitForBackgroundTasksOnPrint`, rebuilt over v2 primitives
   * — no v2 service owns the print policy (the native v2 print runner
   * re-implements the same drain inline in run-v2-print). Same gate (drain
   * mode only), same ceiling, same suppress + wait + re-enumerate loop over
   * every live agent's task service. Config timing note: v1 reads the
   * `background` section captured at session creation; v2 resolves the live
   * config (the `[task]` section layered over `[background]`) — identical
   * unless the config changes mid-session.
   */
  override async waitForBackgroundTasksOnPrint(
    input: SessionIdRpcInput,
  ): Promise<void> {
    await this.requireLiveSessionId(input.sessionId);
    const config = await this.printTaskConfig();
    if (resolvePrintBackgroundMode(config) !== 'drain') return;
    const ceilingS =
      resolveAgentTaskConfig(config)?.printWaitCeilingS ?? PRINT_WAIT_CEILING_S_DEFAULT;
    await this.drainBackgroundTasksOnPrint(input.sessionId, ceilingS);
  }

  /**
   * v1's `Session.handlePrintMainTurnCompleted`, rebuilt over the same v2
   * primitives: `'exit'` finishes immediately, `'drain'` drains then
   * finishes, and `'steer'` keeps the run alive while background tasks are
   * pending, bounded by the wall-clock ceiling (`print_wait_ceiling_s`) and
   * the turn cap (`print_max_turns`). The steer deadline/turn counters are
   * per-session SDK state ({@link printSteerStates}), mirroring v1's
   * Session-object fields.
   */
  override async handlePrintMainTurnCompleted(
    input: SessionIdRpcInput,
  ): Promise<'finish' | 'continue'> {
    await this.requireLiveSessionId(input.sessionId);
    const config = await this.printTaskConfig();
    const taskConfig = resolveAgentTaskConfig(config);
    const ceilingS = taskConfig?.printWaitCeilingS ?? PRINT_WAIT_CEILING_S_DEFAULT;
    const mode = resolvePrintBackgroundMode(config);
    if (mode === 'exit') return 'finish';
    if (mode === 'drain') {
      await this.drainBackgroundTasksOnPrint(input.sessionId, ceilingS);
      return 'finish';
    }
    // 'steer'
    const maxTurns = taskConfig?.printMaxTurns ?? PRINT_MAX_TURNS_DEFAULT;
    const state = this.printSteerStates.get(input.sessionId) ?? {
      deadline: undefined,
      turns: 0,
    };
    this.printSteerStates.set(input.sessionId, state);
    const now = Date.now();
    state.deadline ??= now + ceilingS * 1000;
    state.turns += 1;
    if (now >= state.deadline) return 'finish';
    if (state.turns > maxTurns) return 'finish';
    if ((await this.countActiveBackgroundTasks(input.sessionId)) > 0) return 'continue';
    return 'finish';
  }

  /**
   * The engine's pure print-policy helpers take the whole `IConfigService`
   * but only read the `task` / `background` sections; feed them a duck-typed
   * shim over the facade's per-domain reads so the policy math stays the
   * engine's own. Config timing note: v1 reads the `background` section
   * captured at session creation; v2 resolves the live config (the `[task]`
   * section layered over `[background]`) — identical unless the config
   * changes mid-session.
   */
  private async printTaskConfig(): Promise<IConfigService> {
    await this.configReady;
    const [task, background] = await Promise.all([
      this.klient.global.config.get(TASK_SECTION),
      this.klient.global.config.get(LEGACY_BACKGROUND_SECTION),
    ]);
    const sections: Record<string, unknown> = {
      [TASK_SECTION]: task,
      [LEGACY_BACKGROUND_SECTION]: background,
    };
    return {
      get: (section: string) => sections[section],
    } as unknown as IConfigService;
  }

  /**
   * The shared drain pass of the two print-policy overrides, ported from
   * v1's `waitForBackgroundTasksOnPrint` (the native v2 print runner carries
   * the same loop): re-enumerate active tasks across every live agent until
   * none remain or the ceiling expires — a subagent may fan out new tasks
   * mid-drain — with terminal notifications suppressed up front so a
   * completing task cannot steer a finished main turn. An agent that exits
   * mid-drain is skipped (its tasks are gone with it).
   */
  private async drainBackgroundTasksOnPrint(
    sessionId: string,
    ceilingS: number,
  ): Promise<void> {
    const deadline = Date.now() + ceilingS * 1000;
    const seen = new Set<string>();
    const allWaiters: Promise<unknown>[] = [];
    while (Date.now() < deadline) {
      const batch: Promise<unknown>[] = [];
      const suppressions: Promise<unknown>[] = [];
      let activeCount = 0;
      const agentIds = await this.callSession(sessionId, (session) =>
        session.listLiveAgents(),
      );
      for (const agentId of agentIds) {
        const agent = this.klient.session(sessionId).agent(agentId);
        let tasks: readonly BackgroundTaskInfo[];
        try {
          tasks = (await agent.getTasks({
            activeOnly: true,
          })) as readonly BackgroundTaskInfo[];
        } catch (error) {
          if (isAgentGone(error)) continue;
          throw error;
        }
        for (const task of tasks) {
          activeCount++;
          if (seen.has(task.taskId)) continue;
          seen.add(task.taskId);
          suppressions.push(
            agent.suppressTaskTerminalNotification(task.taskId).catch(swallowAgentGone),
          );
          // The engine's `wait` arms a raw `setTimeout(timeoutMs)`, which
          // overflows above the ~24.8-day timer ceiling into an immediate
          // resolve (v1's `timeoutOutcome` clamps to the same bound) — the
          // default print ceiling is 10 years, so clamp here. The outer loop
          // re-enumerates after an early return, so semantics are unchanged.
          const remaining = Math.min(
            Math.max(1, deadline - Date.now()),
            MAX_TIMER_DELAY_MS,
          );
          const waiter = agent
            .waitForTask(task.taskId, remaining)
            .catch(swallowAgentGone);
          batch.push(waiter);
          allWaiters.push(waiter);
        }
      }
      if (suppressions.length > 0) await Promise.all(suppressions);
      if (activeCount === 0 || batch.length === 0) break;
      await Promise.all(batch);
    }
    if (allWaiters.length > 0) await Promise.all(allWaiters);
  }

  /** v1's `countActiveBackgroundTasks`: active tasks across every live agent. */
  private async countActiveBackgroundTasks(sessionId: string): Promise<number> {
    let count = 0;
    const agentIds = await this.callSession(sessionId, (session) =>
      session.listLiveAgents(),
    );
    for (const agentId of agentIds) {
      try {
        count += (
          await this.klient
            .session(sessionId)
            .agent(agentId)
            .getTasks({ activeOnly: true })
        ).length;
      } catch (error) {
        if (!isAgentGone(error)) throw error;
      }
    }
    return count;
  }

  // -----------------------------------------------------------------------
  // MCP: the user-global surface is rebuilt over the SDK-side store port in
  // `src/v2/global-mcp.ts` plus the v2 engine's own OAuth service and
  // connection manager (agent-core-v2 has no app-scope MCP config service —
  // it only reads `mcp.json`); the session-level reads go through the klient
  // session facade (the workspace handler's one shared connection manager,
  // reached via the main agent's scope).
  // -----------------------------------------------------------------------

  /**
   * The engine's management plane throws `Error2`; the SDK's public error
   * contract is `KimiError` (what `isKimiError` branches on, and what the v1
   * client throws for the same failures). Restate so both engines surface
   * the identical class — see `restateEngineError`.
   */
  private async mcpManagement<T>(
    call: (management: IMcpManagementService) => Promise<T>,
  ): Promise<T> {
    try {
      return await call(
        this.app === undefined
          ? remoteMcpManagement(this.klient)
          : this.engineAccessor.get(IMcpManagementService),
      );
    } catch (error) {
      throw restateEngineError(error);
    }
  }

  override async listGlobalMcpServers(
    options: { readonly cwd?: string } = {},
  ): Promise<readonly McpManagedServerInfo[]> {
    const servers = await this.mcpManagement((management) =>
      management.listServers({ cwd: options.cwd }),
    );
    return servers.map(toManagedServerInfo);
  }

  override async getGlobalMcpServer(
    name: string,
    options: { readonly cwd?: string } = {},
  ): Promise<McpManagedServerInfo> {
    const server = await this.mcpManagement((management) =>
      management.getServer(name, { cwd: options.cwd }),
    );
    return toManagedServerInfo(server);
  }

  override async listGlobalMcpServerAuthStatuses(
    options: { readonly cwd?: string; readonly verify?: boolean } = {},
  ): Promise<readonly GlobalMcpServerAuthStatus[]> {
    const statuses = await this.mcpManagement((management) =>
      management.listAuthStatuses({ cwd: options.cwd, verify: options.verify }),
    );
    // The legacy surface never reports `unavailable` (no ambiguity check
    // here), so the engine's wider state union narrows to the v1 wire one.
    return statuses as readonly GlobalMcpServerAuthStatus[];
  }

  override async inspectAppMcpServers(
    targets?: readonly McpServerLocator[],
    options: { readonly cwd?: string } = {},
  ): Promise<readonly AppMcpServerInspection[]> {
    const inspections = await this.mcpManagement((management) =>
      management.inspectServers(targets, { cwd: options.cwd }),
    );
    // Field-identical with the v1 wire shape (the engines' locator /
    // config-view / auth-state declarations match structurally).
    return inspections as readonly AppMcpServerInspection[];
  }

  override async addGlobalMcpServer(
    server: McpServerConfig,
    options: { readonly cwd?: string } = {},
  ): Promise<readonly McpManagedServerInfo[]> {
    const servers = await this.mcpManagement((management) =>
      management.addServer(server, { cwd: options.cwd }),
    );
    return servers.map(toManagedServerInfo);
  }

  override async updateGlobalMcpServer(
    server: McpServerConfig,
    options: { readonly cwd?: string } = {},
  ): Promise<readonly McpManagedServerInfo[]> {
    const servers = await this.mcpManagement((management) =>
      management.updateServer(server, { cwd: options.cwd }),
    );
    return servers.map(toManagedServerInfo);
  }

  override async removeGlobalMcpServer(
    name: string,
    options: { readonly cwd?: string } = {},
  ): Promise<readonly McpManagedServerInfo[]> {
    const servers = await this.mcpManagement((management) =>
      management.removeServer(name, { cwd: options.cwd }),
    );
    return servers.map(toManagedServerInfo);
  }

  /**
   * The legacy name-only entry point resolves its locator first: exactly one
   * enabled entry may own the runtime name, so a global/plugin collision
   * rejects instead of guessing which credential the flow acts on.
   */
  override async beginGlobalMcpServerAuth(
    name: string,
    options: { readonly cwd?: string } = {},
  ): Promise<BeginGlobalMcpServerAuthResult> {
    return this.mcpManagement(async (management) => {
      const query = { cwd: options.cwd };
      return management.beginServerAuth(
        await management.resolveServerByName(name, query),
        query,
      );
    });
  }

  override async beginMcpServerAuth(
    locator: McpServerLocator,
    options: { readonly cwd?: string } = {},
  ): Promise<BeginGlobalMcpServerAuthResult> {
    return this.mcpManagement((management) =>
      management.beginServerAuth(locator, { cwd: options.cwd }),
    );
  }

  override async completeGlobalMcpServerAuth(
    input: {
      readonly flowId: string;
      readonly timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    return this.completeMcpServerAuth(input, signal);
  }

  override async completeMcpServerAuth(
    input: {
      readonly flowId: string;
      readonly timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    return this.mcpManagement((management) =>
      management.completeServerAuth(input, { signal }),
    );
  }

  override async cancelGlobalMcpServerAuth(flowId: string): Promise<void> {
    return this.cancelMcpServerAuth(flowId);
  }

  override async cancelMcpServerAuth(flowId: string): Promise<void> {
    return this.mcpManagement((management) => management.cancelServerAuth({ flowId }));
  }

  override async resetGlobalMcpServerAuth(
    name: string,
    options: { readonly cwd?: string } = {},
  ): Promise<void> {
    return this.mcpManagement(async (management) => {
      const query = { cwd: options.cwd };
      return management.resetServerAuth(
        await management.resolveServerByName(name, query),
        query,
      );
    });
  }

  override async resetMcpServerAuth(
    locator: McpServerLocator,
    options: { readonly cwd?: string } = {},
  ): Promise<void> {
    return this.mcpManagement((management) =>
      management.resetServerAuth(locator, { cwd: options.cwd }),
    );
  }

  override async testGlobalMcpServer(
    name: string,
    options: { readonly cwd?: string } = {},
  ): Promise<McpTestResult> {
    return this.mcpManagement((management) =>
      management.testServer({ name, cwd: options.cwd }),
    );
  }

  /**
   * The inline-config channel of v1's `testGlobalMcpServer`: the same
   * schema-validated, unsaved probe — nothing has to be persisted first.
   */
  override async testGlobalMcpServerConfig(
    server: McpServerConfig,
    options: { readonly cwd?: string } = {},
  ): Promise<McpTestResult> {
    return this.mcpManagement((management) =>
      management.testServer({ server, cwd: options.cwd }),
    );
  }

  /**
   * Facade (`agentMcpService.list` — the workspace handler's shared
   * connection manager merged with the session's own servers, reached
   * through the main agent's scope; scope resolution materializes the main
   * agent). This is a live snapshot: v2's create/resume no longer waits for
   * MCP startup, so entries may still be pending. The v2 `McpServerEntry` is
   * field-identical with v1's
   * `McpServerInfo` (the cast bridges the two packages' type declarations).
   */
  override async listMcpServers(
    input: SessionIdRpcInput,
  ): Promise<readonly McpServerInfo[]> {
    return this.callSession(input.sessionId, async (session) => {
      const entries = await session.listMcpServers();
      return entries as readonly McpServerInfo[];
    });
  }

  /**
   * Workspace-level MCP view (the handler's one shared connection set), so
   * `/mcp` is inspectable on a v2 session-less startup before any session
   * exists. Awaits `ready` so a fresh handler's initial connect settles
   * before the list is read.
   * Same `McpServerEntry`-as-`McpServerInfo` cast as listMcpServers.
   */
  override async listWorkspaceMcpServers(
    workDir: string,
  ): Promise<readonly McpServerInfo[]> {
    return this.klient.global.workspaces.listMcpServers(
      normalizeRequiredWorkDir('listWorkspaceMcpServers', workDir),
    );
  }

  override async getMcpStartupMetrics(
    input: SessionIdRpcInput,
  ): Promise<McpStartupMetrics> {
    return this.callSession(input.sessionId, (session) =>
      session.getMcpStartupMetrics(),
    );
  }

  /**
   * Facade (`agentMcpService.reconnect`) — the same direct `reconnect` as
   * v1's session RPC: the v2 manager raises the same
   * `mcp.server_not_found` / `mcp.server_disabled` errors, and the tool
   * re-registration rides on the status listeners in both engines.
   */
  override async reconnectMcpServer(input: ReconnectMcpServerRpcInput): Promise<void> {
    return this.callSession(input.sessionId, (session) =>
      input.config === undefined
        ? session.reconnectMcpServer(input.name)
        : session.replaceMcpServer(input.name, {
            name: input.name,
            ...parseReconnectMcpServerConfig(input.name, input.config),
          }),
    );
  }

  /**
   * `uploadFile` → `klient.global.files.save` (the app-scope `IFileService`).
   * The SDK's single `name` doubles as the engine's `filename`; the engine's
   * `SaveOptions.name` (display name) defaults to it.
   */
  override async uploadFile(
    data: Uint8Array,
    options: UploadFileOptions,
  ): Promise<FileMeta> {
    return this.klient.global.files.save({
      data,
      filename: options.name,
      mimeType: options.mimeType,
      expiresInSec: options.expiresInSec,
    });
  }

  override async deleteFile(fileId: string): Promise<void> {
    return this.klient.global.files.delete(fileId);
  }

  /**
   * Through the workspace handler's `IWorkspaceFsService` — the same engine
   * suggest the kap-server `fs:suggest` routes serve (fuzzy scoring,
   * directories included, gitignore respected), so in-process hosts match
   * the web client's @ mention results.
   */
  override async suggestFiles(
    workDir: string,
    input: SuggestFilesInput,
  ): Promise<SuggestFilesResult | undefined> {
    const parsed = fsSuggestRequestSchema.safeParse({
      query: input.query,
      limit: input.limit ?? 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where =
        issue !== undefined && issue.path.length > 0
          ? `${String(issue.path[0])}: `
          : '';
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `suggestFiles ${where}${issue?.message ?? 'invalid input'}`,
      );
    }
    const result = await this.klient.global.workspaces.suggestFiles(
      normalizeRequiredWorkDir('suggestFiles', workDir),
      parsed.data,
    );
    return {
      items: result.items.map((item) => ({
        path: item.path,
        name: item.name,
        kind: item.kind,
        matchPositions: item.match_positions,
      })),
      truncated: result.truncated,
    };
  }

  /**
   * Runs `work` after every previously queued operation on the same session
   * settles; different sessions still run in parallel. The map entry drops
   * itself once the queue drains.
   */
  private runSessionAccess<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.sessionAccessQueues.get(sessionId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.sessionAccessQueues.set(sessionId, tail);
    void tail.then(() => {
      if (this.sessionAccessQueues.get(sessionId) === tail) {
        this.sessionAccessQueues.delete(sessionId);
      }
    });
    return run;
  }

  /**
   * Multi-key variant of {@link runSessionAccess}: acquires the queues in
   * sorted order so concurrent multi-key operations (fork A→B vs fork B→A)
   * cannot deadlock.
   */
  private runSessionAccessAll<T>(
    sessionIds: readonly string[],
    work: () => Promise<T>,
  ): Promise<T> {
    const keys = [...new Set(sessionIds)].toSorted();
    let chained: () => Promise<T> = work;
    for (const key of [...keys].toReversed()) {
      const inner = chained;
      chained = () => this.runSessionAccess(key, inner);
    }
    return chained();
  }

  /**
   * Runs `action` against the session without changing its live footprint: a
   * session that is already live (publicly resumed or created through this
   * client) is used in place and left open, while a cold session is resumed
   * for the duration of the action and closed again. Only safe inside
   * {@link runSessionAccess} — the queue is what makes the resume/close pair
   * atomic against the public lifecycle operations.
   */
  private async withTemporarySession<T>(
    sessionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const session = this.klient.session(sessionId);
    if (await session.isLive()) return action();
    if (!(await session.resume())) throw SDKRpcClientV2.sessionNotFound(sessionId);
    try {
      return await action();
    } finally {
      await session.close();
    }
  }

  /**
   * v2-only (`ISessionTitleService`, session scope). Like `renameSession`, a
   * closed session is resumed, titled, and closed again so generation does
   * not leak a live session. `undefined` means generation was unavailable
   * (no managed OAuth login, no prompt yet, or a custom title is set) — the
   * current title is kept.
   */
  override async generateSessionTitle(
    input: GenerateSessionTitleInput,
  ): Promise<string | undefined> {
    return this.runSessionAccess(input.id, () =>
      this.withTemporarySession(input.id, () =>
        this.klient
          .session(input.id)
          .generateTitle({ force: input.force === true, source: input.source }),
      ),
    );
  }

  private async refreshPluginSessionStarts(excludedSessionId?: string): Promise<void> {
    await this.klient.global.plugins.refreshSessionStarts(excludedSessionId);
  }

  /**
   * v1's `addSessionMcpServer` over the session scope's connection manager:
   * validate, optionally persist to the user-level file, then upsert through
   * `connect`. Two accepted gaps against v1: the v2 entry carries no
   * `source`/`config` tags (the manager does not track origins), and the one
   * shared manager per workspace handler makes an unpersisted add visible to
   * sibling sessions of the same workspace. The same merged-view limitation
   * as {@link reconnectMcpServer} applies.
   */
  override async addSessionMcpServer(input: {
    readonly sessionId: string;
    readonly server: McpServerConfig;
    readonly persist?: boolean;
  }): Promise<McpServerInfo> {
    const parsed = parseInlineMcpServer(input.server);
    const server = { ...parsed, name: normalizeServerName(parsed.name) };
    return this.callSession(input.sessionId, (session) =>
      session.addMcpServer(server, input.persist),
    );
  }
}

export function createKimiHarness(options: KimiHarnessOptions): KimiHarness {
  const rpc = new SDKRpcClientV2(options);
  rpc.suppressEngineSessionStarted();
  return new KimiHarness(rpc, {
    identity: rpc.identity,
    uiMode: options.uiMode,
    homeDir: rpc.homeDir,
    configPath: rpc.configPath,
    auth: rpc.auth,
    telemetry: rpc.telemetry,
    ensureConfigFile: () => rpc.ensureConfigFile(),
    onClose: () => rpc.close(),
    imageLimits: undefined,
    sessionStartedProperties: options.sessionStartedProperties,
    sessionStartedDynamicProperties: () => ({
      experimental_flags: rpc.enabledExperimentalFlags(),
    }),
  });
}

export interface KimiHarnessV2RemoteConnection {
  /** Unix socket of a kap-server-hosted engine (`<home>/server/klient-<port>.sock`). */
  readonly socketPath: string;
  /** Bearer token matching the server's persistent token (`<home>/server.token`). */
  readonly token?: string;
}

/**
 * Remote-mode harness: the TUI runs against a kap-server-hosted engine over a
 * unix socket instead of an in-process one. Session methods, the interaction
 * bridge, and the event stream behave identically (memory/ipc parity by
 * construction); in-process-only capabilities degrade as documented on
 * `SDKRpcClientV2Options.remoteKlient`.
 */
export function createKimiHarnessV2Remote(
  options: KimiHarnessOptions,
  connection: KimiHarnessV2RemoteConnection,
): KimiHarness {
  const klient = createIpcKlient({
    socketPath: connection.socketPath,
    token: connection.token,
  });
  const rpc = new SDKRpcClientV2({ ...options, remoteKlient: klient });
  return new KimiHarness(rpc, {
    identity: rpc.identity,
    uiMode: options.uiMode,
    homeDir: rpc.homeDir,
    configPath: rpc.configPath,
    auth: rpc.auth,
    telemetry: rpc.telemetry,
    ensureConfigFile: () => rpc.ensureConfigFile(),
    onClose: () => rpc.close(),
    imageLimits: undefined,
    sessionStartedProperties: options.sessionStartedProperties,
  });
}

/** v1's `requiredWorkDir`: reject blank and normalize to the canonical spelling. */
function normalizeRequiredWorkDir(operation: string, workDir: string): string {
  if (typeof workDir !== 'string' || workDir.trim() === '') {
    throw new KimiError(
      ErrorCodes.REQUEST_WORK_DIR_REQUIRED,
      `${operation} requires workDir`,
    );
  }
  return normalizeWorkDir(workDir);
}

/**
 * Restate an engine `Error2` in the SDK's public error shape (`KimiError`,
 * what `isKimiError` branches on) so the delegated management plane throws
 * the same class the v1 client throws for the same failure. Non-Error2
 * failures (DI resolution bugs, aborts) pass through untouched.
 *
 * An engine code this build's registry does not declare (a newer engine than
 * the pinned SDK) restates as `internal` — stamping the unknown code would
 * mint a `KimiError` that `toKimiErrorPayload` cannot serialize (its
 * `KIMI_ERROR_INFO` lookup throws on undeclared codes).
 */
function restateEngineError(error: unknown): unknown {
  if (!isError2(error)) return error;
  const code: KimiErrorCode = isKimiErrorCode(error.code)
    ? error.code
    : ErrorCodes.INTERNAL;
  return new KimiError(code, error.message, {
    details: error.details as Record<string, unknown> | undefined,
    cause: error.cause,
  });
}

/**
 * v1's `toManagedServerInfo` over the engine's managed view: flatten the
 * config to the top level (mutable entries carry the full values, read-only
 * entries the redacted `envKeys` / `headerKeys` lists) and tag it with the
 * source metadata.
 */
function toManagedServerInfo(server: McpManagedServer): McpManagedServerInfo {
  return {
    name: server.name,
    ...server.config,
    source: server.source,
    origin: server.origin,
    mutable: server.mutable,
    plugin: server.plugin,
  } as McpManagedServerInfo;
}

function describeWorkspaceMcpServer(
  name: string,
  config: WorkspaceMcpServerConfig,
): WorkspaceTrustInfo['gatedMcpServers'][number] {
  if (config.transport === 'stdio') {
    return {
      name,
      transport: config.transport,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
    };
  }
  return { name, transport: config.transport, url: config.url };
}
