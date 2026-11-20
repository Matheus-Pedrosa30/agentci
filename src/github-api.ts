import { sign } from "node:crypto";

import type { GitHubIntakeApi } from "./intake.ts";

interface GitHubAppApiOptions {
  appId: string;
  privateKey: string;
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

function jwt(options: GitHubAppApiOptions): string {
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: now - 60,
    exp: now + 540,
    iss: options.appId,
  })}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), options.privateKey).toString("base64url")}`;
}

export function createGitHubAppIntakeApi(options: GitHubAppApiOptions): GitHubIntakeApi {
  const fetchGitHub = options.fetch ?? globalThis.fetch;
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/u, "");
  const commonHeaders = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };

  async function installationToken(installationId: number): Promise<string> {
    const response = await fetchGitHub(
      `${apiUrl}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: { ...commonHeaders, authorization: `Bearer ${jwt(options)}` },
      },
    );
    if (!response.ok) throw new Error("GitHub installation authentication failed.");
    const value = (await response.json()) as { token?: unknown };
    if (typeof value.token !== "string")
      throw new Error("GitHub returned an invalid access token.");
    return value.token;
  }

  async function installationHeaders(installationId: number): Promise<Record<string, string>> {
    return {
      ...commonHeaders,
      authorization: `Bearer ${await installationToken(installationId)}`,
    };
  }

  function repositoryUrl(owner: string, repository: string): string {
    return `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  }

  return {
    async getRepositoryContract(input) {
      const response = await fetchGitHub(
        `${repositoryUrl(input.owner, input.repository)}/contents/.agentci.json?ref=${encodeURIComponent(input.revision)}`,
        { headers: await installationHeaders(input.installationId) },
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("GitHub Repository Contract retrieval failed.");
      const value = (await response.json()) as { encoding?: unknown; content?: unknown };
      if (value.encoding !== "base64" || typeof value.content !== "string") {
        throw new Error("GitHub returned an invalid Repository Contract.");
      }
      return Buffer.from(value.content.replace(/\s/gu, ""), "base64").toString("utf8");
    },
    async getWorkflowJobs(input) {
      const jobs: {
        id?: string;
        name: string;
        conclusion: string | null;
        steps?: { number: number; name: string; conclusion: string | null }[];
      }[] = [];
      for (let page = 1; ; page += 1) {
        const response = await fetchGitHub(
          `${repositoryUrl(input.owner, input.repository)}/actions/runs/${encodeURIComponent(input.runId)}/jobs?per_page=100&page=${page}`,
          { headers: await installationHeaders(input.installationId) },
        );
        if (!response.ok) throw new Error("GitHub workflow job retrieval failed.");
        const value = (await response.json()) as { jobs?: unknown };
        if (!Array.isArray(value.jobs)) throw new Error("GitHub returned invalid workflow jobs.");
        for (const job of value.jobs) {
          if (
            typeof job === "object" &&
            job !== null &&
            "name" in job &&
            typeof job.name === "string" &&
            "conclusion" in job &&
            (typeof job.conclusion === "string" || job.conclusion === null)
          ) {
            const id =
              "id" in job && (typeof job.id === "number" || typeof job.id === "string")
                ? String(job.id)
                : undefined;
            const steps =
              "steps" in job && Array.isArray(job.steps)
                ? job.steps.flatMap((step: unknown) => {
                    if (
                      typeof step !== "object" ||
                      step === null ||
                      !("number" in step) ||
                      typeof step.number !== "number" ||
                      !("name" in step) ||
                      typeof step.name !== "string" ||
                      !("conclusion" in step) ||
                      (typeof step.conclusion !== "string" && step.conclusion !== null)
                    ) {
                      return [];
                    }
                    return [{ number: step.number, name: step.name, conclusion: step.conclusion }];
                  })
                : undefined;
            jobs.push({
              name: job.name,
              conclusion: job.conclusion,
              ...(id ? { id } : {}),
              ...(steps ? { steps } : {}),
            });
          }
        }
        if (value.jobs.length < 100) return jobs;
      }
    },
    async getWorkflowJobLog(input) {
      const response = await fetchGitHub(
        `${repositoryUrl(input.owner, input.repository)}/actions/jobs/${encodeURIComponent(input.jobId)}/logs`,
        { headers: await installationHeaders(input.installationId) },
      );
      if (!response.ok) throw new Error("GitHub workflow job log retrieval failed.");
      return response.text();
    },
    async ensureInitialCheck(input) {
      for (let page = 1; ; page += 1) {
        const existingResponse = await fetchGitHub(
          `${repositoryUrl(input.owner, input.repository)}/commits/${encodeURIComponent(input.revision)}/check-runs?check_name=AgentCI&filter=all&per_page=100&page=${page}`,
          { headers: await installationHeaders(input.installationId) },
        );
        if (!existingResponse.ok) throw new Error("GitHub Check reconciliation failed.");
        const value = (await existingResponse.json()) as { check_runs?: unknown };
        if (!Array.isArray(value.check_runs)) {
          throw new Error("GitHub returned invalid Check reconciliation data.");
        }
        if (
          value.check_runs.some(
            (check) =>
              typeof check === "object" &&
              check !== null &&
              "external_id" in check &&
              check.external_id === input.externalId &&
              "app" in check &&
              typeof check.app === "object" &&
              check.app !== null &&
              "id" in check.app &&
              check.app.id === Number(options.appId),
          )
        ) {
          return;
        }
        if (value.check_runs.length < 100) break;
      }
      const response = await fetchGitHub(
        `${repositoryUrl(input.owner, input.repository)}/check-runs`,
        {
          method: "POST",
          headers: {
            ...(await installationHeaders(input.installationId)),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "AgentCI",
            head_sha: input.revision,
            status: "queued",
            external_id: input.externalId,
            output: { title: "AgentCI Repair Attempt queued", summary: input.summary },
          }),
        },
      );
      if (!response.ok) throw new Error("GitHub Check creation failed.");
    },
    async updateCheck(input) {
      let checkId: string | undefined;
      for (let page = 1; ; page += 1) {
        const existingResponse = await fetchGitHub(
          `${repositoryUrl(input.owner, input.repository)}/commits/${encodeURIComponent(input.revision)}/check-runs?check_name=AgentCI&filter=all&per_page=100&page=${page}`,
          { headers: await installationHeaders(input.installationId) },
        );
        if (!existingResponse.ok) throw new Error("GitHub Check reconciliation failed.");
        const value = (await existingResponse.json()) as { check_runs?: unknown };
        if (!Array.isArray(value.check_runs)) {
          throw new Error("GitHub returned invalid Check reconciliation data.");
        }
        const check = value.check_runs.find(
          (candidate) =>
            typeof candidate === "object" &&
            candidate !== null &&
            "external_id" in candidate &&
            candidate.external_id === input.externalId &&
            "app" in candidate &&
            typeof candidate.app === "object" &&
            candidate.app !== null &&
            "id" in candidate.app &&
            candidate.app.id === Number(options.appId) &&
            "id" in candidate &&
            (typeof candidate.id === "number" || typeof candidate.id === "string"),
        ) as { id: number | string } | undefined;
        if (check) {
          checkId = String(check.id);
          break;
        }
        if (value.check_runs.length < 100) break;
      }
      if (!checkId) throw new Error("AgentCI Check could not be reconciled.");
      const response = await fetchGitHub(
        `${repositoryUrl(input.owner, input.repository)}/check-runs/${encodeURIComponent(checkId)}`,
        {
          method: "PATCH",
          headers: {
            ...(await installationHeaders(input.installationId)),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            status: input.status,
            ...(input.conclusion ? { conclusion: input.conclusion } : {}),
            output: { title: input.title, summary: input.summary },
          }),
        },
      );
      if (!response.ok) throw new Error("GitHub Check update failed.");
    },
  };
}
