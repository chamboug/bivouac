import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The host script that rolls the reconciler back when a new version keeps
 * failing at start (D61), run in a throwaway container: it only needs sh,
 * sed and grep.
 */

const here = dirname(fileURLToPath(import.meta.url));
type Unit = { name: string; dropins?: { name: string; contents: string }[] };
const butane = parse(readFileSync(join(here, "..", "..", "..", "template", "butane", "server.bu"), "utf8"), {
  version: "1.1",
}) as { storage: { files: { path: string; mode: number; contents?: { inline?: string } }[] }; systemd: { units: Unit[] } };
const SCRIPT_PATH = "/opt/bivouac/reconciler-trial";
const scriptFile = butane.storage.files.find((file) => file.path === SCRIPT_PATH);
const script = scriptFile?.contents?.inline ?? "";

const OLD = "ghcr.io/example/bivouac-reconciler:sha-1111111";
const NEW = `ghcr.io/example/bivouac-reconciler:sha-2222222@sha256:${"a".repeat(64)}`;
const ALPINE_IMAGE = "alpine:3.24";
const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const describeWithDocker = hasDocker || process.env.CI ? describe : describe.skip;

type Files = Partial<Record<"image.env" | "trial.env" | "trial.starts" | "refused.env", string>>;

/** Runs the script `times` times on a state directory holding `files`; returns its output and the files after. */
function run(files: Files, times = 1): { output: string; files: Files } {
  const names = ["image.env", "trial.env", "trial.starts", "refused.env"] as const;
  const setup = [
    "mkdir -p /var/lib/bivouac/reconciler",
    ...names.flatMap((name) => (files[name] === undefined ? [] : [`printf '%s' "$F_${name.replace(/\W/g, "_")}" > /var/lib/bivouac/reconciler/${name}`])),
    "printf '%s' \"$SCRIPT\" > /trial && chmod +x /trial",
    ...Array.from({ length: times }, () => "/trial"),
    ...names.map((name) => `echo "--- ${name}"; cat /var/lib/bivouac/reconciler/${name} 2>/dev/null || echo "(none)"`),
  ].join(" && ");
  const env: Record<string, string> = { SCRIPT: script };
  for (const name of names) if (files[name] !== undefined) env[`F_${name.replace(/\W/g, "_")}`] = files[name];
  const result = spawnSync(
    "docker",
    ["run", "--rm", ...Object.keys(env).flatMap((key) => ["--env", key]), ALPINE_IMAGE, "sh", "-c", setup],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
  expect(result.status, result.stderr).toBe(0);
  const [output = "", ...parts] = result.stdout.split(/^--- /m);
  const after: Files = {};
  for (const part of parts) {
    const [name = "", ...rest] = part.split("\n");
    const content = rest.join("\n").trim();
    if (content !== "(none)") after[name as keyof Files] = content;
  }
  return { output: output.trim(), files: after };
}

const onTrial = (starts?: number): Files => ({
  "image.env": `BIVOUAC_RECONCILER_IMAGE=${NEW}\n`,
  "trial.env": `BIVOUAC_TRIAL_IMAGE=${NEW}\nBIVOUAC_PREVIOUS_IMAGE=${OLD}\n`,
  ...(starts === undefined ? {} : { "trial.starts": `${starts}\n` }),
});

describe("reconciler trial hook", () => {
  it("is in the Butane, executable by root only, run before each start of the reconciler", () => {
    expect(scriptFile?.mode.toString(8)).toBe("700");
    const unit = butane.systemd.units.find((candidate) => candidate.name === "bivouac-reconciler.service");
    expect(unit?.dropins?.map((dropin) => dropin.contents)).toEqual([`[Service]\nExecStartPre=-${SCRIPT_PATH}\n`]);
  });
});

// The first run pulls the Alpine image.
describeWithDocker("reconciler trial hook (script)", { timeout: 120_000 }, () => {
  it("does nothing when no version is on trial", () => {
    const files = { "image.env": `BIVOUAC_RECONCILER_IMAGE=${NEW}\n` };
    expect(run(files)).toEqual({ output: "", files: { "image.env": files["image.env"].trim() } });
  });

  it("counts the first three starts of a version on trial", () => {
    const first = run(onTrial());
    expect(first.output).toBe(`${NEW} is on trial: start 1 of 3`);
    expect(first.files["trial.starts"]).toBe("1");
    const third = run(onTrial(), 3);
    expect(third.files["trial.starts"]).toBe("3");
    expect(third.files["image.env"]).toBe(`BIVOUAC_RECONCILER_IMAGE=${NEW}`);
  });

  it("goes back to the previous version at the fourth start, and records the failed one", () => {
    const result = run(onTrial(3));
    expect(result.output).toBe(`${NEW} failed 3 starts: back to ${OLD}`);
    expect(result.files).toEqual({
      "image.env": `BIVOUAC_RECONCILER_IMAGE=${OLD}`,
      "refused.env": `BIVOUAC_REFUSED_IMAGE=${NEW}`,
    });
  });

  it("forgets a trial that does not name the version being started", () => {
    const files = { ...onTrial(2), "image.env": `BIVOUAC_RECONCILER_IMAGE=${OLD}\n` };
    const result = run(files);
    expect(result.output).toMatch(/forgotten/);
    expect(result.files).toEqual({ "image.env": `BIVOUAC_RECONCILER_IMAGE=${OLD}` });
  });

  it("treats a damaged count as zero", () => {
    expect(run({ ...onTrial(), "trial.starts": "x\n" }).files["trial.starts"]).toBe("1");
  });

  it("never writes a value that is not a reconciler image", () => {
    for (const previous of ["ghcr.io/someone/other:sha-1111111", `${OLD} BIVOUAC_X=1`, ""]) {
      const files = { ...onTrial(3), "trial.env": `BIVOUAC_TRIAL_IMAGE=${NEW}\nBIVOUAC_PREVIOUS_IMAGE=${previous}\n` };
      const result = run(files);
      expect(result.output).toMatch(/left as is/);
      expect(result.files["image.env"]).toBe(`BIVOUAC_RECONCILER_IMAGE=${NEW}`);
      expect(result.files["refused.env"]).toBeUndefined();
    }
  });

  it("never rolls back to or records a bare repository or an invalid value", () => {
    const bare = "ghcr.io/example/bivouac-reconciler";
    for (const [candidate, previous] of [[NEW, bare], [`${bare}:latest`, OLD], [bare, OLD]]) {
      const files = {
        "image.env": `BIVOUAC_RECONCILER_IMAGE=${candidate}\n`,
        "trial.env": `BIVOUAC_TRIAL_IMAGE=${candidate}\nBIVOUAC_PREVIOUS_IMAGE=${previous}\n`,
        "trial.starts": "3\n",
      };
      const result = run(files);
      expect(result.output).toMatch(/left as is/);
      expect(result.files["image.env"]).toBe(`BIVOUAC_RECONCILER_IMAGE=${candidate}`);
      expect(result.files["refused.env"]).toBeUndefined();
    }
  });
});
