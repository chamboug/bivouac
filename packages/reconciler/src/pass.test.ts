import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prepare, type PassConfig } from "./pass.js";

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, "..", "..", "..", "template");
const SSH_KEY = readFileSync(join(here, "..", "..", "manifest", "fixtures", "ssh-key.pub"), "utf8").trim();

/** platform.yml beyond the domain. */
const PLATFORM_REST = "repository: git@github.com:example/bivouac-platform.git\nreconciler:\n  image: ghcr.io/example/bivouac-reconciler:sha-abc1234\n";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** An instance repo on disk, filled from the template, and a reconciler config reading it. */
function setup(): { work: string; config: Pick<PassConfig, "source" | "checkout">; commit: (message: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "bivouac-reconciler-"));
  roots.push(root);
  const work = join(root, "work");
  cpSync(template, work, { recursive: true });
  writeFileSync(join(work, "platform.yml"), `domain: apps.example.com\n${PLATFORM_REST}`);
  writeFileSync(join(work, "ssh-keys.yml"), `keys:\n  - name: fixture\n    key: ${SSH_KEY}\n`);
  git(root, "init", "--quiet", "--initial-branch=main", work);
  const commit = (message: string) => {
    git(work, "add", "--all");
    git(work, "commit", "--quiet", "--message", message);
    return git(work, "rev-parse", "HEAD");
  };
  commit("initial");
  return {
    work,
    commit,
    config: {
      // file:// makes git use its normal transport, so `--depth` is honored.
      source: { repository: `file://${work}`, branch: "main" },
      checkout: join(root, "state", "repo"),
    },
  };
}

const app = (name: string) => `name: ${name}\nimage: ghcr.io/example/${name}:sha-abc123\ngroups: [family]\n`;

const appNames = (config: Pick<PassConfig, "source" | "checkout">) => {
  const prepared = prepare(config);
  return prepared.status === "valid" ? prepared.instance.apps.map((entry) => entry.name) : prepared;
};

describe("reading the desired state", () => {
  it("clones the repo, then follows new commits", () => {
    const { config, work, commit } = setup();
    const head = git(work, "rev-parse", "HEAD");
    expect(prepare(config)).toMatchObject({ status: "valid", commit: head });

    writeFileSync(join(work, "apps", "recipes.yml"), app("recipes"));
    const next = commit("add recipes");
    expect(prepare(config)).toMatchObject({ status: "valid", commit: next });
    expect(appNames(config)).toEqual(["recipes"]);
  });

  it("reports an invalid commit, so nothing gets applied", () => {
    const { config, work, commit } = setup();
    writeFileSync(join(work, "apps", "library.yml"), "name: library\nimage: ghcr.io/example/library:latest\ngroups: [family]\n");
    const head = commit("broken manifest");
    const result = prepare(config);

    expect(result).toMatchObject({ status: "invalid", commit: head });
    expect(result.status === "invalid" && result.errors).toEqual([
      { file: "apps/library.yml", message: expect.stringContaining("latest") },
    ]);
  });

  it("refuses what the Caddyfile cannot serve yet (auth forward)", () => {
    const { config, work, commit } = setup();
    writeFileSync(join(work, "apps", "red.yml"), "name: red\nimage: nodered/node-red:4.0.9\nauth: forward\ngroups: [admin]\n");
    commit("forward app");
    expect(prepare(config).status).toBe("invalid");
  });

  it("discards local edits in the checkout: Git is the only source of truth", () => {
    const { config } = setup();
    prepare(config);
    writeFileSync(join(config.checkout, "platform.yml"), `domain: hacked.example.com\n${PLATFORM_REST}`);
    writeFileSync(join(config.checkout, "apps", "stray.yml"), app("stray"));

    const result = prepare(config);
    expect(result.status === "valid" && result.instance.platform.domain).toBe("apps.example.com");
    expect(appNames(config)).toEqual([]);
  });
});
