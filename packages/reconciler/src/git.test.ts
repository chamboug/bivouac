import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sshEnv } from "./git.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("git SSH options", () => {
  it("pins the host keys even before the deploy key exists, and uses the key once it does", () => {
    const dir = mkdtempSync(join(tmpdir(), "bivouac-git-"));
    roots.push(dir);
    const source = { repository: "git@github.com:o/r.git", branch: "main", deployKey: join(dir, "deploy_key"), knownHosts: "/hosts" };

    const before = sshEnv(source).GIT_SSH_COMMAND;
    expect(before).toContain("-o StrictHostKeyChecking=yes");
    expect(before).toContain("-o UserKnownHostsFile=/hosts");
    expect(before).not.toContain("-i ");

    writeFileSync(join(dir, "deploy_key"), "not a real key");
    const after = sshEnv(source).GIT_SSH_COMMAND;
    expect(after).toContain(`-i ${join(dir, "deploy_key")}`);
    expect(after).toContain("-o IdentitiesOnly=yes");
    expect(after).toContain("-o UserKnownHostsFile=/hosts");
  });

  it("sets nothing for local repos in tests", () => {
    expect(sshEnv({ repository: "/tmp/repo", branch: "main" })).toEqual({});
  });
});
