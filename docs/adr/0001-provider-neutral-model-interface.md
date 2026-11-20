# Use a provider-neutral model interface

AgentCI will depend on the AI SDK Language Model Specification instead of coupling its repair workflow to a provider SDK. The MVP includes OpenAI, Anthropic, and OpenAI-compatible adapters, while custom adapters can extend the same interface; this adds an abstraction dependency but keeps repair behavior independent from any model vendor. Repositories select only operator-approved model aliases, while a trusted local `agentci.config.ts` imports providers and owns endpoints, credentials, and runtime mappings.
