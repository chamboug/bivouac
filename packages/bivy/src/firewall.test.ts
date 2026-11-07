import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The nftables rules that keep containers away from the metadata service
 * (D7), checked by loading them for real, twice, in a throwaway container:
 * `nft` there only changes the container's own network namespace, never
 * the machine running the tests.
 */

const here = dirname(fileURLToPath(import.meta.url));
const butane = parse(readFileSync(join(here, "..", "..", "..", "template", "butane", "server.bu"), "utf8"), {
  version: "1.1",
}) as { storage: { files: { path: string; contents?: { inline?: string } }[] } };
const RULES_PATH = "/etc/bivouac-metadata-block.nft";
const rules = butane.storage.files.find((file) => file.path === RULES_PATH)?.contents?.inline ?? "";

const ALPINE_IMAGE = "alpine:3.24";
const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const describeWithDocker = hasDocker || process.env.CI ? describe : describe.skip;

describe("metadata block", () => {
  it("is in the Butane and drops forwarded traffic to 169.254.169.254", () => {
    expect(rules).toContain("type filter hook forward");
    expect(rules).toMatch(/ip daddr 169\.254\.169\.254 .*reject/);
  });
});

describeWithDocker("metadata block (nft)", () => {
  it("loads, can be loaded again without duplicating its rule, and is what nft lists", () => {
    const script = [
      "apk add --quiet nftables >/dev/null",
      "nft -f /rules.nft",
      "nft -f /rules.nft",
      "nft list table inet bivouac_metadata",
    ].join(" && ");
    const result = spawnSync(
      "docker",
      ["run", "--rm", "--cap-add", "NET_ADMIN", "--interactive", ALPINE_IMAGE, "sh", "-c", `cat > /rules.nft && ${script}`],
      { input: rules, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/169\.254\.169\.254/g)).toHaveLength(1);
  }, 120_000);
});
