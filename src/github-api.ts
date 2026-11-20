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
      const response = await fetchGitHub(
        `${repositoryUrl(input.owner, input.repository)}/actions/runs/${encodeURIComponent(input.runId)}/jobs`,
        { headers: await installationHeaders(input.installationId) },
      );
      if (!response.ok) throw new Error("GitHub workflow job retrieval failed.");
      const value = (await response.json()) as { jobs?: unknown };
      if (!Array.isArray(value.jobs)) throw new Error("GitHub returned invalid workflow jobs.");
      return value.jobs.flatMap((job) => {
        if (
          typeof job === "object" &&
          job !== null &&
          "name" in job &&
          typeof job.name === "string" &&
          "conclusion" in job &&
          (typeof job.conclusion === "string" || job.conclusion === null)
        ) {
          return [{ name: job.name, conclusion: job.conclusion }];
        }
        return [];
      });
    },
    async createInitialCheck(input) {
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
  };
}
