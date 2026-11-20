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
