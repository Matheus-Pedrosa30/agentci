import { expect, it } from "vitest";

import { RepairProviderError, type RepairProviderErrorKind } from "../src/model-provider.js";
import { createRepairOrchestrator } from "../src/repair-orchestrator.js";
import { primaryFailureIdentity } from "../src/proposal-policy.js";

async function publishCurrent<T>(
  _input: { attemptId: string; at: string },
  publish: () => Promise<T>,
) {
  return { outcome: "published" as const, value: await publish() };
}

it("publishes one validated Repair Proposal as a Draft Repair PR through fake boundaries", async () => {
  const calls: { kind: string; value: unknown }[] = [];
  const transitions: unknown[] = [];
  const checks: unknown[] = [];
  const pullRequests: unknown[] = [];
  const orchestrator = createRepairOrchestrator({
    github: {
      async readTrackedTextFiles(input) {
        calls.push({ kind: "read", value: input });
        return {
          "src/math.ts": "export const add = () => 1;\nAPI_TOKEN=source-secret\n",
        };
      },
      async ensureValidatedRepair(input) {
        calls.push({ kind: "publish", value: input });
        pullRequests.push(input);
        return { number: 41, url: "https://example.invalid/pull/41" };
      },
      async completeCheck(input) {
        checks.push(input);
      },
    },
    provider: {
      alias: "repair",
      async analyzeFailure(input) {
        calls.push({ kind: "analyze", value: input });
        return {
          actionable: true,
          summary: "The addition returns a constant. Authorization: Bearer provider-secret",
          requestedFiles: ["src/math.ts"],
          usage: { inputTokens: 120, outputTokens: 20 },
        };
      },
      async proposeRepair(input) {
        calls.push({ kind: "propose", value: input });
        return {
          summary: "Use both operands.",
          changes: [
            {
              path: "src/math.ts",
              content: "export const add = (left: number, right: number) => left + right;\n",
            },
          ],
          usage: { inputTokens: 80, outputTokens: 30 },
        };
      },
      provider: "fake-provider TOKEN=provider-secret",
      model: "fake-model",
    },
    sandbox: {
      async validate(input) {
        calls.push({ kind: "validate", value: input });
        return { outcome: "passed", changedFiles: ["src/math.ts"] };
      },
    },
    persistence: {
      publishIfCurrent: publishCurrent,
      async transition(input) {
        transitions.push(input);
      },
    },
    clock: { now: () => new Date("2026-11-20T12:00:00.000Z") },
  });

  await expect(
    orchestrator.advance({
      attemptId: "attempt-7",
      runId: "9001",
      repository: "owner/repository",
      revision: "abc123",
      defaultBranch: "main",
      modelAlias: "repair",
      runtimeAlias: "node-24",
      allowedPaths: ["src/**"],
      installCommand: ["npm", "ci", "--ignore-scripts"],
      validationCommand: ["npm", "test", "API_TOKEN=command-secret"],
      primaryFailure: {
        jobId: "17",
        jobName: "test TOKEN=job-secret",
        stepNumber: 2,
        stepName: "Unit tests PASSWORD=step-secret",
        log: `expected 3, received 1\nAuthorization: Bearer log-secret\n${"x\n".repeat(250)}`,
      },
    }),
  ).resolves.toEqual({ outcome: "validated", pullRequestNumber: 41 });

  expect(calls.map((call) => call.kind)).toEqual([
    "analyze",
    "read",
    "propose",
    "validate",
    "publish",
  ]);
  expect(calls.find((call) => call.kind === "read")?.value).toEqual({
    repository: "owner/repository",
    revision: "abc123",
    paths: ["src/math.ts"],
  });
  const providerInput = JSON.stringify(calls.filter((call) => call.kind === "propose"));
  expect(providerInput).not.toMatch(/log-secret|source-secret|provider-secret/u);
  expect(providerInput).not.toContain("defaultBranch");
  expect(providerInput.length).toBeLessThan(40_000);
  expect(transitions).toEqual([
    { attemptId: "attempt-7", status: "proposing", at: "2026-11-20T12:00:00.000Z" },
    { attemptId: "attempt-7", status: "validating", at: "2026-11-20T12:00:00.000Z" },
    { attemptId: "attempt-7", status: "publishing", at: "2026-11-20T12:00:00.000Z" },
    { attemptId: "attempt-7", status: "validated", at: "2026-11-20T12:00:00.000Z" },
  ]);
  expect(pullRequests).toEqual([
    expect.objectContaining({
      repository: "owner/repository",
      revision: "abc123",
      baseBranch: "main",
      headBranch: "agentci/repair-9001",
      draft: true,
      changes: [
        {
          path: "src/math.ts",
          content: "export const add = (left: number, right: number) => left + right;\n",
        },
      ],
    }),
  ]);
  const report = JSON.stringify({ pullRequests, checks });
  expect(report).toContain(
    "Primary Failure: test TOKEN=[REDACTED] / Unit tests PASSWORD=[REDACTED] (step 2)",
  );
  expect(report).toContain("src/math.ts");
  expect(report).toContain("npm test API_TOKEN=[REDACTED]");
  expect(report).toContain("fake-provider TOKEN=[REDACTED]/fake-model");
  expect(report).toContain("Proposal count: 1");
  expect(report).toContain("Input tokens: 200; output tokens: 50");
  expect(report).toContain("expected 3, received 1");
  expect(report).not.toMatch(
    /log-secret|source-secret|provider-secret|command-secret|job-secret|step-secret|credentials|merge/u,
  );
  expect(checks).toEqual([
    expect.objectContaining({
      repository: "owner/repository",
      revision: "abc123",
      conclusion: "success",
      title: "AgentCI produced a Validated Repair",
    }),
  ]);
});

