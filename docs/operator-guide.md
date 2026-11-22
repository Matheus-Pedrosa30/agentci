# Secure local operation

AgentCI is a local GitHub App service. Run it on a host you control, keep its trusted
configuration outside repaired repositories, and install the App only on repositories that
should be eligible for analysis. AgentCI has a language-agnostic core; the only validated Runtime
Profile is `node-24`.

> [!IMPORTANT]
> This repository is an early MVP. The CLI currently provides environment validation, signed
> webhook intake, durable serial queuing, Primary Failure identification, and Check updates.
> Provider adapters, the repair orchestrator, the hardened Docker runtime, and Draft Repair PR
> publication are implemented and tested as library boundaries, but `agentci start` does not yet
> connect those boundaries into a complete unattended repair pipeline. Do not treat the current
> CLI as a production security boundary.

## Requirements

- A supported Linux host. Windows with Docker Desktop or WSL2 is useful for development but does
  not have the supported Linux isolation guarantee.
- Node.js 24 and npm 11 or newer.
- Docker Engine available to the host user. AgentCI runs as a host process and invokes Docker
  directly; do not put AgentCI in a container or give an application container the Docker socket.
- A writable local directory for SQLite and a GitHub App installed on selected repositories.
- Provider credentials in environment variables when using a model adapter.

Build from a reviewed checkout with `npm ci --ignore-scripts && npm run build`. Run
`agentci doctor --config /trusted/path/agentci.config.ts` before `agentci start`.

## Create the GitHub App manually

1. In GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub App**. For an
   organization-owned App, use the organization's GitHub App settings instead.
2. Give the App a unique name. Set its homepage to the repository or internal operator page.
3. Generate a high-entropy webhook secret locally. Set **Webhook URL** to the public HTTPS relay
   URL ending in `/github/webhook`, paste the secret, and leave webhooks active.
4. Under **Repository permissions**, set exactly:

   - **Actions: Read-only**
   - **Contents: Read and write**
   - **Pull requests: Read and write**
   - **Checks: Read and write**
   - **Metadata: Read-only** (GitHub includes this mandatory permission)

   Leave every other repository, organization, and account permission at **No access**.

5. Subscribe to exactly the **Workflow runs** and **Check runs** events. Workflow runs drive intake;
   requested Check runs actions carry Retry or Continuation authorization.
6. Choose **Only on this account** unless the App must be installed elsewhere. Create the App,
   record its numeric App ID, and generate a private key. Restrict the downloaded key file to the
   AgentCI operating-system account.
7. Install the App and select **Only select repositories**. Do not grant all-repository access by
   default.

The service listens on plain HTTP on `127.0.0.1` by default. GitHub requires a public HTTPS webhook
URL, so terminate HTTPS in a relay and forward to `http://127.0.0.1:3000/github/webhook`. Common
development options are:

- **smee.io**: `npx smee-client --url https://smee.io/<channel> --target http://127.0.0.1:3000/github/webhook`
- **ngrok**: run `ngrok http 3000`, then use `https://<assigned-host>/github/webhook`.
- **Cloudflare Tunnel**: run `cloudflared tunnel --url http://127.0.0.1:3000`, then append
  `/github/webhook` to the assigned HTTPS URL.

Relays are separate trust boundaries: they can observe webhook traffic and may retain it. Use a
relay whose privacy policy is acceptable, or operate your own TLS reverse proxy. Webhook HMAC
verification detects modification but does not make relay-visible payloads confidential. Do not
put the webhook secret in a relay URL or command line.

## Trusted operator configuration

Store `agentci.config.ts` outside every repaired repository and restrict it to the AgentCI OS
account. The file contains environment-variable names, aliases, and a digest-pinned image—not
credential values. Alias names use lowercase letters, digits, and hyphens and begin with a letter.

