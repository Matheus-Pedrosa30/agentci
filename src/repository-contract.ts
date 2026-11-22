export interface RepositoryContract {
  version: 1;
  workflow: string;
  job: string;
  branches: string[];
  model: string;
  runtime: string;
  install: string[];
  test: string[];
  allowedPaths: string[];
}

const REPOSITORY_CONTRACT_FIELDS = new Set([
  "version",
  "workflow",
  "job",
  "branches",
  "model",
  "runtime",
  "install",
  "test",
  "allowedPaths",
]);

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((item) => typeof item === "string" && item.length > 0)
    ? (value as string[])
    : undefined;
}

export function parseRepositoryContract(source: string): RepositoryContract | undefined {
  try {
    const value = object(JSON.parse(source));
    if (!value) return undefined;
    if (Object.keys(value).some((field) => !REPOSITORY_CONTRACT_FIELDS.has(field))) {
      return undefined;
    }
    const branches = stringArray(value.branches);
    const install = stringArray(value.install);
    const test = stringArray(value.test);
    const allowedPaths = stringArray(value.allowedPaths);
    if (
      value.version !== 1 ||
      typeof value.workflow !== "string" ||
      typeof value.job !== "string" ||
      typeof value.model !== "string" ||
      typeof value.runtime !== "string" ||
      !branches ||
      !install ||
      !test ||
      !allowedPaths
    ) {
      return undefined;
    }
    return {
      version: 1,
      workflow: value.workflow,
      job: value.job,
      branches,
      model: value.model,
      runtime: value.runtime,
      install,
      test,
      allowedPaths,
    };
  } catch {
    return undefined;
  }
}