it.each([
  {
    name: "a traversal path",
    proposal: { summary: "malformed", changes: [{ path: "../secret", content: "stolen" }] },
  },
  {
    name: "more than 200 changed lines",
    proposal: {
      summary: "too large",
      changes: [{ path: "src/math.ts", content: "changed\n".repeat(201) }],
    },
  },
  {
    name: "non-text output",
    proposal: {
      summary: "binary-like",
      changes: [{ path: "src/math.ts", content: "export const value = '\u0000';\n" }],
    },
  },
])("rejects $name before sandbox mutation or publication", async ({ proposal }) => {
  const boundaryCalls: string[] = [];
  const transitions: unknown[] = [];
  const checks: unknown[] = [];
  const orchestrator = createRepairOrchestrator({
    github: {
      async readTrackedTextFiles() {
        return { "src/math.ts": "export const add = () => 1;\n" };
      },
      async ensureValidatedRepair() {
        boundaryCalls.push("publish");
        return { number: 1, url: "https://example.invalid/pull/1" };
      },
      async completeCheck(input) {
        checks.push(input);
      },
    },
    provider: {
      alias: "repair",
      provider: "fake-provider",
      model: "fake-model",
      async analyzeFailure() {
        return { actionable: true, summary: "bad addition", requestedFiles: ["src/math.ts"] };
      },
      async proposeRepair() {
        return proposal;
      },
    },
    sandbox: {
      async validate() {
        boundaryCalls.push("validate");
        return { outcome: "passed", changedFiles: [] };
      },
    },
    persistence: {
      publishIfCurrent: publishCurrent,
      async transition(input) {
        transitions.push(input);
      },
    },
    clock: { now: () => new Date("2026-11-20T12:00:00.000Z") },
  });

  await expect(
    orchestrator.advance({
      attemptId: "attempt-invalid",
      runId: "9002",
      repository: "owner/repository",
      revision: "def456",
      defaultBranch: "main",
      modelAlias: "repair",
      runtimeAlias: "node-24",
      allowedPaths: ["src/**"],
      installCommand: ["npm", "ci"],
      validationCommand: ["npm", "test"],
      primaryFailure: {
        jobId: "17",
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "expected 3, received 1",
      },
    }),
  ).resolves.toEqual({ outcome: "unresolved" });

  expect(boundaryCalls).toEqual([]);
  expect(transitions).toEqual([
    { attemptId: "attempt-invalid", status: "proposing", at: "2026-11-20T12:00:00.000Z" },
    { attemptId: "attempt-invalid", status: "unresolved", at: "2026-11-20T12:00:00.000Z" },
  ]);
  expect(checks).toEqual([
    expect.objectContaining({
      conclusion: "neutral",
      title: "AgentCI could not validate a Repair Proposal",
    }),
  ]);
});

