import type { LanguageModelV4 } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import {
  createAnthropicRepairProvider,
  createAnthropicModel,
  createModelRegistry,
  createOpenAICompatibleModel,
  createOpenAICompatibleRepairProvider,
  createOpenAIModel,
  createOpenAIRepairProvider,
  ModelSelectionError,
  RepairProviderError,
} from "../src/model-provider.js";

function customModel(): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "operator-custom",
    modelId: "custom-repair-model",
  } as LanguageModelV4;
}

describe("trusted model registry", () => {
  it("resolves an allowlisted alias to an imported AI SDK Language Model", () => {
    const model = customModel();
    const registry = createModelRegistry({ repair: model });

    expect(registry.resolve("repair")).toEqual({ alias: "repair", model });
  });

  it("registers built-ins at the AI SDK Language Model Specification boundary", () => {
    const environment = {
      OPENAI_KEY: "openai-secret",
      ANTHROPIC_KEY: "anthropic-secret",
      COMPATIBLE_KEY: "compatible-secret",
    };
    const models = [
      createOpenAIModel({
        modelId: "gpt-test",
        apiKeyEnvironmentVariable: "OPENAI_KEY",
        environment,
      }),
      createAnthropicModel({
        modelId: "claude-test",
        apiKeyEnvironmentVariable: "ANTHROPIC_KEY",
        environment,
      }),
      createOpenAICompatibleModel({
        modelId: "compatible-test",
        baseURL: "https://operator-model.invalid/v1",
        apiKeyEnvironmentVariable: "COMPATIBLE_KEY",
        environment,
      }),
    ];

    expect(models.map((model) => model.specificationVersion)).toEqual(["v4", "v4", "v4"]);
    const registry = createModelRegistry({ openai: models[0]! });
    expect(registry.resolve("openai").model).toBe(models[0]);
    expect(registry.createRepairProvider("openai")).toMatchObject({
      alias: "openai",
      provider: models[0]!.provider,
      model: models[0]!.modelId,
    });
  });

  it("rejects a Repository Contract model alias that the operator did not allowlist", () => {
    const registry = createModelRegistry({ repair: customModel() });

    expect(() => registry.resolve("repository-controlled")).toThrow(
      new ModelSelectionError("model_alias_not_allowed"),
    );
  });
});

