# AgentCI

[![CI](https://github.com/Matheus-Pedrosa30/agentci/actions/workflows/ci.yml/badge.svg)](https://github.com/Matheus-Pedrosa30/agentci/actions/workflows/ci.yml)

AI-powered CI/CD repair agent that analyzes failed pipelines, proposes patches, and validates them in isolated environments.

> [!NOTE]
> AgentCI is at an early stage. Its repair core is language-agnostic, but the only validated Runtime Profile is `node-24`.

See [secure local operation](docs/operator-guide.md) for GitHub App setup, trusted configuration,
privacy and sandbox boundaries, repair lifecycle, and troubleshooting.

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
  server: { host: "127.0.0.1", port: 3000 },
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
node dist/cli.js doctor
```

Use `node dist/cli.js doctor --config /trusted/path/agentci.config.ts` to select another trusted config file. If you register the package's `agentci` bin on `PATH`, `agentci doctor` is the equivalent command. The command checks Docker, the SQLite location, GitHub App credential variables, provider and model aliases, and Runtime Profile image pins. It reports all detected problems together and exits nonzero unless the environment is ready.

## Webhook intake

After `doctor` succeeds, start the local service with `node dist/cli.js start` (or pass the same `--config` option used for `doctor`). The service exposes `GET /health` and accepts GitHub App `workflow_run` deliveries at `POST /github/webhook`. Configure the GitHub App with the same webhook secret named by the trusted configuration.

Eligible repositories opt in with `.agentci.json` at the failed workflow revision:

```json
{
  "version": 1,
  "workflow": "CI",
  "job": "test",
  "branches": ["main"],
  "model": "repair",
  "runtime": "node-24",
  "install": ["npm", "ci", "--ignore-scripts"],
  "test": ["npm", "test"],
  "allowedPaths": ["src/**", "test/**"]
}
```

Model and Runtime Profile names are aliases into trusted local configuration; repository input cannot select credentials, endpoints, or images directly. Signed eligible failures are queued durably in SQLite, processed serially, and receive one initial AgentCI Check. Raw webhook bodies and Repository Contract contents are not retained.

## Security

Do not open public issues for vulnerabilities or include credentials, tokens, or private CI logs in reports. See [SECURITY.md](SECURITY.md).

## License

Licensed under the [MIT License](LICENSE).