it("does not publish when the fake sandbox rejects the Repair Proposal", async () => {
  const boundaryCalls: string[] = [];
  const transitions: unknown[] = [];
  const checks: unknown[] = [];
  const orchestrator = createRepairOrchestrator({
    github: {
      async readTrackedTextFiles() {
        return { "src/math.ts": "export const add = () => 1;\n" };
      },
      async ensureValidatedRepair() {
        boundaryCalls.push("publish");
        return { number: 1, url: "https://example.invalid/pull/1" };
      },
      async completeCheck(input) {
        checks.push(input);
      },
    },
    provider: {
      alias: "repair",
      provider: "fake-provider",
      model: "fake-model",
      async analyzeFailure() {
        return { actionable: true, summary: "bad addition", requestedFiles: ["src/math.ts"] };
      },
      async proposeRepair() {
        return {
          summary: "Use both operands.",
          changes: [
            {
              path: "src/math.ts",
              content: "export const add = (left: number, right: number) => left + right;\n",
            },
          ],
        };
      },
    },
    sandbox: {
      async validate() {
        boundaryCalls.push("validate");
        return { outcome: "failed", summary: "Unit test remains red. TOKEN=sandbox-secret" };
      },
    },
    persistence: {
      publishIfCurrent: publishCurrent,
      async transition(input) {
        transitions.push(input);
      },
    },
    clock: { now: () => new Date("2026-11-20T12:00:00.000Z") },
  });

  await expect(
    orchestrator.advance({
      attemptId: "attempt-failed-validation",
      runId: "9003",
      repository: "owner/repository",
      revision: "ghi789",
      defaultBranch: "main",
      modelAlias: "repair",
      runtimeAlias: "node-24",
      allowedPaths: ["src/**"],
      installCommand: ["npm", "ci"],
      validationCommand: ["npm", "test"],
      primaryFailure: {
        jobId: "17",
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "expected 3, received 1",
      },
    }),
  ).resolves.toEqual({ outcome: "unresolved" });

  expect(boundaryCalls).toEqual(["validate"]);
  expect(transitions.map((transition) => (transition as { status: string }).status)).toEqual([
    "proposing",
    "validating",
    "unresolved",
  ]);
  expect(JSON.stringify(checks)).toContain("Unit test remains red");
  expect(JSON.stringify(checks)).not.toContain("sandbox-secret");
});

it.each([
  {
    name: "non-actionable analysis",
    analysis: { actionable: false, summary: "not actionable", requestedFiles: [] },
  },
  {
    name: "an out-of-allowlist file request",
    analysis: { actionable: true, summary: "unsafe request", requestedFiles: ["private/key"] },
  },
  {
    name: "malformed analysis",
    analysis: { actionable: true, summary: "malformed", requestedFiles: undefined },
  },
])("durably completes the Check for $name", async ({ analysis }) => {
  const transitions: unknown[] = [];
  const checks: unknown[] = [];
  const orchestrator = createRepairOrchestrator({
    github: {
      async readTrackedTextFiles() {
        throw new Error("source files must not be read");
      },
      async ensureValidatedRepair() {
        throw new Error("a Repair PR must not be published");
      },
      async completeCheck(input) {
        checks.push(input);
      },
    },
    provider: {
      alias: "repair",
      provider: "fake-provider",
      model: "fake-model",
      async analyzeFailure() {
        return analysis as never;
      },
      async proposeRepair() {
        throw new Error("a Repair Proposal must not be requested");
      },
    },
    sandbox: {
      async validate() {
        throw new Error("the sandbox must not run");
      },
    },
    persistence: {
      publishIfCurrent: publishCurrent,
      async transition(input) {
        transitions.push(input);
      },
    },
    clock: { now: () => new Date("2026-11-20T12:00:00.000Z") },
  });

  await expect(
    orchestrator.advance({
      attemptId: "attempt-analysis",
      runId: "9006",
      repository: "owner/repository",
      revision: "analysis123",
      defaultBranch: "main",
      modelAlias: "repair",
      runtimeAlias: "node-24",
      allowedPaths: ["src/**"],
      installCommand: ["npm", "ci"],
      validationCommand: ["npm", "test"],
      primaryFailure: {
        jobId: "17",
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "expected 3, received 1",
      },
    }),
  ).resolves.toEqual({ outcome: "unresolved" });

  expect(transitions).toEqual([
    { attemptId: "attempt-analysis", status: "unresolved", at: "2026-11-20T12:00:00.000Z" },
  ]);
  expect(checks).toEqual([expect.objectContaining({ conclusion: "neutral" })]);
});

