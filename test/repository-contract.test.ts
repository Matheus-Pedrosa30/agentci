import { expect, it } from "vitest";

import { parseRepositoryContract } from "../src/repository-contract.js";

const validContract = {
  version: 1,
  workflow: "CI",
  job: "test",
  branches: ["main"],
  model: "repair",
  runtime: "node-24",
  install: ["npm", "ci"],
  test: ["npm", "test"],
  allowedPaths: ["src/**"],
};

it.each(["endpoint", "baseURL", "credential", "apiKeyEnvironmentVariable"])(
  "rejects a Repository Contract that attempts to set %s",
  (field) => {
    expect(
      parseRepositoryContract(JSON.stringify({ ...validContract, [field]: "repository-value" })),
    ).toBeUndefined();
  },
);
