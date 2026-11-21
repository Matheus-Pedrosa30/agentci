import { generateKeyPairSync } from "node:crypto";

import { expect, it } from "vitest";

import { createGitHubAppIntakeApi } from "../src/github-api.js";

it("reads the exact-revision Repository Contract through an installation-scoped GitHub API token", async () => {
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  }).privateKey;
  const requests: { url: string; authorization: string | null }[] = [];
  const api = createGitHubAppIntakeApi({
    appId: "12345",
    privateKey,
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/app/installations/99/access_tokens")) {
        return Response.json({ token: "installation-token" });
      }
      return Response.json({
        encoding: "base64",
        content: Buffer.from('{"version":1}').toString("base64"),
      });
    },
  });

  await expect(
    api.getRepositoryContract({
      installationId: 99,
      owner: "example",
      repository: "repository",
      revision: "0123456789abcdef0123456789abcdef01234567",
    }),
  ).resolves.toBe('{"version":1}');
  expect(requests).toEqual([
    {
      url: "https://api.github.com/app/installations/99/access_tokens",
      authorization: expect.stringMatching(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/u),
    },
    {
      url: "https://api.github.com/repos/example/repository/contents/.agentci.json?ref=0123456789abcdef0123456789abcdef01234567",
      authorization: "Bearer installation-token",
    },
  ]);
});

it("paginates workflow jobs before deciding eligibility", async () => {
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  }).privateKey;
  const requestedPages: string[] = [];
  const api = createGitHubAppIntakeApi({
    appId: "12345",
    privateKey,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/app/installations/99/access_tokens")) {
        return Response.json({ token: "installation-token" });
      }
      requestedPages.push(url);
      if (url.endsWith("per_page=100&page=1")) {
        return Response.json({
          jobs: Array.from({ length: 100 }, (_, index) => ({
            name: `matrix-${index}`,
            conclusion: "success",
          })),
        });
      }
      return Response.json({ jobs: [{ name: "test", conclusion: "failure" }] });
    },
  });

  await expect(
    api.getWorkflowJobs({
      installationId: 99,
      owner: "example",
      repository: "repository",
      runId: "4242",
    }),
  ).resolves.toHaveLength(101);
  expect(requestedPages).toEqual([
    "https://api.github.com/repos/example/repository/actions/runs/4242/jobs?per_page=100&page=1",
    "https://api.github.com/repos/example/repository/actions/runs/4242/jobs?per_page=100&page=2",
  ]);
});

it("reconciles an initial Check by stable external ID after an ambiguous create response", async () => {
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  }).privateKey;
  let checkExists = false;
  let createRequests = 0;
  const api = createGitHubAppIntakeApi({
    appId: "12345",
    privateKey,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app/installations/99/access_tokens")) {
        return Response.json({ token: "installation-token" });
      }
      if (init?.method === "POST") {
        createRequests += 1;
        checkExists = true;
        throw new TypeError("connection closed after GitHub accepted the Check");
      }
      return Response.json({
        check_runs: checkExists
          ? [{ external_id: "agentci-repair-attempt-1", app: { id: 12345 } }]
          : [],
      });
    },
  });
  const input = {
    installationId: 99,
    owner: "example",
    repository: "repository",
    revision: "0123456789abcdef0123456789abcdef01234567",
    externalId: "agentci-repair-attempt-1",
    summary: "Eligible failed workflow queued.",
  };

  await expect(api.ensureInitialCheck(input)).rejects.toThrow("connection closed");
  await expect(api.ensureInitialCheck(input)).resolves.toBeUndefined();
  expect(createRequests).toBe(1);
});
