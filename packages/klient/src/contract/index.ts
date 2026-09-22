import { agentContextMemoryContract as contextMutations } from './agent/contextMemory.js';
import {
  agentConversationUndoContract,
  agentPluginCommandContract,
  agentReminderContract,
  agentTodoContract,
  agentToolsContract,
  agentTowerContract,
} from './agent/extensions.js';
import { agentGoalContract } from './agent/goal.js';
import { agentLifecycleContract } from './agent/lifecycle.js';
import { agentMcpContract, sessionMcpManagementContract } from './agent/mcp.js';
import { agentPermissionRulesContract } from './agent/permission.js';
import { agentContextSizeContract, agentSwarmContract } from './agent/services.js';
import { eventServiceContract } from './global/eventBus.js';
import { sessionExportContract } from './global/export.js';
import { skillDiscoveryContract } from './global/skillDiscovery.js';
import {
  workspaceFsContract,
  workspaceMcpContract,
  workspaceSkillsContract,
} from './global/workspaceRuntime.js';
import { workspaceAliasesContract } from './global/workspaces.js';
import { sessionBtwContract } from './session/btw.js';
import {
  sessionContextContract,
  sessionWorkspaceContextContract,
} from './session/context.js';
import { sessionCronContract } from './session/cron.js';
import {
  pluginSessionStartsContract,
  sessionInitContract,
  sessionWarningsContract,
} from './session/init.js';
import { workspaceDirsContract } from './session/workspaceDirs.js';
import { workspaceTrustContract } from './session/workspaceTrust.js';
/**
 * The aggregated klient contract — service wire name → method → zod
 * input/output schemas, across the core/session/agent scopes. The klient
 * factory validates every call against this table; transports never see it.
 * Event registrations live in the per-scope `events.ts` files alongside
 * their payload schemas.
 */

import {
  agentCommandContract,
  agentContextMemoryContract,
  agentFullCompactionContract,
  agentLoopContract,
  agentPermissionModeContract,
  agentPlanContract,
  agentProfileContract,
  agentPromptContract,
  agentRuntimeBindingContract,
  agentShellCommandContract,
  agentSkillContract,
  agentTaskContract,
  agentTokenCountingContract,
  agentUsageContract,
} from './agent/services.js';
import { authContract, authSummaryContract } from './global/auth.js';
import { capabilitiesContract } from './global/capabilities.js';
import { catalogContract } from './global/catalog.js';
import { configContract } from './global/config.js';
import { envContract } from './global/env.js';
import { filesContract } from './global/files.js';
import { flagsContract } from './global/flags.js';
import { hostFsContract } from './global/hostFs.js';
import { mcpManagementContract } from './global/mcpManagement.js';
import { modelsContract } from './global/models.js';
import { pluginsContract } from './global/plugins.js';
import { providerDiscoveryContract } from './global/providerDiscovery.js';
import { providersContract } from './global/providers.js';
import { registryImportContract } from './global/registryImport.js';
import { sessionsContract } from './global/sessions.js';
import { workspacesContract } from './global/workspaces.js';
import { sessionActivityViewContract } from './session/activity.js';
import { sessionApprovalContract } from './session/approval.js';
import { sessionInteractionContract } from './session/interaction.js';
import { sessionManagerContract } from './session/lifecycle.js';
import { sessionMetadataContract } from './session/metadata.js';
import { sessionQuestionContract } from './session/question.js';
import { sessionSkillCatalogContract } from './session/skills.js';
import { sessionTitleContract } from './session/title.js';
import type { KlientContract } from './types.js';

export const globalContract: KlientContract = {
  // core (app scope)
  sessionIndex: sessionsContract,
  workspaceService: workspacesContract,
  configService: configContract,
  providerService: providersContract,
  modelService: modelsContract,
  modelResolver: catalogContract,
  providerDiscovery: providerDiscoveryContract,
  modelsDevImport: registryImportContract,
  oauthService: authContract,
  authSummaryService: authSummaryContract,
  flagService: flagsContract,
  pluginService: pluginsContract,
  capabilityService: capabilitiesContract,
  hostFolderBrowser: hostFsContract,
  bootstrapService: envContract,
  eventService: eventServiceContract,
  agentPluginCommandService: agentPluginCommandContract,
  agentConversationUndoService: agentConversationUndoContract,
  agentTools: agentToolsContract,
  agentTowerService: agentTowerContract,
  agentTodoService: agentTodoContract,
  agentReminderService: agentReminderContract,
  sessionExportService: sessionExportContract,
  skillDiscovery: skillDiscoveryContract,
  workspaceAliases: workspaceAliasesContract,
  workspaceTrust: workspaceTrustContract,
  workspaceFs: workspaceFsContract,
  workspaceMcp: workspaceMcpContract,
  workspaceSkills: workspaceSkillsContract,
  workspaceDirs: workspaceDirsContract,
  sessionContext: sessionContextContract,
  sessionWorkspaceContext: sessionWorkspaceContextContract,
  sessionInitService: sessionInitContract,
  sessionWarnings: sessionWarningsContract,
  pluginSessionStarts: pluginSessionStartsContract,
  sessionMcpManagement: sessionMcpManagementContract,
  agentCronService: sessionCronContract,
  sessionBtwService: sessionBtwContract,
  agentLifecycleService: agentLifecycleContract,
  agentGoalService: agentGoalContract,
  agentPermissionRulesService: agentPermissionRulesContract,
  agentSwarmService: agentSwarmContract,

  fileService: filesContract,
  mcpManagementService: mcpManagementContract,
  sessionManager: sessionManagerContract,
  // session scope
  sessionMetadata: sessionMetadataContract,
  sessionInteractionService: sessionInteractionContract,
  sessionApprovalService: sessionApprovalContract,
  sessionQuestionService: sessionQuestionContract,
  sessionSkillCatalog: sessionSkillCatalogContract,
  sessionTitleService: sessionTitleContract,
  sessionActivityView: sessionActivityViewContract,
  // agent scope
  agentPromptService: agentPromptContract,
  agentSkillService: agentSkillContract,
  agentLoopService: agentLoopContract,
  agentPermissionModeService: agentPermissionModeContract,
  agentCommandService: agentCommandContract,
  agentRuntimeBindingService: agentRuntimeBindingContract,
  agentContextMemoryService: { ...agentContextMemoryContract, ...contextMutations },
  agentTokenCountingService: {
    ...agentTokenCountingContract,
    ...agentContextSizeContract,
  },
  agentShellCommandService: agentShellCommandContract,
  agentProfileService: agentProfileContract,
  agentUsageService: agentUsageContract,
  agentPlanService: agentPlanContract,
  agentTaskService: agentTaskContract,
  agentMcpService: agentMcpContract,
  agentFullCompactionService: agentFullCompactionContract,
};

export { isStreamingContract } from './types.js';
export type {
  KlientContract,
  ProcedureContract,
  ServiceContract,
  StreamingProcedureContract,
} from './types.js';
