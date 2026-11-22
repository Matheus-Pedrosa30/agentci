import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { FailureAnalysis, FailureAnalyzer } from "./failure-analyzer.ts";
import {
  buildModelEvidence,
  identifyPrimaryFailure,
  redactAndBoundSummary,
  validateAllowedFilePatterns,
  validateRequestedFiles,
  type PrimaryFailure,
} from "./failure-evidence.ts";
import type { PolicyProposal } from "./proposal-policy.ts";
import { parseRepositoryContract } from "./repository-contract.ts";

export interface GitHubIntakeApi {
  getRepositoryPermission?(input: {
    installationId: number;
    owner: string;
    repository: string;
    username: string;
  }): Promise<"admin" | "maintain" | "write" | "triage" | "read" | "none">;
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
  /** Stable AgentCI identifier; distinct from the originating GitHub workflow run ID. */
  attemptKey: string;
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
  parentAttemptId?: number;
  rootAttemptId?: number;
  action?: "initial" | "retry" | "continuation";
  primaryFailure?: Omit<PrimaryFailure, "log">;
  cumulativeChangedFileCount?: number;
  cumulativeChangedLines?: number;
}

export interface IntakeOptions {
  databasePath: string;
  webhookSecret: string;
  aliases: { models: readonly string[]; runtimes: readonly string[] };
  github: GitHubIntakeApi;
  analyzer?: FailureAnalyzer;
  now?: () => Date;
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
  offerRetry(input: { attemptId: string; at: string; expiresAt: string }): Promise<string>;
  offerContinuation(input: {
    attemptId: string;
    at: string;
    expiresAt: string;
    proposal: PolicyProposal;
    revealedFailure: PrimaryFailure;
    cumulativeChangedFiles: readonly string[];
    cumulativeChangedLines: number;
  }): Promise<string>;
  takeContinuationContext(
    attemptId: string,
  ): { proposal: PolicyProposal; revealedFailure: PrimaryFailure } | undefined;
  close(): void;
}

interface CheckActionPayload {
  action: "requested_action";
  installation: { id: number };
  repository: { full_name: string };
  sender: { login: string };
  requested_action: { identifier: string };
  check_run: { external_id: string; head_sha: string };
}

interface AttemptRow {
  workflow_run_id: string;
  source_workflow_run_id: string | null;
  repository: string;
  branch: string;
  revision: string;
  workflow: string;
  job: string;
  model_alias: string;
  runtime_alias: string;
  installation_id: number;
  primary_job_id: string | null;
  primary_job_name: string | null;
  primary_step_number: number | null;
  primary_step_name: string | null;
  root_attempt_id: number | null;
}

interface OfferedRepairAction {
  attemptId: number;
  kind: "retry" | "continuation";
  expiresAt: string;
  consumedAt: string | null;
  repository: string;
  revision: string;
  installationId: number;
}

interface ContinuationLineage {
  revealedFailure: Omit<PrimaryFailure, "log">;
  cumulativeChangedFileCount: number;
  cumulativeChangedLines: number;
}

