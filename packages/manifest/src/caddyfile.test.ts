import { describe, expect, it } from "vitest";
import { generateCaddyfile } from "./caddyfile.js";
import { appManifestSchema, siteManifestSchema } from "./schema.js";

const platform = {
  domain: "apps.example.com",
  repository: "git@github.com:example/bivouac-platform.git",
  reconciler: { image: "ghcr.io/example/bivouac-reconciler:sha-abc1234" },
};
const app = (fields: Record<string, unknown>) =>
  appManifestSchema.parse({ image: "ghcr.io/example/app:sha-abc123", groups: ["family"], ...fields });

describe("caddyfile", () => {
  it("routes each app to its container by name, on its subdomain and custom domains", () => {
    const { caddyfile, errors } = generateCaddyfile(
      platform,
      [app({ name: "recipes", port: 8080, domains: ["recipes.example.org"] }), app({ name: "library" })],
      [],
    );
    expect(errors).toEqual([]);
    expect(caddyfile).toContain(
      "recipes.apps.example.com, recipes.example.org {\n\treverse_proxy bivouac-app-recipes:8080\n}",
    );
    expect(caddyfile).toContain("library.apps.example.com {\n\treverse_proxy bivouac-app-library:3000\n}");
  });

  it("keeps the admin API inside Caddy's container", () => {
    expect(generateCaddyfile(platform, [], []).caddyfile).toMatch(/^\{\n(\t#.*\n)*\tadmin localhost:2019\n\}/);
  });

  it("always refuses Pocket ID's first-admin page by default (D15)", () => {
    const { caddyfile } = generateCaddyfile(platform, [], []);
    expect(caddyfile).toContain(
      "auth.apps.example.com {\n" +
        "\t@setup path /setup /setup/* /api/signup/setup /api/signup/setup/*\n" +
        "\trespond @setup 403\n" +
        "\treverse_proxy bivouac-pocket-id:1411\n" +
        "}",
    );
  });

  it("opens the first-admin page to the owner's IP only, during installation", () => {
    const { caddyfile } = generateCaddyfile({ ...platform, auth: { setupFrom: "203.0.113.7" } }, [], []);
    expect(caddyfile).toContain("\t\tnot remote_ip 203.0.113.7\n");
    expect(caddyfile).toContain("\trespond @setup 403\n");
  });

  it("refuses what is not built yet instead of serving it unprotected", () => {
    const { caddyfile, errors } = generateCaddyfile(
      platform,
      [app({ name: "node-red", auth: "forward" })],
      [siteManifestSchema.parse({ name: "home" })],
    );
    expect(errors.map((error) => error.file)).toEqual(["apps/node-red.yml", "sites/home.yml"]);
    expect(caddyfile).not.toContain("node-red");
  });
});
