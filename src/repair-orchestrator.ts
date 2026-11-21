import {
  buildModelEvidence,
  redactAndBoundSourceFile,
  redactAndBoundSummary,
  validateRequestedFiles,
  type ModelFailureEvidence,
  type PrimaryFailure,
} from "./failure-evidence.ts";
import {
  classifyValidation,
  evaluateProposal,
  primaryFailureIdentity,
  type PolicyProposal,
} from "./proposal-policy.ts";
import { RepairProviderError } from "./model-provider.ts";

export interface RepairProposalChange {
  path: string;
  content: string;
}

export type RepairProposal = PolicyProposal;

interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface RepairProvider {
  alias: string;
  provider: string;
  model: string;
  analyzeFailure(evidence: ModelFailureEvidence): Promise<{
    actionable: boolean;
    summary: string;
    requestedFiles: readonly string[];
    usage?: TokenUsage;
  }>;
  proposeRepair(input: {
    evidence: ModelFailureEvidence;
    files: Readonly<Record<string, string>>;
    previousRejections: readonly string[];
  }): Promise<unknown>;
}

export interface RepairModelRegistry {
  createRepairProvider(alias: string): RepairProvider;
}

export interface SandboxRuntime {
  validate(input: {
    repository: string;
    revision: string;
    runtimeAlias: string;
    installCommand: readonly string[];
    validationCommand: readonly string[];
    proposal: RepairProposal;
    baselineProposal?: RepairProposal;
    signal?: AbortSignal;
  }): Promise<
    | { outcome: "passed"; changedFiles: readonly string[] }
    | { outcome: "failed"; summary: string; observedFailureIdentity?: string }
  >;
  cleanup?(input: { attemptId: string }): Promise<void>;
}

interface PublicationReport {
  repository: string;
  revision: string;
  title: string;
  body: string;
  actions?: readonly {
    label: string;
    description: string;
    identifier: string;
  }[];
}

export interface GitHubPublication {
  readTrackedTextFiles(input: {
    repository: string;
    revision: string;
    paths: readonly string[];
  }): Promise<Readonly<Record<string, string>>>;
  ensureValidatedRepair(
    input: PublicationReport & {
      baseBranch: string;
      headBranch: string;
      draft: true;
      changes: readonly RepairProposalChange[];
    },
  ): Promise<{ number: number; url: string }>;
  completeCheck(input: PublicationReport & { conclusion: "success" | "neutral" }): Promise<void>;
}

export interface RepairAttemptPersistence {
  transition(input: {
    attemptId: string;
    status: "proposing" | "validating" | "publishing" | "validated" | "unresolved" | "stale";
    at: string;
  }): Promise<void>;
  publishIfCurrent<T>(
    input: { attemptId: string; at: string },
    publish: () => Promise<T>,
  ): Promise<{ outcome: "published"; value: T } | { outcome: "stale" }>;
  offerContinuation?(input: {
    attemptId: string;
    at: string;
    expiresAt: string;
    proposal: RepairProposal;
    revealedFailure: PrimaryFailure;
    cumulativeChangedFiles: readonly string[];
    cumulativeChangedLines: number;
  }): Promise<string>;
  offerRetry?(input: { attemptId: string; at: string; expiresAt: string }): Promise<string>;
}

export interface RepairClock {
  now(): Date;
}

export interface RepairAttemptInput {
  attemptId: string;
  runId: string;
  repository: string;
  revision: string;
  workflow?: string;
  defaultBranch: string;
  modelAlias: string;
  runtimeAlias: string;
  allowedPaths: readonly string[];
  installCommand: readonly string[];
  validationCommand: readonly string[];
  primaryFailure: PrimaryFailure;
  baseline?: {
    proposal: RepairProposal;
    cumulativeChangedFiles: readonly string[];
    cumulativeChangedLines: number;
  };
}

function mergeProposals(
  baseline: RepairProposal | undefined,
  proposal: RepairProposal,
): RepairProposal {
  const changes = new Map<string, RepairProposalChange>();
  for (const change of baseline?.changes ?? []) changes.set(change.path, change);
  for (const change of proposal.changes) changes.set(change.path, change);
  return { summary: proposal.summary, changes: [...changes.values()] };
}