/** Persistence seam for the action invariant: consume once and create exactly one linked attempt. */
interface AttemptRepository {
  findOfferedAction(identifier: string): OfferedRepairAction | undefined;
  consumeActionAndCreateLinkedAttempt(input: {
    identifier: string;
    at: string;
    continuation?: ContinuationLineage;
  }):
    | { outcome: "ignored" }
    | {
        outcome: "queued";
        attemptId: string;
        sourceAttemptId: string;
        kind: "retry" | "continuation";
        expiresAt: string;
      };
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

function parseCheckAction(body: Uint8Array): CheckActionPayload | undefined {
  try {
    const payload = object(JSON.parse(Buffer.from(body).toString("utf8")));
    const installation = object(payload?.installation);
    const repository = object(payload?.repository);
    const sender = object(payload?.sender);
    const requestedAction = object(payload?.requested_action);
    const checkRun = object(payload?.check_run);
    if (
      payload?.action !== "requested_action" ||
      typeof installation?.id !== "number" ||
      typeof repository?.full_name !== "string" ||
      typeof sender?.login !== "string" ||
      typeof requestedAction?.identifier !== "string" ||
      typeof checkRun?.external_id !== "string" ||
      typeof checkRun.head_sha !== "string"
    ) {
      return undefined;
    }
    return {
      action: "requested_action",
      installation: { id: installation.id },
      repository: { full_name: repository.full_name },
      sender: { login: sender.login },
      requested_action: { identifier: requestedAction.identifier },
      check_run: { external_id: checkRun.external_id, head_sha: checkRun.head_sha },
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
      source_workflow_run_id TEXT,
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
      primary_job_name TEXT,
      primary_step_number INTEGER,
      primary_step_name TEXT,
      parent_attempt_id INTEGER,
      root_attempt_id INTEGER,
      action TEXT,
      cumulative_changed_file_count INTEGER,
      cumulative_changed_lines INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      worker_state TEXT NOT NULL DEFAULT 'available',
      claim_token TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS repair_actions (
      identifier TEXT PRIMARY KEY,
      attempt_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS repair_actions_one_kind_per_attempt
      ON repair_actions(attempt_id, kind);
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
    [
      "source_workflow_run_id",
      "ALTER TABLE repair_attempts ADD COLUMN source_workflow_run_id TEXT",
    ],
    ["primary_job_id", "ALTER TABLE repair_attempts ADD COLUMN primary_job_id TEXT"],
    ["primary_job_name", "ALTER TABLE repair_attempts ADD COLUMN primary_job_name TEXT"],
    ["primary_step_number", "ALTER TABLE repair_attempts ADD COLUMN primary_step_number INTEGER"],
    ["primary_step_name", "ALTER TABLE repair_attempts ADD COLUMN primary_step_name TEXT"],
    ["parent_attempt_id", "ALTER TABLE repair_attempts ADD COLUMN parent_attempt_id INTEGER"],
    ["root_attempt_id", "ALTER TABLE repair_attempts ADD COLUMN root_attempt_id INTEGER"],
    ["action", "ALTER TABLE repair_attempts ADD COLUMN action TEXT"],
    [
      "cumulative_changed_file_count",
      "ALTER TABLE repair_attempts ADD COLUMN cumulative_changed_file_count INTEGER",
    ],
    [
      "cumulative_changed_lines",
      "ALTER TABLE repair_attempts ADD COLUMN cumulative_changed_lines INTEGER",
    ],
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
  if (!attemptColumns.has("source_workflow_run_id")) {
    database.exec("UPDATE repair_attempts SET source_workflow_run_id = workflow_run_id");
  }
  if (attemptColumns.has("cumulative_changed_files")) {
    database.exec("PRAGMA secure_delete = ON");
    database.exec("UPDATE repair_attempts SET cumulative_changed_files = NULL");
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
  database
    .prepare(
      `UPDATE repair_attempts
       SET status = 'unresolved',
           summary = 'Unresolved Repair: Continuation baseline expired during interruption.',
           worker_state = 'effect_pending', claim_token = NULL, check_status = 'pending',
           updated_at = CURRENT_TIMESTAMP
       WHERE action = 'continuation' AND status = 'primary_failure'
         AND worker_state IN ('available', 'effect_pending')`,
    )
    .run();
  database
    .prepare("DELETE FROM repair_actions WHERE kind = 'continuation' AND consumed_at IS NULL")
    .run();

  let exclusiveTail = Promise.resolve();
  const offeredContinuations = new Map<
    string,
    {
      proposal: PolicyProposal;
      revealedFailure: PrimaryFailure;
      cumulativeChangedFiles: readonly string[];
      cumulativeChangedLines: number;
      cleanupTimer: NodeJS.Timeout;
    }
  >();
  const queuedContinuationContexts = new Map<
    string,
    {
      proposal: PolicyProposal;
      revealedFailure: PrimaryFailure;
      cleanupTimer: NodeJS.Timeout;
    }
  >();
  function cleanupOfferedContinuation(identifier: string): void {
    const context = offeredContinuations.get(identifier);
    if (context) clearTimeout(context.cleanupTimer);
    offeredContinuations.delete(identifier);
  }
  function cleanupQueuedContinuation(attemptId: string): void {
    const context = queuedContinuationContexts.get(attemptId);
    if (context) clearTimeout(context.cleanupTimer);
    queuedContinuationContexts.delete(attemptId);
  }
  function cleanupDelay(at: string, expiresAt: string): number {
    return Math.max(1, Date.parse(expiresAt) - Date.parse(at));
  }
  const attemptRepository: AttemptRepository = {
    findOfferedAction(identifier) {
      return database
        .prepare(
          `SELECT actions.attempt_id AS attemptId, actions.kind, actions.expires_at AS expiresAt,
                  actions.consumed_at AS consumedAt, attempts.repository, attempts.revision,
                  attempts.installation_id AS installationId
           FROM repair_actions AS actions
           JOIN repair_attempts AS attempts ON attempts.id = actions.attempt_id
           WHERE actions.identifier = ?`,
        )
        .get(identifier) as OfferedRepairAction | undefined;
    },
    consumeActionAndCreateLinkedAttempt(input) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const action = this.findOfferedAction(input.identifier);
        if (
          !action ||
          action.consumedAt ||
          Date.parse(action.expiresAt) <= Date.parse(input.at) ||
          (action.kind === "continuation" && !input.continuation)
        ) {
          database.exec("COMMIT");
          return { outcome: "ignored" };
        }
        const source = database
          .prepare("SELECT * FROM repair_attempts WHERE id = ? AND status = 'unresolved'")
          .get(action.attemptId) as AttemptRow | undefined;
        if (!source) {
          database.exec("COMMIT");
          return { outcome: "ignored" };
        }
        const rootAttemptId = Number(source.root_attempt_id ?? action.attemptId);
        const root = database
          .prepare("SELECT * FROM repair_attempts WHERE id = ?")
          .get(rootAttemptId) as AttemptRow | undefined;
        if (!root) throw new Error("Repair Attempt root is unavailable.");

        const consumed = database
          .prepare(
            `UPDATE repair_actions SET consumed_at = ?
             WHERE identifier = ? AND consumed_at IS NULL AND expires_at > ?`,
          )
          .run(input.at, input.identifier, input.at);
        if (consumed.changes === 0) {
          database.exec("COMMIT");
          return { outcome: "ignored" };
        }

        // The legacy column stores AgentCI's attempt key. source_workflow_run_id is the
        // actual GitHub workflow-run identifier shared by every attempt in the lineage.
        const workflowRunId = String(root.source_workflow_run_id ?? root.workflow_run_id);
        const attemptKey = `${workflowRunId}:${action.kind}:${input.identifier}`;
        const selectedFailure = input.continuation?.revealedFailure;
        const inserted = database
          .prepare(
            `INSERT INTO repair_attempts
             (workflow_run_id, source_workflow_run_id, status, repository, branch, revision,
              workflow, job, model_alias, runtime_alias, summary, installation_id,
              primary_job_id, primary_job_name, primary_step_number, primary_step_name,
              parent_attempt_id, root_attempt_id, action,
              cumulative_changed_file_count, cumulative_changed_lines)
             VALUES (?, ?, 'primary_failure', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            attemptKey,
            workflowRunId,
            root.repository,
            root.branch,
            root.revision,
            root.workflow,
            root.job,
            root.model_alias,
            root.runtime_alias,
            action.kind === "retry"
              ? "Retry queued from the original revision and Primary Failure."
              : "Continuation queued with the accepted proposal as its baseline.",
            root.installation_id,
            selectedFailure?.jobId ?? root.primary_job_id,
            selectedFailure?.jobName ?? root.primary_job_name ?? root.job,
            selectedFailure?.stepNumber ?? root.primary_step_number,
            selectedFailure?.stepName ?? root.primary_step_name,
            action.attemptId,
            rootAttemptId,
            action.kind,
            action.kind === "continuation"
              ? (input.continuation?.cumulativeChangedFileCount ?? null)
              : null,
            action.kind === "continuation"
              ? (input.continuation?.cumulativeChangedLines ?? null)
              : null,
          );
        if (inserted.changes !== 1) throw new Error("Repair Attempt could not be queued.");
        database.exec("COMMIT");
        return {
          outcome: "queued",
          attemptId: String(inserted.lastInsertRowid),
          sourceAttemptId: String(action.attemptId),
          kind: action.kind,
          expiresAt: action.expiresAt,
        };
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    },
  };
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
      if (delivery.event === "check_run") {
        const payload = parseCheckAction(delivery.body);
        if (!payload || !delivery.deliveryId) return { status: 422, outcome: "rejected" };
        const [owner, repository, extra] = payload.repository.full_name.split("/");
        if (!owner || !repository || extra) return { status: 422, outcome: "rejected" };
        const action = attemptRepository.findOfferedAction(payload.requested_action.identifier);
        if (!action || action.consumedAt) return { status: 202, outcome: "ignored" };
        const continuation = offeredContinuations.get(payload.requested_action.identifier);
        if (action.kind === "continuation" && !continuation) {
          return { status: 202, outcome: "ignored" };
        }
        if (Date.parse(action.expiresAt) <= (options.now?.() ?? new Date()).getTime()) {
          cleanupOfferedContinuation(payload.requested_action.identifier);
          return { status: 202, outcome: "ignored" };
        }
        if (
          action.repository !== payload.repository.full_name ||
          action.revision !== payload.check_run.head_sha ||
          action.installationId !== payload.installation.id ||
          payload.check_run.external_id !== `agentci-repair-attempt-${action.attemptId}`
        ) {
          return { status: 202, outcome: "ignored" };
        }
        const permission = await options.github.getRepositoryPermission?.({
          owner,
          repository,
          installationId: payload.installation.id,
          username: payload.sender.login,
        });
        if (!permission || !["admin", "maintain", "write"].includes(permission)) {
          return { status: 202, outcome: "ignored" };
        }
        return exclusively(() => {
          const now = (options.now?.() ?? new Date()).toISOString();
          const result = attemptRepository.consumeActionAndCreateLinkedAttempt({
            identifier: payload.requested_action.identifier,
            at: now,
            ...(continuation
              ? {
                  continuation: {
                    revealedFailure: {
                      jobId: continuation.revealedFailure.jobId,
                      jobName: continuation.revealedFailure.jobName,
                      stepNumber: continuation.revealedFailure.stepNumber,
                      stepName: continuation.revealedFailure.stepName,
                    },
                    cumulativeChangedFileCount: new Set(continuation.cumulativeChangedFiles).size,
                    cumulativeChangedLines: continuation.cumulativeChangedLines,
                  },
                }
              : {}),
          });
          if (result.outcome === "ignored") {
            return { status: 202 as const, outcome: "ignored" as const };
          }
          if (result.kind === "continuation" && continuation) {
            const linkedAttemptId = result.attemptId;
            cleanupOfferedContinuation(payload.requested_action.identifier);
            const cleanupTimer = setTimeout(
              () => {
                queuedContinuationContexts.delete(linkedAttemptId);
                database
                  .prepare(
                    `UPDATE repair_attempts
                     SET status = 'unresolved',
                         summary = 'Unresolved Repair: Continuation baseline expired before processing.',
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND action = 'continuation' AND status = 'primary_failure'
                       AND worker_state = 'available'`,
                  )
                  .run(linkedAttemptId);
              },
              cleanupDelay(now, result.expiresAt),
            );
            cleanupTimer.unref();
            queuedContinuationContexts.set(linkedAttemptId, {
              proposal: continuation.proposal,
              revealedFailure: continuation.revealedFailure,
              cleanupTimer,
            });
          }
          if (result.kind === "retry") cleanupQueuedContinuation(result.sourceAttemptId);
          return { status: 202 as const, outcome: "queued" as const };
        });
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
               source_workflow_run_id, model_alias, runtime_alias, summary, installation_id, action)
             VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 'Eligible failed workflow queued.', ?, 'initial')`,
            )
            .run(
              String(payload.workflow_run.id),
              payload.repository.full_name,
              payload.workflow_run.head_branch,
              payload.workflow_run.head_sha,
              contract.workflow,
              contract.job,
              String(payload.workflow_run.id),
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
          `SELECT id, workflow_run_id AS attemptKey,
                  COALESCE(source_workflow_run_id, workflow_run_id) AS workflowRunId,
                  status, repository, branch, revision,
                  workflow, job, model_alias AS modelAlias, runtime_alias AS runtimeAlias, summary,
                  input_tokens AS inputTokens, output_tokens AS outputTokens,
                  parent_attempt_id AS parentAttemptId, root_attempt_id AS rootAttemptId, action,
                  primary_job_id AS primaryJobId, primary_job_name AS primaryJobName,
                  primary_step_number AS primaryStepNumber, primary_step_name AS primaryStepName,
                  cumulative_changed_file_count AS cumulativeChangedFileCount,
                  cumulative_changed_lines AS cumulativeChangedLines
           FROM repair_attempts ORDER BY id`,
        )
        .all()
        .map((row) => {
          const {
            inputTokens,
            outputTokens,
            parentAttemptId,
            rootAttemptId,
            action,
            primaryJobId,
            primaryJobName,
            primaryStepNumber,
            primaryStepName,
            cumulativeChangedFileCount,
            cumulativeChangedLines,
            ...attempt
          } = row as unknown as Omit<RepairAttemptMetadata, "inputTokens" | "outputTokens"> & {
            inputTokens: number | null;
            outputTokens: number | null;
            parentAttemptId: number | null;
            rootAttemptId: number | null;
            action: "initial" | "retry" | "continuation" | null;
            primaryJobId: string | null;
            primaryJobName: string | null;
            primaryStepNumber: number | null;
            primaryStepName: string | null;
            cumulativeChangedFileCount: number | null;
            cumulativeChangedLines: number | null;
          };
          return {
            ...attempt,
            ...(inputTokens === null ? {} : { inputTokens }),
            ...(outputTokens === null ? {} : { outputTokens }),
            ...(parentAttemptId === null ? {} : { parentAttemptId }),
            ...(rootAttemptId === null ? {} : { rootAttemptId }),
            ...(action === null || action === "initial" ? {} : { action }),
            ...(primaryJobId === null ||
            primaryJobName === null ||
            primaryStepNumber === null ||
            primaryStepName === null
              ? {}
              : {
                  primaryFailure: {
                    jobId: primaryJobId,
                    jobName: primaryJobName,
                    stepNumber: primaryStepNumber,
                    stepName: primaryStepName,
                  },
                }),
            ...(cumulativeChangedFileCount === null ? {} : { cumulativeChangedFileCount }),
            ...(cumulativeChangedLines === null ? {} : { cumulativeChangedLines }),
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
                           primary_job_name = ?, primary_step_number = ?, primary_step_name = ?, input_tokens = ?,
                           output_tokens = ?, updated_at = CURRENT_TIMESTAMP
                       WHERE id = ? AND worker_state = 'claimed' AND claim_token = ?`,
                      )
                      .run(
                        summary,
                        identification.failure.jobId,
                        identification.failure.jobName,
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
    async offerRetry(input) {
      const identifier = `r-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const result = database
        .prepare(
          `INSERT INTO repair_actions (identifier, attempt_id, kind, expires_at)
           SELECT ?, id, 'retry', ? FROM repair_attempts
           WHERE id = ? AND status = 'unresolved' AND ? < ?`,
        )
        .run(identifier, input.expiresAt, input.attemptId, input.at, input.expiresAt);
      if (result.changes !== 1) throw new Error("Retry is not available for this Repair Attempt.");
      return identifier;
    },
    async offerContinuation(input) {
      const identifier = `c-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const result = database
        .prepare(
          `INSERT INTO repair_actions (identifier, attempt_id, kind, expires_at)
           SELECT ?, id, 'continuation', ? FROM repair_attempts
           WHERE id = ? AND status = 'unresolved' AND ? < ?`,
        )
        .run(identifier, input.expiresAt, input.attemptId, input.at, input.expiresAt);
      if (result.changes !== 1) {
        throw new Error("Continuation is not available for this Repair Attempt.");
      }
      offeredContinuations.set(identifier, {
        proposal: input.proposal,
        revealedFailure: input.revealedFailure,
        cumulativeChangedFiles: [...input.cumulativeChangedFiles],
        cumulativeChangedLines: input.cumulativeChangedLines,
        cleanupTimer: (() => {
          const timer = setTimeout(
            () => offeredContinuations.delete(identifier),
            cleanupDelay(input.at, input.expiresAt),
          );
          timer.unref();
          return timer;
        })(),
      });
      return identifier;
    },
    takeContinuationContext(attemptId) {
      const context = queuedContinuationContexts.get(attemptId);
      if (!context) return undefined;
      cleanupQueuedContinuation(attemptId);
      return { proposal: context.proposal, revealedFailure: context.revealedFailure };
    },
    close() {
      for (const context of offeredContinuations.values()) clearTimeout(context.cleanupTimer);
      for (const context of queuedContinuationContexts.values()) clearTimeout(context.cleanupTimer);
      offeredContinuations.clear();
      queuedContinuationContexts.clear();
      database.close();
    },
  };
}
