# AgentCI

[![CI](https://github.com/Matheus-Pedrosa30/agentci/actions/workflows/ci.yml/badge.svg)](https://github.com/Matheus-Pedrosa30/agentci/actions/workflows/ci.yml)

AI-powered CI/CD repair agent that analyzes failed pipelines, proposes patches, and validates them in isolated environments.

> [!NOTE]
> AgentCI is at an early stage. The first milestone is a deliberately small proof of concept for Node.js repositories.

## Development

Requirements:

- Node.js 24
- npm 11 or newer

```bash
npm ci
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.

## Environment validation

Create a trusted local `agentci.config.ts` file outside repositories being repaired. The file names credential environment variables; it must not contain credential values. Runtime images must be pinned by SHA-256 digest.

```ts
export default {
  database: { path: "/var/lib/agentci/agentci.sqlite" },
  github: {
    appIdEnv: "AGENTCI_GITHUB_APP_ID",
    privateKeyEnv: "AGENTCI_GITHUB_PRIVATE_KEY",
    webhookSecretEnv: "AGENTCI_GITHUB_WEBHOOK_SECRET",
  },
  providers: {
    primary: { type: "openai", apiKeyEnv: "OPENAI_API_KEY" },
  },
  models: {
    repair: { provider: "primary", model: "operator-selected-model" },
  },
  runtimes: {
    "node-24": { image: "node@sha256:<64 hexadecimal characters>" },
  },
};
```

Build and validate the environment without starting a Repair Attempt:

```bash
npm run build
agentci doctor
```

Use `agentci doctor --config /trusted/path/agentci.config.ts` to select another trusted config file. The command checks Docker, the SQLite location, GitHub App credential variables, provider and model aliases, and Runtime Profile image pins. It reports all detected problems together and exits nonzero unless the environment is ready.

## Security

Do not open public issues for vulnerabilities or include credentials, tokens, or private CI logs in reports. See [SECURITY.md](SECURITY.md).

## License

Licensed under the [MIT License](LICENSE).