it("rejects a passing sandbox result that reports different changed files", async () => {
  const events: string[] = [];
  const statuses: string[] = [];
  const orchestrator = createRepairOrchestrator({
    github: {
      async readTrackedTextFiles() {
        return { "src/math.ts": "export const value = 1;\n" };
      },
      async ensureValidatedRepair() {
        events.push("publish");
        return { number: 1, url: "https://example.invalid/pull/1" };
      },
      async completeCheck() {
        events.push("check");
      },
    },
    provider: {
      alias: "repair",
      provider: "fake-provider",
      model: "fake-model",
      async analyzeFailure() {
        return { actionable: true, summary: "bad value", requestedFiles: ["src/math.ts"] };
      },
      async proposeRepair() {
        return {
          summary: "change value",
          changes: [{ path: "src/math.ts", content: "export const value = 2;\n" }],
        };
      },
    },
    sandbox: {
      async validate() {
        return { outcome: "passed", changedFiles: ["src/unrelated.ts"] } as const;
      },
    },
    persistence: {
      publishIfCurrent: publishCurrent,
      async transition(input) {
        statuses.push(input.status);
      },
    },
    clock: { now: () => new Date("2026-11-20T12:00:00.000Z") },
  });

  await expect(
    orchestrator.advance({
      attemptId: "attempt-mismatch",
      runId: "9007",
      repository: "owner/repository",
      revision: "mismatch123",
      defaultBranch: "main",
      modelAlias: "repair",
      runtimeAlias: "node-24",
      allowedPaths: ["src/**"],
      installCommand: ["npm", "ci"],
      validationCommand: ["npm", "test"],
      primaryFailure: {
        jobId: "17",
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "expected 2, received 1",
      },
    }),
  ).resolves.toEqual({ outcome: "unresolved" });

  expect(events).toEqual(["check"]);
  expect(statuses).toEqual(["proposing", "validating", "unresolved"]);
});

it("refuses a proposal containing credential-like content before mutation or publication", async () => {
  const boundaryCalls: string[] = [];
  const orchestrator = createRepairOrchestrator({
    github: {
      async readTrackedTextFiles() {
        return { "src/math.ts": "export const add = () => 1;\n" };
      },
      async ensureValidatedRepair() {
        boundaryCalls.push("publish");
        return { number: 1, url: "https://example.invalid/pull/1" };
      },
      async completeCheck() {},
    },
    provider: {
      alias: "repair",
      provider: "fake-provider",
      model: "fake-model",
      async analyzeFailure() {
        return { actionable: true, summary: "bad addition", requestedFiles: ["src/math.ts"] };
      },
      async proposeRepair() {
        return {
          summary: "unsafe proposal",
          changes: [{ path: "src/math.ts", content: "API_TOKEN=repair-secret\n" }],
        };
      },
    },
    sandbox: {
      async validate() {
        boundaryCalls.push("validate");
        return { outcome: "passed", changedFiles: ["src/math.ts"] };
      },
    },
    persistence: { async transition() {}, publishIfCurrent: publishCurrent },
    clock: { now: () => new Date("2026-11-20T12:00:00.000Z") },
  });

  await expect(
    orchestrator.advance({
      attemptId: "attempt-credential",
      runId: "9004",
      repository: "owner/repository",
      revision: "jkl012",
      defaultBranch: "main",
      modelAlias: "repair",
      runtimeAlias: "node-24",
      allowedPaths: ["src/**"],
      installCommand: ["npm", "ci"],
      validationCommand: ["npm", "test"],
      primaryFailure: {
        jobId: "17",
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "expected 3, received 1",
      },
    }),
  ).resolves.toEqual({ outcome: "unresolved" });
  expect(boundaryCalls).toEqual([]);
});

