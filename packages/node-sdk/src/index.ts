export { KimiAuthFacade } from '#/auth';
export {
	KimiConfigRpcClient,createKimiConfigRpc,type KimiConfigRpc,
	type KimiConfigValidationIssue,
	type KimiConfigValidationPathSegment,
	type ResolveKimiConfigPathInput,
	type ValidateKimiConfigTomlInput
} from '#/config-rpc';
export { KimiForCodingProvider } from '#/kimi-code-model-provider';
export type { KimiForCodingProviderOptions } from '#/kimi-code-model-provider';
export { KimiHarness } from '#/kimi-harness';
export type { KimiHarnessRuntimeOptions } from '#/kimi-harness';
export { SDKRpcClientBase } from '#/rpc';
export {
	SDKRpcClientV2,createKimiHarness,createKimiHarness as createKimiHarnessV2,
	createKimiHarnessV2Remote,type KimiHarnessV2RemoteConnection,
	type SDKRpcClientV2Options
} from '#/sdk-rpc-client-v2';
export { Session } from '#/session';
export { removeProviderFromConfig } from '#/v2/config-mapper';

export {
	CatalogFetchError,DEFAULT_CATALOG_URL,RegistryImportError,applyCatalogProvider,
	catalogBaseUrl,
	catalogModelToAlias,
	catalogProviderModels,fetchCatalog,
	inferWireType,
	loadBuiltInCatalog,
	resolveCatalogImport
} from '#/catalog';
export type {
	ApplyCatalogProviderOptions,
	Catalog,
	CatalogImportInvalidReason,
	CatalogImportResolution,
	CatalogModel,
	CatalogProviderEntry,
	FetchCatalogOptions
} from '#/catalog';

export {
	ErrorCodes,KIMI_ERROR_INFO,KimiError,fromKimiErrorPayload,
	isKimiError,
	toKimiErrorPayload,type KimiErrorCode,
	type KimiErrorInfo,
	type KimiErrorOptions,
	type KimiErrorPayload
} from '#/errors';

export {
	flushDiagnosticLogs,
	flushDiagnosticLogsSync,
	log,
	redact,
	resolveGlobalLogPath
} from '#/logging/index';
export type { LogContext,LogLevel,LogPayload,Logger } from '#/logging/index';
export { resolveKimiHome } from '@moonshot-ai/agent-core-v2';

export { SECONDARY_DERIVED_MODEL_ALIAS,effectiveModelAlias,loadRuntimeConfigSafe } from '#/config/index';
export { limitAgentReplayByTurns } from '#/replay';
export { parseAgentFileText,resolveAgentPath,resolveConfigPath } from '@moonshot-ai/agent-core-v2';
export { PRIMARY_SUBAGENT_MODEL_CHOICE } from '@moonshot-ai/agent-core-v2/session/subagent/configSection';

export { installGlobalProxyDispatcher } from '#/proxy';

export { ImageLimits,compressBase64ForModel,compressImageForModel } from '#/image';
export type {
	CompressBase64Result,CompressImageOptions,
	CompressImageResult,ImageCompressionCaptionInput,
	ImageCompressionTelemetry
} from '#/image';
export {
	IMAGE_BYTE_BUDGET,
	MAX_IMAGE_EDGE_PX,buildImageCompressionCaption,
	buildUnsupportedImageNotice,
	gateImageFormatParts,
	isModelAcceptedImageMime,
	normalizeImageMime,
	parseImageDataUrl,
	persistOriginalImage,
	sessionMediaOriginalsDir
} from '@moonshot-ai/agent-core-v2';

export type {
	ExperimentalFeatureState,
	ExperimentalFlagMap,
	ExperimentalFlagSource,
	FlagDefinition,
	FlagDefinitionInput,
	FlagId,
	FlagSurface
} from '#/flag';

export {
	buildDaemonFileUrl,
	buildMediaPathTag,
	isDaemonFileUrl,
	matchSingleMediaPathTag,
	parseDaemonFileUrl
} from '@moonshot-ai/agent-core-v2/agent/media/mediaRef';
export type {
	DaemonFileRef,
	MediaKind
} from '@moonshot-ai/agent-core-v2/agent/media/mediaRef';

export type {
	KimiAuthCompleteFeedbackUploadInput,
	KimiAuthCompleteFeedbackUploadPart,
	KimiAuthCreateFeedbackUploadUrlInput,
	KimiAuthCreateFeedbackUploadUrlOk,
	KimiAuthCreateFeedbackUploadUrlResult,
	KimiAuthFeedbackUploadPart,
	KimiAuthLoginResult,
	KimiAuthLogoutResult,
	KimiAuthSubmitFeedbackInput
} from '#/auth';

export * from '#/events';
export type * from '#/types';
