# Contributing to AgentCI

Thank you for helping improve AgentCI. This project is intentionally small, and focused contributions are preferred over broad rewrites.

## Before you start

- Search existing issues before opening a new one.
- Use an issue to discuss behavior changes or significant design decisions first.
- Never include credentials, access tokens, private source code, or unredacted CI logs.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md) and [Security Policy](SECURITY.md).

## Local setup

Install Node.js 24 and npm 11 or newer, then run:

```bash
npm ci
npm run check
```

`npm run check` runs the same formatting, lint, type-check, and test gates used by CI.

## Making a change

1. Create a focused branch from `main`.
2. Keep the change limited to one concern.
3. Add or update tests when behavior changes.
4. Run `npm run check` before pushing.
5. Open a pull request that explains the problem, the approach, and how the result was verified.

Conventional Commit-style messages are encouraged, for example `feat: parse failed workflow logs` or `fix: enforce sandbox timeout`.

## Pull requests

Pull requests must:

- pass CI;
- avoid unrelated refactors;
- document user-visible behavior;
- include tests for new behavior or explain why a test is not applicable;
- call out security implications, especially changes involving GitHub tokens, repository contents, command execution, containers, or network access.

AI-assisted contributions are welcome, but the author remains responsible for reviewing, testing, and understanding the submitted code. Do not submit generated patches without human review.

## Security-sensitive code

AgentCI processes repository content and may eventually execute repository commands. Changes to authentication, webhook verification, prompt construction, patch application, process execution, Docker configuration, or secret handling require explicit security reasoning in the pull request.