<!-- operator-config:start -->

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
    "node-24": {
      image: "node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  },
};
```

<!-- operator-config:end -->

The repeated `a` digest is deliberately non-secret example data; replace it with the verified
digest for the exact image you approved. The current CLI configuration schema accepts the
`openai` provider shape shown above. It requires the three GitHub variables and the provider API
key variable to be present; the private-key variable contains PEM text, not a path. Load real
values from a secret manager or protected files into the service environment. Never commit them.

Run `agentci doctor --config /trusted/path/agentci.config.ts`. It checks Docker, the SQLite path,
GitHub environment values, provider/model references, and SHA-256 image pins and reports all
detected problems without printing secret values. Only then run the matching
`agentci start --config /trusted/path/agentci.config.ts`. Check `GET /health` locally before
enabling webhook deliveries.

## Repository Contract

An eligible repository opts in with `.agentci.json` at the exact failed revision. Repositories can
choose only aliases already approved in trusted configuration; they cannot choose credentials,
provider endpoints, container images, mounts, Docker flags, or resource limits.

<!-- repository-contract:start -->

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

<!-- repository-contract:end -->

`workflow`, `job`, and `branches` filter completed failed workflow runs. `model` and `runtime`
resolve through trusted aliases. Commands are non-empty argument arrays executed without a shell;
pipes, redirects, variable expansion, quoting rules, and compound commands are not supported.
`allowedPaths` bounds which existing text files a model may request and change. Unknown fields or
an invalid version make the contract ineligible.

## Provider registry and custom providers

The repair core consumes the AI SDK `LanguageModelV4` interface. The library includes
`createOpenAIModel`, `createAnthropicModel`, and `createOpenAICompatibleModel`. A custom provider
can supply any operator-created `LanguageModelV4` through `createModelRegistry`:

```ts
import { createModelRegistry } from "agentci";
import type { LanguageModelV4 } from "@ai-sdk/provider";

