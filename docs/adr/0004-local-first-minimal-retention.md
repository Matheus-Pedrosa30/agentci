# Default to local processing and minimal retention

AgentCI is local-first and sends repository context only to the model endpoint explicitly selected by the operator. It emits no telemetry and persists only identifiers, state transitions, timestamps, and redacted summaries; raw logs, prompts, model responses, repository files, and sandbox workspaces remain temporary and are removed when processing ends.
