import { createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { parseRepositoryContract } from "./repository-contract.ts";

export interface GitHubIntakeApi {
  getRepositoryContract(input: {
    installationId: number;
    owner: string;
    repository: string;
    revision: string;
  }): Promise<string | null>;
  getWorkflowJobs(input: {
    installationId: number;
    owner: string;
    repository: string;
    runId: string;
  }): Promise<readonly { name: string; conclusion: string | null }[]>;
  createInitialCheck(input: {
    installationId: number;
    owner: string;
    repository: string;
    revision: string;
    externalId: string;
    summary: string;
  }): Promise<void>;
}

export interface RepairAttemptMetadata {
  id: number;
  workflowRunId: string;
  status: "queued";
  repository: string;
  branch: string;
  revision: string;
  workflow: string;
  job: string;
  modelAlias: string;
  runtimeAlias: string;
  summary: string;
}

export interface IntakeOptions {
  databasePath: string;
  webhookSecret: string;
  aliases: { models: readonly string[]; runtimes: readonly string[] };
  github: GitHubIntakeApi;
}

interface WorkflowRunPayload {
  action: "completed";
  installation: { id: number };
  repository: { full_name: string };
  workflow_run: {
    id: number;
    name: string;
    status: "completed";
    conclusion: "failure";
    head_branch: string;
    head_sha: string;
  };
}

interface Delivery {
  event: string | undefined;
  deliveryId: string | undefined;
  signature: string | undefined;
  body: Uint8Array;
}

export interface WebhookIntake {
  receive(
    delivery: Delivery,
  ): Promise<{ status: number; outcome: "rejected" | "ignored" | "queued" }>;
  listAttempts(): RepairAttemptMetadata[];
  workOnce(): Promise<boolean>;
  close(): void;
}

function validSignature(secret: string, body: Uint8Array, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseWorkflowRun(body: Uint8Array): WorkflowRunPayload | undefined {
  try {
    const payload = object(JSON.parse(Buffer.from(body).toString("utf8")));
    const repository = object(payload?.repository);
    const run = object(payload?.workflow_run);
    if (
      payload?.action !== "completed" ||
      typeof object(payload?.installation)?.id !== "number" ||
      typeof repository?.full_name !== "string" ||
      typeof run?.id !== "number" ||
      typeof run.name !== "string" ||
      run.status !== "completed" ||
      run.conclusion !== "failure" ||
      typeof run.head_branch !== "string" ||
      typeof run.head_sha !== "string"
    ) {
      return undefined;
    }
    return {
      action: "completed",
      installation: { id: object(payload.installation)?.id as number },
      repository: { full_name: repository.full_name },
      workflow_run: {
        id: run.id,
        name: run.name,
        status: "completed",
        conclusion: "failure",
        head_branch: run.head_branch,
        head_sha: run.head_sha,
      },
    };
  } catch {
    return undefined;
  }
}

export function createWebhookIntake(options: IntakeOptions): WebhookIntake {
  const database = new DatabaseSync(options.databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS repair_attempts (
      id INTEGER PRIMARY KEY,
      workflow_run_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      repository TEXT NOT NULL,
      branch TEXT NOT NULL,
      revision TEXT NOT NULL,
      workflow TEXT NOT NULL,
      job TEXT NOT NULL,
      model_alias TEXT NOT NULL,
      runtime_alias TEXT NOT NULL,
      summary TEXT NOT NULL,
      check_status TEXT NOT NULL DEFAULT 'pending',
      installation_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return {
    async receive(delivery) {
      if (!validSignature(options.webhookSecret, delivery.body, delivery.signature)) {
        return { status: 401, outcome: "rejected" };
      }
      if (delivery.event !== "workflow_run") {
        return { status: 400, outcome: "rejected" };
      }
      const payload = parseWorkflowRun(delivery.body);
      if (!payload || !delivery.deliveryId) {
        return { status: 422, outcome: "rejected" };
      }
      const deliveryExists = database
        .prepare("SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?")
        .get(delivery.deliveryId);
      if (deliveryExists) return { status: 202, outcome: "ignored" };
      const [owner, repository, extra] = payload.repository.full_name.split("/");
      if (!owner || !repository || extra) {
        return { status: 422, outcome: "rejected" };
      }
      const contractSource = await options.github.getRepositoryContract({
        owner,
        repository,
        revision: payload.workflow_run.head_sha,
        installationId: payload.installation.id,
      });
      const contract = contractSource ? parseRepositoryContract(contractSource) : undefined;
      if (
        !contract ||
        contract.workflow !== payload.workflow_run.name ||
        !contract.branches.includes(payload.workflow_run.head_branch) ||
        !options.aliases.models.includes(contract.model) ||
        !options.aliases.runtimes.includes(contract.runtime)
      ) {
        return { status: 422, outcome: "rejected" };
      }
      const jobs = await options.github.getWorkflowJobs({
        owner,
        repository,
        runId: String(payload.workflow_run.id),
        installationId: payload.installation.id,
      });
      const configuredJobs = jobs.filter((job) => job.name === contract.job);
      if (configuredJobs.length !== 1 || configuredJobs[0]?.conclusion !== "failure") {
        return { status: 422, outcome: "rejected" };
      }

      const runExists = database
        .prepare("SELECT 1 FROM repair_attempts WHERE workflow_run_id = ?")
        .get(String(payload.workflow_run.id));

      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            `INSERT OR IGNORE INTO repair_attempts
              (workflow_run_id, status, repository, branch, revision, workflow, job,
               model_alias, runtime_alias, summary, installation_id)
             VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, 'Eligible failed workflow queued.', ?)`,
          )
          .run(
            String(payload.workflow_run.id),
            payload.repository.full_name,
            payload.workflow_run.head_branch,
            payload.workflow_run.head_sha,
            contract.workflow,
            contract.job,
            contract.model,
            contract.runtime,
            payload.installation.id,
          );
        database
          .prepare("INSERT INTO webhook_deliveries (delivery_id, workflow_run_id) VALUES (?, ?)")
          .run(delivery.deliveryId, String(payload.workflow_run.id));
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { status: 202, outcome: runExists ? "ignored" : "queued" };
    },
    listAttempts() {
      return database
        .prepare(
          `SELECT id, workflow_run_id AS workflowRunId, status, repository, branch, revision,
                  workflow, job, model_alias AS modelAlias, runtime_alias AS runtimeAlias, summary
           FROM repair_attempts ORDER BY id`,
        )
        .all() as unknown as RepairAttemptMetadata[];
    },
    async workOnce() {
      const attempt = database
        .prepare(
          `SELECT id, repository, revision, summary, installation_id AS installationId FROM repair_attempts
           WHERE check_status = 'pending' ORDER BY id LIMIT 1`,
        )
        .get() as
        | {
            id: number;
            repository: string;
            revision: string;
            summary: string;
            installationId: number;
          }
        | undefined;
      if (!attempt) return false;
      const [owner, repository] = attempt.repository.split("/") as [string, string];
      await options.github.createInitialCheck({
        owner,
        repository,
        installationId: attempt.installationId,
        revision: attempt.revision,
        externalId: `agentci-repair-attempt-${attempt.id}`,
        summary: attempt.summary,
      });
      database
        .prepare("UPDATE repair_attempts SET check_status = 'created' WHERE id = ?")
        .run(attempt.id);
      return true;
    },
    close() {
      database.close();
    },
  };
}
