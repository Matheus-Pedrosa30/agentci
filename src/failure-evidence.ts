export interface FailedStepEvidence {
  number: number;
  name: string;
  conclusion: string | null;
}

export interface ConfiguredJobEvidence {
  id: string;
  name: string;
  conclusion: string | null;
  steps: readonly FailedStepEvidence[];
  log: string;
}

export interface PrimaryFailure {
  jobId: string;
  jobName: string;
  stepNumber: number;
  stepName: string;
  log: string;
}

export interface ModelFailureEvidence {
  jobName: string;
  stepNumber: number;
  stepName: string;
  log: string;
  allowedPaths: readonly string[];
}

const MAX_LOG_LINES = 200;
const MAX_LOG_BYTES = 32_768;

function stripAnsi(source: string): string {
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 27 && source[index + 1] === "[") {
      index += 2;
      while (index < source.length && /[\d;]/u.test(source[index] ?? "")) index += 1;
      if (source[index] === "m") continue;
      result += source[index] ?? "";
      continue;
    }
    result += source[index] ?? "";
  }
  return result;
}

function containsUnsafeControlCharacter(source: string): boolean {
  for (const character of source) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

function isSafeRelativePath(path: string, allowGlobs: boolean): boolean {
  return (
    path.length > 0 &&
    path === path.normalize("NFC") &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes(":") &&
    !containsUnsafeControlCharacter(path) &&
    (allowGlobs ||
      (!path.includes("*") && !path.includes("?") && !path.includes("[") && !path.includes("]"))) &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function redact(source: string): string {
  return stripAnsi(source)
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/giu, "$1[REDACTED]")
    .replace(/\b(?:github_pat_[A-Za-z\d_]+|gh[pousr]_[A-Za-z\d]+)\b/gu, "[REDACTED]")
    .replace(
      /\b([A-Z\d_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z\d_]*\s*=\s*)[^\s]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gu,
      "[REDACTED PRIVATE KEY]",
    );
}

export function redactAndBoundSummary(source: string): string {
  let summary = redact(source).replace(/\s+/gu, " ").trim();
  if (summary.length > 1_000) summary = `${summary.slice(0, 997)}...`;
  return summary || "Failure analysis did not provide a safe explanation.";
}

export function buildModelEvidence(
  failure: PrimaryFailure,
  allowedPaths: readonly string[] = [],
): ModelFailureEvidence {
  let log = redact(failure.log).split(/\r?\n/u).slice(0, MAX_LOG_LINES).join("\n");
  if (Buffer.byteLength(log, "utf8") > MAX_LOG_BYTES) {
    log = Buffer.from(log, "utf8").subarray(0, MAX_LOG_BYTES).toString("utf8");
    while (Buffer.byteLength(log, "utf8") > MAX_LOG_BYTES) log = log.slice(0, -1);
  }
  return {
    jobName: failure.jobName,
    stepNumber: failure.stepNumber,
    stepName: failure.stepName,
    log,
    allowedPaths,
  };
}

export type RequestedFilesValidation =
  { outcome: "accepted"; files: string[] } | { outcome: "rejected"; explanation: string };

export function validateAllowedFilePatterns(patterns: readonly string[]):
  | { outcome: "accepted"; patterns: readonly string[] }
  | {
      outcome: "rejected";
      explanation: string;
    } {
  if (patterns.length === 0 || patterns.some((pattern) => !isSafeRelativePath(pattern, true))) {
    return {
      outcome: "rejected",
      explanation: "Repository Contract contains an unsafe allowed path pattern.",
    };
  }
  return { outcome: "accepted", patterns };
}

function allowedPath(path: string, patterns: readonly string[]): boolean {
  if (!isSafeRelativePath(path, false)) return false;
  return patterns.some((pattern) => {
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
  });
}

export function validateRequestedFiles(
  requested: readonly string[],
  allowedPatterns: readonly string[],
): RequestedFilesValidation {
  const files = [...new Set(requested)];
  if (files.length > 5) {
    return { outcome: "rejected", explanation: "Failure analysis requested more than five files." };
  }
  if (!files.every((path) => allowedPath(path, allowedPatterns))) {
    return {
      outcome: "rejected",
      explanation: "Failure analysis requested a file outside allowed paths.",
    };
  }
  return { outcome: "accepted", files };
}

export type PrimaryFailureIdentification =
  | { outcome: "identified"; failure: PrimaryFailure }
  | { outcome: "unresolved"; explanation: string };

export function identifyPrimaryFailure(
  jobs: readonly ConfiguredJobEvidence[],
): PrimaryFailureIdentification {
  if (jobs.length > 1) {
    return {
      outcome: "unresolved",
      explanation: "Multiple configured jobs failed; AgentCI cannot select one safely.",
    };
  }
  const job = jobs[0];
  const step = job?.steps
    .filter(
      (candidate) =>
        candidate.conclusion === "failure" &&
        Number.isSafeInteger(candidate.number) &&
        candidate.number > 0,
    )
    .toSorted((left, right) => left.number - right.number)[0];
  if (!job || !step) {
    return { outcome: "unresolved", explanation: "No failed step could be identified safely." };
  }
  const textualLog = stripAnsi(job.log);
  if (textualLog.trim().length === 0 || containsUnsafeControlCharacter(textualLog)) {
    return {
      outcome: "unresolved",
      explanation: "The failed step has no safe textual evidence to analyze.",
    };
  }
  return {
    outcome: "identified",
    failure: {
      jobId: job.id,
      jobName: job.name,
      stepNumber: step.number,
      stepName: step.name,
      log: job.log,
    },
  };
}
