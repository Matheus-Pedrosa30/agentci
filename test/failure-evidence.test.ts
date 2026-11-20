import { describe, expect, it } from "vitest";

import {
  buildModelEvidence,
  identifyPrimaryFailure,
  validateAllowedFilePatterns,
  validateRequestedFiles,
} from "../src/failure-evidence.js";

describe("Primary Failure identification", () => {
  it("selects the first failed step of the one configured failed job", () => {
    expect(
      identifyPrimaryFailure([
        {
          id: "job-17",
          name: "test",
          conclusion: "failure",
          steps: [
            { number: 1, name: "Install", conclusion: "success" },
            { number: 2, name: "Unit tests", conclusion: "failure" },
            { number: 3, name: "Upload", conclusion: "failure" },
          ],
          log: "test output",
        },
      ]),
    ).toEqual({
      outcome: "identified",
      failure: {
        jobId: "job-17",
        jobName: "test",
        stepNumber: 2,
        stepName: "Unit tests",
        log: "test output",
      },
    });
  });

  it("selects the lowest failed step number when GitHub returns steps out of order", () => {
    const result = identifyPrimaryFailure([
      {
        id: "job-17",
        name: "test",
        conclusion: "failure",
        steps: [
          { number: 7, name: "Cleanup", conclusion: "failure" },
          { number: 3, name: "Unit tests", conclusion: "failure" },
        ],
        log: "test output",
      },
    ]);

    expect(result).toEqual(
      expect.objectContaining({
        outcome: "identified",
        failure: expect.objectContaining({ stepNumber: 3, stepName: "Unit tests" }),
      }),
    );
  });

  it("refuses multiple configured failed jobs instead of guessing", () => {
    const job = {
      id: "job-17",
      name: "test",
      conclusion: "failure",
      steps: [{ number: 1, name: "Tests", conclusion: "failure" }],
      log: "failure",
    } as const;

    expect(identifyPrimaryFailure([job, { ...job, id: "job-18" }])).toEqual({
      outcome: "unresolved",
      explanation: "Multiple configured jobs failed; AgentCI cannot select one safely.",
    });
  });

  it("reports an Unresolved Repair when the configured job has no failed step", () => {
    expect(
      identifyPrimaryFailure([
        {
          id: "job-17",
          name: "test",
          conclusion: "failure",
          steps: [{ number: 1, name: "Tests", conclusion: "success" }],
          log: "process exited unexpectedly",
        },
      ]),
    ).toEqual({
      outcome: "unresolved",
      explanation: "No failed step could be identified safely.",
    });
  });

  it("does not identify a failure without usable log evidence", () => {
    expect(
      identifyPrimaryFailure([
        {
          id: "job-17",
          name: "test",
          conclusion: "failure",
          steps: [{ number: 1, name: "Tests", conclusion: "failure" }],
          log: "\u0000\u0000",
        },
      ]),
    ).toEqual({
      outcome: "unresolved",
      explanation: "The failed step has no safe textual evidence to analyze.",
    });
  });

  it("treats ordinary ANSI-colored logs as safe textual evidence", () => {
    expect(
      identifyPrimaryFailure([
        {
          id: "job-17",
          name: "test",
          conclusion: "failure",
          steps: [{ number: 1, name: "Tests", conclusion: "failure" }],
          log: `${String.fromCharCode(27)}[31massertion failed${String.fromCharCode(27)}[0m`,
        },
      ]).outcome,
    ).toBe("identified");
  });
});

describe("bounded model evidence", () => {
  it("redacts secrets and bounds failed-step logs before analysis", () => {
    const log = [
      "Authorization: Bearer extremely-sensitive-token",
      "github_pat_11AAABBBCCCDDDEEEFFF_verysecret",
      ...Array.from({ length: 205 }, (_, index) => `safe line ${index + 1}`),
    ].join("\n");

    const evidence = buildModelEvidence({
      jobId: "job-17",
      jobName: "test",
      stepNumber: 2,
      stepName: "Unit tests",
      log,
    });

    expect(evidence.log).not.toContain("extremely-sensitive-token");
    expect(evidence.log).not.toContain("verysecret");
    expect(evidence.log).toContain("[REDACTED]");
    expect(evidence.log.split("\n")).toHaveLength(200);
    expect(Buffer.byteLength(evidence.log, "utf8")).toBeLessThanOrEqual(32_768);
  });

  it("accepts at most five unique requested files within allowed paths", () => {
    expect(
      validateRequestedFiles(
        ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "test/a.test.ts"],
        ["src/**", "test/**"],
      ),
    ).toEqual({
      outcome: "accepted",
      files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "test/a.test.ts"],
    });
    expect(
      validateRequestedFiles(
        ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"],
        ["src/**"],
      ),
    ).toEqual({
      outcome: "rejected",
      explanation: "Failure analysis requested more than five files.",
    });
    expect(validateRequestedFiles(["../secret", ".github/workflows/ci.yml"], ["src/**"])).toEqual({
      outcome: "rejected",
      explanation: "Failure analysis requested a file outside allowed paths.",
    });
    expect(validateRequestedFiles(["src/*.ts"], ["src/**"])).toEqual({
      outcome: "rejected",
      explanation: "Failure analysis requested a file outside allowed paths.",
    });
    expect(validateRequestedFiles(["src/file.ts:private"], ["src/**"])).toEqual({
      outcome: "rejected",
      explanation: "Failure analysis requested a file outside allowed paths.",
    });
  });

  it("rejects an unsafe repository allowlist before it can be shown to a provider", () => {
    expect(validateAllowedFilePatterns(["src/**", "../private/**"])).toEqual({
      outcome: "rejected",
      explanation: "Repository Contract contains an unsafe allowed path pattern.",
    });
  });
});