declare const operatorModel: LanguageModelV4;
const registry = createModelRegistry({ repair: operatorModel });
const provider = registry.createRepairProvider("repair");
```

This registry is an embedding/library seam today; the trusted CLI config loader does not import
custom providers and accepts only its current `openai` config shape. Built-in adapter factories
read the named credential variable when instantiated. AgentCI sends bounded evidence and selected
files to the one operator-selected endpoint. Providers receive no host tools or autonomous
repository access, and there is no automatic provider/model fallback. Usage token counts are
reported when present; AgentCI does not estimate monetary cost.

The core orchestrator has no npm-specific repair logic. Runtime Profiles own ecosystem execution.
Only `node-24` has been validated: it requires `npm ci`, forces install scripts off, and runs the
contract test command separately. Python, Ruby, Rust, other JavaScript package managers, and custom
profiles require their own implementation and security validation before being described as
supported.

## Privacy and retention

AgentCI is local-first, emits no telemetry, and sends repository context only to the selected model
endpoint. Before a model call, it truncates failure logs to 200 lines/32 KiB, bounds each selected
source file to 32 KiB, allows at most five requested files, strips ANSI sequences, and replaces
recognized bearer headers, common GitHub token forms, secret-like assignments, and PEM private
keys.

Redaction is best-effort, not a proof that arbitrary secrets or sensitive source are absent. It
cannot recognize every credential format or confidential value. Keep secrets out of CI output and
eligible source paths, use a provider with acceptable data-handling terms, and choose narrow
`allowedPaths`.

SQLite retains delivery/workflow identifiers, repository/branch/revision, workflow and job,
installation ID, model/runtime aliases, Repair Attempt state and timestamps, action/lineage data,
Primary Failure coordinates, token counts when available, and bounded redacted summaries. It does
not retain raw webhook bodies, Repository Contract contents, CI logs, prompts, model responses,
repository files, or sandbox workspaces. Temporary workspaces are removed after processing;
interrupted work is not resumed. Protect and rotate/archive the SQLite file according to your own
retention policy because metadata can still be sensitive.

## Sandbox guarantees and limits

The validated `node-24` runtime exports the exact 40-hex revision archive and rejects unsafe paths,
links, Git metadata, submodules, Git LFS pointers, archives over 50 MiB, and excessive entries.
It applies a bounded proposal only to existing regular files and cleans its temporary workspace.

Dependency installation and validation use separate digest-pinned containers. Installation has
bridge networking, no injected credentials, and npm lifecycle scripts forced off. Validation uses
`--network=none`. Both containers run as UID/GID 65532, drop all capabilities, enable
`no-new-privileges`, use a read-only container root plus a bounded `/tmp`, and are limited to one
CPU, 1 GiB memory, 256 processes, and a shared five-minute host-enforced deadline. GitHub/model
credentials and the Docker socket are not mounted.

These controls reduce risk; they do not prove that hostile code cannot exploit the Linux kernel,
Docker daemon, image contents, or host configuration. The install phase deliberately has network
access and may download untrusted packages. The workspace bind mount is writable. Operate on a
patched, dedicated Linux host with an approved immutable image and do not colocate higher-value
secrets. Windows and macOS development environments do not receive the supported isolation
guarantee.

## Repair outcomes and developer actions

- A Repair Attempt targets one immutable Primary Failure and tries at most three bounded Repair
  Proposals. Each incremental proposal may edit at most three existing text files and 200 changed
  lines. It cannot create/delete/rename files, change modes, write binary data, traverse paths, or
  modify workflows, `.agentci.json`, lockfiles, or files outside the allowlist.
- An **Unresolved Repair** is a terminal neutral Check when AgentCI cannot safely identify or
  validate a proposal, the provider/runtime fails, work is interrupted, or a different failure is
  revealed. It does not mutate the repository.
- **Retry** is an explicit, single-use Check action offered for an Unresolved Repair. It creates a
  linked Repair Attempt from the original revision and Primary Failure and discards prior
  proposals. It is not a resume or automatic retry loop.
- **Continuation** is offered only when validation removes the original failure and reveals a
  different Primary Failure. The single-use action accepts the rejected proposal as a new baseline
  and authorizes exactly one new Repair Attempt. Cumulative changed files/lines remain visible;
  each further failure needs another explicit action.
- A **Stale Repair** is a terminal neutral Check produced when a newer eligible run for the same
  branch supersedes old queued or running work. AgentCI rechecks currentness at publication and
  refuses a stale PR.
- A Validated Repair is published on `agentci/repair-<run-id>` as a **Draft Repair PR**. AgentCI
  never merges it and never writes directly to the default branch. A human reviews, edits, closes,
  or merges it using normal repository controls.

## Unsupported repository features

The validated MVP does not support npm install scripts, non-`npm ci` installers, private package
registries or repository secrets in the sandbox, submodules, Git LFS, Git metadata-dependent tests,
new/deleted/renamed/binary/symlink/mode-changing patches, lockfile or workflow changes, shell
commands, arbitrary images/endpoints/resource limits selected by a repository, multiple failed
configured jobs, autonomous newly revealed-failure repair, provider fallback, automatic merge, or
official isolation guarantees outside Linux. Lint-only, build, flaky-test, and deployment repair
are not validated milestone claims.

## Troubleshooting

1. Run `agentci doctor --config /trusted/path/agentci.config.ts` first. Fix every diagnostic before
   restarting; the command aggregates failures and exits nonzero when the environment is not ready.
2. If Docker is unavailable, run `docker info` as the same OS account. Confirm the daemon is
   running and the approved `node@sha256:...` digest is reachable.
3. For SQLite errors, verify the configured file is readable/writable or its parent directory is
   writable, and that only the intended AgentCI process owns the database.
4. For GitHub diagnostics, confirm the App ID is numeric, the environment variable contains the
   complete PEM private key, the webhook secret matches GitHub, the App is installed on the
   repository, and permissions/events exactly match this guide.
5. If `/health` works but deliveries do not arrive, inspect the GitHub App delivery page and relay
   forwarding target. A delivery must reach `/github/webhook` unchanged; do not paste payloads,
   signatures, logs, or credentials into public reports.
6. If a run is ignored, check `.agentci.json` at the failed revision, exact workflow/job/branch
   spelling, and that its model/runtime aliases exist in trusted configuration.
7. Treat an Unresolved Repair or Stale Repair as a deliberate safe stop. Read its bounded Check
   summary; use Retry or Continuation only when the action is offered and its semantics are right.
