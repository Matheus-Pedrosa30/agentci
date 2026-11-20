import { createHash } from "node:crypto";

import { redactAndBoundSourceFile } from "./failure-evidence.ts";

export interface ProposalChange {
  path: string;
  content: string;
}

export interface PolicyProposal {
  summary: string;
  changes: readonly ProposalChange[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ProposalUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type ProposalEvaluation =
  | { outcome: "accepted"; proposal: PolicyProposal; changedLines: number }
  | { outcome: "rejected"; explanation: string; usage?: ProposalUsage };

export type ValidationObservation =
  | { outcome: "passed" }
  | {
      outcome: "failed";
      observedFailureIdentity?: string;
      summary: string;
    };

export type ValidationClassification =
  { outcome: "validated" } | { outcome: "retry" } | { outcome: "unresolved"; explanation: string };

export function primaryFailureIdentity(input: {
  revision: string;
  workflow: string;
  jobId: string;
  stepNumber: number;
  evidence: string;
}): string {
  const stableFields = JSON.stringify([
    input.revision.normalize("NFC"),
    input.workflow.normalize("NFC"),
    input.jobId.normalize("NFC"),
    input.stepNumber,
    input.evidence.normalize("NFC").replace(/\r\n?/gu, "\n").trim(),
  ]);
  return createHash("sha256").update(stableFields).digest("hex");
}

export function classifyValidation(input: {
  primaryFailureIdentity: string;
  proposalCount: number;
  validation: ValidationObservation;
}): ValidationClassification {
  if (input.validation.outcome === "passed") return { outcome: "validated" };
  if (input.validation.observedFailureIdentity !== input.primaryFailureIdentity) {
    return {
      outcome: "unresolved",
      explanation:
        "Validation revealed a different Primary Failure; Continuation requires developer authorization.",
    };
  }
  if (input.proposalCount >= 3) {
    return {
      outcome: "unresolved",
      explanation: "The Repair Attempt exhausted its three-proposal budget.",
    };
  }
  return { outcome: "retry" };
}

function reject(explanation: string, usage?: ProposalUsage): ProposalEvaluation {
  return { outcome: "rejected", explanation, ...(usage ? { usage } : {}) };
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path === path.normalize("NFC") &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes(":") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function matchesPattern(path: string, pattern: string): boolean {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else {
      source += character?.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") ?? "";
    }
  }
  return new RegExp(`${source}$`, "u").test(path);
}

const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "package-lock.json",
  "packages.lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pubspec.lock",
  "uv.lock",
  "yarn.lock",
]);

function protectedPath(path: string): boolean {
  const folded = path.toLocaleLowerCase("en-US");
  const base = folded.split("/").at(-1) ?? "";
  return (
    folded.startsWith(".github/workflows/") ||
    folded === ".agentci.json" ||
    LOCKFILE_NAMES.has(base)
  );
}

function unsafeText(source: string): boolean {
  for (const character of source) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

function validUsage(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  if (Object.keys(usage).some((key) => key !== "inputTokens" && key !== "outputTokens")) {
    return false;
  }
  return [usage.inputTokens, usage.outputTokens].every(
    (count) => count === undefined || (Number.isSafeInteger(count) && Number(count) >= 0),
  );
}

function normalizedUsage(value: unknown): ProposalUsage | undefined {
  if (!validUsage(value) || value === undefined) return undefined;
  const usage = value as ProposalUsage;
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  };
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

export function evaluateProposal(input: {
  proposal: unknown;
  existingTextFiles: Readonly<Record<string, string>>;
  allowedPaths: readonly string[];
}): ProposalEvaluation {
  if (
    typeof input.proposal !== "object" ||
    input.proposal === null ||
    Array.isArray(input.proposal)
  ) {
    return reject("The provider returned an invalid structured proposal.");
  }
  const candidate = input.proposal as Record<string, unknown>;
  const usage = normalizedUsage(candidate.usage);
  if (
    Object.keys(candidate).some(
      (key) => key !== "summary" && key !== "changes" && key !== "usage",
    ) ||
    typeof candidate.summary !== "string" ||
    candidate.summary.length === 0 ||
    candidate.summary.length > 1_000 ||
    !Array.isArray(candidate.changes) ||
    candidate.changes.length === 0 ||
    candidate.changes.length > 3 ||
    !validUsage(candidate.usage)
  ) {
    return reject("The provider returned an invalid structured proposal.", usage);
  }
  const changes: ProposalChange[] = [];
  const seen = new Set<string>();
  let changedLines = 0;
  for (const value of candidate.changes) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return reject("The Repair Proposal contains an invalid change.", usage);
    }
    const change = value as Record<string, unknown>;
    if (
      Object.keys(change).some((key) => key !== "path" && key !== "content") ||
      typeof change.path !== "string" ||
      typeof change.content !== "string"
    ) {
      return reject("The Repair Proposal requests an unsupported patch operation.", usage);
    }
    const path = change.path;
    if (!safeRelativePath(path)) {
      return reject("The Repair Proposal contains an unsafe path.", usage);
    }
    if (protectedPath(path)) {
      return reject("The Repair Proposal targets a protected path.", usage);
    }
    if (!input.allowedPaths.some((pattern) => matchesPattern(path, pattern))) {
      return reject("The Repair Proposal targets a path outside allowed paths.", usage);
    }
    if (!Object.hasOwn(input.existingTextFiles, path)) {
      return reject("The Repair Proposal attempts to create a file.", usage);
    }
    if (seen.has(path)) {
      return reject("The Repair Proposal changes a file more than once.", usage);
    }
    if (unsafeText(change.content)) {
      return reject("The Repair Proposal contains binary data.", usage);
    }
    if (redactAndBoundSourceFile(change.content) !== change.content) {
      return reject("The Repair Proposal contains unsafe or overlong text.", usage);
    }
    changedLines += changedLineCount(input.existingTextFiles[path] ?? "", change.content, 200);
    if (changedLines > 200) {
      return reject("The Repair Proposal changes more than 200 lines.", usage);
    }
    seen.add(path);
    changes.push({ path, content: change.content });
  }
  const proposal: PolicyProposal = {
    summary: candidate.summary,
    changes,
    ...(usage ? { usage } : {}),
  };
  return {
    outcome: "accepted",
    proposal,
    changedLines,
  };
}
