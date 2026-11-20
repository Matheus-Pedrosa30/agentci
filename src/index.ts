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
export type {
  GitHubPublication,
  RepairAttemptInput,
  RepairAttemptPersistence,
  RepairClock,
  RepairProposal,
  RepairProposalChange,
  RepairProvider,
  SandboxRuntime,
} from "./repair-orchestrator.ts";
export { startAgentCiService } from "./start.ts";
export type { RunningAgentCiService } from "./start.ts";
