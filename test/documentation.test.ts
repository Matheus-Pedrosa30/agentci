import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { parseRepositoryContract } from "../src/repository-contract.js";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

function fencedExample(document: string, name: string): string {
  const start = document.indexOf(`<!-- ${name}:start -->`);
  const end = document.indexOf(`<!-- ${name}:end -->`);
  if (start === -1 || end === -1 || end <= start) throw new Error(`Missing ${name} example.`);
  const section = document.slice(start, end);
  const match = section.match(/```(?:json|ts)\s*([\s\S]*?)```/u);
  if (!match?.[1]) throw new Error(`Missing ${name} fenced block.`);
  return match[1].trim();
}

it("documents the exact GitHub App permissions, events, and local HTTPS boundary", () => {
  const guide = read("docs/operator-guide.md");
  for (const permission of [
    "Actions: Read-only",
    "Contents: Read and write",
    "Pull requests: Read and write",
    "Checks: Read and write",
    "Metadata: Read-only",
  ]) {
    expect(guide).toContain(permission);
  }
  expect(guide).toContain("Workflow runs");
  expect(guide).toContain("Check runs");
  expect(guide).toContain("/github/webhook");
  expect(guide).toMatch(/smee\.io/u);
  expect(guide).toMatch(/ngrok/u);
  expect(guide).toMatch(/Cloudflare Tunnel/u);
});

it("keeps the documented Repository Contract executable and schema-accurate", () => {
  const guide = read("docs/operator-guide.md");
  const contract = JSON.parse(fencedExample(guide, "repository-contract")) as unknown;
  expect(parseRepositoryContract(JSON.stringify(contract))).toEqual(contract);
  expect(contract).toEqual({
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
});

it("keeps the operator configuration example aligned with the CLI schema and credential-safe", () => {
  const guide = read("docs/operator-guide.md");
  const config = fencedExample(guide, "operator-config");
  for (const field of [
    'database: { path: "/var/lib/agentci/agentci.sqlite" }',
    'appIdEnv: "AGENTCI_GITHUB_APP_ID"',
    'privateKeyEnv: "AGENTCI_GITHUB_PRIVATE_KEY"',
    'webhookSecretEnv: "AGENTCI_GITHUB_WEBHOOK_SECRET"',
    'primary: { type: "openai", apiKeyEnv: "OPENAI_API_KEY" }',
    'repair: { provider: "primary", model: "operator-selected-model" }',
    '"node-24": {',
    'image: "node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
  ]) {
    expect(config).toContain(field);
  }
  expect(config).not.toMatch(/BEGIN [^-]*PRIVATE KEY|github_pat_|ghp_|sk-[A-Za-z\d]/u);
});

it("documents secure operation, lifecycle, and the validated runtime boundary", () => {
  const guide = read("docs/operator-guide.md");
  for (const heading of [
    "## Provider registry and custom providers",
    "## Privacy and retention",
    "## Sandbox guarantees and limits",
    "## Repair outcomes and developer actions",
    "## Unsupported repository features",
    "## Troubleshooting",
  ]) {
    expect(guide).toContain(heading);
  }
  expect(guide).toContain("language-agnostic core");
  expect(guide).toMatch(/only validated Runtime\s+Profile is `node-24`/u);
  expect(guide).toContain("Redaction is best-effort");
  expect(guide).toContain("Draft Repair PR");
  expect(guide).toContain("Unresolved Repair");
  expect(guide).toContain("Stale Repair");
  expect(guide).toContain("Retry");
  expect(guide).toContain("Continuation");

  const troubleshooting = guide.slice(guide.indexOf("## Troubleshooting"));
  expect(troubleshooting).toMatch(/1\. Run `agentci doctor/u);
});

it("keeps the README entry point synchronized with the operator guide", () => {
  const readme = read("README.md");
  expect(readme).toContain("[secure local operation](docs/operator-guide.md)");
  expect(readme).toContain("only validated Runtime Profile is `node-24`");
});
