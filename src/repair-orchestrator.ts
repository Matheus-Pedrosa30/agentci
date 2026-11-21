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
    signal?: AbortSignal;
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
    status: "proposing" | "validating" | "publishing" | "validated" | "unresolved";
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

function parseProposal(
  value: unknown,
  availableFiles: Readonly<Record<string, string>>,
): RepairProposal | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<RepairProposal>;
  if (
    typeof candidate.summary !== "string" ||
    candidate.summary.length === 0 ||
    candidate.summary.length > 1_000 ||
    !Array.isArray(candidate.changes) ||
    candidate.changes.length === 0 ||
    candidate.changes.length > 3 ||
    (candidate.usage !== undefined && !validUsage(candidate.usage))
  ) {
    return undefined;
  }
  const changes: RepairProposalChange[] = [];
  const seen = new Set<string>();
  let changedLines = 0;
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
      !Object.hasOwn(availableFiles, typed.path) ||
      seen.has(typed.path) ||
      containsUnsafeTextControl(typed.content) ||
      redactAndBoundSourceFile(typed.content) !== typed.content
    ) {
      return undefined;
    }
    changedLines += changedLineCount(availableFiles[typed.path] ?? "", typed.content, 200);
    if (changedLines > 200) return undefined;
    seen.add(typed.path);
    changes.push({ path: typed.path, content: typed.content });
  }
  return {
    summary: candidate.summary,
    changes,
    ...(candidate.usage ? { usage: { ...candidate.usage } } : {}),
  };
}

function parseValidation(
  value: unknown,
):
  | { outcome: "passed"; changedFiles: readonly string[] }
  | { outcome: "failed"; summary: string }
  | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as { outcome?: unknown; changedFiles?: unknown; summary?: unknown };
  if (
    candidate.outcome === "passed" &&
    Array.isArray(candidate.changedFiles) &&
    candidate.changedFiles.every((path) => typeof path === "string")
  ) {
    return { outcome: "passed", changedFiles: candidate.changedFiles };
  }
  if (candidate.outcome === "failed" && typeof candidate.summary === "string") {
    return { outcome: "failed", summary: candidate.summary };
  }
  return undefined;
}

function changedLineCount(before: string, after: string, limit: number): number {
  const left = before.split("\n");
  const right = after.split("\n");
  const furthest = new Map<number, number>([[1, 0]]);
  const maximum = Math.min(left.length + right.length, limit + 1);
  for (let distance = 0; distance <= maximum; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = furthest.get(diagonal + 1) ?? -1;
      const rightward = furthest.get(diagonal - 1) ?? -1;
      let x =
        diagonal === -distance || (diagonal !== distance && rightward < down)
          ? down
          : rightward + 1;
      if (x < 0) x = 0;
      let y = x - diagonal;
      while (x < left.length && y < right.length && left[x] === right[y]) {
        x += 1;
        y += 1;
      }
      furthest.set(diagonal, x);
      if (x >= left.length && y >= right.length) return distance;
    }
  }
  return limit + 1;
}

function containsUnsafeTextControl(source: string): boolean {
  for (const character of source) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
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
      if (dependencies.provider.alias !== attempt.modelAlias) {
        return unresolved("The configured model alias does not match the selected provider.");
      }
      const evidence = buildModelEvidence(attempt.primaryFailure, attempt.allowedPaths);
      let analysisResult: unknown;
      try {
        analysisResult = await dependencies.provider.analyzeFailure(evidence);
      } catch {
        return unresolved("Failure analysis could not be completed.");
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
      await dependencies.persistence.transition({
        attemptId: attempt.attemptId,
        status: "proposing",
        at: at(),
      });
      let proposalResult: unknown;
      try {
        proposalResult = await dependencies.provider.proposeRepair({ evidence, files });
      } catch {
        return unresolved("Repair Proposal generation could not be completed.");
      }
      const proposal = parseProposal(proposalResult, files);
      if (!proposal) return unresolved("The provider returned an invalid structured proposal.");

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
        });
      } catch {
        return unresolved("Sandbox validation could not be completed.");
      }
      const validation = parseValidation(validationResult);
      if (!validation) return unresolved("Sandbox validation returned an invalid result.");
      if (validation.outcome !== "passed") return unresolved(validation.summary);

      const changedFiles = proposal.changes.map((change) => change.path);
      if (
        validation.changedFiles.length !== changedFiles.length ||
        validation.changedFiles.some((path) => !changedFiles.includes(path)) ||
        changedFiles.some((path) => !validation.changedFiles.includes(path))
      ) {
        return unresolved("Sandbox validation reported unexpected changed files.");
      }
      const inputTokens =
        tokenCount(analysis.usage, "inputTokens") + tokenCount(proposal.usage, "inputTokens");
      const outputTokens =
        tokenCount(analysis.usage, "outputTokens") + tokenCount(proposal.usage, "outputTokens");
      const report = [
        `Primary Failure: ${auditText(attempt.primaryFailure.jobName)} / ${auditText(attempt.primaryFailure.stepName)} (step ${attempt.primaryFailure.stepNumber})`,
        `Evidence: ${redactAndBoundSummary(evidence.log)}`,
        `Changed files: ${auditText(changedFiles.join(", "))}`,
        `Validation command: ${auditText(commandText(attempt.validationCommand))}`,
        `Provider/model: ${auditText(dependencies.provider.provider)}/${auditText(dependencies.provider.model)}`,
        "Proposal count: 1",
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
      const publication = await dependencies.github.ensureValidatedRepair({
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
