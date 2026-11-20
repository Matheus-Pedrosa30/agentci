import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import { createDeterministicFailureAnalyzer } from "../src/failure-analyzer.js";
import { createWebhookIntake } from "../src/intake.js";

const payload = readFileSync(new URL("./fixtures/workflow-run-failed.json", import.meta.url));
const contract = JSON.stringify({
  version: 1,
  workflow: "CI",
  job: "test",
  branches: ["main"],
  model: "repair",
  runtime: "node-24",
  install: ["npm", "ci", "--ignore-scripts"],
  test: ["npm", "test"],
  allowedPaths: ["src/**", "test/**"],
});

it("turns queued configured-job evidence into one bounded Primary Failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentci-primary-failure-"));
  const databasePath = join(directory, "agentci.sqlite");
  const analyzed: unknown[] = [];
  const downloadedJobIds: string[] = [];
  const updates: unknown[] = [];
  const fakeAnalyzer = createDeterministicFailureAnalyzer({
    actionable: true,
    summary: "Assertion mismatch in the unit test. Authorization: Bearer response-secret",
    requestedFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "test/a.test.ts", "test/b.test.ts"],
    usage: { inputTokens: 123, outputTokens: 45 },
  });
  const jobs = [
    {
      id: "17",
      name: "test",
      conclusion: "failure",
      steps: [
        { number: 1, name: "Install", conclusion: "success" },
        { number: 2, name: "Unit tests", conclusion: "failure" },
      ],
    },
    {
      id: "18",
      name: "lint",
      conclusion: "failure",
      steps: [{ number: 1, name: "Lint", conclusion: "failure" }],
    },
  ];
  const intake = createWebhookIntake({
    databasePath,
    webhookSecret: "test-webhook-secret",
    aliases: { models: ["repair"], runtimes: ["node-24"] },
    github: {
      async getRepositoryContract() {
        return contract;
      },
      async getWorkflowJobs() {
        return jobs;
      },
      async getWorkflowJobLog(input) {
        downloadedJobIds.push(input.jobId);
        return [
          "Authorization: Bearer never-send-this",
          ...Array.from({ length: 205 }, (_, index) => `test failure line ${index + 1}`),
        ].join("\n");
      },
      async ensureInitialCheck() {},
      async updateCheck(input) {
        updates.push(input);
      },
    },
    analyzer: {
      async analyzeFailure(input) {
        analyzed.push(input);
        return fakeAnalyzer.analyzeFailure(input);
      },
    },
  });

  const signature = `sha256=${createHmac("sha256", "test-webhook-secret").update(payload).digest("hex")}`;
  await intake.receive({
    event: "workflow_run",
    deliveryId: "primary-failure",
    signature,
    body: payload,
  });
  await expect(intake.workOnce()).resolves.toBe(true);

  expect(downloadedJobIds).toEqual(["17"]);
  expect(analyzed).toHaveLength(1);
  expect(JSON.stringify(analyzed)).not.toContain("never-send-this");
  expect((analyzed[0] as { log: string }).log.split("\n")).toHaveLength(200);
  expect(intake.listAttempts()).toEqual([
    expect.objectContaining({
      status: "primary_failure",
      summary:
        "Primary Failure: test / Unit tests (step 2). Assertion mismatch in the unit test. Authorization: Bearer [REDACTED]",
      inputTokens: 123,
      outputTokens: 45,
    }),
  ]);
  expect(updates).toEqual([
    expect.objectContaining({
      status: "in_progress",
      title: "AgentCI identified a Primary Failure",
      summary:
        "Primary Failure: test / Unit tests (step 2). Assertion mismatch in the unit test. Authorization: Bearer [REDACTED]",
    }),
  ]);
  intake.close();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const retained = JSON.stringify({
    attempts: database.prepare("SELECT * FROM repair_attempts").all(),
    deliveries: database.prepare("SELECT * FROM webhook_deliveries").all(),
  });
  expect(retained).not.toContain("never-send-this");
  expect(retained).not.toContain("response-secret");
  expect(retained).not.toContain("test failure line");
  const columnNames = (
    database.prepare("PRAGMA table_info(repair_attempts)").all() as unknown as { name: string }[]
  ).map((column) => column.name);
  expect(columnNames).not.toEqual(expect.arrayContaining(["log", "prompt", "response", "source"]));
  database.close();
});

