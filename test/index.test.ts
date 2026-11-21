import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PROJECT_NAME } from "../src/index.js";

const TEST_PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 1024,
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
}).privateKey;

describe("project metadata", () => {
  it("exposes the canonical project name", () => {
    expect(PROJECT_NAME).toBe("AgentCI");
  });
});

describe("agentci doctor", () => {
  it("exits successfully when the trusted environment is ready", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-doctor-"));
    const binDirectory = join(directory, "bin");
    const dataDirectory = join(directory, "data");
    mkdirSync(binDirectory);
    mkdirSync(dataDirectory);
    writeFileSync(
      join(directory, "agentci.config.ts"),
      `export default {
        database: { path: ${JSON.stringify(join(dataDirectory, "agentci.sqlite"))} },
        github: {
          appIdEnv: "TEST_GITHUB_APP_ID",
          privateKeyEnv: "TEST_GITHUB_PRIVATE_KEY",
          webhookSecretEnv: "TEST_GITHUB_WEBHOOK_SECRET"
        },
        providers: {
          primary: { type: "openai", apiKeyEnv: "TEST_MODEL_API_KEY" }
        },
        models: {
          repair: { provider: "primary", model: "repair-model" }
        },
        runtimes: {
          "node-24": { image: "node@sha256:${"a".repeat(64)}" }
        }
      };`,
    );
    const dockerName = process.platform === "win32" ? "docker.cmd" : "docker";
    writeFileSync(
      join(binDirectory, dockerName),
      process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, [resolve("src/cli.ts"), "doctor"], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
        TEST_GITHUB_APP_ID: "12345",
        TEST_GITHUB_PRIVATE_KEY: TEST_PRIVATE_KEY,
        TEST_GITHUB_WEBHOOK_SECRET: "webhook-secret-value",
        TEST_MODEL_API_KEY: "model-secret-value",
      },
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: "AgentCI environment is ready.\n",
      stderr: "",
    });
  });

  it("reports every detected problem without exposing secrets", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-doctor-"));
    const binDirectory = join(directory, "bin");
    mkdirSync(binDirectory);
    const dockerName = process.platform === "win32" ? "docker.cmd" : "docker";
    writeFileSync(
      join(binDirectory, dockerName),
      process.platform === "win32" ? "@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n",
      { mode: 0o755 },
    );
    const config = join(directory, "agentci.config.mjs");
    writeFileSync(
      config,
      `export default {
        database: { path: ${JSON.stringify(join(directory, "missing", "agentci.sqlite"))} },
        github: {
          appIdEnv: "MISSING_GITHUB_APP_ID",
          privateKeyEnv: "MISSING_GITHUB_PRIVATE_KEY",
          webhookSecretEnv: "MISSING_GITHUB_WEBHOOK_SECRET"
        },
        providers: {
          "secret-provider-alias": { type: "openai", apiKeyEnv: "MISSING_PROVIDER_KEY", endpoint: "https://secret.invalid" }
        },
        models: {
          "secret-model-alias": { provider: "absent", model: "private-model-name" }
        },
        runtimes: {
          "secret-runtime-alias": { image: "private.registry.invalid/secret/image:latest" }
        }
      };`,
    );

    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "doctor", "--config", config],
      {
        encoding: "utf8",
        env: {
          PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
          SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `AgentCI environment is not ready:
- Docker daemon is unavailable.
- SQLite directory is not writable.
- GitHub App ID environment variable is missing.
- GitHub App private key environment variable is missing.
- GitHub webhook secret environment variable is missing.
- A provider has a missing credential environment variable.
- A model references an unknown provider.
- A Runtime Profile does not use an image pinned by SHA-256 digest.
`,
    );
    expect(`${result.stdout}${result.stderr}`).not.toMatch(
      /secret-provider-alias|secret-model-alias|secret-runtime-alias|secret\.invalid|private-model-name|private\.registry/u,
    );
  });

  it("requires configured provider, model, and Runtime Profile aliases", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-doctor-"));
    const binDirectory = join(directory, "bin");
    mkdirSync(binDirectory);
    const dockerName = process.platform === "win32" ? "docker.cmd" : "docker";
    writeFileSync(
      join(binDirectory, dockerName),
      process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    const config = join(directory, "agentci.config.mjs");
    writeFileSync(
      config,
      `export default {
        database: { path: ${JSON.stringify(join(directory, "agentci.sqlite"))} },
        github: {
          appIdEnv: "READY_APP_ID",
          privateKeyEnv: "READY_PRIVATE_KEY",
          webhookSecretEnv: "READY_WEBHOOK_SECRET"
        },
        providers: {}, models: {}, runtimes: {}
      };`,
    );

    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "doctor", "--config", config],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
          READY_APP_ID: "12345",
          READY_PRIVATE_KEY: TEST_PRIVATE_KEY,
          READY_WEBHOOK_SECRET: "configured",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `AgentCI environment is not ready:
- At least one provider alias is required.
- At least one model alias is required.
- At least one Runtime Profile alias is required.
`,
    );
  });

  it("reports all missing sections in a malformed configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-doctor-"));
    const binDirectory = join(directory, "bin");
    mkdirSync(binDirectory);
    const dockerName = process.platform === "win32" ? "docker.cmd" : "docker";
    writeFileSync(
      join(binDirectory, dockerName),
      process.platform === "win32" ? "@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n",
      { mode: 0o755 },
    );
    const config = join(directory, "agentci.config.mjs");
    writeFileSync(config, "export default {};\n");

    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "doctor", "--config", config],
      {
        encoding: "utf8",
        env: {
          PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
          SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Docker daemon is unavailable.");
    expect(result.stderr).toContain("SQLite path is missing or invalid.");
    expect(result.stderr).toContain("GitHub App ID environment variable name is invalid.");
    expect(result.stderr).toContain("GitHub App private key environment variable name is invalid.");
    expect(result.stderr).toContain("GitHub webhook secret environment variable name is invalid.");
    expect(result.stderr).toContain("At least one provider alias is required.");
    expect(result.stderr).toContain("At least one model alias is required.");
    expect(result.stderr).toContain("At least one Runtime Profile alias is required.");
  });

  it("rejects semantically invalid credentials, providers, models, and aliases", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-doctor-"));
    const binDirectory = join(directory, "bin");
    mkdirSync(binDirectory);
    const dockerName = process.platform === "win32" ? "docker.cmd" : "docker";
    writeFileSync(
      join(binDirectory, dockerName),
      process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    const config = join(directory, "agentci.config.mjs");
    writeFileSync(
      config,
      `export default {
        database: { path: ${JSON.stringify(join(directory, "agentci.sqlite"))} },
        github: {
          appIdEnv: "INVALID_APP_ID",
          privateKeyEnv: "INVALID_PRIVATE_KEY",
          webhookSecretEnv: "READY_WEBHOOK_SECRET"
        },
        providers: {
          "bad alias": { type: "unsupported", apiKeyEnv: "READY_MODEL_API_KEY" }
        },
        models: {
          "bad alias": { provider: "missing", model: "" }
        },
        runtimes: {
          "bad alias": { image: "node@sha256:${"a".repeat(64)}" }
        }
      };`,
    );

    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "doctor", "--config", config],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
          INVALID_APP_ID: "not-numeric",
          INVALID_PRIVATE_KEY:
            "-----BEGIN PRIVATE KEY-----\nnot-encoded-key-material\n-----END PRIVATE KEY-----",
          READY_WEBHOOK_SECRET: "configured",
          READY_MODEL_API_KEY: "configured",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GitHub App ID is invalid.");
    expect(result.stderr).toContain("GitHub App private key is invalid.");
    expect(result.stderr).toContain("A provider alias is invalid.");
    expect(result.stderr).toContain("A provider type is invalid.");
    expect(result.stderr).toContain("A model alias is invalid.");
    expect(result.stderr).toContain("A model identifier is invalid.");
    expect(result.stderr).toContain("A model references an unknown provider.");
    expect(result.stderr).toContain("A Runtime Profile alias is invalid.");
  });

  it("rejects an existing directory as the SQLite database path", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentci-doctor-"));
    const binDirectory = join(directory, "bin");
    const dataDirectory = join(directory, "data");
    mkdirSync(binDirectory);
    mkdirSync(dataDirectory);
    const dockerName = process.platform === "win32" ? "docker.cmd" : "docker";
    writeFileSync(
      join(binDirectory, dockerName),
      process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    const config = join(directory, "agentci.config.mjs");
    writeFileSync(
      config,
      `export default {
        database: { path: ${JSON.stringify(dataDirectory)} },
        github: {
          appIdEnv: "READY_APP_ID",
          privateKeyEnv: "READY_PRIVATE_KEY",
          webhookSecretEnv: "READY_WEBHOOK_SECRET"
        },
        providers: {
          primary: { type: "openai", apiKeyEnv: "READY_MODEL_API_KEY" }
        },
        models: {
          repair: { provider: "primary", model: "repair-model" }
        },
        runtimes: {
          "node-24": { image: "node@sha256:${"a".repeat(64)}" }
        }
      };`,
    );

    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "doctor", "--config", config],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
          READY_APP_ID: "12345",
          READY_PRIVATE_KEY: TEST_PRIVATE_KEY,
          READY_WEBHOOK_SECRET: "configured",
          READY_MODEL_API_KEY: "configured",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SQLite path is not a writable file.");
  });
});