describe("built-in provider contracts", () => {
  it("runs OpenAI analysis through an AI SDK model without tools or leaked credential metadata", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      requests.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          created: 1,
          model: "gpt-test",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  actionable: true,
                  summary: "The assertion is actionable.",
                  requestedFiles: ["src/math.ts"],
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const provider = createOpenAIRepairProvider({
      alias: "repair",
      modelId: "gpt-test",
      apiKeyEnvironmentVariable: "OPERATOR_OPENAI_KEY",
      environment: { OPERATOR_OPENAI_KEY: "operator-secret" },
      fetch,
    });

    await expect(
      provider.analyzeFailure({
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "expected 2, received 1",
        allowedPaths: ["src/**"],
      }),
    ).resolves.toEqual({
      actionable: true,
      summary: "The assertion is actionable.",
      requestedFiles: ["src/math.ts"],
      usage: { inputTokens: 12, outputTokens: 7 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer operator-secret");
    expect(requests[0]?.body).not.toHaveProperty("tools");
    expect(JSON.stringify(requests[0]?.body)).not.toMatch(/OPERATOR_OPENAI_KEY|operator-secret/u);
  });

  it("runs an OpenAI-compatible endpoint through the same AI SDK model path", async () => {
    const urls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      urls.push(String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("tools");
      return new Response(
        JSON.stringify({
          id: "chatcmpl-compatible",
          created: 1,
          model: "compatible-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  actionable: false,
                  summary: "The failure is not actionable.",
                  requestedFiles: [],
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const provider = createOpenAICompatibleRepairProvider({
      alias: "local-repair",
      modelId: "compatible-model",
      baseURL: "https://operator-model.invalid/v1",
      apiKeyEnvironmentVariable: "LOCAL_MODEL_TOKEN",
      environment: { LOCAL_MODEL_TOKEN: "local-secret" },
      fetch,
    });

    await expect(
      provider.analyzeFailure({
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "not actionable",
        allowedPaths: ["src/**"],
      }),
    ).resolves.toEqual({
      actionable: false,
      summary: "The failure is not actionable.",
      requestedFiles: [],
      usage: { inputTokens: 4, outputTokens: 3 },
    });
    expect(urls).toEqual(["https://operator-model.invalid/v1/chat/completions"]);
  });

  it("runs Anthropic through the same AI SDK model path without tools", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      requests.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                actionable: true,
                summary: "Inspect one source file.",
                requestedFiles: ["src/math.ts"],
              }),
            },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 9, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const provider = createAnthropicRepairProvider({
      alias: "repair",
      modelId: "claude-test",
      apiKeyEnvironmentVariable: "OPERATOR_ANTHROPIC_KEY",
      environment: { OPERATOR_ANTHROPIC_KEY: "anthropic-secret" },
      fetch,
    });

    await expect(
      provider.analyzeFailure({
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "expected 2, received 1",
        allowedPaths: ["src/**"],
      }),
    ).resolves.toEqual({
      actionable: true,
      summary: "Inspect one source file.",
      requestedFiles: ["src/math.ts"],
      usage: { inputTokens: 9, outputTokens: 5 },
    });
    expect(requests[0]?.headers.get("x-api-key")).toBe("anthropic-secret");
    expect(requests[0]?.body).not.toHaveProperty("tools");
    expect(JSON.stringify(requests[0]?.body)).not.toMatch(
      /OPERATOR_ANTHROPIC_KEY|anthropic-secret/u,
    );
  });

  it("classifies a built-in provider quota response explicitly without fallback", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { message: "quota exhausted", type: "insufficient_quota", code: "quota" },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const provider = createOpenAIRepairProvider({
      alias: "repair",
      modelId: "gpt-test",
      apiKeyEnvironmentVariable: "OPERATOR_OPENAI_KEY",
      environment: { OPERATOR_OPENAI_KEY: "operator-secret" },
      fetch,
    });

    await expect(
      provider.analyzeFailure({
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "expected 2, received 1",
        allowedPaths: ["src/**"],
      }),
    ).rejects.toEqual(new RepairProviderError("quota_exceeded"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies a built-in provider error explicitly without exposing its body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "TOKEN=provider-secret" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const provider = createOpenAIRepairProvider({
      alias: "repair",
      modelId: "gpt-test",
      apiKeyEnvironmentVariable: "OPERATOR_OPENAI_KEY",
      environment: { OPERATOR_OPENAI_KEY: "operator-secret" },
      fetch,
    });

    await expect(
      provider.analyzeFailure({
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "expected 2, received 1",
        allowedPaths: ["src/**"],
      }),
    ).rejects.toEqual(new RepairProviderError("provider_error"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("terminates explicitly when a built-in response omits usage", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "chatcmpl-no-usage",
            created: 1,
            model: "gpt-test",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    actionable: true,
                    summary: "actionable",
                    requestedFiles: ["src/math.ts"],
                  }),
                },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const provider = createOpenAIRepairProvider({
      alias: "repair",
      modelId: "gpt-test",
      apiKeyEnvironmentVariable: "OPERATOR_OPENAI_KEY",
      environment: { OPERATOR_OPENAI_KEY: "operator-secret" },
      fetch,
    });

    await expect(
      provider.analyzeFailure({
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "expected 2, received 1",
        allowedPaths: ["src/**"],
      }),
    ).rejects.toEqual(new RepairProviderError("missing_usage"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("terminates explicitly when a built-in response has invalid structured output", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "chatcmpl-invalid-output",
            created: 1,
            model: "gpt-test",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "not valid JSON" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const provider = createOpenAIRepairProvider({
      alias: "repair",
      modelId: "gpt-test",
      apiKeyEnvironmentVariable: "OPERATOR_OPENAI_KEY",
      environment: { OPERATOR_OPENAI_KEY: "operator-secret" },
      fetch,
    });

    await expect(
      provider.analyzeFailure({
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "expected 2, received 1",
        allowedPaths: ["src/**"],
      }),
    ).rejects.toEqual(new RepairProviderError("invalid_structured_output"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
