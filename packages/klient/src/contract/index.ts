/**
 * The aggregated klient contract — service wire name → method → zod
 * input/output schemas, across the core/session/agent scopes. The klient
 * factory validates every call against this table; transports never see it.
 * Event registrations live in the per-scope `events.ts` files alongside
 * their payload schemas.
 */

import type { KlientContract } from './types.js';
import { agentActivityViewContract } from './agent/activity.js';
import { agentContextMemoryContract } from './agent/contextMemory.js';
import { agentGoalContract } from './agent/goal.js';
import { agentLifecycleContract } from './agent/lifecycle.js';
import { agentLoopContract } from './agent/loop.js';
import { agentMcpContract } from './agent/mcp.js';
import {
  agentPermissionModeContract,
  agentPermissionRulesContract,
} from './agent/permission.js';
import { agentRpcContract } from './agent/rpc.js';
import { agentSkillContract } from './agent/skill.js';
import {
  agentContextSizeContract,
  agentFullCompactionContract,
  agentPlanContract,
  agentProfileContract,
  agentShellCommandContract,
  agentSwarmContract,
  agentTaskContract,
  agentUsageContract,
} from './agent/services.js';
import { authContract, authSummaryContract } from './global/auth.js';
import { catalogContract } from './global/catalog.js';
import { providerDiscoveryContract } from './global/providerDiscovery.js';
import { configContract } from './global/config.js';
import { envContract } from './global/env.js';
import { eventServiceContract } from './global/eventBus.js';
import { sessionExportContract } from './global/export.js';
import { flagsContract } from './global/flags.js';
import { hostFsContract } from './global/hostFs.js';
import { modelsContract } from './global/models.js';
import { pluginsContract } from './global/plugins.js';
import { providersContract } from './global/providers.js';
import { sessionsContract } from './global/sessions.js';
import { skillDiscoveryContract } from './global/skillDiscovery.js';
import { workspaceAliasesContract, workspacesContract } from './global/workspaces.js';
import { sessionApprovalContract } from './session/approval.js';
import { sessionContextContract, sessionWorkspaceContextContract } from './session/context.js';
import { sessionCronContract } from './session/cron.js';
import { sessionBtwContract } from './session/btw.js';
import { sessionInitContract } from './session/init.js';
import { sessionInteractionContract } from './session/interaction.js';
import {
  sessionLifecycleContract,
  workspaceLifecycleContract,
} from './session/lifecycle.js';
import { sessionMetadataContract } from './session/metadata.js';
import { sessionQuestionContract } from './session/question.js';
import { sessionSecondaryModelWarningContract } from './session/secondaryModelWarning.js';
import { sessionSkillCatalogContract } from './session/skillCatalog.js';
import { workspaceDirsContract } from './session/workspaceDirs.js';
import { workspaceTrustContract } from './session/workspaceTrust.js';

export const globalContract: KlientContract = {
  // core (app scope)
  sessionIndex: sessionsContract,
  workspaceService: workspacesContract,
  workspaceAliases: workspaceAliasesContract,
  configService: configContract,
  providerService: providersContract,
  modelService: modelsContract,
  modelResolver: catalogContract,
  providerDiscovery: providerDiscoveryContract,
  oauthService: authContract,
  authSummaryService: authSummaryContract,
  flagService: flagsContract,
  pluginService: pluginsContract,
  hostFolderBrowser: hostFsContract,
  bootstrapService: envContract,
  eventService: eventServiceContract,
  sessionExportService: sessionExportContract,
  skillDiscovery: skillDiscoveryContract,
  // workspace scope (+ the app-registered handler registry)
  workspaceLifecycleService: workspaceLifecycleContract,
  sessionLifecycleService: sessionLifecycleContract,
  workspaceDirs: workspaceDirsContract,
  workspaceTrust: workspaceTrustContract,
  // session scope
  sessionMetadata: sessionMetadataContract,
  sessionInteractionService: sessionInteractionContract,
  sessionApprovalService: sessionApprovalContract,
  sessionCronService: sessionCronContract,
  sessionQuestionService: sessionQuestionContract,
  sessionSkillCatalog: sessionSkillCatalogContract,
  sessionBtwService: sessionBtwContract,
  sessionSecondaryModelWarningService: sessionSecondaryModelWarningContract,
  sessionInitService: sessionInitContract,
  sessionContext: sessionContextContract,
  sessionWorkspaceContext: sessionWorkspaceContextContract,
  agentLifecycleService: agentLifecycleContract,
  // agent scope
  agentRPCService: agentRpcContract,
  agentActivityView: agentActivityViewContract,
  agentFullCompactionService: agentFullCompactionContract,
  agentGoalService: agentGoalContract,
  agentMcpService: agentMcpContract,
  agentShellCommandService: agentShellCommandContract,
  agentContextSizeService: agentContextSizeContract,
  agentContextMemoryService: agentContextMemoryContract,
  agentProfileService: agentProfileContract,
  agentSwarmService: agentSwarmContract,
  agentUsageService: agentUsageContract,
  agentPlanService: agentPlanContract,
  agentTaskService: agentTaskContract,
  agentPermissionModeService: agentPermissionModeContract,
  agentPermissionRulesService: agentPermissionRulesContract,
  agentLoopService: agentLoopContract,
  agentSkillService: agentSkillContract,
};

export type { KlientContract, ProcedureContract, ServiceContract, StreamingProcedureContract } from './types.js';
export { isStreamingContract } from './types.js';
