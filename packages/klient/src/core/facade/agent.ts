/**
 * The agent facade — one `session.agent(id)` handle over the agent-scope
 * services the wire exposes. Turn-driving calls (prompt / steer / cancel) go
 * through the `agentRPCService` channel; shell commands, model, usage, plan,
 * and task calls go straight to their domain services. Prompt streaming is
 * NOT on this interface: it flows through the agent's `events` hub
 * (`turn.*`, `assistant.delta`, `tool.call.*`, `prompt.completed`, …).
 */

import type { IAgentRPCService } from '@moonshot-ai/agent-core-v2/agent/rpc/rpc';
import type { IAgentGoalService } from '@moonshot-ai/agent-core-v2/agent/goal/goal';
import type { IAgentPlanService } from '@moonshot-ai/agent-core-v2/agent/plan/plan';
import type { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import type { IAgentShellCommandService } from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommand';
import type { IAgentSwarmService, SwarmModeTrigger } from '@moonshot-ai/agent-core-v2/agent/swarm/swarm';
import type { IAgentTaskService } from '@moonshot-ai/agent-core-v2/agent/task/task';
import type { IAgentUsageService } from '@moonshot-ai/agent-core-v2/agent/usage/usage';
import type { SkillSummary } from '@moonshot-ai/agent-core-v2/app/skillCatalog/types';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/kosong/contract/message';
import type { ThinkingEffort } from '@moonshot-ai/agent-core-v2/kosong/contract/provider';
import type { PermissionMode } from '@moonshot-ai/agent-core-v2/agent/permissionPolicy/types';

import type { ScopeRef } from '../channel.js';
import type { ScopedCaller } from './session.js';

// Wire-type aliases derived through the engine service interfaces (keeps
// klient free of protocol-package imports).
export type PromptLaunchResult = Awaited<ReturnType<IAgentRPCService['prompt']>>;
export type ShellCommandResult = Awaited<ReturnType<IAgentShellCommandService['run']>>;
export type SetModelResult = Awaited<ReturnType<IAgentProfileService['setModel']>>;
export type UsageStatus = Awaited<ReturnType<IAgentUsageService['status']>>;
export type AgentContextData = Awaited<ReturnType<IAgentRPCService['getContext']>>;
export type PlanData = Awaited<ReturnType<IAgentPlanService['status']>>;
export type AgentTaskInfo = Awaited<ReturnType<IAgentTaskService['list']>>[number];
export type CreateGoalInput = Parameters<IAgentGoalService['createGoal']>[0];
export type GoalSnapshot = Awaited<ReturnType<IAgentGoalService['createGoal']>>;
export type GoalToolResult = ReturnType<IAgentGoalService['getGoal']>;
export type AgentToolInfo = Awaited<ReturnType<IAgentRPCService['getTools']>>[number] & {
  /** Resolved live from the tool policy at call time; the engine's declared
   * `ToolInfo` type omits it, but every wire row carries it. */
  readonly active: boolean;
};
export type { SkillSummary, SwarmModeTrigger };

export interface AgentFacade {
  prompt(input: {
    input: readonly ContentPart[];
    disabledTools?: readonly string[];
  }): Promise<PromptLaunchResult>;
  steer(input: { input: readonly ContentPart[] }): Promise<PromptLaunchResult>;
  cancel(input?: { turnId?: number }): Promise<void>;
  runShellCommand(input: { command: string; commandId?: string }): Promise<ShellCommandResult>;
  cancelShellCommand(input: { commandId: string }): Promise<void>;
  getModel(): Promise<string>;
  setModel(model: string): Promise<SetModelResult>;
  setPermission(mode: PermissionMode): Promise<void>;
  getUsage(): Promise<UsageStatus>;
  getContext(): Promise<AgentContextData>;
  getPlan(): Promise<PlanData>;
  enterPlan(): Promise<void>;
  clearPlan(): Promise<void>;
  cancelPlan(input?: { id?: string }): Promise<void>;
  getTasks(input?: { activeOnly?: boolean; limit?: number }): Promise<readonly AgentTaskInfo[]>;
  stopTask(input: { taskId: string; reason?: string }): Promise<void>;
  getTaskOutput(input: { taskId: string; tail?: number }): Promise<string>;
  // --- Goal lifecycle (mirrors the v1 SDK session methods) ----------------
  createGoal(input: CreateGoalInput): Promise<GoalSnapshot>;
  getGoal(): Promise<GoalToolResult>;
  pauseGoal(): Promise<GoalSnapshot>;
  resumeGoal(): Promise<GoalSnapshot>;
  cancelGoal(): Promise<GoalSnapshot>;
  // --- Skills --------------------------------------------------------------
  listSkills(): Promise<readonly SkillSummary[]>;
  activateSkill(name: string, args?: string): Promise<void>;
  // --- Swarm ---------------------------------------------------------------
  setSwarmMode(enabled: boolean, trigger: SwarmModeTrigger): Promise<void>;
  // --- Compaction ----------------------------------------------------------
  compact(input?: { instruction?: string }): Promise<void>;
  cancelCompaction(): Promise<void>;
  // --- Tools / thinking ------------------------------------------------------
  setThinking(effort: ThinkingEffort): Promise<void>;
  getTools(): Promise<readonly AgentToolInfo[]>;
  setActiveTools(tools: readonly string[]): Promise<void>;
  // --- History / tasks -------------------------------------------------------
  undoHistory(count?: number): Promise<number>;
  detachBackgroundTask(taskId: string): Promise<AgentTaskInfo | undefined>;
}

export function createAgentFacade(call: ScopedCaller, scope: ScopeRef): AgentFacade {
  const rpc = (method: string, payload: unknown): Promise<unknown> =>
    call(scope, 'agentRPCService', method, [payload]);

  return {
    prompt: (input) => rpc('prompt', input) as Promise<PromptLaunchResult>,
    steer: (input) => rpc('steer', input) as Promise<PromptLaunchResult>,
    cancel: (input) => rpc('cancel', input ?? {}) as Promise<void>,
    runShellCommand: (input) =>
      call(scope, 'agentShellCommandService', 'run', [input]) as Promise<ShellCommandResult>,
    cancelShellCommand: (input) =>
      call(scope, 'agentShellCommandService', 'cancel', [input.commandId]) as Promise<void>,
    getModel: () => call(scope, 'agentProfileService', 'getModel', []) as Promise<string>,
    setModel: (model) =>
      call(scope, 'agentProfileService', 'setModel', [model]) as Promise<SetModelResult>,
    setPermission: (mode) => rpc('setPermission', { mode }) as Promise<void>,
    getUsage: () => call(scope, 'agentUsageService', 'status', []) as Promise<UsageStatus>,
    getContext: () => rpc('getContext', {}) as Promise<AgentContextData>,
    getPlan: () => call(scope, 'agentPlanService', 'status', []) as Promise<PlanData>,
    enterPlan: () => call(scope, 'agentPlanService', 'enter', []) as Promise<void>,
    clearPlan: () => call(scope, 'agentPlanService', 'clear', []) as Promise<void>,
    cancelPlan: (input) =>
      call(scope, 'agentPlanService', 'cancel', [input?.id]) as Promise<void>,
    getTasks: (input) =>
      call(scope, 'agentTaskService', 'list', [
        input?.activeOnly ?? false,
        input?.limit,
      ]) as Promise<readonly AgentTaskInfo[]>,
    stopTask: async (input) => {
      if (input.reason === undefined) {
        await call(scope, 'agentTaskService', 'stopByUser', [input.taskId]);
        return;
      }
      await call(scope, 'agentTaskService', 'stop', [input.taskId, input.reason]);
    },
    getTaskOutput: (input) =>
      call(scope, 'agentTaskService', 'readOutput', [input.taskId, input.tail]) as Promise<string>,
    createGoal: (input) =>
      call(scope, 'agentGoalService', 'createGoal', [input]) as Promise<GoalSnapshot>,
    getGoal: () => call(scope, 'agentGoalService', 'getGoal', []) as Promise<GoalToolResult>,
    pauseGoal: () =>
      call(scope, 'agentGoalService', 'pauseGoal', [undefined]) as Promise<GoalSnapshot>,
    resumeGoal: () =>
      call(scope, 'agentGoalService', 'resumeGoal', [undefined]) as Promise<GoalSnapshot>,
    cancelGoal: () =>
      call(scope, 'agentGoalService', 'cancelGoal', [undefined]) as Promise<GoalSnapshot>,
    // `listSkills` is dispatcher-synthesized from the session-scope catalog
    // (see dispatcher.ts); the agent scope resolves the parent-scope service.
    listSkills: () =>
      call(scope, 'sessionSkillCatalog', 'listSkills', []) as Promise<readonly SkillSummary[]>,
    // Fire-and-forget like the v1 RPC: the skill turn launches in the
    // background and also updates the session prompt metadata.
    activateSkill: (name, args) => rpc('activateSkill', { name, args }) as Promise<void>,
    setSwarmMode: async (enabled, trigger) => {
      if (enabled) {
        await call(scope, 'agentSwarmService', 'enter', [trigger]);
        return;
      }
      await call(scope, 'agentSwarmService', 'exit', []);
    },
    // `begin` reports whether the compaction started (`false` = one is
    // already running); the v1 SDK surface is `void`, so the flag is dropped.
    compact: async (input) => {
      await call(scope, 'agentFullCompactionService', 'begin', [
        { source: 'manual', instruction: input?.instruction },
      ]);
    },
    cancelCompaction: () => rpc('cancelCompaction', {}) as Promise<void>,
    setThinking: (effort) =>
      call(scope, 'agentProfileService', 'setThinking', [effort]) as Promise<void>,
    getTools: () => rpc('getTools', {}) as Promise<readonly AgentToolInfo[]>,
    setActiveTools: (tools) =>
      call(scope, 'agentProfileService', 'update', [
        { activeToolNames: [...tools] },
      ]) as Promise<void>,
    undoHistory: (count) => rpc('undoHistory', { count: count ?? 1 }) as Promise<number>,
    detachBackgroundTask: (taskId) =>
      call(scope, 'agentTaskService', 'detach', [taskId]) as Promise<AgentTaskInfo | undefined>,
  };
}
