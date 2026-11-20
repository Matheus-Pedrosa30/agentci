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

function fakeGitHub(): GitHubIntakeApi {
  return {
    async getRepositoryContract() {
      throw new Error("not expected");
    },
    async getWorkflowJobs() {
      throw new Error("not expected");
    },
    async createInitialCheck() {
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
      async createInitialCheck(input) {
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
        return JSON.stringify({ ...JSON.parse(validContract), ignoredSecret: "do-not-retain" });
      },
      async getWorkflowJobs() {
        return [{ name: "test", conclusion: "failure" }];
      },
      async createInitialCheck(input) {
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
        async createInitialCheck() {
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