it("never publishes a repair branch over the default branch", async () => {
  let published = false;
  const orchestrator = createRepairOrchestrator({
    github: {
      async readTrackedTextFiles() {
        return { "src/math.ts": "export const add = () => 1;\n" };
      },
      async ensureValidatedRepair() {
        published = true;
        return { number: 1, url: "https://example.invalid/pull/1" };
      },
      async completeCheck() {},
    },
    provider: {
      alias: "repair",
      provider: "fake-provider",
      model: "fake-model",
      async analyzeFailure() {
        return { actionable: true, summary: "bad addition", requestedFiles: ["src/math.ts"] };
      },
      async proposeRepair() {
        return {
          summary: "repair",
          changes: [{ path: "src/math.ts", content: "export const add = () => 2;\n" }],
        };
      },
    },
    sandbox: {
      async validate() {
        return { outcome: "passed", changedFiles: ["src/math.ts"] };
      },
    },
    persistence: { async transition() {}, publishIfCurrent: publishCurrent },
    clock: { now: () => new Date("2026-11-20T12:00:00.000Z") },
  });

  await expect(
    orchestrator.advance({
      attemptId: "attempt-default-branch",
      runId: "9005",
      repository: "owner/repository",
      revision: "mno345",
      defaultBranch: "agentci/repair-9005",
      modelAlias: "repair",
      runtimeAlias: "node-24",
      allowedPaths: ["src/**"],
      installCommand: ["npm", "ci"],
      validationCommand: ["npm", "test"],
      primaryFailure: {
        jobId: "17",
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "expected 3, received 1",
      },
    }),
  ).resolves.toEqual({ outcome: "unresolved" });
  expect(published).toBe(false);
});

it("tries at most three proposals for the same Primary Failure and reports bounded rejections and usage", async () => {
  const events: string[] = [];
  const checks: { body: string }[] = [];
  const identity = primaryFailureIdentity({
    revision: "budget123",
    workflow: "",
    jobId: "17",
    stepNumber: 2,
    evidence: "expected 2, received 1",
  });
  let proposalNumber = 0;
  const orchestrator = createRepairOrchestrator({
    github: {
      async readTrackedTextFiles() {
        return { "src/math.ts": "export const value = 1;\n" };
      },
      async ensureValidatedRepair() {
        events.push("publish");
        return { number: 1, url: "https://example.invalid/pull/1" };
      },
      async completeCheck(input) {
        checks.push(input);
      },
    },
    provider: {
      alias: "repair",
      provider: "fake-provider",
      model: "fake-model",
      async analyzeFailure() {
        return {
          actionable: true,
          summary: "bad value",
          requestedFiles: ["src/math.ts"],
          usage: { inputTokens: 10, outputTokens: 1 },
        };
      },
      async proposeRepair() {
        proposalNumber += 1;
        events.push(`propose-${proposalNumber}`);
        return {
          summary: `raw model response ${proposalNumber} TOKEN=must-not-persist`,
          changes: [
            { path: "src/math.ts", content: `export const value = ${proposalNumber + 1};\n` },
          ],
          usage: { inputTokens: 20, outputTokens: 2 },
        };
      },
    },
    sandbox: {
      async validate() {
        events.push(`validate-${proposalNumber}`);
        return {
          outcome: "failed",
          observedFailureIdentity: identity,
          summary: `attempt ${proposalNumber} remains red TOKEN=sandbox-secret`,
        } as const;
      },
    },
    persistence: { async transition() {}, publishIfCurrent: publishCurrent },
    clock: { now: () => new Date("2026-11-20T12:00:00.000Z") },
  });

  await expect(
    orchestrator.advance({
      attemptId: "attempt-budget",
      runId: "9010",
      repository: "owner/repository",
      revision: "budget123",
      defaultBranch: "main",
      modelAlias: "repair",
      runtimeAlias: "node-24",
      allowedPaths: ["src/**"],
      installCommand: ["npm", "ci"],
      validationCommand: ["npm", "test"],
      primaryFailure: {
        jobId: "17",
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "expected 2, received 1",
      },
    }),
  ).resolves.toEqual({ outcome: "unresolved" });

  expect(events).toEqual([
    "propose-1",
    "validate-1",
    "propose-2",
    "validate-2",
    "propose-3",
    "validate-3",
  ]);
  expect(checks[0]?.body).toContain("Proposal count: 3");
  expect(checks[0]?.body).toContain("Rejected proposals: 1. attempt 1 remains red");
  expect(checks[0]?.body).toContain("Input tokens: 70; output tokens: 7");
  expect(JSON.stringify(checks)).not.toMatch(/must-not-persist|sandbox-secret/u);
});

