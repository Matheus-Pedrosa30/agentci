import type { ModelFailureEvidence } from "./failure-evidence.ts";

export interface FailureAnalysis {
  actionable: boolean;
  summary: string;
  requestedFiles: readonly string[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface FailureAnalyzer {
  analyzeFailure(evidence: ModelFailureEvidence): Promise<FailureAnalysis>;
}

export function createDeterministicFailureAnalyzer(result: FailureAnalysis): FailureAnalyzer {
  return {
    async analyzeFailure() {
      return {
        ...result,
        requestedFiles: [...result.requestedFiles],
        ...(result.usage ? { usage: { ...result.usage } } : {}),
      };
    },
  };
}
