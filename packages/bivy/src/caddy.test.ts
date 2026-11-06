import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { appManifestSchema, generateCaddyfile } from "@bivouac/manifest";
import { validateCaddyfile } from "./caddy.js";

// Caddy runs in Docker. In CI Docker is always there, so never skip there.
const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const describeWithDocker = hasDocker || process.env.CI ? describe : describe.skip;

describeWithDocker("caddy validate", () => {
  it("accepts the generated Caddyfile without any warning", () => {
    const app = appManifestSchema.parse({
      name: "recipes",
      image: "ghcr.io/example/recipes:sha-abc123",
      groups: ["family"],
      domains: ["recipes.example.org"],
    });
    const { caddyfile } = generateCaddyfile({ domain: "apps.example.com", auth: { setupFrom: "2001:db8::1" } }, [app], []);
    expect(() => validateCaddyfile(caddyfile)).not.toThrow();
  }, 120_000); // the first run pulls the Caddy image

  it("fails on a formatting warning, like Butane's --strict", () => {
    expect(() => validateCaddyfile("a.example.com {\n  reverse_proxy x:1\n}\n")).toThrow(/not formatted/);
  }, 60_000);

  it("fails on an invalid directive", () => {
    expect(() => validateCaddyfile("a.example.com {\n\tbogus\n}\n")).toThrow(/unrecognized directive/);
  }, 60_000);
});