it("stops after one proposal when validation reveals a different Primary Failure", async () => {
  let proposals = 0;
  let validations = 0;
  const different = primaryFailureIdentity({
    revision: "chain123",
    workflow: "",
    jobId: "17",
    stepNumber: 5,
    evidence: "a later step failed",
  });
  const orchestrator = createRepairOrchestrator({
    github: {
      async readTrackedTextFiles() {
        return { "src/math.ts": "export const value = 1;\n" };
      },
      async ensureValidatedRepair() {
        throw new Error("must not publish");
      },
      async completeCheck() {},
    },
    provider: {
      alias: "repair",
      provider: "fake-provider",
      model: "fake-model",
      async analyzeFailure() {
        return { actionable: true, summary: "bad value", requestedFiles: ["src/math.ts"] };
      },
      async proposeRepair() {
        proposals += 1;
        return {
          summary: "change value",
          changes: [{ path: "src/math.ts", content: "export const value = 2;\n" }],
        };
      },
    },
    sandbox: {
      async validate() {
        validations += 1;
        return {
          outcome: "failed",
          observedFailureIdentity: different,
          summary: "a later step failed",
        } as const;
      },
    },
    persistence: { async transition() {}, publishIfCurrent: publishCurrent },
    clock: { now: () => new Date("2026-11-20T12:00:00.000Z") },
  });

  await orchestrator.advance({
    attemptId: "attempt-chain",
    runId: "9011",
    repository: "owner/repository",
    revision: "chain123",
    defaultBranch: "main",
    modelAlias: "repair",
    runtimeAlias: "node-24",
    allowedPaths: ["src/**"],
    installCommand: ["npm", "ci"],
    validationCommand: ["npm", "test"],
    primaryFailure: {
      jobId: "17",
      jobName: "test",
      stepNumber: 2,
      stepName: "Unit tests",
      log: "expected 2, received 1",
    },
  });

  expect({ proposals, validations }).toEqual({ proposals: 1, validations: 1 });
});

it("cleans up bounded retries and cannot publish after the attempt becomes stale", async () => {
  const events: string[] = [];
  const identity = primaryFailureIdentity({
    revision: "stale123",
    workflow: "",
    jobId: "17",
    stepNumber: 2,
    evidence: "expected 2, received 1",
  });
  let proposalNumber = 0;
  const orchestrator = createRepairOrchestrator({
    github: {
      async readTrackedTextFiles() {
        return { "src/math.ts": "export const value = 1;\n" };
      },
      async ensureValidatedRepair() {
        events.push("publish");
        return { number: 1, url: "https://example.invalid/pull/1" };
      },
      async completeCheck(input) {
        events.push(`check:${input.title}`);
      },
    },
    provider: {
      alias: "repair",
      provider: "fake-provider",
      model: "fake-model",
      async analyzeFailure() {
        return { actionable: true, summary: "bad value", requestedFiles: ["src/math.ts"] };
      },
      async proposeRepair() {
        proposalNumber += 1;
        events.push(`propose-${proposalNumber}`);
        return {
          summary: "change value",
          changes: [
            { path: "src/math.ts", content: `export const value = ${proposalNumber + 1};\n` },
          ],
        };
      },
    },
    sandbox: {
      async validate() {
        events.push(`validate-${proposalNumber}`);
        return proposalNumber === 1
          ? ({
              outcome: "failed",
              summary: "still red",
              observedFailureIdentity: identity,
            } as const)
          : ({ outcome: "passed", changedFiles: ["src/math.ts"] } as const);
      },
      async cleanup() {
        events.push(`cleanup-${proposalNumber}`);
      },
    },
    persistence: {
      async transition() {},
      async publishIfCurrent() {
        events.push("guard:stale");
        return { outcome: "stale" } as const;
      },
    },
    clock: { now: () => new Date("2026-11-20T12:00:00.000Z") },
  });

  await expect(
    orchestrator.advance({
      attemptId: "attempt-stale",
      runId: "9012",
      repository: "owner/repository",
      revision: "stale123",
      defaultBranch: "main",
      modelAlias: "repair",
      runtimeAlias: "node-24",
      allowedPaths: ["src/**"],
      installCommand: ["npm", "ci"],
      validationCommand: ["npm", "test"],
      primaryFailure: {
        jobId: "17",
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "expected 2, received 1",
      },
    }),
  ).resolves.toEqual({ outcome: "stale" });

  expect(events).toEqual([
    "propose-1",
    "validate-1",
    "cleanup-1",
    "propose-2",
    "validate-2",
    "cleanup-2",
    "guard:stale",
    "check:AgentCI stopped a Stale Repair",
  ]);
});

