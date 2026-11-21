import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWebhookIntake, type GitHubIntakeApi } from "../src/intake.js";

const payload = readFileSync(new URL("./fixtures/workflow-run-failed.json", import.meta.url));

function signature(body: Uint8Array): string {
  return `sha256=${createHmac("sha256", "test-webhook-secret").update(body).digest("hex")}`;
}

function checkActionBody(input: {
  identifier: string;
  externalId?: string;
  revision?: string;
  repository?: string;
  installationId?: number;
  sender?: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: "requested_action",
      requested_action: { identifier: input.identifier },
      check_run: {
        external_id: input.externalId ?? "agentci-repair-attempt-1",
        head_sha: input.revision ?? "0123456789abcdef0123456789abcdef01234567",
      },
      installation: { id: input.installationId ?? 99 },
      repository: { full_name: input.repository ?? "example/repository" },
      sender: { login: input.sender ?? "maintainer" },
    }),
  );
}

function fakeGitHub(): GitHubIntakeApi {
  return {
    async getRepositoryContract() {
      throw new Error("not expected");
    },
    async getWorkflowJobs() {
      throw new Error("not expected");
    },
    async ensureInitialCheck() {
      throw new Error("not expected");
    },
  };
}

const validContract = JSON.stringify({
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

describe("signed GitHub webhook intake", () => {
  it("atomically consumes one Retry action into a linked attempt at the original revision", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-intake-"));
    const github: GitHubIntakeApi = {
      async getRepositoryContract() {
        return validContract;
      },
      async getWorkflowJobs() {
        return [{ name: "test", conclusion: "failure" }];
      },
      async ensureInitialCheck() {},
      async getRepositoryPermission() {
        return "write";
      },
    };
    const intake = createWebhookIntake({
      databasePath: join(directory, "agentci.sqlite"),
      webhookSecret: "test-webhook-secret",
      aliases: { models: ["repair"], runtimes: ["node-24"] },
      github,
      now: () => new Date("2026-11-21T12:00:00.000Z"),
    });
    await intake.receive({
      event: "workflow_run",
      deliveryId: "retry-source",
      signature: signature(payload),
      body: payload,
    });
    await intake.transition({
      attemptId: "1",
      status: "unresolved",
      at: "2026-11-21T11:59:00.000Z",
    });
    const identifier = await intake.offerRetry({
      attemptId: "1",
      at: "2026-11-21T11:59:00.000Z",
      expiresAt: "2026-11-21T12:05:00.000Z",
    });
    const action = checkActionBody({ identifier });

    const results = await Promise.all([
      intake.receive({
        event: "check_run",
        deliveryId: "retry-action",
        signature: signature(action),
        body: action,
      }),
      intake.receive({
        event: "check_run",
        deliveryId: "retry-action-replay",
        signature: signature(action),
        body: action,
      }),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["ignored", "queued"]);

    expect(intake.listAttempts()).toMatchObject([
      { id: 1, revision: "0123456789abcdef0123456789abcdef01234567" },
      {
        id: 2,
        parentAttemptId: 1,
        rootAttemptId: 1,
        action: "retry",
        revision: "0123456789abcdef0123456789abcdef01234567",
      },
    ]);
    intake.close();
  });

  it("queues nothing for invalid, expired, or unauthorized Check actions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-intake-"));
    let now = new Date("2026-11-21T12:00:00.000Z");
    let permission: "write" | "read" = "write";
    const intake = createWebhookIntake({
      databasePath: join(directory, "agentci.sqlite"),
      webhookSecret: "test-webhook-secret",
      aliases: { models: ["repair"], runtimes: ["node-24"] },
      now: () => now,
      github: {
        async getRepositoryContract() {
          return validContract;
        },
        async getWorkflowJobs() {
          return [
            {
              id: "job-original",
              name: "test",
              conclusion: "failure",
              steps: [{ number: 2, name: "Unit tests", conclusion: "failure" }],
            },
          ];
        },
        async getWorkflowJobLog() {
          return "unit assertion failed";
        },
        async ensureInitialCheck() {},
        async getRepositoryPermission() {
          return permission;
        },
      },
      analyzer: {
        async analyzeFailure() {
          return { actionable: true, summary: "unit failure", requestedFiles: ["src/math.ts"] };
        },
      },
    });
    await intake.receive({
      event: "workflow_run",
      deliveryId: "invalid-action-source",
      signature: signature(payload),
      body: payload,
    });
    await intake.workOnce();
    await intake.transition({
      attemptId: "1",
      status: "unresolved",
      at: "2026-11-21T11:59:00.000Z",
    });
    const identifier = await intake.offerRetry({
      attemptId: "1",
      at: "2026-11-21T11:59:00.000Z",
      expiresAt: "2026-11-21T12:05:00.000Z",
    });
    const deliver = async (deliveryId: string, body: Buffer) =>
      intake.receive({
        event: "check_run",
        deliveryId,
        signature: signature(body),
        body,
      });

    await expect(
      deliver("invalid-binding", checkActionBody({ identifier, repository: "other/repository" })),
    ).resolves.toEqual({ status: 202, outcome: "ignored" });
    permission = "read";
    await expect(deliver("unauthorized", checkActionBody({ identifier }))).resolves.toEqual({
      status: 202,
      outcome: "ignored",
    });
    permission = "write";
    now = new Date("2026-11-21T12:06:00.000Z");
    await expect(deliver("expired", checkActionBody({ identifier }))).resolves.toEqual({
      status: 202,
      outcome: "ignored",
    });
    expect(intake.listAttempts()).toHaveLength(1);
    intake.close();
  });

  it("consumes one Continuation into a linked attempt with a new immutable Primary Failure and accepted baseline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-intake-"));
    const intake = createWebhookIntake({
      databasePath: join(directory, "agentci.sqlite"),
      webhookSecret: "test-webhook-secret",
      aliases: { models: ["repair"], runtimes: ["node-24"] },
      now: () => new Date("2026-11-21T12:00:00.000Z"),
      github: {
        async getRepositoryContract() {
          return validContract;
        },
        async getWorkflowJobs() {
          return [
            {
              id: "job-original",
              name: "test",
              conclusion: "failure",
              steps: [{ number: 2, name: "Unit tests", conclusion: "failure" }],
            },
          ];
        },
        async getWorkflowJobLog() {
          return "unit assertion failed";
        },
        async ensureInitialCheck() {},
        async getRepositoryPermission() {
          return "maintain";
        },
      },
      analyzer: {
        async analyzeFailure() {
          return { actionable: true, summary: "unit failure", requestedFiles: ["src/math.ts"] };
        },
      },
    });
    await intake.receive({
      event: "workflow_run",
      deliveryId: "continuation-source",
      signature: signature(payload),
      body: payload,
    });
    await intake.workOnce();
    await intake.transition({
      attemptId: "1",
      status: "unresolved",
      at: "2026-11-21T11:59:00.000Z",
    });
    const revealedFailure = {
      jobId: "job-17",
      jobName: "test",
      stepNumber: 5,
      stepName: "Integration tests",
      log: "integration assertion failed",
    };
    const proposal = {
      summary: "repair the unit assertion",
      changes: [{ path: "src/math.ts", content: "export const value = 2;\n" }],
    };
    const identifier = await intake.offerContinuation({
      attemptId: "1",
      at: "2026-11-21T11:59:00.000Z",
      expiresAt: "2026-11-21T12:05:00.000Z",
      proposal,
      revealedFailure,
      cumulativeChangedFiles: ["src/math.ts"],
      cumulativeChangedLines: 2,
    });
    const action = checkActionBody({ identifier });

    await expect(
      intake.receive({
        event: "check_run",
        deliveryId: "continuation-action",
        signature: signature(action),
        body: action,
      }),
    ).resolves.toEqual({ status: 202, outcome: "queued" });

    expect(intake.listAttempts()).toMatchObject([
      { id: 1 },
      {
        id: 2,
        parentAttemptId: 1,
        rootAttemptId: 1,
        action: "continuation",
        primaryFailure: {
          jobId: "job-17",
          jobName: "test",
          stepNumber: 5,
          stepName: "Integration tests",
        },
        cumulativeChangedFiles: ["src/math.ts"],
        cumulativeChangedLines: 2,
      },
    ]);
    expect(intake.takeContinuationContext("2")).toEqual({ proposal, revealedFailure });
    expect(intake.takeContinuationContext("2")).toBeUndefined();

    await intake.transition({
      attemptId: "2",
      status: "unresolved",
      at: "2026-11-21T12:01:00.000Z",
    });
    const retryIdentifier = await intake.offerRetry({
      attemptId: "2",
      at: "2026-11-21T12:01:00.000Z",
      expiresAt: "2026-11-21T12:05:00.000Z",
    });
    const retryAction = checkActionBody({
      identifier: retryIdentifier,
      externalId: "agentci-repair-attempt-2",
    });
    await expect(
      intake.receive({
        event: "check_run",
        deliveryId: "retry-after-continuation",
        signature: signature(retryAction),
        body: retryAction,
      }),
    ).resolves.toEqual({ status: 202, outcome: "queued" });
    expect(intake.listAttempts()[2]).toMatchObject({
      id: 3,
      parentAttemptId: 2,
      rootAttemptId: 1,
      action: "retry",
      primaryFailure: {
        jobId: "job-original",
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
      },
      revision: "0123456789abcdef0123456789abcdef01234567",
    });
    intake.close();
  });

  it("rejects an invalid raw-body signature without queuing work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-intake-"));
    const intake = createWebhookIntake({
      databasePath: join(directory, "agentci.sqlite"),
      webhookSecret: "test-webhook-secret",
      aliases: { models: ["repair"], runtimes: ["node-24"] },
      github: fakeGitHub(),
    });

    const result = await intake.receive({
      event: "workflow_run",
      deliveryId: "delivery-1",
      signature: "sha256=invalid",
      body: payload,
    });

    expect(result).toEqual({ status: 401, outcome: "rejected" });
    expect(intake.listAttempts()).toEqual([]);
    intake.close();
  });

  it("rejects unsupported signed events without reading repository data", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-intake-"));
    const intake = createWebhookIntake({
      databasePath: join(directory, "agentci.sqlite"),
      webhookSecret: "test-webhook-secret",
      aliases: { models: ["repair"], runtimes: ["node-24"] },
      github: fakeGitHub(),
    });

    const result = await intake.receive({
      event: "push",
      deliveryId: "delivery-2",
      signature: signature(payload),
      body: payload,
    });

    expect(result).toEqual({ status: 400, outcome: "rejected" });
    expect(intake.listAttempts()).toEqual([]);
    intake.close();
  });

  it("queues one Repair Attempt and creates its initial Check through the GitHub boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-intake-"));
    const checks: unknown[] = [];
    const github: GitHubIntakeApi = {
      async getRepositoryContract() {
        return validContract;
      },
      async getWorkflowJobs() {
        return [{ name: "test", conclusion: "failure" }];
      },
      async ensureInitialCheck(input) {
        checks.push(input);
      },
    };
    const intake = createWebhookIntake({
      databasePath: join(directory, "agentci.sqlite"),
      webhookSecret: "test-webhook-secret",
      aliases: { models: ["repair"], runtimes: ["node-24"] },
      github,
    });

    expect(
      await intake.receive({
        event: "workflow_run",
        deliveryId: "delivery-3",
        signature: signature(payload),
        body: payload,
      }),
    ).toEqual({ status: 202, outcome: "queued" });
    expect(intake.listAttempts()).toEqual([
      {
        id: 1,
        workflowRunId: "4242",
        status: "queued",
        repository: "example/repository",
        branch: "main",
        revision: "0123456789abcdef0123456789abcdef01234567",
        workflow: "CI",
        job: "test",
        modelAlias: "repair",
        runtimeAlias: "node-24",
        summary: "Eligible failed workflow queued.",
      },
    ]);

    expect(await intake.workOnce()).toBe(true);
    expect(checks).toEqual([
      {
        installationId: 99,
        owner: "example",
        repository: "repository",
        revision: "0123456789abcdef0123456789abcdef01234567",
        externalId: "agentci-repair-attempt-1",
        summary: "Eligible failed workflow queued.",
      },
    ]);
    expect(await intake.workOnce()).toBe(false);
    intake.close();
  });

  it("preserves one redacted queued attempt across restart and deduplicates deliveries and runs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-intake-"));
    const databasePath = join(directory, "agentci.sqlite");
    const checks: unknown[] = [];
    const github: GitHubIntakeApi = {
      async getRepositoryContract() {
        return JSON.stringify({
          ...JSON.parse(validContract),
          branches: ["main", "do-not-retain"],
        });
      },
      async getWorkflowJobs() {
        return [{ name: "test", conclusion: "failure" }];
      },
      async ensureInitialCheck(input) {
        checks.push(input);
      },
    };
    const options = {
      databasePath,
      webhookSecret: "test-webhook-secret",
      aliases: { models: ["repair"], runtimes: ["node-24"] },
      github,
    };
    const first = createWebhookIntake(options);
    const receive = (deliveryId: string) =>
      first.receive({
        event: "workflow_run",
        deliveryId,
        signature: signature(payload),
        body: payload,
      });

    expect(await receive("delivery-restart")).toEqual({ status: 202, outcome: "queued" });
    expect(await receive("delivery-restart")).toEqual({ status: 202, outcome: "ignored" });
    expect(await receive("delivery-same-run")).toEqual({ status: 202, outcome: "ignored" });
    first.close();

    const restarted = createWebhookIntake(options);
    expect(restarted.listAttempts()).toHaveLength(1);
    expect(JSON.stringify(restarted.listAttempts())).not.toContain("do-not-retain");
    expect(await restarted.workOnce()).toBe(true);
    expect(await restarted.workOnce()).toBe(false);
    expect(checks).toHaveLength(1);
    restarted.close();
  });

  it("deduplicates concurrent deliveries atomically", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-intake-"));
    const intake = createWebhookIntake({
      databasePath: join(directory, "agentci.sqlite"),
      webhookSecret: "test-webhook-secret",
      aliases: { models: ["repair"], runtimes: ["node-24"] },
      github: {
        async getRepositoryContract() {
          return validContract;
        },
        async getWorkflowJobs() {
          return [{ name: "test", conclusion: "failure" }];
        },
        async ensureInitialCheck() {
          throw new Error("not expected");
        },
      },
    });
    const delivery = {
      event: "workflow_run",
      deliveryId: "concurrent-delivery",
      signature: signature(payload),
      body: payload,
    };

    const results = await Promise.all([intake.receive(delivery), intake.receive(delivery)]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["ignored", "queued"]);
    expect(results.every((result) => result.status === 202)).toBe(true);
    expect(intake.listAttempts()).toHaveLength(1);
    intake.close();
  });

  it("reconciles an ambiguous Check success after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-intake-"));
    const databasePath = join(directory, "agentci.sqlite");
    const checkExternalIds = new Set<string>();
    let firstRequest = true;
    const options = {
      databasePath,
      webhookSecret: "test-webhook-secret",
      aliases: { models: ["repair"], runtimes: ["node-24"] },
      github: {
        async getRepositoryContract() {
          return validContract;
        },
        async getWorkflowJobs() {
          return [{ name: "test", conclusion: "failure" }];
        },
        async ensureInitialCheck(input: { externalId: string }) {
          if (checkExternalIds.has(input.externalId)) return;
          checkExternalIds.add(input.externalId);
          if (firstRequest) {
            firstRequest = false;
            throw new Error("ambiguous network failure after GitHub accepted the Check");
          }
        },
      },
    };
    const first = createWebhookIntake(options);
    await first.receive({
      event: "workflow_run",
      deliveryId: "ambiguous-check",
      signature: signature(payload),
      body: payload,
    });
    await expect(first.workOnce()).rejects.toThrow("ambiguous network failure");
    first.close();

    const restarted = createWebhookIntake(options);
    await expect(restarted.workOnce()).resolves.toBe(true);
    await expect(restarted.workOnce()).resolves.toBe(false);
    expect(checkExternalIds).toEqual(new Set(["agentci-repair-attempt-1"]));
    restarted.close();
  });

  it.each([
    ["workflow", { workflow: "Other" }, [{ name: "test", conclusion: "failure" }]],
    ["job", {}, [{ name: "test", conclusion: "success" }]],
    ["branch", { branches: ["release"] }, [{ name: "test", conclusion: "failure" }]],
    ["contract version", { version: 2 }, [{ name: "test", conclusion: "failure" }]],
    ["model alias", { model: "unapproved-model" }, [{ name: "test", conclusion: "failure" }]],
    ["runtime alias", { runtime: "unapproved-runtime" }, [{ name: "test", conclusion: "failure" }]],
  ])("rejects an ineligible %s without queuing work", async (_name, contractChanges, jobs) => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-intake-"));
    const intake = createWebhookIntake({
      databasePath: join(directory, "agentci.sqlite"),
      webhookSecret: "test-webhook-secret",
      aliases: { models: ["repair"], runtimes: ["node-24"] },
      github: {
        async getRepositoryContract() {
          return JSON.stringify({ ...JSON.parse(validContract), ...contractChanges });
        },
        async getWorkflowJobs() {
          return jobs;
        },
        async ensureInitialCheck() {
          throw new Error("not expected");
        },
      },
    });

    expect(
      await intake.receive({
        event: "workflow_run",
        deliveryId: `ineligible-${_name}`,
        signature: signature(payload),
        body: payload,
      }),
    ).toEqual({ status: 422, outcome: "rejected" });
    expect(intake.listAttempts()).toEqual([]);
    intake.close();
  });
});