function validUsage(value: unknown): value is TokenUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const usage = value as TokenUsage;
  return [usage.inputTokens, usage.outputTokens].every(
    (count) => count === undefined || (Number.isSafeInteger(count) && count >= 0),
  );
}

function parseAnalysis(value: unknown):
  | {
      actionable: boolean;
      summary: string;
      requestedFiles: readonly string[];
      usage?: TokenUsage;
    }
  | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as {
    actionable?: unknown;
    summary?: unknown;
    requestedFiles?: unknown;
    usage?: unknown;
  };
  if (
    typeof candidate.actionable !== "boolean" ||
    typeof candidate.summary !== "string" ||
    !Array.isArray(candidate.requestedFiles) ||
    !candidate.requestedFiles.every((path) => typeof path === "string") ||
    (candidate.usage !== undefined && !validUsage(candidate.usage))
  ) {
    return undefined;
  }
  return {
    actionable: candidate.actionable,
    summary: candidate.summary,
    requestedFiles: candidate.requestedFiles,
    ...(candidate.usage ? { usage: candidate.usage } : {}),
  };
}

function parseValidation(value: unknown):
  | { outcome: "passed"; changedFiles: readonly string[] }
  | {
      outcome: "failed";
      summary: string;
      observedFailureIdentity?: string;
      revealedFailure?: PrimaryFailure;
    }
  | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as {
    outcome?: unknown;
    changedFiles?: unknown;
    summary?: unknown;
    observedFailureIdentity?: unknown;
    revealedFailure?: unknown;
  };
  if (
    candidate.outcome === "passed" &&
    Array.isArray(candidate.changedFiles) &&
    candidate.changedFiles.every((path) => typeof path === "string")
  ) {
    return { outcome: "passed", changedFiles: candidate.changedFiles };
  }
  if (
    candidate.outcome === "failed" &&
    typeof candidate.summary === "string" &&
    (candidate.observedFailureIdentity === undefined ||
      typeof candidate.observedFailureIdentity === "string") &&
    (candidate.revealedFailure === undefined || validPrimaryFailure(candidate.revealedFailure))
  ) {
    return {
      outcome: "failed",
      summary: candidate.summary,
      ...(candidate.observedFailureIdentity === undefined
        ? {}
        : { observedFailureIdentity: candidate.observedFailureIdentity }),
      ...(candidate.revealedFailure === undefined
        ? {}
        : { revealedFailure: candidate.revealedFailure }),
    };
  }
  return undefined;
}

function validPrimaryFailure(value: unknown): value is PrimaryFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const failure = value as Partial<PrimaryFailure>;
  return (
    typeof failure.jobId === "string" &&
    typeof failure.jobName === "string" &&
    Number.isSafeInteger(failure.stepNumber) &&
    typeof failure.stepName === "string" &&
    typeof failure.log === "string"
  );
}

function tokenCount(usage: TokenUsage | undefined, key: keyof TokenUsage): number {
  return usage?.[key] ?? 0;
}

function commandText(command: readonly string[]): string {
  return command.join(" ");
}

function auditText(value: string): string {
  return redactAndBoundSummary(value);
}

function providerFailureReason(error: unknown, fallback: string): string {
  if (!(error instanceof RepairProviderError)) return fallback;
  switch (error.kind) {
    case "provider_error":
      return "The model provider request failed.";
    case "quota_exceeded":
      return "The model provider quota was exceeded.";
    case "invalid_structured_output":
      return "The model provider returned invalid structured output.";
    case "missing_usage":
      return "The model provider response omitted required usage data.";
  }
}

type RepairOrchestratorDependencies = {
  github: GitHubPublication;
  sandbox: SandboxRuntime;
  persistence: RepairAttemptPersistence;
  clock: RepairClock;
} & (
  { provider: RepairProvider; models?: never } | { models: RepairModelRegistry; provider?: never }
);

