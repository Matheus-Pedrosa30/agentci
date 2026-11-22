import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";

import type { ModelFailureEvidence } from "./failure-evidence.ts";
import type { RepairProvider } from "./repair-orchestrator.ts";

export type RegisteredModel = Readonly<{
  alias: string;
  model: LanguageModelV4;
}>;

export class ModelSelectionError extends Error {
  readonly kind: "model_alias_not_allowed";

  constructor(kind: "model_alias_not_allowed") {
    super(kind);
    this.name = "ModelSelectionError";
    this.kind = kind;
  }
}

export type RepairProviderErrorKind =
  "provider_error" | "quota_exceeded" | "invalid_structured_output" | "missing_usage";

export class RepairProviderError extends Error {
  readonly kind: RepairProviderErrorKind;

  constructor(kind: RepairProviderErrorKind) {
    super(kind);
    this.name = "RepairProviderError";
    this.kind = kind;
  }
}

const analysisSchema = z.object({
  actionable: z.boolean(),
  summary: z.string(),
  requestedFiles: z.array(z.string()).max(5),
});

const proposalSchema = z.object({
  summary: z.string(),
  changes: z.array(z.object({ path: z.string(), content: z.string() })).max(3),
});

type ProviderFetch = NonNullable<Parameters<typeof createOpenAI>[0]>["fetch"];

export interface OpenAIModelOptions {
  modelId: string;
  apiKeyEnvironmentVariable: string;
  environment?: Readonly<Record<string, string | undefined>>;
  baseURL?: string;
  name?: string;
  fetch?: ProviderFetch;
}

interface OpenAIRepairProviderOptions extends OpenAIModelOptions {
  alias: string;
}

export interface OpenAICompatibleModelOptions extends OpenAIModelOptions {
  baseURL: string;
}

interface OpenAICompatibleRepairProviderOptions extends OpenAICompatibleModelOptions {
  alias: string;
}

export interface AnthropicModelOptions {
  modelId: string;
  apiKeyEnvironmentVariable: string;
  environment?: Readonly<Record<string, string | undefined>>;
  baseURL?: string;
  fetch?: NonNullable<Parameters<typeof createAnthropic>[0]>["fetch"];
}

interface AnthropicRepairProviderOptions extends AnthropicModelOptions {
  alias: string;
}

function credential(
  name: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const value = environment[name];
  if (!value) throw new Error("model_credential_missing");
  return value;
}

function promptForAnalysis(evidence: ModelFailureEvidence): string {
  return [
    "Analyze exactly one CI Primary Failure.",
    `Job: ${evidence.jobName}`,
    `Step ${evidence.stepNumber}: ${evidence.stepName}`,
    `Allowed paths: ${evidence.allowedPaths.join(", ")}`,
    "Request no more than five files and only from the allowed paths.",
    `Failure evidence:\n${evidence.log}`,
  ].join("\n");
}

async function invokeModel<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (APICallError.isInstance(error) && error.statusCode === 429) {
      throw new RepairProviderError("quota_exceeded");
    }
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new RepairProviderError("invalid_structured_output");
    }
    throw new RepairProviderError("provider_error");
  }
}

function requiredUsage(usage: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}): { inputTokens: number; outputTokens: number } {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
    throw new RepairProviderError("missing_usage");
  }
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

export function createAiSdkRepairProvider(input: RegisteredModel): RepairProvider {
  return {
    alias: input.alias,
    provider: input.model.provider,
    model: input.model.modelId,
    async analyzeFailure(evidence) {
      const result = await invokeModel(() =>
        generateText({
          model: input.model,
          output: Output.object({ schema: analysisSchema }),
          prompt: promptForAnalysis(evidence),
          maxOutputTokens: 4096,
          maxRetries: 0,
        }),
      );
      return {
        ...result.output,
        usage: requiredUsage(result.usage),
      };
    },
    async proposeRepair(request) {
      const result = await invokeModel(() =>
        generateText({
          model: input.model,
          output: Output.object({ schema: proposalSchema }),
          prompt: [
            promptForAnalysis(request.evidence),
            `Files:\n${JSON.stringify(request.files)}`,
            `Previous rejected proposals:\n${JSON.stringify(request.previousRejections)}`,
            "Return a bounded Repair Proposal only; do not call tools.",
          ].join("\n"),
          maxOutputTokens: 8192,
          maxRetries: 0,
        }),
      );
      return {
        ...result.output,
        usage: requiredUsage(result.usage),
      };
    },
  };
}

export function createOpenAIModel(options: OpenAIModelOptions): LanguageModelV4 {
  const environment = options.environment ?? process.env;
  const sdk = createOpenAI({
    apiKey: credential(options.apiKeyEnvironmentVariable, environment),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.name ? { name: options.name } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return sdk.chat(options.modelId);
}

export function createOpenAICompatibleModel(
  options: OpenAICompatibleModelOptions,
): LanguageModelV4 {
  return createOpenAIModel({ ...options, name: options.name ?? "openai-compatible" });
}

export function createAnthropicModel(options: AnthropicModelOptions): LanguageModelV4 {
  const environment = options.environment ?? process.env;
  const sdk = createAnthropic({
    apiKey: credential(options.apiKeyEnvironmentVariable, environment),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return sdk(options.modelId);
}

export function createOpenAIRepairProvider(options: OpenAIRepairProviderOptions): RepairProvider {
  return createAiSdkRepairProvider({ alias: options.alias, model: createOpenAIModel(options) });
}

export function createOpenAICompatibleRepairProvider(
  options: OpenAICompatibleRepairProviderOptions,
): RepairProvider {
  return createAiSdkRepairProvider({
    alias: options.alias,
    model: createOpenAICompatibleModel(options),
  });
}

export function createAnthropicRepairProvider(
  options: AnthropicRepairProviderOptions,
): RepairProvider {
  return createAiSdkRepairProvider({ alias: options.alias, model: createAnthropicModel(options) });
}

export function createModelRegistry(models: Readonly<Record<string, LanguageModelV4>>): {
  resolve(alias: string): RegisteredModel;
  createRepairProvider(alias: string): RepairProvider;
} {
  const entries = new Map(Object.entries(models));
  const resolve = (alias: string): RegisteredModel => {
    const model = entries.get(alias);
    if (!model) throw new ModelSelectionError("model_alias_not_allowed");
    return { alias, model };
  };
  return {
    resolve,
    createRepairProvider: (alias) => createAiSdkRepairProvider(resolve(alias)),
  };
}
