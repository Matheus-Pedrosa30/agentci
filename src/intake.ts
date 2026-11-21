import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { FailureAnalysis, FailureAnalyzer } from "./failure-analyzer.ts";
import {
  buildModelEvidence,
  identifyPrimaryFailure,
  redactAndBoundSummary,
  validateAllowedFilePatterns,
  validateRequestedFiles,
} from "./failure-evidence.ts";
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
  }): Promise<
    readonly {
      id?: string;
      name: string;
      conclusion: string | null;
      steps?: readonly { number: number; name: string; conclusion: string | null }[];
    }[]
  >;
  getWorkflowJobLog?(input: {
    installationId: number;
    owner: string;
    repository: string;
    jobId: string;
  }): Promise<string>;
  ensureInitialCheck(input: {
    installationId: number;
    owner: string;
    repository: string;
    revision: string;
    externalId: string;
    summary: string;
  }): Promise<void>;
  updateCheck?(input: {
    installationId: number;
    owner: string;
    repository: string;
    revision: string;
    externalId: string;
    status: "in_progress" | "completed";
    title: string;
    summary: string;
    conclusion?: "neutral";
  }): Promise<void>;
}

export interface RepairAttemptMetadata {
  id: number;
  workflowRunId: string;
  status:
    | "queued"
    | "primary_failure"
    | "proposing"
    | "validating"
    | "publishing"
    | "validated"
    | "unresolved"
    | "stale";
  repository: string;
  branch: string;
  revision: string;
  workflow: string;
  job: string;
  modelAlias: string;
  runtimeAlias: string;
  summary: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface IntakeOptions {
  databasePath: string;
  webhookSecret: string;
  aliases: { models: readonly string[]; runtimes: readonly string[] };
  github: GitHubIntakeApi;
  analyzer?: FailureAnalyzer;
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
  transition(input: {
    attemptId: string;
    status: "proposing" | "validating" | "publishing" | "validated" | "unresolved" | "stale";
    at: string;
  }): Promise<void>;
  publishIfCurrent<T>(
    input: { attemptId: string; at: string },
    publish: () => Promise<T>,
  ): Promise<{ outcome: "published"; value: T } | { outcome: "stale" }>;
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

function usageCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validFailureAnalysis(value: unknown): value is FailureAnalysis {
  if (typeof value !== "object" || value === null) return false;
  const analysis = value as Partial<FailureAnalysis>;
  return (
    typeof analysis.actionable === "boolean" &&
    typeof analysis.summary === "string" &&
    Array.isArray(analysis.requestedFiles) &&
    analysis.requestedFiles.every((path) => typeof path === "string") &&
    (analysis.usage === undefined ||
      (typeof analysis.usage === "object" && analysis.usage !== null))
  );
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
      primary_job_id TEXT,
      primary_step_number INTEGER,
      primary_step_name TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      worker_state TEXT NOT NULL DEFAULT 'available',
      claim_token TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const attemptColumns = new Set(
    (
      database.prepare("PRAGMA table_info(repair_attempts)").all() as unknown as {
        name: string;
      }[]
    ).map((column) => column.name),
  );
  const migrations = [
    ["primary_job_id", "ALTER TABLE repair_attempts ADD COLUMN primary_job_id TEXT"],
    ["primary_step_number", "ALTER TABLE repair_attempts ADD COLUMN primary_step_number INTEGER"],
    ["primary_step_name", "ALTER TABLE repair_attempts ADD COLUMN primary_step_name TEXT"],
    ["input_tokens", "ALTER TABLE repair_attempts ADD COLUMN input_tokens INTEGER"],
    ["output_tokens", "ALTER TABLE repair_attempts ADD COLUMN output_tokens INTEGER"],
    [
      "worker_state",
      "ALTER TABLE repair_attempts ADD COLUMN worker_state TEXT NOT NULL DEFAULT 'available'",
    ],
    ["claim_token", "ALTER TABLE repair_attempts ADD COLUMN claim_token TEXT"],
    ["updated_at", "ALTER TABLE repair_attempts ADD COLUMN updated_at TEXT"],
  ] as const;
  for (const [column, sql] of migrations) {
    if (!attemptColumns.has(column)) database.exec(sql);
  }
  if (!attemptColumns.has("updated_at")) {
    database.exec("UPDATE repair_attempts SET updated_at = created_at WHERE updated_at IS NULL");
  }
  database
    .prepare(
      `UPDATE repair_attempts
       SET status = 'unresolved',
           summary = 'Unresolved Repair: Repair Attempt was interrupted; partial work was discarded.',
           worker_state = 'effect_pending', claim_token = NULL, check_status = 'pending',
           updated_at = CURRENT_TIMESTAMP
       WHERE worker_state = 'claimed'`,
    )
    .run();
  database
    .prepare(
      `UPDATE repair_attempts
       SET status = 'unresolved',
           summary = 'Unresolved Repair: Repair Attempt was interrupted; partial work was discarded.',
           worker_state = 'effect_pending', claim_token = NULL, check_status = 'pending',
           updated_at = CURRENT_TIMESTAMP
       WHERE status IN ('proposing', 'validating', 'publishing')`,
    )
    .run();

  let exclusiveTail = Promise.resolve();
  async function exclusively<T>(operation: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const predecessor = exclusiveTail;
    exclusiveTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

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
      const configuredFailedJobs = jobs.filter(
        (job) => job.name === contract.job && job.conclusion === "failure",
      );
      if (configuredFailedJobs.length === 0) {
        return { status: 422, outcome: "rejected" };
      }

      return exclusively(() => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const deliveryInsert = database
            .prepare(
              "INSERT OR IGNORE INTO webhook_deliveries (delivery_id, workflow_run_id) VALUES (?, ?)",
            )
            .run(delivery.deliveryId!, String(payload.workflow_run.id));
          if (deliveryInsert.changes === 0) {
            database.exec("COMMIT");
            return { status: 202 as const, outcome: "ignored" as const };
          }
          const attemptInsert = database
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
          if (attemptInsert.changes === 0) {
            database.exec("COMMIT");
            return { status: 202 as const, outcome: "ignored" as const };
          }
          database
            .prepare(
              `UPDATE repair_attempts
               SET status = 'stale',
                   summary = 'Stale Repair: A newer eligible workflow run superseded this Repair Attempt.',
                   worker_state = 'effect_pending', claim_token = NULL, check_status = 'pending',
                   updated_at = CURRENT_TIMESTAMP
               WHERE repository = ? AND branch = ? AND workflow_run_id <> ?
                 AND status IN ('queued', 'primary_failure', 'proposing', 'validating', 'publishing')`,
            )
            .run(
              payload.repository.full_name,
              payload.workflow_run.head_branch,
              String(payload.workflow_run.id),
            );
          database.exec("COMMIT");
          return {
            status: 202 as const,
            outcome: "queued" as const,
          };
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      });
    },
    listAttempts() {
      return database
        .prepare(
          `SELECT id, workflow_run_id AS workflowRunId, status, repository, branch, revision,
                  workflow, job, model_alias AS modelAlias, runtime_alias AS runtimeAlias, summary,
                  input_tokens AS inputTokens, output_tokens AS outputTokens
           FROM repair_attempts ORDER BY id`,
        )
        .all()
        .map((row) => {
          const { inputTokens, outputTokens, ...attempt } = row as unknown as Omit<
            RepairAttemptMetadata,
            "inputTokens" | "outputTokens"
          > & {
            inputTokens: number | null;
            outputTokens: number | null;
          };
          return {
            ...attempt,
            ...(inputTokens === null ? {} : { inputTokens }),
            ...(outputTokens === null ? {} : { outputTokens }),
          };
        });
    },
    async workOnce() {
      const claimToken = randomUUID();
      database.exec("BEGIN IMMEDIATE");
      let attempt:
        | {
            id: number;
            workflowRunId: string;
            status: "queued" | "primary_failure" | "unresolved" | "stale";
            repository: string;
            revision: string;
            job: string;
            summary: string;
            installationId: number;
            workerState: "available" | "claimed" | "effect_pending";
          }
        | undefined;
      try {
        attempt = database
          .prepare(
            `SELECT id, workflow_run_id AS workflowRunId, status, repository, revision, job,
                    summary, installation_id AS installationId, worker_state AS workerState
             FROM repair_attempts
             WHERE check_status = 'pending' AND worker_state IN ('available', 'effect_pending')
             ORDER BY id LIMIT 1`,
          )
          .get() as
          | {
              id: number;
              workflowRunId: string;
              status: "queued" | "primary_failure" | "unresolved" | "stale";
              repository: string;
              revision: string;
              job: string;
              summary: string;
              installationId: number;
              workerState: "available" | "claimed" | "effect_pending";
            }
          | undefined;
        if (!attempt) {
          database.exec("COMMIT");
          return false;
        }
        if (attempt.workerState === "available") {
          const claimed = database
            .prepare(
              `UPDATE repair_attempts SET worker_state = 'claimed', claim_token = ?,
                      updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND worker_state = 'available' AND check_status = 'pending'`,
            )
            .run(claimToken, attempt.id);
          if (claimed.changes === 0) {
            database.exec("COMMIT");
            return false;
          }
          attempt.workerState = "claimed";
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      const [owner, repository] = attempt.repository.split("/") as [string, string];
      await options.github.ensureInitialCheck({
        owner,
        repository,
        installationId: attempt.installationId,
        revision: attempt.revision,
        externalId: `agentci-repair-attempt-${attempt.id}`,
        summary: attempt.summary,
      });

      let status = attempt.status;
      let summary = attempt.summary;
      if (status === "queued" && attempt.workerState === "claimed") {
        const unresolved = (explanation: string) => {
          status = "unresolved";
          summary = redactAndBoundSummary(`Unresolved Repair: ${explanation}`);
          database
            .prepare(
              `UPDATE repair_attempts
               SET status = 'unresolved', summary = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND worker_state = 'claimed' AND claim_token = ?`,
            )
            .run(summary, attempt.id, claimToken);
        };
        const jobs = await options.github.getWorkflowJobs({
          owner,
          repository,
          runId: attempt.workflowRunId,
          installationId: attempt.installationId,
        });
        const configuredFailedJobs = jobs.filter(
          (job) => job.name === attempt.job && job.conclusion === "failure",
        );
        if (configuredFailedJobs.length > 1) {
          unresolved("Multiple configured jobs failed; AgentCI cannot select one safely.");
        } else {
          const job = configuredFailedJobs[0];
          if (!job?.id) {
            unresolved("The configured failed job could not be identified safely.");
          } else if (!job.steps?.some((step) => step.conclusion === "failure")) {
            unresolved("No failed step could be identified safely.");
          } else if (!options.github.getWorkflowJobLog) {
            unresolved("The configured failed job log is unavailable.");
          } else {
            const log = await options.github.getWorkflowJobLog({
              owner,
              repository,
              installationId: attempt.installationId,
              jobId: job.id,
            });
            const identification = identifyPrimaryFailure([
              {
                id: job.id,
                name: job.name,
                conclusion: job.conclusion,
                steps: job.steps,
                log,
              },
            ]);
            if (identification.outcome === "unresolved") {
              unresolved(identification.explanation);
            } else if (!options.analyzer) {
              unresolved("No failure analyzer is configured.");
            } else {
              const contractSource = await options.github.getRepositoryContract({
                owner,
                repository,
                revision: attempt.revision,
                installationId: attempt.installationId,
              });
              const contract = contractSource ? parseRepositoryContract(contractSource) : undefined;
              const allowlist = validateAllowedFilePatterns(contract?.allowedPaths ?? []);
              if (allowlist.outcome === "rejected") {
                unresolved(allowlist.explanation);
              } else {
                let analysis: FailureAnalysis;
                try {
                  const result: unknown = await options.analyzer.analyzeFailure(
                    buildModelEvidence(identification.failure, allowlist.patterns),
                  );
                  if (!validFailureAnalysis(result)) {
                    throw new Error("Invalid failure analysis.");
                  }
                  analysis = result;
                } catch {
                  unresolved("Failure analysis could not be completed.");
                  analysis = {
                    actionable: false,
                    summary: "Failure analysis could not be completed.",
                    requestedFiles: [],
                  };
                }
                const inputTokens = usageCount(analysis.usage?.inputTokens);
                const outputTokens = usageCount(analysis.usage?.outputTokens);
                database
                  .prepare(
                    `UPDATE repair_attempts SET input_tokens = ?, output_tokens = ?,
                            updated_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND worker_state = 'claimed' AND claim_token = ?`,
                  )
                  .run(inputTokens, outputTokens, attempt.id, claimToken);
                if (status === "queued") {
                  const requested = validateRequestedFiles(
                    analysis.requestedFiles,
                    allowlist.patterns,
                  );
                  if (!analysis.actionable) {
                    unresolved(redactAndBoundSummary(analysis.summary));
                  } else if (requested.outcome === "rejected") {
                    unresolved(requested.explanation);
                  } else {
                    status = "primary_failure";
                    summary = redactAndBoundSummary(
                      `Primary Failure: ${identification.failure.jobName} / ${identification.failure.stepName} (step ${identification.failure.stepNumber}). ${analysis.summary}`,
                    );
                    database
                      .prepare(
                        `UPDATE repair_attempts
                       SET status = 'primary_failure', summary = ?, primary_job_id = ?,
                           primary_step_number = ?, primary_step_name = ?, input_tokens = ?,
                           output_tokens = ?, updated_at = CURRENT_TIMESTAMP
                       WHERE id = ? AND worker_state = 'claimed' AND claim_token = ?`,
                      )
                      .run(
                        summary,
                        identification.failure.jobId,
                        identification.failure.stepNumber,
                        identification.failure.stepName,
                        inputTokens,
                        outputTokens,
                        attempt.id,
                        claimToken,
                      );
                  }
                }
              }
            }
          }
        }
      }

      if (attempt.workerState === "claimed") {
        database
          .prepare(
            `UPDATE repair_attempts
             SET worker_state = 'effect_pending', claim_token = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND worker_state = 'claimed' AND claim_token = ?`,
          )
          .run(attempt.id, claimToken);
        const current = database
          .prepare("SELECT status, summary FROM repair_attempts WHERE id = ?")
          .get(attempt.id) as { status: typeof status; summary: string };
        status = current.status;
        summary = current.summary;
      }

      if (options.github.updateCheck) {
        await options.github.updateCheck({
          owner,
          repository,
          installationId: attempt.installationId,
          revision: attempt.revision,
          externalId: `agentci-repair-attempt-${attempt.id}`,
          status: status === "unresolved" || status === "stale" ? "completed" : "in_progress",
          ...(status === "unresolved" || status === "stale"
            ? { conclusion: "neutral" as const }
            : {}),
          title:
            status === "stale"
              ? "AgentCI stopped a Stale Repair"
              : status === "unresolved"
                ? "AgentCI could not identify an actionable Primary Failure"
                : "AgentCI identified a Primary Failure",
          summary,
        });
      }
      database
        .prepare(
          `UPDATE repair_attempts
           SET check_status = 'reported', worker_state = 'done', updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND worker_state = 'effect_pending'`,
        )
        .run(attempt.id);
      return true;
    },
    async transition(input) {
      const result = database
        .prepare(
          `UPDATE repair_attempts SET status = ?, updated_at = ?
           WHERE id = ? AND status NOT IN ('stale', 'validated', 'unresolved')`,
        )
        .run(input.status, input.at, input.attemptId);
      if (result.changes === 0 && input.status === "validated") {
        database
          .prepare(
            "UPDATE repair_attempts SET updated_at = ? WHERE id = ? AND status = 'validated'",
          )
          .run(input.at, input.attemptId);
      }
    },
    async publishIfCurrent(input, publish) {
      return exclusively(async () => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const current = database
            .prepare(
              `SELECT id FROM repair_attempts AS candidate
               WHERE candidate.id = ? AND candidate.status = 'publishing'
                 AND NOT EXISTS (
                   SELECT 1 FROM repair_attempts AS newer
                   WHERE newer.repository = candidate.repository
                     AND newer.branch = candidate.branch AND newer.id > candidate.id
                 )`,
            )
            .get(input.attemptId);
          database.exec("COMMIT");
          if (!current) return { outcome: "stale" as const };
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        const value = await publish();
        database
          .prepare(
            `UPDATE repair_attempts SET status = 'validated', updated_at = ?
             WHERE id = ? AND status = 'publishing'`,
          )
          .run(input.at, input.attemptId);
        return { outcome: "published" as const, value };
      });
    },
    close() {
      database.close();
    },
  };
}
