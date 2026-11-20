import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { startAgentCiService } from "../src/start.js";

const body = readFileSync(new URL("./fixtures/workflow-run-failed.json", import.meta.url));

it("serves health and signed webhook endpoints while its serial worker creates the initial Check", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentci-start-"));
  const checks: unknown[] = [];
  const service = await startAgentCiService({
    host: "127.0.0.1",
    port: 0,
    workerIntervalMs: 5,
    databasePath: join(directory, "agentci.sqlite"),
    webhookSecret: "server-secret",
    aliases: { models: ["repair"], runtimes: ["node-24"] },
    github: {
      async getRepositoryContract() {
        return JSON.stringify({
          version: 1,
          workflow: "CI",
          job: "test",
          branches: ["main"],
          model: "repair",
          runtime: "node-24",
          install: ["npm", "ci", "--ignore-scripts"],
          test: ["npm", "test"],
          allowedPaths: ["src/**"],
        });
      },
      async getWorkflowJobs() {
        return [{ name: "test", conclusion: "failure" }];
      },
      async createInitialCheck(input) {
        checks.push(input);
      },
    },
  });

  try {
    const health = await fetch(`${service.url}/health`);
    expect({ status: health.status, body: await health.json() }).toEqual({
      status: 200,
      body: { status: "ok" },
    });

    const signature = `sha256=${createHmac("sha256", "server-secret").update(body).digest("hex")}`;
    const webhook = await fetch(`${service.url}/github/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "workflow_run",
        "x-github-delivery": "server-delivery",
        "x-hub-signature-256": signature,
      },
      body,
    });
    expect({ status: webhook.status, body: await webhook.json() }).toEqual({
      status: 202,
      body: { outcome: "queued" },
    });

    await expect.poll(() => checks.length).toBe(1);
    expect(service.listAttempts()).toHaveLength(1);
  } finally {
    await service.close();
  }
});
