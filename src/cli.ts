#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function environmentVariableName(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z_][A-Z\d_]*$/u.test(value) ? value : undefined;
}

function aliasName(value: string): boolean {
  return /^[a-z][a-z\d-]*$/u.test(value);
}

function isPrivateKey(value: string): boolean {
  try {
    createPrivateKey(value);
    return true;
  } catch {
    return false;
  }
}

function configuredEnvironmentValue(
  configuredName: unknown,
  invalidNameProblem: string,
  missingProblem: string,
  problems: string[],
): string | undefined {
  const name = environmentVariableName(configuredName);
  if (!name) {
    problems.push(invalidNameProblem);
    return undefined;
  }

  const value = process.env[name];
  if (!value) {
    problems.push(missingProblem);
    return undefined;
  }

  return value;
}

function configPath(arguments_: string[]): string {
  const flagIndex = arguments_.indexOf("--config");
  return resolve(flagIndex === -1 ? "agentci.config.ts" : (arguments_[flagIndex + 1] ?? ""));
}

async function doctor(arguments_: string[]): Promise<number> {
  const loaded = (await import(pathToFileURL(configPath(arguments_)).href)) as {
    default: unknown;
  };
  const config = record(loaded.default);
  const database = record(config.database);
  const github = record(config.github);
  const providers = record(config.providers);
  const models = record(config.models);
  const runtimes = record(config.runtimes);
  const problems: string[] = [];

  const docker =
    process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", "docker info"], { stdio: "ignore" })
      : spawnSync("docker", ["info"], { stdio: "ignore" });
  if (docker.status !== 0) {
    problems.push("Docker daemon is unavailable.");
  }

  if (typeof database.path !== "string" || database.path.length === 0) {
    problems.push("SQLite path is missing or invalid.");
  } else {
    try {
      const databaseFile = statSync(database.path);
      if (!databaseFile.isFile()) {
        problems.push("SQLite path is not a writable file.");
      } else {
        accessSync(database.path, constants.R_OK | constants.W_OK);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          accessSync(dirname(database.path), constants.W_OK);
        } catch {
          problems.push("SQLite directory is not writable.");
        }
      } else {
        problems.push("SQLite path is not a writable file.");
      }
    }
  }

  const appId = configuredEnvironmentValue(
    github.appIdEnv,
    "GitHub App ID environment variable name is invalid.",
    "GitHub App ID environment variable is missing.",
    problems,
  );
  if (appId && !/^[1-9]\d*$/u.test(appId)) {
    problems.push("GitHub App ID is invalid.");
  }
  const privateKey = configuredEnvironmentValue(
    github.privateKeyEnv,
    "GitHub App private key environment variable name is invalid.",
    "GitHub App private key environment variable is missing.",
    problems,
  );
  if (privateKey && !isPrivateKey(privateKey)) {
    problems.push("GitHub App private key is invalid.");
  }
  configuredEnvironmentValue(
    github.webhookSecretEnv,
    "GitHub webhook secret environment variable name is invalid.",
    "GitHub webhook secret environment variable is missing.",
    problems,
  );

  if (Object.keys(providers).length === 0) {
    problems.push("At least one provider alias is required.");
  }
  for (const [alias, providerValue] of Object.entries(providers)) {
    const provider = record(providerValue);
    if (!aliasName(alias)) {
      problems.push("A provider alias is invalid.");
    }
    if (provider.type !== "openai") {
      problems.push("A provider type is invalid.");
    }
    const apiKeyEnv = environmentVariableName(provider.apiKeyEnv);
    if (!apiKeyEnv || !process.env[apiKeyEnv]) {
      problems.push("A provider has a missing credential environment variable.");
    }
  }
  if (Object.keys(models).length === 0) {
    problems.push("At least one model alias is required.");
  }
  for (const [alias, modelValue] of Object.entries(models)) {
    const model = record(modelValue);
    if (!aliasName(alias)) {
      problems.push("A model alias is invalid.");
    }
    if (typeof model.model !== "string" || model.model.trim().length === 0) {
      problems.push("A model identifier is invalid.");
    }
    if (typeof model.provider !== "string" || !providers[model.provider]) {
      problems.push("A model references an unknown provider.");
    }
  }
  if (Object.keys(runtimes).length === 0) {
    problems.push("At least one Runtime Profile alias is required.");
  }
  for (const [alias, runtimeValue] of Object.entries(runtimes)) {
    const runtime = record(runtimeValue);
    if (!aliasName(alias)) {
      problems.push("A Runtime Profile alias is invalid.");
    }
    if (typeof runtime.image !== "string" || !/@sha256:[a-f\d]{64}$/u.test(runtime.image)) {
      problems.push("A Runtime Profile does not use an image pinned by SHA-256 digest.");
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
