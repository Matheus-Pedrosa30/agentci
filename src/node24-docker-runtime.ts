import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import type { RepairProposal, SandboxRuntime } from "./repair-orchestrator.ts";

const IMAGE_DIGEST = /^[a-z\d]+(?:[._/-][a-z\d]+)*(?::[\w.-]+)?@sha256:[a-f\d]{64}$/u;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_OUTPUT_BYTES = 32 * 1024;

export interface DockerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DockerCommandRunner {
  run(
    command: string,
    arguments_: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<DockerCommandResult>;
}

export interface ExactRevisionArchiveProvider {
  fetchExactRevisionArchive(input: {
    repository: string;
    revision: string;
    signal: AbortSignal;
  }): Promise<Buffer>;
}

export interface Node24DockerRuntimeOptions {
  runtimeImages: Readonly<Record<string, string>>;
  archiveProvider: ExactRevisionArchiveProvider;
  docker?: DockerCommandRunner;
  temporaryRoot?: string;
  timeoutMs?: number;
}

function boundedAppend(current: string, chunk: Buffer): string {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  return (current + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
}

function processRunner(): DockerCommandRunner {
  return {
    run(command, arguments_, options = {}) {
      return new Promise((resolvePromise, reject) => {
        const child = spawn(command, arguments_, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: { PATH: process.env.PATH ?? "" },
          signal: options.signal,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout = boundedAppend(stdout, chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = boundedAppend(stderr, chunk);
        });
        child.once("error", reject);
        child.once("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }));
      });
    },
  };
}

function octal(field: Buffer): number {
  const value = field.toString("ascii").replaceAll("\0", "").trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error("Archive contains an invalid numeric field.");
  return Number.parseInt(value, 8);
}

function archivePath(header: Buffer): string {
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/su, "");
  const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/su, "");
  return prefix ? `${prefix}/${name}` : name;
}

interface ArchiveEntry {
  path: string;
  directory: boolean;
  content: Buffer;
}

function parseArchive(source: Buffer): ArchiveEntry[] {
  if (source.length > MAX_ARCHIVE_BYTES) throw new Error("Repository archive is too large.");
  const bytes = source[0] === 0x1f && source[1] === 0x8b ? gunzipSync(source) : source;
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("Repository archive is too large.");
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const storedChecksum = octal(header.subarray(148, 156));
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (storedChecksum !== checksum) throw new Error("Repository archive checksum is invalid.");
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] ?? 0);
    if (type !== "\0" && type !== "0" && type !== "5") {
      throw new Error("Repository archive contains a link or unsupported entry.");
    }
    const path = archivePath(header).replace(/\/$/u, "");
    if (
      !path ||
      path.includes("\\") ||
      path.startsWith("/") ||
      posix.normalize(path) !== path ||
      path.split("/").includes("..")
    ) {
      throw new Error("Repository archive contains an unsafe path.");
    }
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > bytes.length) throw new Error("Repository archive is truncated.");
    entries.push({
      path,
      directory: type === "5",
      content: bytes.subarray(contentStart, contentEnd),
    });
    if (entries.length > MAX_ARCHIVE_ENTRIES)
      throw new Error("Repository archive has too many entries.");
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0) throw new Error("Repository archive is empty.");
  return entries;
}

function strippedEntries(entries: readonly ArchiveEntry[]): ArchiveEntry[] {
  const firstParts = entries.map((entry) => entry.path.split("/")[0]);
  const root = firstParts[0];
  const strip =
    root &&
    firstParts.every((part) => part === root) &&
    entries.some((entry) => entry.path.includes("/"));
  return entries
    .map((entry) => ({ ...entry, path: strip ? entry.path.slice(root.length + 1) : entry.path }))
    .filter((entry) => entry.path.length > 0);
}

function workspacePath(workspace: string, archiveRelativePath: string): string {
  const components = archiveRelativePath.split("/");
  if (components.some((part) => part === ".git" || part === ".gitmodules")) {
    throw new Error("Repository archive contains Git metadata.");
  }
  const target = resolve(workspace, ...components);
  const prefix = `${resolve(workspace)}${sep}`;
  if (!target.startsWith(prefix)) throw new Error("Repository archive escapes the workspace.");
  return target;
}

async function extractArchive(source: Buffer, workspace: string): Promise<void> {
  for (const entry of strippedEntries(parseArchive(source))) {
    const target = workspacePath(workspace, entry.path);
    if (entry.directory) {
      await mkdir(target, { recursive: true });
      await chmod(target, 0o777);
      continue;
    }
    if (
      entry.content
        .subarray(0, 64)
        .toString("utf8")
        .startsWith("version https://git-lfs.github.com/spec/")
    ) {
      throw new Error("Repository archive contains a Git LFS pointer.");
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.content, { flag: "wx", mode: 0o666 });
    await chmod(dirname(target), 0o777);
    await chmod(target, 0o666);
  }
}

