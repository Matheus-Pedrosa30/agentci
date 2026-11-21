import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";

import {
  createNode24DockerRuntime,
  type DockerCommandRunner,
} from "../src/node24-docker-runtime.js";

function tar(
  entries: ReadonlyArray<{ path: string; content: string; type?: "file" | "symlink" }>,
): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    header.write("0000777\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    const content = Buffer.from(entry.content);
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(32, 148, 156);
    header[156] = (entry.type === "symlink" ? "2" : "0").charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

it("resolves an approved digest-pinned node-24 image and uses two hardened containers", async () => {
  const commands: string[][] = [];
  const runner: DockerCommandRunner = {
    async run(_command, arguments_) {
      commands.push([...arguments_]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agentci-runtime-test-"));
  try {
    const runtime = createNode24DockerRuntime({
      runtimeImages: { "node-24": `node@sha256:${"a".repeat(64)}` },
      archiveProvider: {
        async fetchExactRevisionArchive() {
          return tar([{ path: "repo/package.json", content: "{}" }]);
        },
      },
      docker: runner,
      temporaryRoot,
    });

    const result = await runtime.validate({
      repository: "owner/repo",
      revision: "1".repeat(40),
      runtimeAlias: "node-24",
      installCommand: ["npm", "ci"],
      validationCommand: ["npm", "test"],
      proposal: { summary: "repair", changes: [{ path: "package.json", content: '{"ok":true}' }] },
    });

    expect(result).toEqual({ outcome: "passed", changedFiles: ["package.json"] });
    const runs = commands.filter(([verb]) => verb === "run");
    expect(runs).toHaveLength(2);
    for (const arguments_ of runs) {
      expect(arguments_).toEqual(
        expect.arrayContaining([
          "--rm",
          "--user",
          "65532:65532",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--cpus",
          "1",
          "--memory",
          "1g",
          "--pids-limit",
          "256",
          `node@sha256:${"a".repeat(64)}`,
        ]),
      );
      expect(arguments_.join(" ")).not.toContain("docker.sock");
      expect(arguments_.join(" ")).not.toMatch(/TOKEN|KEY|SECRET/u);
    }
    expect(runs[0]).toEqual(
      expect.arrayContaining(["--network", "bridge", "npm", "ci", "--ignore-scripts=true"]),
    );
    expect(runs[1]).toEqual(expect.arrayContaining(["--network", "none", "npm", "test"]));
    expect(await readdir(temporaryRoot)).toEqual([]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

it.each([
  ["unknown alias", "unapproved", `node@sha256:${"a".repeat(64)}`, "1".repeat(40)],
  ["mutable tag", "node-24", "node:24", "1".repeat(40)],
  ["non-exact revision", "node-24", `node@sha256:${"a".repeat(64)}`, "main"],
])(
  "rejects an %s before acquiring source or invoking Docker",
  async (_name, alias, image, revision) => {
    let archiveRequested = false;
    let dockerInvoked = false;
    const runtime = createNode24DockerRuntime({
      runtimeImages: { "node-24": image },
      archiveProvider: {
        async fetchExactRevisionArchive() {
          archiveRequested = true;
          return Buffer.alloc(0);
        },
      },
      docker: {
        async run() {
          dockerInvoked = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    });
    const result = await runtime.validate({
      repository: "owner/repo",
      revision,
      runtimeAlias: alias,
      installCommand: ["npm", "ci"],
      validationCommand: ["npm", "test"],
      proposal: { summary: "repair", changes: [{ path: "a.txt", content: "after" }] },
    });
    expect(result).toEqual({
      outcome: "failed",
      summary: "Runtime Profile is not approved and digest-pinned.",
    });
    expect({ archiveRequested, dockerInvoked }).toEqual({
      archiveRequested: false,
      dockerInvoked: false,
    });
  },
);

it.each([
  ["traversal", [{ path: "repo/../../escape", content: "x" }]],
  ["absolute path", [{ path: "/escape", content: "x" }]],
  ["symlink", [{ path: "repo/link", content: "target", type: "symlink" as const }]],
  ["Git metadata", [{ path: "repo/.git/config", content: "credential=secret" }]],
  ["submodule metadata", [{ path: "repo/.gitmodules", content: "[submodule]" }]],
  [
    "Git LFS pointer",
    [
      {
        path: "repo/file.bin",
        content: "version https://git-lfs.github.com/spec/v1\noid sha256:abc\n",
      },
    ],
  ],
])("rejects an archive containing %s and removes its workspace", async (_name, entries) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agentci-archive-test-"));
  let dockerInvoked = false;
  try {
    const runtime = createNode24DockerRuntime({
      runtimeImages: { "node-24": `node@sha256:${"a".repeat(64)}` },
      archiveProvider: {
        async fetchExactRevisionArchive() {
          return tar(entries);
        },
      },
      docker: {
        async run(_command, arguments_) {
          if (arguments_[0] === "run") dockerInvoked = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      temporaryRoot,
    });
    const result = await runtime.validate({
      repository: "owner/repo",
      revision: "1".repeat(40),
      runtimeAlias: "node-24",
      installCommand: ["npm", "ci"],
      validationCommand: ["npm", "test"],
      proposal: { summary: "repair", changes: [{ path: "file.bin", content: "after" }] },
    });
    expect(result.outcome).toBe("failed");
    expect(dockerInvoked).toBe(false);
    expect(await readdir(temporaryRoot)).toEqual([]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

it.each(["success", "install failure", "validation failure"])(
  "cleans named containers and workspace after %s",
  async (scenario) => {
    const calls: string[][] = [];
    const temporaryRoot = await mkdtemp(join(tmpdir(), "agentci-cleanup-test-"));
    try {
      const runtime = createNode24DockerRuntime({
        runtimeImages: { "node-24": `node@sha256:${"a".repeat(64)}` },
        archiveProvider: {
          async fetchExactRevisionArchive() {
            return tar([{ path: "repo/a.txt", content: "before" }]);
          },
        },
        docker: {
          async run(_command, arguments_) {
            calls.push([...arguments_]);
            const runNumber = calls.filter(([verb]) => verb === "run").length;
            const shouldFail =
              (scenario === "install failure" && runNumber === 1) ||
              (scenario === "validation failure" && runNumber === 2);
            return { exitCode: shouldFail ? 1 : 0, stdout: "", stderr: "" };
          },
        },
        temporaryRoot,
      });
      await runtime.validate({
        repository: "owner/repo",
        revision: "1".repeat(40),
        runtimeAlias: "node-24",
        installCommand: ["npm", "ci"],
        validationCommand: ["npm", "test"],
        proposal: { summary: "repair", changes: [{ path: "a.txt", content: "after" }] },
      });
      const names = calls
        .filter(([verb]) => verb === "run")
        .map((arguments_) => arguments_[arguments_.indexOf("--name") + 1]);
      const removed = calls.filter(([verb]) => verb === "rm").map((arguments_) => arguments_[2]);
      expect(removed).toEqual(expect.arrayContaining(names));
      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

it.each(["timeout", "cancellation"])(
  "aborts on %s and still cleans all resources",
  async (cause) => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "agentci-abort-test-"));
    const external = new AbortController();
    const calls: string[][] = [];
    try {
      const runtime = createNode24DockerRuntime({
        runtimeImages: { "node-24": `node@sha256:${"a".repeat(64)}` },
        archiveProvider: {
          async fetchExactRevisionArchive() {
            return tar([{ path: "repo/a.txt", content: "before" }]);
          },
        },
        docker: {
          async run(_command, arguments_, options) {
            calls.push([...arguments_]);
            if (arguments_[0] !== "run") return { exitCode: 0, stdout: "", stderr: "" };
            await new Promise<void>((resolvePromise) => {
              if (options?.signal?.aborted) resolvePromise();
              else
                options?.signal?.addEventListener("abort", () => resolvePromise(), { once: true });
            });
            throw new Error("aborted");
          },
        },
        temporaryRoot,
        timeoutMs: cause === "timeout" ? 10 : 10_000,
      });
      if (cause === "cancellation") setTimeout(() => external.abort(), 10);
      const result = await runtime.validate({
        repository: "owner/repo",
        revision: "1".repeat(40),
        runtimeAlias: "node-24",
        installCommand: ["npm", "ci"],
        validationCommand: ["npm", "test"],
        signal: external.signal,
        proposal: { summary: "repair", changes: [{ path: "a.txt", content: "after" }] },
      });
      expect(result).toEqual({
        outcome: "failed",
        summary:
          cause === "timeout"
            ? "Sandbox validation timed out."
            : "Sandbox validation was cancelled.",
      });
      expect(calls.filter(([verb]) => verb === "rm")).toHaveLength(2);
      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

it("does not acquire source or start Docker when validation is already cancelled", async () => {
  const external = new AbortController();
  external.abort();
  let archiveRequested = false;
  let dockerInvoked = false;
  const runtime = createNode24DockerRuntime({
    runtimeImages: { "node-24": `node@sha256:${"a".repeat(64)}` },
    archiveProvider: {
      async fetchExactRevisionArchive() {
        archiveRequested = true;
        return Buffer.alloc(0);
      },
    },
    docker: {
      async run() {
        dockerInvoked = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });

  const result = await runtime.validate({
    repository: "owner/repo",
    revision: "1".repeat(40),
    runtimeAlias: "node-24",
    installCommand: ["npm", "ci"],
    validationCommand: ["npm", "test"],
    signal: external.signal,
    proposal: { summary: "repair", changes: [{ path: "a.txt", content: "after" }] },
  });

  expect(result).toEqual({ outcome: "failed", summary: "Sandbox validation was cancelled." });
  expect({ archiveRequested, dockerInvoked }).toEqual({
    archiveRequested: false,
    dockerInvoked: false,
  });
});

it.each([
  ["a non-npm installer", ["pnpm", "install"]],
  ["npm install", ["npm", "install"]],
  ["scripts explicitly enabled", ["npm", "ci", "--ignore-scripts=false"]],
  ["scripts enabled with split arguments", ["npm", "ci", "--ignore-scripts", "false"]],
  ["scripts enabled with the negative flag", ["npm", "ci", "--no-ignore-scripts"]],
  ["scripts enabled through config", ["npm", "ci", "--config.ignore-scripts=false"]],
  ["an option terminator that bypasses enforced options", ["npm", "ci", "--"]],
])("refuses %s before starting an installation container", async (_name, installCommand) => {
  const calls: string[][] = [];
  const runtime = createNode24DockerRuntime({
    runtimeImages: { "node-24": `node@sha256:${"a".repeat(64)}` },
    archiveProvider: {
      async fetchExactRevisionArchive() {
        return tar([{ path: "repo/a.txt", content: "before" }]);
      },
    },
    docker: {
      async run(_command, arguments_) {
        calls.push([...arguments_]);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });
  const result = await runtime.validate({
    repository: "owner/repo",
    revision: "1".repeat(40),
    runtimeAlias: "node-24",
    installCommand,
    validationCommand: ["npm", "test"],
    proposal: { summary: "repair", changes: [{ path: "a.txt", content: "after" }] },
  });
  expect(result.outcome).toBe("failed");
  expect(calls.some(([verb]) => verb === "run")).toBe(false);
});

it("rejects a compressed archive whose expanded form exceeds the workspace limit", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agentci-compressed-archive-test-"));
  let dockerInvoked = false;
  try {
    const runtime = createNode24DockerRuntime({
      runtimeImages: { "node-24": `node@sha256:${"a".repeat(64)}` },
      archiveProvider: {
        async fetchExactRevisionArchive() {
          return gzipSync(Buffer.alloc(50 * 1024 * 1024 + 1));
        },
      },
      docker: {
        async run(_command, arguments_) {
          if (arguments_[0] === "run") dockerInvoked = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      temporaryRoot,
    });

    const result = await runtime.validate({
      repository: "owner/repo",
      revision: "1".repeat(40),
      runtimeAlias: "node-24",
      installCommand: ["npm", "ci"],
      validationCommand: ["npm", "test"],
      proposal: { summary: "repair", changes: [{ path: "a.txt", content: "after" }] },
    });

    expect(result.outcome).toBe("failed");
    expect(dockerInvoked).toBe(false);
    expect(await readdir(temporaryRoot)).toEqual([]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
