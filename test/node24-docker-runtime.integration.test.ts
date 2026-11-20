import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createNode24DockerRuntime } from "../src/node24-docker-runtime.js";

function tar(files: Readonly<Record<string, string>>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, source] of Object.entries(files)) {
    const content = Buffer.from(source);
    const header = Buffer.alloc(512);
    header.write(`fixture/${path}`, 0, 100, "utf8");
    header.write("0000777\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(32, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const pinnedImage = process.env.AGENTCI_NODE24_TEST_IMAGE;
const dockerAvailable =
  process.platform === "linux" &&
  /^.+@sha256:[a-f\d]{64}$/u.test(pinnedImage ?? "") &&
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

it.skipIf(!dockerAvailable)(
  "proves the node-24 Runtime Profile in real Docker without network, privileges, credentials, scripts, or residue",
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "agentci-docker-integration-"));
    const validateSource = String.raw`
      const fs = require("node:fs");
      const assert = require("node:assert/strict");
      assert.notEqual(process.getuid(), 0);
      assert.equal(fs.existsSync("install-script-ran"), false);
      assert.equal(fs.existsSync("node_modules/.package-lock.json"), true);
      assert.equal(fs.existsSync(".git"), false);
      assert.equal(process.env.GITHUB_TOKEN, undefined);
      assert.equal(process.env.OPENAI_API_KEY, undefined);
      const status = fs.readFileSync("/proc/self/status", "utf8");
      assert.match(status, /^CapEff:\s+0+$/m);
      assert.match(status, /^NoNewPrivs:\s+1$/m);
      assert.deepEqual(fs.readdirSync("/sys/class/net"), ["lo"]);
      const memory = Number(fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim());
      const pids = Number(fs.readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim());
      const [quota, period] = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(" ").map(Number);
      assert.ok(memory <= 1073741824);
      assert.ok(pids <= 256);
      assert.ok(quota / period <= 1);
    `;
    try {
      const runtime = createNode24DockerRuntime({
        runtimeImages: { "node-24": pinnedImage! },
        archiveProvider: {
          async fetchExactRevisionArchive() {
            return tar({
              "package.json": JSON.stringify({
                name: "agentci-runtime-fixture",
                version: "1.0.0",
                scripts: {
                  preinstall: "node -e \"require('fs').writeFileSync('install-script-ran','')\"",
                },
              }),
              "package-lock.json": JSON.stringify({
                name: "agentci-runtime-fixture",
                version: "1.0.0",
                lockfileVersion: 3,
                requires: true,
                packages: {
                  "": { name: "agentci-runtime-fixture", version: "1.0.0", hasInstallScript: true },
                },
              }),
              "validate.cjs": validateSource,
              "repair.txt": "before",
            });
          },
        },
        temporaryRoot,
      });
      const result = await runtime.validate({
        repository: "owner/repo",
        revision: "1".repeat(40),
        runtimeAlias: "node-24",
        installCommand: ["npm", "ci"],
        validationCommand: ["node", "validate.cjs"],
        proposal: { summary: "repair", changes: [{ path: "repair.txt", content: "after" }] },
      });
      expect(result).toEqual({ outcome: "passed", changedFiles: ["repair.txt"] });
      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
  330_000,
);
