import { expect, it } from "vitest";

import { createDeterministicFailureAnalyzer } from "../src/failure-analyzer.js";

it("provides deterministic analyzeFailure results without a live model", async () => {
  const analyzer = createDeterministicFailureAnalyzer({
    actionable: true,
    summary: "A deterministic assertion failure.",
    requestedFiles: ["src/assertion.ts"],
    usage: { inputTokens: 10, outputTokens: 4 },
  });
  const evidence = {
    jobName: "test",
    stepNumber: 2,
    stepName: "Unit tests",
    log: "expected true, received false",
    allowedPaths: ["src/**"],
  };

  await expect(analyzer.analyzeFailure(evidence)).resolves.toEqual({
    actionable: true,
    summary: "A deterministic assertion failure.",
    requestedFiles: ["src/assertion.ts"],
    usage: { inputTokens: 10, outputTokens: 4 },
  });
  await expect(analyzer.analyzeFailure(evidence)).resolves.toEqual({
    actionable: true,
    summary: "A deterministic assertion failure.",
    requestedFiles: ["src/assertion.ts"],
    usage: { inputTokens: 10, outputTokens: 4 },
  });
});
