#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface OperatorConfig {
  database: { path: string };
  github: {
    appIdEnv: string;
    privateKeyEnv: string;
    webhookSecretEnv: string;
  };
  providers: Record<string, { type: string; apiKeyEnv: string }>;
  models: Record<string, { provider: string; model: string }>;
  runtimes: Record<string, { image: string }>;
}

function configPath(arguments_: string[]): string {
  const flagIndex = arguments_.indexOf("--config");
  return resolve(flagIndex === -1 ? "agentci.config.ts" : (arguments_[flagIndex + 1] ?? ""));
}

async function doctor(arguments_: string[]): Promise<number> {
  const loaded = (await import(pathToFileURL(configPath(arguments_)).href)) as {
    default: OperatorConfig;
  };
  const config = loaded.default;
  const problems: string[] = [];

  const docker =
    process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", "docker info"], { stdio: "ignore" })
      : spawnSync("docker", ["info"], { stdio: "ignore" });
  if (docker.status !== 0) {
    problems.push("Docker daemon is unavailable.");
  }

  try {
    accessSync(dirname(config.database.path), constants.W_OK);
  } catch {
    problems.push("SQLite directory is not writable.");
  }

  const githubCredentials: Array<[string, string]> = [
    [config.github.appIdEnv, "GitHub App ID environment variable is missing."],
    [config.github.privateKeyEnv, "GitHub App private key environment variable is missing."],
    [config.github.webhookSecretEnv, "GitHub webhook secret environment variable is missing."],
  ];
  for (const [name, problem] of githubCredentials) {
    if (!process.env[name]) problems.push(problem);
  }

  if (Object.keys(config.providers).length === 0) {
    problems.push("At least one provider alias is required.");
  }
  for (const [alias, provider] of Object.entries(config.providers)) {
    if (!process.env[provider.apiKeyEnv]) {
      problems.push(
        `Provider alias ${JSON.stringify(alias)} has a missing credential environment variable.`,
      );
    }
  }
  if (Object.keys(config.models).length === 0) {
    problems.push("At least one model alias is required.");
  }
  for (const [alias, model] of Object.entries(config.models)) {
    if (!config.providers[model.provider]) {
      problems.push(`Model alias ${JSON.stringify(alias)} references an unknown provider.`);
    }
  }
  if (Object.keys(config.runtimes).length === 0) {
    problems.push("At least one Runtime Profile alias is required.");
  }
  for (const [alias, runtime] of Object.entries(config.runtimes)) {
    if (!/@sha256:[a-f\d]{64}$/u.test(runtime.image)) {
      problems.push(
        `Runtime Profile alias ${JSON.stringify(alias)} does not use an image pinned by SHA-256 digest.`,
      );
    }
  }

  if (problems.length > 0) {
    process.stderr.write(
      `AgentCI environment is not ready:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`,
    );
    return 1;
  }

  process.stdout.write("AgentCI environment is ready.\n");
  return 0;
}

async function main(): Promise<number> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command !== "doctor") {
    process.stderr.write("Usage: agentci doctor [--config <path>]\n");
    return 2;
  }

  return doctor(arguments_);
}

void main().then(
  (status) => {
    process.exitCode = status;
  },
  () => {
    process.stderr.write("AgentCI environment is not ready.\n");
    process.exitCode = 1;
  },
);