it("completes the Check as an Unresolved Repair when multiple configured jobs fail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentci-primary-failure-"));
  let jobReads = 0;
  const updates: unknown[] = [];
  const intake = createWebhookIntake({
    databasePath: join(directory, "agentci.sqlite"),
    webhookSecret: "test-webhook-secret",
    aliases: { models: ["repair"], runtimes: ["node-24"] },
    github: {
      async getRepositoryContract() {
        return contract;
      },
      async getWorkflowJobs() {
        jobReads += 1;
        const job = {
          id: "17",
          name: "test",
          conclusion: "failure",
          steps: [{ number: 1, name: "Tests", conclusion: "failure" }],
        };
        return jobReads === 1 ? [job] : [job, { ...job, id: "18" }];
      },
      async getWorkflowJobLog() {
        throw new Error("ambiguous job logs must not be downloaded");
      },
      async ensureInitialCheck() {},
      async updateCheck(input) {
        updates.push(input);
      },
    },
    analyzer: {
      async analyzeFailure() {
        throw new Error("ambiguous evidence must not reach the analyzer");
      },
    },
  });
  const signature = `sha256=${createHmac("sha256", "test-webhook-secret").update(payload).digest("hex")}`;
  await intake.receive({
    event: "workflow_run",
    deliveryId: "ambiguous-primary-failure",
    signature,
    body: payload,
  });

  await expect(intake.workOnce()).resolves.toBe(true);
  expect(intake.listAttempts()).toEqual([
    expect.objectContaining({
      status: "unresolved",
      summary:
        "Unresolved Repair: Multiple configured jobs failed; AgentCI cannot select one safely.",
    }),
  ]);
  expect(updates).toEqual([
    expect.objectContaining({
      status: "completed",
      conclusion: "neutral",
      title: "AgentCI could not identify an actionable Primary Failure",
      summary:
        "Unresolved Repair: Multiple configured jobs failed; AgentCI cannot select one safely.",
    }),
  ]);
  intake.close();
});

it("does not call the analyzer when the configured allowlist is unsafe", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentci-primary-failure-"));
  let analyzed = false;
  const unsafeContract = JSON.stringify({
    ...JSON.parse(contract),
    allowedPaths: ["src/**", "../private/**"],
  });
  const intake = createWebhookIntake({
    databasePath: join(directory, "agentci.sqlite"),
    webhookSecret: "test-webhook-secret",
    aliases: { models: ["repair"], runtimes: ["node-24"] },
    github: {
      async getRepositoryContract() {
        return unsafeContract;
      },
      async getWorkflowJobs() {
        return [
          {
            id: "17",
            name: "test",
            conclusion: "failure",
            steps: [{ number: 1, name: "Tests", conclusion: "failure" }],
          },
        ];
      },
      async getWorkflowJobLog() {
        return "failure";
      },
      async ensureInitialCheck() {},
      async updateCheck() {},
    },
    analyzer: {
      async analyzeFailure() {
        analyzed = true;
        throw new Error("not expected");
      },
    },
  });
  const signature = `sha256=${createHmac("sha256", "test-webhook-secret").update(payload).digest("hex")}`;
  await intake.receive({
    event: "workflow_run",
    deliveryId: "unsafe-allowlist",
    signature,
    body: payload,
  });

  await intake.workOnce();
  expect(analyzed).toBe(false);
  expect(intake.listAttempts()[0]).toEqual(
    expect.objectContaining({
      status: "unresolved",
      summary: "Unresolved Repair: Repository Contract contains an unsafe allowed path pattern.",
    }),
  );
  intake.close();
});

it("retains usage but only a redacted summary when analysis is not actionable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentci-primary-failure-"));
  const intake = createWebhookIntake({
    databasePath: join(directory, "agentci.sqlite"),
    webhookSecret: "test-webhook-secret",
    aliases: { models: ["repair"], runtimes: ["node-24"] },
    github: {
      async getRepositoryContract() {
        return contract;
      },
      async getWorkflowJobs() {
        return [
          {
            id: "17",
            name: "test",
            conclusion: "failure",
            steps: [{ number: 1, name: "Tests", conclusion: "failure" }],
          },
        ];
      },
      async getWorkflowJobLog() {
        return "process terminated without an identifiable error";
      },
      async ensureInitialCheck() {},
      async updateCheck() {},
    },
    analyzer: {
      async analyzeFailure() {
        return {
          actionable: false,
          summary: "Could not identify safely. Authorization: Bearer response-secret",
          requestedFiles: [],
          usage: { inputTokens: 9, outputTokens: 3 },
        };
      },
    },
  });
  const signature = `sha256=${createHmac("sha256", "test-webhook-secret").update(payload).digest("hex")}`;
  await intake.receive({
    event: "workflow_run",
    deliveryId: "unidentifiable-analysis",
    signature,
    body: payload,
  });

  await intake.workOnce();
  expect(intake.listAttempts()[0]).toEqual(
    expect.objectContaining({
      status: "unresolved",
      summary: "Unresolved Repair: Could not identify safely. Authorization: Bearer [REDACTED]",
      inputTokens: 9,
      outputTokens: 3,
    }),
  );
  intake.close();
});