function proposalPath(workspace: string, path: string): string {
  if (
    !path ||
    path.includes("\\") ||
    path.startsWith("/") ||
    posix.normalize(path) !== path ||
    path.split("/").includes("..")
  ) {
    throw new Error("Repair Proposal contains an unsafe path.");
  }
  return workspacePath(workspace, path);
}

async function applyProposal(workspace: string, proposal: RepairProposal): Promise<string[]> {
  const changedFiles: string[] = [];
  for (const change of proposal.changes) {
    const target = proposalPath(workspace, change.path);
    const metadata = await stat(target);
    if (!metadata.isFile()) throw new Error("Repair Proposal path is not an existing file.");
    await writeFile(target, change.content, { encoding: "utf8" });
    await chmod(target, 0o666);
    changedFiles.push(change.path);
  }
  return changedFiles;
}

function containerArguments(input: {
  name: string;
  workspace: string;
  image: string;
  network: "bridge" | "none";
  command: readonly string[];
}): string[] {
  return [
    "run",
    "--rm",
    "--name",
    input.name,
    "--network",
    input.network,
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
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=256m",
    "--env",
    "HOME=/tmp",
    "--env",
    "NPM_CONFIG_CACHE=/tmp/npm-cache",
    "--env",
    "NPM_CONFIG_IGNORE_SCRIPTS=true",
    "--workdir",
    "/workspace",
    "--mount",
    `type=bind,source=${input.workspace},target=/workspace`,
    input.image,
    ...input.command,
  ];
}

function installCommand(command: readonly string[]): string[] {
  if (
    command[0] !== "npm" ||
    command[1] !== "ci" ||
    command.some((argument) => argument.includes("\0") || argument === "--ignore-scripts=false")
  ) {
    throw new Error("Installation command is invalid.");
  }
  return command[0] === "npm" && !command.includes("--ignore-scripts")
    ? [...command, "--ignore-scripts"]
    : [...command];
}

function validationCommand(command: readonly string[]): string[] {
  if (command.length === 0 || command.some((argument) => argument.includes("\0"))) {
    throw new Error("Validation command is invalid.");
  }
  return [...command];
}

export function createNode24DockerRuntime(options: Node24DockerRuntimeOptions): SandboxRuntime {
  const docker = options.docker ?? processRunner();
  const timeoutMs = options.timeoutMs ?? 300_000;
  return {
    async validate(input) {
      const image = options.runtimeImages[input.runtimeAlias];
      if (!image || !IMAGE_DIGEST.test(image) || !/^[a-f\d]{40}$/u.test(input.revision)) {
        return { outcome: "failed", summary: "Runtime Profile is not approved and digest-pinned." };
      }
      const controller = new AbortController();
      let timedOut = false;
      const startedAt = Date.now();
      const timer = setTimeout(
        () => {
          timedOut = true;
          controller.abort();
        },
        Math.max(1, Math.floor(timeoutMs * 0.95)),
      );
      const cancel = () => controller.abort();
      input.signal?.addEventListener("abort", cancel, { once: true });
      const root = options.temporaryRoot ?? tmpdir();
      const workspaceParent = await mkdtemp(join(root, "agentci-workspace-"));
      const workspace = join(workspaceParent, "repository");
      const names = [`agentci-install-${randomUUID()}`, `agentci-validate-${randomUUID()}`];
      try {
        await mkdir(workspace, { mode: 0o777 });
        const archive = await options.archiveProvider.fetchExactRevisionArchive({
          repository: input.repository,
          revision: input.revision,
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw new Error("Sandbox validation timed out.");
        await extractArchive(archive, workspace);
        const changedFiles = await applyProposal(workspace, input.proposal);
        const install = await docker.run(
          "docker",
          containerArguments({
            name: names[0]!,
            workspace,
            image,
            network: "bridge",
            command: installCommand(input.installCommand),
          }),
          { signal: controller.signal },
        );
        if (install.exitCode !== 0)
          return { outcome: "failed", summary: "Dependency installation failed." };
        const validation = await docker.run(
          "docker",
          containerArguments({
            name: names[1]!,
            workspace,
            image,
            network: "none",
            command: validationCommand(input.validationCommand),
          }),
          { signal: controller.signal },
        );
        return validation.exitCode === 0
          ? { outcome: "passed", changedFiles }
          : { outcome: "failed", summary: "Validation command failed." };
      } catch {
        return {
          outcome: "failed",
          summary: timedOut
            ? "Sandbox validation timed out."
            : input.signal?.aborted
              ? "Sandbox validation was cancelled."
              : "Sandbox validation could not be completed.",
        };
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", cancel);
        const cleanup = new AbortController();
        const cleanupTimer = setTimeout(
          () => cleanup.abort(),
          Math.max(1, timeoutMs - (Date.now() - startedAt)),
        );
        await Promise.allSettled(
          names.map((name) =>
            docker.run("docker", ["rm", "--force", name], { signal: cleanup.signal }),
          ),
        );
        clearTimeout(cleanupTimer);
        await rm(workspaceParent, { recursive: true, force: true });
      }
    },
  };
}
