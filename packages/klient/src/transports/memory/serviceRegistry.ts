/**
 * Service name → DI token registry for the in-process dispatcher. Only leaf
 * modules are imported (tokens + types) — never the engine root barrel, so
 * hosting klient in-process does not force the full registration side effects
 * beyond what the host already bootstrapped.
 */

import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import { ISessionIndex } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import { IWorkspaceService } from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IModelService } from '@moonshot-ai/agent-core-v2/kosong/model/model';
import { IModelCatalog } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';
import { IProviderDiscoveryService } from '@moonshot-ai/agent-core-v2/app/kosongConfig/discovery';
import { IProviderService } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';
import {
  IAuthSummaryService,
  IOAuthService,
} from '@moonshot-ai/agent-core-v2/app/auth/auth';
import { IFlagService } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import { IPluginService } from '@moonshot-ai/agent-core-v2/app/plugin/plugin';
import { IBootstrapService } from '@moonshot-ai/agent-core-v2/app/bootstrap/bootstrap';
import { IEventService } from '@moonshot-ai/agent-core-v2/app/event/event';
import { IHostFolderBrowser } from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
import { IWorkspaceLifecycleService } from '@moonshot-ai/agent-core-v2/app/workspaceLifecycle/workspaceLifecycle';
import { IWorkspaceAliases } from '@moonshot-ai/agent-core-v2/app/workspaceAliases/workspaceAliases';
import { ISessionExportService } from '@moonshot-ai/agent-core-v2/app/sessionExport/sessionExport';
import { ISkillDiscovery } from '@moonshot-ai/agent-core-v2/app/skillCatalog/skillDiscovery';
import { ISessionLifecycleService } from '@moonshot-ai/agent-core-v2/workspace/sessionLifecycle/sessionLifecycle';
import { IWorkspaceTrust } from '@moonshot-ai/agent-core-v2/workspace/workspaceTrust/workspaceTrust';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '@moonshot-ai/agent-core-v2/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '@moonshot-ai/agent-core-v2/session/workspaceContext/workspaceContext';
import { ISessionInitService } from '@moonshot-ai/agent-core-v2/session/sessionInit/sessionInit';
import { ISessionInteractionService } from '@moonshot-ai/agent-core-v2/session/interaction/interaction';
import { ISessionApprovalService } from '@moonshot-ai/agent-core-v2/session/approval/approval';
import { ISessionCronService } from '@moonshot-ai/agent-core-v2/session/cron/sessionCronService';
import { ISessionQuestionService } from '@moonshot-ai/agent-core-v2/session/question/question';
import { IAgentRPCService } from '@moonshot-ai/agent-core-v2/agent/rpc/rpc';
import { IAgentActivityView } from '@moonshot-ai/agent-core-v2/agent/activityView/activityView';
import { IAgentContextMemoryService } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextMemory';
import { IAgentFullCompactionService } from '@moonshot-ai/agent-core-v2/agent/fullCompaction/fullCompaction';
import { IAgentGoalService } from '@moonshot-ai/agent-core-v2/agent/goal/goal';
import { IAgentLifecycleService } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { IAgentLoopService } from '@moonshot-ai/agent-core-v2/agent/loop/loop';
import { IAgentPermissionModeService } from '@moonshot-ai/agent-core-v2/agent/permissionMode/permissionMode';
import { IAgentPermissionRulesService } from '@moonshot-ai/agent-core-v2/agent/permissionRules/permissionRules';
import { IAgentPlanService } from '@moonshot-ai/agent-core-v2/agent/plan/plan';
import { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import { IAgentSkillService } from '@moonshot-ai/agent-core-v2/agent/skill/skill';
import { IAgentShellCommandService } from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommand';
import { IAgentContextSizeService } from '@moonshot-ai/agent-core-v2/agent/contextSize/contextSize';
import { IAgentSwarmService } from '@moonshot-ai/agent-core-v2/agent/swarm/swarm';
import { IAgentTaskService } from '@moonshot-ai/agent-core-v2/agent/task/task';
import { IAgentUsageService } from '@moonshot-ai/agent-core-v2/agent/usage/usage';
import { ISessionSkillCatalog } from '@moonshot-ai/agent-core-v2/session/sessionSkillCatalog/skillCatalog';
import { ISessionBtwService } from '@moonshot-ai/agent-core-v2/session/btw/btw';
import { ISessionSecondaryModelWarningService } from '@moonshot-ai/agent-core-v2/session/subagent/secondaryModelWarning';
import { IAgentMcpService } from '@moonshot-ai/agent-core-v2/agent/mcp/mcp';
import { IWorkspaceDirs } from '@moonshot-ai/agent-core-v2/workspace/workspaceDirs/workspaceDirs';

/** Wire service name (decorator id string) → token. */
export const serviceTokens: Readonly<Record<string, ServiceIdentifier<unknown>>> = {
  sessionIndex: ISessionIndex,
  workspaceService: IWorkspaceService,
  configService: IConfigService,
  modelService: IModelService,
  modelResolver: IModelCatalog,
  providerDiscovery: IProviderDiscoveryService,
  providerService: IProviderService,
  oauthService: IOAuthService,
  authSummaryService: IAuthSummaryService,
  flagService: IFlagService,
  pluginService: IPluginService,
  hostFolderBrowser: IHostFolderBrowser,
  bootstrapService: IBootstrapService,
  eventService: IEventService,
  sessionExportService: ISessionExportService,
  skillDiscovery: ISkillDiscovery,
  workspaceAliases: IWorkspaceAliases,
  workspaceLifecycleService: IWorkspaceLifecycleService,
  sessionLifecycleService: ISessionLifecycleService,
  workspaceTrust: IWorkspaceTrust,
  sessionMetadata: ISessionMetadata,
  sessionContext: ISessionContext,
  sessionWorkspaceContext: ISessionWorkspaceContext,
  sessionInitService: ISessionInitService,
  sessionInteractionService: ISessionInteractionService,
  sessionApprovalService: ISessionApprovalService,
  sessionCronService: ISessionCronService,
  sessionQuestionService: ISessionQuestionService,
  sessionSkillCatalog: ISessionSkillCatalog,
  sessionBtwService: ISessionBtwService,
  sessionSecondaryModelWarningService: ISessionSecondaryModelWarningService,
  agentLifecycleService: IAgentLifecycleService,
  agentMcpService: IAgentMcpService,
  workspaceDirs: IWorkspaceDirs,
  agentRPCService: IAgentRPCService,
  agentActivityView: IAgentActivityView,
  agentContextMemoryService: IAgentContextMemoryService,
  agentFullCompactionService: IAgentFullCompactionService,
  agentGoalService: IAgentGoalService,
  agentLoopService: IAgentLoopService,
  agentPermissionModeService: IAgentPermissionModeService,
  agentPermissionRulesService: IAgentPermissionRulesService,
  agentShellCommandService: IAgentShellCommandService,
  agentContextSizeService: IAgentContextSizeService,
  agentProfileService: IAgentProfileService,
  agentSkillService: IAgentSkillService,
  agentSwarmService: IAgentSwarmService,
  agentUsageService: IAgentUsageService,
  agentPlanService: IAgentPlanService,
  agentTaskService: IAgentTaskService,
};

export { IEventService };