export function createRepairOrchestrator(dependencies: RepairOrchestratorDependencies): {
  advance(
    attempt: RepairAttemptInput,
  ): Promise<
    | { outcome: "validated"; pullRequestNumber: number }
    | { outcome: "unresolved" }
    | { outcome: "stale" }
  >;
} {
  const at = () => dependencies.clock.now().toISOString();
  return {
    async advance(attempt) {
      const unresolved = async (
        reason: string,
        audit?: {
          proposalCount: number;
          rejections: readonly string[];
          inputTokens: number;
          outputTokens: number;
        },
      ): Promise<{ outcome: "unresolved" }> => {
        await dependencies.persistence.transition({
          attemptId: attempt.attemptId,
          status: "unresolved",
          at: at(),
        });
        const retryIdentifier = dependencies.persistence.offerRetry
          ? await dependencies.persistence.offerRetry({
              attemptId: attempt.attemptId,
              at: at(),
              expiresAt: new Date(dependencies.clock.now().getTime() + 15 * 60_000).toISOString(),
            })
          : undefined;
        await dependencies.github.completeCheck({
          repository: attempt.repository,
          revision: attempt.revision,
          conclusion: "neutral",
          title: "AgentCI could not validate a Repair Proposal",
          body: [
            `Unresolved Repair: ${redactAndBoundSummary(reason)}`,
            ...(audit
              ? [
                  `Proposal count: ${audit.proposalCount}`,
                  `Rejected proposals: ${audit.rejections.length === 0 ? "none" : audit.rejections.map((summary, index) => `${index + 1}. ${auditText(summary)}`).join("; ")}`,
                  `Usage: Input tokens: ${audit.inputTokens}; output tokens: ${audit.outputTokens}`,
                ]
              : []),
          ].join("\n"),
          ...(retryIdentifier
            ? {
                actions: [
                  {
                    label: "Retry repair",
                    description: "Restart from the original failure.",
                    identifier: retryIdentifier,
                  },
                ],
              }
            : {}),
        });
        return { outcome: "unresolved" };
      };
      let provider: RepairProvider;
      try {
        provider =
          dependencies.provider ?? dependencies.models.createRepairProvider(attempt.modelAlias);
      } catch {
        return unresolved(
          "The Repository Contract selected a model alias that is not allowlisted.",
        );
      }
      if (provider.alias !== attempt.modelAlias) {
        return unresolved("The configured model alias does not match the selected provider.");
      }
      const evidence = buildModelEvidence(attempt.primaryFailure, attempt.allowedPaths);
      let analysisResult: unknown;
      try {
        analysisResult = await provider.analyzeFailure(evidence);
      } catch (error) {
        return unresolved(providerFailureReason(error, "Failure analysis could not be completed."));
      }
      const analysis = parseAnalysis(analysisResult);
      if (!analysis) return unresolved("The provider returned an invalid failure analysis.");
      const requested = validateRequestedFiles(analysis.requestedFiles, attempt.allowedPaths);
      if (!analysis.actionable) return unresolved(analysis.summary);
      if (requested.outcome === "rejected") return unresolved(requested.explanation);
      if (requested.files.length === 0) {
        return unresolved("Failure analysis did not request any source files.");
      }

      let sourceResult: unknown;
      try {
        sourceResult = await dependencies.github.readTrackedTextFiles({
          repository: attempt.repository,
          revision: attempt.revision,
          paths: requested.files,
        });
      } catch {
        return unresolved("Requested tracked source files could not be read.");
      }
      if (
        typeof sourceResult !== "object" ||
        sourceResult === null ||
        Array.isArray(sourceResult)
      ) {
        return unresolved("Tracked source files did not match the validated model request.");
      }
      const sources = sourceResult as Readonly<Record<string, unknown>>;
      if (
        Object.keys(sources).some((path) => !requested.files.includes(path)) ||
        requested.files.some((path) => typeof sources[path] !== "string")
      ) {
        return unresolved("Tracked source files did not match the validated model request.");
      }
      const files = Object.fromEntries(
        requested.files.map((path) => [path, redactAndBoundSourceFile(sources[path] as string)]),
      );
      for (const change of attempt.baseline?.proposal.changes ?? []) {
        if (Object.hasOwn(files, change.path)) files[change.path] = change.content;
      }
      const failureIdentity = primaryFailureIdentity({
        revision: attempt.revision,
        workflow: attempt.workflow ?? "",
        jobId: attempt.primaryFailure.jobId,
        stepNumber: attempt.primaryFailure.stepNumber,
        evidence: attempt.primaryFailure.log,
      });
      const rejections: string[] = [];
      let proposalCount = 0;
      let inputTokens = tokenCount(analysis.usage, "inputTokens");
      let outputTokens = tokenCount(analysis.usage, "outputTokens");
      let proposal: RepairProposal | undefined;
      let changedFiles: readonly string[] = [];
      const audit = () => ({ proposalCount, rejections, inputTokens, outputTokens });

      while (proposalCount < 3) {
        await dependencies.persistence.transition({
          attemptId: attempt.attemptId,
          status: "proposing",
          at: at(),
        });
        let proposalResult: unknown;
        try {
          proposalResult = await provider.proposeRepair({
            evidence,
            files,
            previousRejections: rejections,
          });
        } catch (error) {
          return unresolved(
            providerFailureReason(error, "Repair Proposal generation could not be completed."),
            audit(),
          );
        }
        proposalCount += 1;
        const evaluation = evaluateProposal({
          proposal: proposalResult,
          existingTextFiles: files,
          allowedPaths: attempt.allowedPaths,
        });
        const proposalUsage =
          evaluation.outcome === "accepted" ? evaluation.proposal.usage : evaluation.usage;
        inputTokens += tokenCount(proposalUsage, "inputTokens");
        outputTokens += tokenCount(proposalUsage, "outputTokens");
        if (evaluation.outcome === "rejected") {
          rejections.push(evaluation.explanation);
          return unresolved(evaluation.explanation, audit());
        }
        proposal = evaluation.proposal;

        await dependencies.persistence.transition({
          attemptId: attempt.attemptId,
          status: "validating",
          at: at(),
        });
        let validationResult: unknown;
        try {
          validationResult = await dependencies.sandbox.validate({
            repository: attempt.repository,
            revision: attempt.revision,
            runtimeAlias: attempt.runtimeAlias,
            installCommand: attempt.installCommand,
            validationCommand: attempt.validationCommand,
            proposal,
            ...(attempt.baseline ? { baselineProposal: attempt.baseline.proposal } : {}),
          });
        } catch {
          return unresolved("Sandbox validation could not be completed.", audit());
        } finally {
          if (dependencies.sandbox.cleanup) {
            await dependencies.sandbox.cleanup({ attemptId: attempt.attemptId });
          }
        }
        const validation = parseValidation(validationResult);
        if (!validation) {
          return unresolved("Sandbox validation returned an invalid result.", audit());
        }
        if (validation.outcome === "passed") {
          const cumulativeProposal = mergeProposals(attempt.baseline?.proposal, proposal);
          changedFiles = cumulativeProposal.changes.map((change) => change.path);
          if (
            validation.changedFiles.length !== changedFiles.length ||
            validation.changedFiles.some((path) => !changedFiles.includes(path)) ||
            changedFiles.some((path) => !validation.changedFiles.includes(path))
          ) {
            return unresolved("Sandbox validation reported unexpected changed files.", audit());
          }
          break;
        }

        rejections.push(validation.summary);
        const classification = classifyValidation({
          primaryFailureIdentity: failureIdentity,
          proposalCount,
          validation,
        });
        const revealedFailureIdentity = validation.revealedFailure
          ? primaryFailureIdentity({
              revision: attempt.revision,
              workflow: attempt.workflow ?? "",
              jobId: validation.revealedFailure.jobId,
              stepNumber: validation.revealedFailure.stepNumber,
              evidence: validation.revealedFailure.log,
            })
          : undefined;
        if (
          classification.outcome === "unresolved" &&
          validation.observedFailureIdentity !== failureIdentity &&
          validation.observedFailureIdentity === revealedFailureIdentity &&
          validation.revealedFailure &&
          dependencies.persistence.offerContinuation
        ) {
          await dependencies.persistence.transition({
            attemptId: attempt.attemptId,
            status: "unresolved",
            at: at(),
          });
          const actionIdentifier = await dependencies.persistence.offerContinuation({
            attemptId: attempt.attemptId,
            at: at(),
            expiresAt: new Date(dependencies.clock.now().getTime() + 15 * 60_000).toISOString(),
            proposal: mergeProposals(attempt.baseline?.proposal, proposal),
            revealedFailure: validation.revealedFailure,
            cumulativeChangedFiles: [
              ...new Set([
                ...(attempt.baseline?.cumulativeChangedFiles ?? []),
                ...proposal.changes.map((change) => change.path),
              ]),
            ],
            cumulativeChangedLines:
              (attempt.baseline?.cumulativeChangedLines ?? 0) + evaluation.changedLines,
          });
          const cumulativeChangedFiles = new Set([
            ...(attempt.baseline?.cumulativeChangedFiles ?? []),
            ...proposal.changes.map((change) => change.path),
          ]);
          const cumulativeChangedLines =
            (attempt.baseline?.cumulativeChangedLines ?? 0) + evaluation.changedLines;
          const fileCount = cumulativeChangedFiles.size;
          await dependencies.github.completeCheck({
            repository: attempt.repository,
            revision: attempt.revision,
            conclusion: "neutral",
            title: "AgentCI stopped at a newly revealed Primary Failure",
            body: [
              "Unresolved Repair: Validation revealed a different Primary Failure; Continuation requires developer authorization.",
              `Cumulative change: ${fileCount} ${fileCount === 1 ? "file" : "files"}; ${cumulativeChangedLines} lines`,
              `Proposal count: ${proposalCount}`,
              `Rejected proposals: ${rejections.map((summary, index) => `${index + 1}. ${auditText(summary)}`).join("; ")}`,
              `Usage: Input tokens: ${inputTokens}; output tokens: ${outputTokens}`,
            ].join("\n"),
            actions: [
              {
                label: "Continue repair",
                description: "Accept proposal and investigate next.",
                identifier: actionIdentifier,
              },
            ],
          });
          return { outcome: "unresolved" };
        }
        if (classification.outcome === "unresolved") {
          return unresolved(classification.explanation, audit());
        }
      }
      if (!proposal || changedFiles.length === 0) {
        return unresolved("The Repair Attempt exhausted its three-proposal budget.", audit());
      }
      const report = [
        `Primary Failure: ${auditText(attempt.primaryFailure.jobName)} / ${auditText(attempt.primaryFailure.stepName)} (step ${attempt.primaryFailure.stepNumber})`,
        `Evidence: ${redactAndBoundSummary(evidence.log)}`,
        `Changed files: ${auditText(changedFiles.join(", "))}`,
        `Validation command: ${auditText(commandText(attempt.validationCommand))}`,
        `Provider/model: ${auditText(provider.provider)}/${auditText(provider.model)}`,
        `Proposal count: ${proposalCount}`,
        `Rejected proposals: ${rejections.length === 0 ? "none" : rejections.map((summary, index) => `${index + 1}. ${auditText(summary)}`).join("; ")}`,
        `Usage: Input tokens: ${inputTokens}; output tokens: ${outputTokens}`,
      ].join("\n");
      const headBranch = `agentci/repair-${attempt.runId}`;
      if (headBranch === attempt.defaultBranch) {
        return unresolved("The repair branch would overwrite the default branch.");
      }
      await dependencies.persistence.transition({
        attemptId: attempt.attemptId,
        status: "publishing",
        at: at(),
      });
      const guardedPublication = await dependencies.persistence.publishIfCurrent(
        { attemptId: attempt.attemptId, at: at() },
        () =>
          dependencies.github.ensureValidatedRepair({
            repository: attempt.repository,
            revision: attempt.revision,
            baseBranch: attempt.defaultBranch,
            headBranch,
            draft: true,
            changes: mergeProposals(attempt.baseline?.proposal, proposal).changes,
            title: `Validated Repair for workflow run ${attempt.runId}`,
            body: report,
          }),
      );
      if (guardedPublication.outcome === "stale") {
        await dependencies.github.completeCheck({
          repository: attempt.repository,
          revision: attempt.revision,
          conclusion: "neutral",
          title: "AgentCI stopped a Stale Repair",
          body: "Stale Repair: A newer eligible workflow run superseded this Repair Attempt.",
        });
        return { outcome: "stale" };
      }
      const publication = guardedPublication.value;
      await dependencies.persistence.transition({
        attemptId: attempt.attemptId,
        status: "validated",
        at: at(),
      });
      await dependencies.github.completeCheck({
        repository: attempt.repository,
        revision: attempt.revision,
        conclusion: "success",
        title: "AgentCI produced a Validated Repair",
        body: report,
      });
      return { outcome: "validated", pullRequestNumber: publication.number };
    },
  };
}
