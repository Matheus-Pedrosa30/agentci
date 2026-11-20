import { expect, it } from "vitest";

import { createRepairOrchestrator } from "../src/repair-orchestrator.js";

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
          "src/math.ts": `${"// padding\n".repeat(5_000)}export const add = () => 1;\nAPI_TOKEN=source-secret`,
        };
      },
      async publishValidatedRepair(input) {
        calls.push({ kind: "publish", value: input });
        pullRequests.push(input);
        return { number: 41, url: "https://example.invalid/pull/41" };
      },
      async completeCheck(input) {
        checks.push(input);
      },
    },
    provider: {
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
      provider: "fake-provider",
      model: "fake-model",
    },
    sandbox: {
      async validate(input) {
        calls.push({ kind: "validate", value: input });
        return { outcome: "passed", changedFiles: ["src/math.ts"] };
      },
    },
    persistence: {
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
      validationCommand: ["npm", "test"],
      primaryFailure: {
        jobId: "17",
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
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
  expect(report).toContain("Primary Failure: test / Unit tests (step 2)");
  expect(report).toContain("src/math.ts");
  expect(report).toContain("npm test");
  expect(report).toContain("fake-provider/fake-model");
  expect(report).toContain("Proposal count: 1");
  expect(report).toContain("Input tokens: 200; output tokens: 50");
  expect(report).toContain("expected 3, received 1");
  expect(report).not.toMatch(/log-secret|source-secret|provider-secret|credentials|merge/u);
  expect(checks).toEqual([
    expect.objectContaining({
      repository: "owner/repository",
      revision: "abc123",
      conclusion: "success",
      title: "AgentCI produced a Validated Repair",
    }),
  ]);
});

it("rejects malformed structured proposal data before sandbox mutation or publication", async () => {
  const boundaryCalls: string[] = [];
  const transitions: unknown[] = [];
  const checks: unknown[] = [];
  const orchestrator = createRepairOrchestrator({
    github: {
      async readTrackedTextFiles() {
        return { "src/math.ts": "export const add = () => 1;\n" };
      },
      async publishValidatedRepair() {
        boundaryCalls.push("publish");
        return { number: 1, url: "https://example.invalid/pull/1" };
      },
      async completeCheck(input) {
        checks.push(input);
      },
    },
    provider: {
      provider: "fake-provider",
      model: "fake-model",
      async analyzeFailure() {
        return { actionable: true, summary: "bad addition", requestedFiles: ["src/math.ts"] };
      },
      async proposeRepair() {
        return { summary: "malformed", changes: [{ path: "../secret", content: "stolen" }] };
      },
    },
    sandbox: {
      async validate() {
        boundaryCalls.push("validate");
        return { outcome: "passed", changedFiles: [] };
      },
    },
    persistence: {
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
      async publishValidatedRepair() {
        boundaryCalls.push("publish");
        return { number: 1, url: "https://example.invalid/pull/1" };
      },
      async completeCheck(input) {
        checks.push(input);
      },
    },
    provider: {
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

it("refuses a proposal containing credential-like content before mutation or publication", async () => {
  const boundaryCalls: string[] = [];
  const orchestrator = createRepairOrchestrator({
    github: {
      async readTrackedTextFiles() {
        return { "src/math.ts": "export const add = () => 1;\n" };
      },
      async publishValidatedRepair() {
        boundaryCalls.push("publish");
        return { number: 1, url: "https://example.invalid/pull/1" };
      },
      async completeCheck() {},
    },
    provider: {
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
    persistence: { async transition() {} },
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
      async publishValidatedRepair() {
        published = true;
        return { number: 1, url: "https://example.invalid/pull/1" };
      },
      async completeCheck() {},
    },
    provider: {
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
    persistence: { async transition() {} },
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
