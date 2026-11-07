import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The host script that applies the SSH keys written by the reconciler
 * (D12), run in a throwaway container with a stand-in `update-ssh-keys`
 * that records how it is called: the real one only exists on Flatcar.
 */

const here = dirname(fileURLToPath(import.meta.url));
const butane = parse(readFileSync(join(here, "..", "..", "..", "template", "butane", "server.bu"), "utf8"), {
  version: "1.1",
}) as { storage: { files: { path: string; mode: number; contents?: { inline?: string } }[] } };
const SCRIPT_PATH = "/opt/bivouac/sync-ssh-keys";
const scriptFile = butane.storage.files.find((file) => file.path === SCRIPT_PATH);
const script = scriptFile?.contents?.inline ?? "";

const KEY = readFileSync(join(here, "..", "..", "manifest", "fixtures", "ssh-key.pub"), "utf8").trim();
const ALPINE_IMAGE = "alpine:3.24";
const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const describeWithDocker = hasDocker || process.env.CI ? describe : describe.skip;

/**
 * Runs the script with `list` as the reconciler's key list (undefined: no
 * list) and `fragments` already in core's authorized_keys.d. Returns the
 * exit code, its output and the recorded `update-ssh-keys` calls.
 */
function runScript(
  list: string | undefined,
  fragments: string[] = [],
  stub = "",
): { status: number; output: string; calls: string[]; applied: string } {
  const setup = [
    "mkdir -p /var/lib/bivouac/ssh /home/core/.ssh/authorized_keys.d /stub",
    ...fragments.map((name) => `touch /home/core/.ssh/authorized_keys.d/${name}`),
    `printf '#!/bin/sh\\necho "$*" >> /calls\\n${stub}\\n' > /stub/update-ssh-keys && chmod +x /stub/update-ssh-keys`,
    ...(list === undefined ? [] : ["printf '%s' \"$LIST\" > /var/lib/bivouac/ssh/authorized_keys"]),
    "printf '%s' \"$SCRIPT\" > /sync && chmod +x /sync",
    "PATH=/stub:$PATH /sync; status=$?; echo \"--- calls\"; cat /calls 2>/dev/null; echo \"--- applied\"; cat /var/lib/bivouac/ssh-status/applied 2>/dev/null; exit $status",
  ].join(" && ");
  const result = spawnSync(
    "docker",
    ["run", "--rm", "--env", "SCRIPT", "--env", "LIST", ALPINE_IMAGE, "sh", "-c", setup],
    { encoding: "utf8", env: { ...process.env, SCRIPT: script, LIST: list ?? "" } },
  );
  const [output = "", rest = ""] = result.stdout.split("--- calls\n");
  const [calls = "", applied = ""] = rest.split("--- applied\n");
  return {
    status: result.status ?? 1,
    output: output.trim(),
    calls: calls.trim() ? calls.trim().split("\n") : [],
    applied: applied.trim(),
  };
}

describe("SSH keys hook", () => {
  it("is in the Butane, executable by root only", () => {
    expect(script).toContain("update-ssh-keys -u core -a bivouac");
    expect(scriptFile?.mode.toString(8)).toBe("700");
  });
});

describeWithDocker("SSH keys hook (script)", () => {
  it("does nothing before the reconciler has written a list", () => {
    expect(runScript(undefined, ["ignition"])).toEqual({
      status: 0,
      output: expect.stringMatching(/nothing to do/),
      calls: [],
      applied: "",
    });
  });

  it("applies the list, then removes every other set of keys, and reports it", () => {
    const list = `${KEY}\n${KEY.replace(/\S+$/, "other@machine")}\n`;
    const result = runScript(list, ["ignition", "coreos-metadata", "afterburn"]);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "-u core -a bivouac /run/bivouac-ssh-keys.list",
      "-u core -d afterburn",
      "-u core -d coreos-metadata",
      "-u core -d ignition",
    ]);
    expect(result.applied).toBe(`applied ${createHash("sha256").update(list).digest("hex")}`);
  });

  it("keeps its own set of keys", () => {
    expect(runScript(`${KEY}\n`, ["bivouac"]).calls).toEqual(["-u core -a bivouac /run/bivouac-ssh-keys.list"]);
  });

  it("removes nothing, and reports it, when update-ssh-keys refuses the list", () => {
    const result = runScript(`${KEY}\n`, ["ignition"], "exit 1");
    expect(result.status).toBe(1);
    expect(result.calls).toEqual(["-u core -a bivouac /run/bivouac-ssh-keys.list"]);
    expect(result.applied).toMatch(/^refused [0-9a-f]{64}: update-ssh-keys did not accept the list$/);
  });

  it("refuses an empty list, a blank line or anything that is not a public key, and changes nothing", () => {
    for (const list of ["", "\n", `${KEY} café\n`, `${KEY}\n\n`, `${KEY}\ncommand="sh" ${KEY}\n`, "-----BEGIN OPENSSH PRIVATE KEY-----\n"]) {
      const result = runScript(list, ["ignition"]);
      expect(result.status, JSON.stringify(list)).toBe(1);
      expect(result.output).toMatch(/^refused [0-9a-f]{64}: /);
      expect(result.applied).toBe(result.output);
      expect(result.calls).toEqual([]);
    }
  });
});
