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

it("turns malformed analyzer output into a terminal redacted Unresolved Repair", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentci-primary-failure-"));
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
        return "test failed";
      },
      async ensureInitialCheck() {},
      async updateCheck(input) {
        updates.push(input);
      },
    },
    analyzer: {
      async analyzeFailure() {
        return { actionable: true, summary: "invalid", requestedFiles: undefined } as never;
      },
    },
  });
  const signature = `sha256=${createHmac("sha256", "test-webhook-secret").update(payload).digest("hex")}`;
  await intake.receive({
    event: "workflow_run",
    deliveryId: "malformed-analysis",
    signature,
    body: payload,
  });

  await expect(intake.workOnce()).resolves.toBe(true);
  expect(intake.listAttempts()[0]).toEqual(
    expect.objectContaining({
      status: "unresolved",
      summary: "Unresolved Repair: Failure analysis could not be completed.",
    }),
  );
  expect(updates).toEqual([
    expect.objectContaining({ status: "completed", conclusion: "neutral" }),
  ]);
  intake.close();
});

it("reconciles a persisted Primary Failure Check after restart without another model call", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentci-primary-failure-"));
  const databasePath = join(directory, "agentci.sqlite");
  let analysisCalls = 0;
  let updateCalls = 0;
  const options = {
    databasePath,
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
        return "test failed";
      },
      async ensureInitialCheck() {},
      async updateCheck() {
        updateCalls += 1;
        if (updateCalls === 1) throw new Error("ambiguous Check update failure");
      },
    },
    analyzer: {
      async analyzeFailure() {
        analysisCalls += 1;
        return {
          actionable: true,
          summary: "A deterministic failure.",
          requestedFiles: ["src/a.ts"],
        };
      },
    },
  };
  const signature = `sha256=${createHmac("sha256", "test-webhook-secret").update(payload).digest("hex")}`;
  const first = createWebhookIntake(options);
  await first.receive({
    event: "workflow_run",
    deliveryId: "restart-primary-failure",
    signature,
    body: payload,
  });
  await expect(first.workOnce()).rejects.toThrow("ambiguous Check update failure");
  expect(first.listAttempts()[0]).toEqual(expect.objectContaining({ status: "primary_failure" }));
  first.close();

  const restarted = createWebhookIntake(options);
  await expect(restarted.workOnce()).resolves.toBe(true);
  await expect(restarted.workOnce()).resolves.toBe(false);
  expect(analysisCalls).toBe(1);
  expect(updateCalls).toBe(2);
  restarted.close();
});

it("lets only one worker claim a queued Repair Attempt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentci-primary-failure-"));
  let analysisCalls = 0;
  let releaseInitialCheck!: () => void;
  const initialCheckBlocked = new Promise<void>((resolve) => {
    releaseInitialCheck = resolve;
  });
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
        return "test failed";
      },
      async ensureInitialCheck() {
        await initialCheckBlocked;
      },
      async updateCheck() {},
    },
    analyzer: {
      async analyzeFailure() {
        analysisCalls += 1;
        return {
          actionable: true,
          summary: "A deterministic failure.",
          requestedFiles: ["src/a.ts"],
        };
      },
    },
  });
  const signature = `sha256=${createHmac("sha256", "test-webhook-secret").update(payload).digest("hex")}`;
  await intake.receive({
    event: "workflow_run",
    deliveryId: "single-claim",
    signature,
    body: payload,
  });

  const first = intake.workOnce();
  const second = intake.workOnce();
  releaseInitialCheck();

  await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
  expect(analysisCalls).toBe(1);
  intake.close();
});

it("turns an interrupted in-progress Repair Attempt into a terminal Unresolved Repair after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentci-primary-failure-"));
  const databasePath = join(directory, "agentci.sqlite");
  let analysisCalls = 0;
  const baseOptions = {
    databasePath,
    webhookSecret: "test-webhook-secret",
    aliases: { models: ["repair"], runtimes: ["node-24"] },
    analyzer: {
      async analyzeFailure() {
        analysisCalls += 1;
        return { actionable: true, summary: "failure", requestedFiles: ["src/a.ts"] };
      },
    },
  };
  const first = createWebhookIntake({
    ...baseOptions,
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
      async ensureInitialCheck() {
        throw new Error("process stopped during claimed work");
      },
    },
  });
  const signature = `sha256=${createHmac("sha256", "test-webhook-secret").update(payload).digest("hex")}`;
  await first.receive({
    event: "workflow_run",
    deliveryId: "interrupted-attempt",
    signature,
    body: payload,
  });
  await expect(first.workOnce()).rejects.toThrow("process stopped during claimed work");
  first.close();

  const checks: unknown[] = [];
  const restarted = createWebhookIntake({
    ...baseOptions,
    github: {
      async getRepositoryContract() {
        throw new Error("interrupted work must not be resumed");
      },
      async getWorkflowJobs() {
        throw new Error("interrupted work must not be resumed");
      },
      async ensureInitialCheck() {},
      async updateCheck(input) {
        checks.push(input);
      },
    },
  });

  await expect(restarted.workOnce()).resolves.toBe(true);
  expect(restarted.listAttempts()).toEqual([
    expect.objectContaining({
      status: "unresolved",
      summary: "Unresolved Repair: Repair Attempt was interrupted; partial work was discarded.",
    }),
  ]);
  expect(analysisCalls).toBe(0);
  expect(checks).toEqual([expect.objectContaining({ status: "completed", conclusion: "neutral" })]);
  restarted.close();
});

