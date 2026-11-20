import {
  buildModelEvidence,
  redactAndBoundSourceFile,
  redactAndBoundSummary,
  validateRequestedFiles,
  type ModelFailureEvidence,
  type PrimaryFailure,
} from "./failure-evidence.ts";

export interface RepairProposalChange {
  path: string;
  content: string;
}

export interface RepairProposal {
  summary: string;
  changes: readonly RepairProposalChange[];
  usage?: TokenUsage;
}

interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface RepairProvider {
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
  }): Promise<unknown>;
}

export interface SandboxRuntime {
  validate(input: {
    repository: string;
    revision: string;
    runtimeAlias: string;
    installCommand: readonly string[];
    validationCommand: readonly string[];
    proposal: RepairProposal;
  }): Promise<
    { outcome: "passed"; changedFiles: readonly string[] } | { outcome: "failed"; summary: string }
  >;
}

interface PublicationReport {
  repository: string;
  revision: string;
  title: string;
  body: string;
}

export interface GitHubPublication {
  readTrackedTextFiles(input: {
    repository: string;
    revision: string;
    paths: readonly string[];
  }): Promise<Readonly<Record<string, string>>>;
  publishValidatedRepair(
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
    status: "proposing" | "validating" | "validated" | "unresolved";
    at: string;
  }): Promise<void>;
}

export interface RepairClock {
  now(): Date;
}

export interface RepairAttemptInput {
  attemptId: string;
  runId: string;
  repository: string;
  revision: string;
  defaultBranch: string;
  modelAlias: string;
  runtimeAlias: string;
  allowedPaths: readonly string[];
  installCommand: readonly string[];
  validationCommand: readonly string[];
  primaryFailure: PrimaryFailure;
}

function validUsage(value: unknown): value is TokenUsage {
  if (typeof value !== "object" || value === null) return false;
  const usage = value as TokenUsage;
  return [usage.inputTokens, usage.outputTokens].every(
    (count) => count === undefined || (Number.isSafeInteger(count) && count >= 0),
  );
}

function parseProposal(
  value: unknown,
  availableFiles: ReadonlySet<string>,
): RepairProposal | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<RepairProposal>;
  if (
    typeof candidate.summary !== "string" ||
    !Array.isArray(candidate.changes) ||
    candidate.changes.length === 0 ||
    candidate.changes.length > 3 ||
    (candidate.usage !== undefined && !validUsage(candidate.usage))
  ) {
    return undefined;
  }
  const changes: RepairProposalChange[] = [];
  const seen = new Set<string>();
  for (const change of candidate.changes) {
    if (
      typeof change !== "object" ||
      change === null ||
      typeof (change as RepairProposalChange).path !== "string" ||
      typeof (change as RepairProposalChange).content !== "string"
    ) {
      return undefined;
    }
    const typed = change as RepairProposalChange;
    if (
      !availableFiles.has(typed.path) ||
      seen.has(typed.path) ||
      redactAndBoundSourceFile(typed.content) !== typed.content
    ) {
      return undefined;
    }
    seen.add(typed.path);
    changes.push({ path: typed.path, content: typed.content });
  }
  return {
    summary: candidate.summary,
    changes,
    ...(candidate.usage ? { usage: { ...candidate.usage } } : {}),
  };
}

function tokenCount(usage: TokenUsage | undefined, key: keyof TokenUsage): number {
  return usage?.[key] ?? 0;
}

function commandText(command: readonly string[]): string {
  return command.join(" ");
}

export function createRepairOrchestrator(dependencies: {
  github: GitHubPublication;
  provider: RepairProvider;
  sandbox: SandboxRuntime;
  persistence: RepairAttemptPersistence;
  clock: RepairClock;
}): {
  advance(
    attempt: RepairAttemptInput,
  ): Promise<{ outcome: "validated"; pullRequestNumber: number } | { outcome: "unresolved" }>;
} {
  const at = () => dependencies.clock.now().toISOString();
  return {
    async advance(attempt) {
      const unresolved = async (reason: string): Promise<{ outcome: "unresolved" }> => {
        await dependencies.persistence.transition({
          attemptId: attempt.attemptId,
          status: "unresolved",
          at: at(),
        });
        await dependencies.github.completeCheck({
          repository: attempt.repository,
          revision: attempt.revision,
          conclusion: "neutral",
          title: "AgentCI could not validate a Repair Proposal",
          body: `Unresolved Repair: ${redactAndBoundSummary(reason)}`,
        });
        return { outcome: "unresolved" };
      };
      const evidence = buildModelEvidence(attempt.primaryFailure, attempt.allowedPaths);
      const analysis = await dependencies.provider.analyzeFailure(evidence);
      const requested = validateRequestedFiles(analysis.requestedFiles, attempt.allowedPaths);
      if (!analysis.actionable || requested.outcome === "rejected")
        return { outcome: "unresolved" };

      const sources = await dependencies.github.readTrackedTextFiles({
        repository: attempt.repository,
        revision: attempt.revision,
        paths: requested.files,
      });
      if (
        Object.keys(sources).some((path) => !requested.files.includes(path)) ||
        requested.files.some((path) => typeof sources[path] !== "string")
      ) {
        return { outcome: "unresolved" };
      }
      const files = Object.fromEntries(
        requested.files.map((path) => [path, redactAndBoundSourceFile(sources[path] ?? "")]),
      );
      await dependencies.persistence.transition({
        attemptId: attempt.attemptId,
        status: "proposing",
        at: at(),
      });
      const proposal = parseProposal(
        await dependencies.provider.proposeRepair({ evidence, files }),
        new Set(requested.files),
      );
      if (!proposal) return unresolved("The provider returned an invalid structured proposal.");

      await dependencies.persistence.transition({
        attemptId: attempt.attemptId,
        status: "validating",
        at: at(),
      });
      const validation = await dependencies.sandbox.validate({
        repository: attempt.repository,
        revision: attempt.revision,
        runtimeAlias: attempt.runtimeAlias,
        installCommand: attempt.installCommand,
        validationCommand: attempt.validationCommand,
        proposal,
      });
      if (validation.outcome !== "passed") return unresolved(validation.summary);

      const changedFiles = [...validation.changedFiles];
      const inputTokens =
        tokenCount(analysis.usage, "inputTokens") + tokenCount(proposal.usage, "inputTokens");
      const outputTokens =
        tokenCount(analysis.usage, "outputTokens") + tokenCount(proposal.usage, "outputTokens");
      const report = [
        `Primary Failure: ${attempt.primaryFailure.jobName} / ${attempt.primaryFailure.stepName} (step ${attempt.primaryFailure.stepNumber})`,
        `Evidence: ${redactAndBoundSummary(evidence.log)}`,
        `Changed files: ${changedFiles.join(", ")}`,
        `Validation command: ${commandText(attempt.validationCommand)}`,
        `Provider/model: ${dependencies.provider.provider}/${dependencies.provider.model}`,
        "Proposal count: 1",
        `Usage: Input tokens: ${inputTokens}; output tokens: ${outputTokens}`,
      ].join("\n");
      const headBranch = `agentci/repair-${attempt.runId}`;
      if (headBranch === attempt.defaultBranch) {
        return unresolved("The repair branch would overwrite the default branch.");
      }
      const publication = await dependencies.github.publishValidatedRepair({
        repository: attempt.repository,
        revision: attempt.revision,
        baseBranch: attempt.defaultBranch,
        headBranch,
        draft: true,
        changes: proposal.changes,
        title: `Validated Repair for workflow run ${attempt.runId}`,
        body: report,
      });
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