it.each([
  ["provider_error", "The model provider request failed."],
  ["quota_exceeded", "The model provider quota was exceeded."],
  ["invalid_structured_output", "The model provider returned invalid structured output."],
  ["missing_usage", "The model provider response omitted required usage data."],
] as const)("terminates explicitly for %s without provider fallback", async (kind, reason) => {
  const checks: Array<{ body: string }> = [];
  let calls = 0;
  const orchestrator = createRepairOrchestrator({
    github: {
      async readTrackedTextFiles() {
        throw new Error("source files must not be read");
      },
      async ensureValidatedRepair() {
        throw new Error("a Repair PR must not be published");
      },
      async completeCheck(input) {
        checks.push(input);
      },
    },
    models: {
      createRepairProvider(alias) {
        expect(alias).toBe("repair");
        return {
          alias,
          provider: "mock-provider",
          model: "mock-model",
          async analyzeFailure() {
            calls += 1;
            throw new RepairProviderError(kind as RepairProviderErrorKind);
          },
          async proposeRepair() {
            throw new Error("a Repair Proposal must not be requested");
          },
        };
      },
    },
    sandbox: {
      async validate() {
        throw new Error("the sandbox must not run");
      },
    },
    persistence: { async transition() {}, publishIfCurrent: publishCurrent },
    clock: { now: () => new Date("2026-11-20T12:00:00.000Z") },
  });

  await expect(
    orchestrator.advance({
      attemptId: `attempt-${kind}`,
      runId: "9013",
      repository: "owner/repository",
      revision: "provider123",
      defaultBranch: "main",
      modelAlias: "repair",
      runtimeAlias: "node-24",
      allowedPaths: ["src/**"],
      installCommand: ["npm", "ci"],
      validationCommand: ["npm", "test"],
      primaryFailure: {
        jobId: "17",
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "expected 2, received 1",
      },
    }),
  ).resolves.toEqual({ outcome: "unresolved" });

  expect(calls).toBe(1);
  expect(checks[0]?.body).toContain(reason);
});

it("selects the Repository Contract model alias independently for each attempt", async () => {
  const selectedAliases: string[] = [];
  const orchestrator = createRepairOrchestrator({
    github: {
      async readTrackedTextFiles() {
        throw new Error("source files must not be read");
      },
      async ensureValidatedRepair() {
        throw new Error("a Repair PR must not be published");
      },
      async completeCheck() {},
    },
    models: {
      createRepairProvider(alias) {
        selectedAliases.push(alias);
        return {
          alias,
          provider: `provider-${alias}`,
          model: `model-${alias}`,
          async analyzeFailure() {
            return { actionable: false, summary: "not actionable", requestedFiles: [] };
          },
          async proposeRepair() {
            throw new Error("a Repair Proposal must not be requested");
          },
        };
      },
    },
    sandbox: {
      async validate() {
        throw new Error("the sandbox must not run");
      },
    },
    persistence: { async transition() {}, publishIfCurrent: publishCurrent },
    clock: { now: () => new Date("2026-11-20T12:00:00.000Z") },
  });
  const attempt = {
    runId: "9014",
    repository: "owner/repository",
    revision: "aliases123",
    defaultBranch: "main",
    runtimeAlias: "node-24",
    allowedPaths: ["src/**"],
    installCommand: ["npm", "ci"],
    validationCommand: ["npm", "test"],
    primaryFailure: {
      jobId: "17",
      jobName: "test",
      stepNumber: 2,
      stepName: "Unit tests",
      log: "expected 2, received 1",
    },
  };

  await expect(
    orchestrator.advance({ ...attempt, attemptId: "attempt-fast", modelAlias: "fast" }),
  ).resolves.toEqual({ outcome: "unresolved" });
  await expect(
    orchestrator.advance({ ...attempt, attemptId: "attempt-deep", modelAlias: "deep" }),
  ).resolves.toEqual({ outcome: "unresolved" });

  expect(selectedAliases).toEqual(["fast", "deep"]);
});