it("makes an older same-branch Repair Attempt stale when a newer eligible run arrives", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentci-primary-failure-"));
  const checks: unknown[] = [];
  let analysisCalls = 0;
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
        return "test failed";
      },
      async ensureInitialCheck() {},
      async updateCheck(input) {
        checks.push(input);
      },
    },
    analyzer: {
      async analyzeFailure() {
        analysisCalls += 1;
        return { actionable: true, summary: "failure", requestedFiles: ["src/a.ts"] };
      },
    },
  });
  const workflowPayload = JSON.parse(payload.toString("utf8")) as {
    workflow_run: { id: number; head_sha: string };
  };
  const delivery = async (runId: number, revision: string) => {
    const body = Buffer.from(
      JSON.stringify({
        ...workflowPayload,
        workflow_run: { ...workflowPayload.workflow_run, id: runId, head_sha: revision },
      }),
    );
    return intake.receive({
      event: "workflow_run",
      deliveryId: `delivery-${runId}`,
      signature: `sha256=${createHmac("sha256", "test-webhook-secret").update(body).digest("hex")}`,
      body,
    });
  };

  await expect(delivery(7001, "older-revision")).resolves.toEqual({
    status: 202,
    outcome: "queued",
  });
  await expect(delivery(7002, "newer-revision")).resolves.toEqual({
    status: 202,
    outcome: "queued",
  });

  expect(intake.listAttempts()).toEqual([
    expect.objectContaining({ status: "stale", revision: "older-revision" }),
    expect.objectContaining({ status: "queued", revision: "newer-revision" }),
  ]);
  await expect(intake.workOnce()).resolves.toBe(true);
  expect(analysisCalls).toBe(0);
  expect(checks).toEqual([
    expect.objectContaining({
      revision: "older-revision",
      status: "completed",
      conclusion: "neutral",
      title: "AgentCI stopped a Stale Repair",
    }),
  ]);
  await expect(intake.workOnce()).resolves.toBe(true);
  expect(analysisCalls).toBe(1);
  intake.close();
});

it("atomically refuses publication after a newer eligible same-branch run wins the race", async () => {
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
        return [{ name: "test", conclusion: "failure" }];
      },
      async ensureInitialCheck() {},
    },
  });
  const workflowPayload = JSON.parse(payload.toString("utf8")) as {
    workflow_run: { id: number; head_sha: string };
  };
  const deliver = async (runId: number) => {
    const body = Buffer.from(
      JSON.stringify({
        ...workflowPayload,
        workflow_run: {
          ...workflowPayload.workflow_run,
          id: runId,
          head_sha: `revision-${runId}`,
        },
      }),
    );
    return intake.receive({
      event: "workflow_run",
      deliveryId: `publication-race-${runId}`,
      signature: `sha256=${createHmac("sha256", "test-webhook-secret").update(body).digest("hex")}`,
      body,
    });
  };
  await deliver(8001);
  await intake.transition({
    attemptId: "1",
    status: "publishing",
    at: "2026-11-20T12:00:00.000Z",
  });
  await deliver(8002);
  let published = false;

  await expect(
    intake.publishIfCurrent({ attemptId: "1", at: "2026-11-20T12:00:01.000Z" }, async () => {
      published = true;
      return { number: 1 };
    }),
  ).resolves.toEqual({ outcome: "stale" });
  expect(published).toBe(false);
  intake.close();
});

it("discards running model work when a newer eligible same-branch run supersedes it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentci-primary-failure-"));
  const checks: { revision: string; title: string }[] = [];
  let analysisStarted!: () => void;
  let releaseAnalysis!: () => void;
  const started = new Promise<void>((resolve) => {
    analysisStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseAnalysis = resolve;
  });
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
        return "test failed";
      },
      async ensureInitialCheck() {},
      async updateCheck(input) {
        checks.push({ revision: input.revision, title: input.title });
      },
    },
    analyzer: {
      async analyzeFailure() {
        analysisStarted();
        await blocked;
        return { actionable: true, summary: "old analysis", requestedFiles: ["src/a.ts"] };
      },
    },
  });
  const workflowPayload = JSON.parse(payload.toString("utf8")) as {
    workflow_run: { id: number; head_sha: string };
  };
  const deliver = async (runId: number) => {
    const body = Buffer.from(
      JSON.stringify({
        ...workflowPayload,
        workflow_run: {
          ...workflowPayload.workflow_run,
          id: runId,
          head_sha: `running-revision-${runId}`,
        },
      }),
    );
    return intake.receive({
      event: "workflow_run",
      deliveryId: `running-supersession-${runId}`,
      signature: `sha256=${createHmac("sha256", "test-webhook-secret").update(body).digest("hex")}`,
      body,
    });
  };

  await deliver(8101);
  const oldWork = intake.workOnce();
  await started;
  await deliver(8102);
  releaseAnalysis();
  await oldWork;

  expect(intake.listAttempts()).toEqual([
    expect.objectContaining({ status: "stale", revision: "running-revision-8101" }),
    expect.objectContaining({ status: "queued", revision: "running-revision-8102" }),
  ]);
  expect(checks).toEqual([
    {
      revision: "running-revision-8101",
      title: "AgentCI stopped a Stale Repair",
    },
  ]);
  intake.close();
});
