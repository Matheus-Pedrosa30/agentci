import { expect, it } from "vitest";

import {
  classifyValidation,
  evaluateProposal,
  primaryFailureIdentity,
} from "../src/proposal-policy.js";

it("accepts a bounded edit to existing allowed text files", () => {
  expect(
    evaluateProposal({
      proposal: {
        summary: "Use both operands.",
        changes: [
          {
            path: "src/math.ts",
            content: "export const add = (left: number, right: number) => left + right;\n",
          },
        ],
      },
      existingTextFiles: { "src/math.ts": "export const add = () => 1;\n" },
      allowedPaths: ["src/**"],
    }),
  ).toEqual({
    outcome: "accepted",
    proposal: {
      summary: "Use both operands.",
      changes: [
        {
          path: "src/math.ts",
          content: "export const add = (left: number, right: number) => left + right;\n",
        },
      ],
    },
    changedLines: 2,
  });
});

it.each([
  ["creation", { summary: "create", changes: [{ path: "src/new.ts", content: "new\n" }] }],
  [
    "deletion",
    { summary: "delete", changes: [{ path: "src/math.ts", content: "", operation: "delete" }] },
  ],
  [
    "rename",
    {
      summary: "rename",
      changes: [{ path: "src/math.ts", content: "changed\n", previousPath: "src/old.ts" }],
    },
  ],
  [
    "symlink",
    {
      summary: "link",
      changes: [{ path: "src/math.ts", content: "target", kind: "symlink" }],
    },
  ],
  [
    "mode change",
    { summary: "mode", changes: [{ path: "src/math.ts", content: "changed\n", mode: 0o755 }] },
  ],
  [
    "binary data",
    { summary: "binary", changes: [{ path: "src/math.ts", content: "binary\u0000data" }] },
  ],
  ["path traversal", { summary: "escape", changes: [{ path: "src/../secret", content: "x" }] }],
  [
    "workflow",
    {
      summary: "workflow",
      changes: [{ path: ".github/workflows/ci.yml", content: "changed\n" }],
    },
  ],
  [
    "Repository Contract",
    { summary: "contract", changes: [{ path: ".agentci.json", content: "{}\n" }] },
  ],
  ["lockfile", { summary: "lock", changes: [{ path: "package-lock.json", content: "{}\n" }] }],
  [
    "path outside allowed paths",
    { summary: "outside", changes: [{ path: "docs/readme.md", content: "changed\n" }] },
  ],
])("rejects %s before a proposal can reach mutation", (_name, proposal) => {
  const existingTextFiles = {
    "src/math.ts": "original\n",
    ".github/workflows/ci.yml": "original\n",
    ".agentci.json": "{}\n",
    "package-lock.json": "{}\n",
    "docs/readme.md": "original\n",
  };

  expect(evaluateProposal({ proposal, existingTextFiles, allowedPaths: ["src/**"] })).toEqual({
    outcome: "rejected",
    explanation: expect.any(String),
  });
});

it("rejects proposals over three files or 200 changed lines", () => {
  const fourFiles = Object.fromEntries(
    Array.from({ length: 4 }, (_, index) => [`src/${index}.ts`, "before\n"]),
  );
  expect(
    evaluateProposal({
      proposal: {
        summary: "too many files",
        changes: Object.keys(fourFiles).map((path) => ({ path, content: "after\n" })),
      },
      existingTextFiles: fourFiles,
      allowedPaths: ["src/**"],
    }).outcome,
  ).toBe("rejected");
  expect(
    evaluateProposal({
      proposal: {
        summary: "too many lines",
        changes: [{ path: "src/math.ts", content: "changed\n".repeat(201) }],
      },
      existingTextFiles: { "src/math.ts": "original\n" },
      allowedPaths: ["src/**"],
    }).outcome,
  ).toBe("rejected");
});

it("preserves normalized provider usage while rejecting the raw proposal", () => {
  expect(
    evaluateProposal({
      proposal: {
        summary: "unsafe",
        changes: [{ path: "../secret", content: "raw model response" }],
        usage: { inputTokens: 12, outputTokens: 3 },
      },
      existingTextFiles: {},
      allowedPaths: ["src/**"],
    }),
  ).toEqual({
    outcome: "rejected",
    explanation: "The Repair Proposal contains an unsafe path.",
    usage: { inputTokens: 12, outputTokens: 3 },
  });
});

it("retries only the same stable Primary Failure and never exceeds three proposals", () => {
  const primary = primaryFailureIdentity({
    revision: "abc123",
    workflow: "CI",
    jobId: "job-17",
    stepNumber: 2,
    evidence: "expected 3, received 1",
  });

  expect(
    classifyValidation({
      primaryFailureIdentity: primary,
      proposalCount: 1,
      validation: {
        outcome: "failed",
        observedFailureIdentity: primary,
        summary: "wording changed while the same assertion remains red",
      },
    }),
  ).toEqual({ outcome: "retry" });
  expect(
    classifyValidation({
      primaryFailureIdentity: primary,
      proposalCount: 3,
      validation: { outcome: "failed", observedFailureIdentity: primary, summary: "still red" },
    }),
  ).toEqual({
    outcome: "unresolved",
    explanation: "The Repair Attempt exhausted its three-proposal budget.",
  });
});

it("stops without an autonomous chain when validation reveals a different failure", () => {
  const primary = primaryFailureIdentity({
    revision: "abc123",
    workflow: "CI",
    jobId: "job-17",
    stepNumber: 2,
    evidence: "expected 3, received 1",
  });
  const different = primaryFailureIdentity({
    revision: "abc123",
    workflow: "CI",
    jobId: "job-17",
    stepNumber: 4,
    evidence: "a later test failed",
  });

  expect(
    classifyValidation({
      primaryFailureIdentity: primary,
      proposalCount: 1,
      validation: {
        outcome: "failed",
        observedFailureIdentity: different,
        summary: "a later test now fails",
      },
    }),
  ).toEqual({
    outcome: "unresolved",
    explanation:
      "Validation revealed a different Primary Failure; Continuation requires developer authorization.",
  });
});

it("distinguishes a newly revealed failure in the same workflow step by normalized evidence", () => {
  const coordinates = {
    revision: "abc123",
    workflow: "CI",
    jobId: "job-17",
    stepNumber: 2,
  };
  expect(
    primaryFailureIdentity({ ...coordinates, evidence: "first assertion failed\r\n" }),
  ).not.toBe(primaryFailureIdentity({ ...coordinates, evidence: "second assertion failed\n" }));
});
