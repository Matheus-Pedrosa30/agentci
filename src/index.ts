export const PROJECT_NAME = "AgentCI";

export { createGitHubAppIntakeApi } from "./github-api.ts";
export { createDeterministicFailureAnalyzer } from "./failure-analyzer.ts";
export type { FailureAnalysis, FailureAnalyzer } from "./failure-analyzer.ts";
export {
  buildModelEvidence,
  identifyPrimaryFailure,
  validateAllowedFilePatterns,
  validateRequestedFiles,
} from "./failure-evidence.ts";
export type {
  ConfiguredJobEvidence,
  ModelFailureEvidence,
  PrimaryFailure,
  PrimaryFailureIdentification,
  RequestedFilesValidation,
} from "./failure-evidence.ts";
export { classifyValidation, evaluateProposal, primaryFailureIdentity } from "./proposal-policy.ts";
export type {
  PolicyProposal,
  ProposalChange,
  ProposalEvaluation,
  ProposalUsage,
  ValidationClassification,
  ValidationObservation,
} from "./proposal-policy.ts";
export { createWebhookIntake } from "./intake.ts";
export type {
  GitHubIntakeApi,
  IntakeOptions,
  RepairAttemptMetadata,
  WebhookIntake,
} from "./intake.ts";
export { parseRepositoryContract } from "./repository-contract.ts";
export type { RepositoryContract } from "./repository-contract.ts";
export { createRepairOrchestrator } from "./repair-orchestrator.ts";
export {
  createAiSdkRepairProvider,
  createAnthropicModel,
  createAnthropicRepairProvider,
  createModelRegistry,
  createOpenAICompatibleModel,
  createOpenAICompatibleRepairProvider,
  createOpenAIModel,
  createOpenAIRepairProvider,
  ModelSelectionError,
  RepairProviderError,
} from "./model-provider.ts";
export type {
  AnthropicModelOptions,
  OpenAICompatibleModelOptions,
  OpenAIModelOptions,
  RegisteredModel,
  RepairProviderErrorKind,
} from "./model-provider.ts";
export { createNode24DockerRuntime } from "./node24-docker-runtime.ts";
export type {
  DockerCommandResult,
  DockerCommandRunner,
  ExactRevisionArchiveProvider,
  Node24DockerRuntimeOptions,
} from "./node24-docker-runtime.ts";
export type {
  GitHubPublication,
  RepairAttemptInput,
  RepairAttemptPersistence,
  RepairClock,
  RepairModelRegistry,
  RepairProposal,
  RepairProposalChange,
  RepairProvider,
  SandboxRuntime,
} from "./repair-orchestrator.ts";
export { startAgentCiService } from "./start.ts";
export type { RunningAgentCiService } from "./start.ts";
