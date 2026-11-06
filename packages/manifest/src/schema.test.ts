import { describe, expect, it } from "vitest";
import { appManifestSchema, platformConfigSchema, siteManifestSchema, sshKeysSchema } from "./schema.js";

const IMAGE = "ghcr.io/someone/recettes:sha-abc123";
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBmN1jW3cGmRk2c3Jx4m8b9e0Y3tB0v6pLqW2x1Yy7Zz gaetan@mac";

function appErrors(input: unknown): string[] {
  const result = appManifestSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

describe("app manifest", () => {
  it("fills in the defaults", () => {
    const app = appManifestSchema.parse({ name: "recettes", image: IMAGE, groups: ["famille"] });
    expect(app).toEqual({
      name: "recettes",
      image: IMAGE,
      port: 3000,
      health: "/api/health",
      auth: "oidc",
      groups: ["famille"],
      volumes: {},
      backup: { stop: false },
      env: {},
      domains: [],
    });
  });

  it("accepts the full example from the brief", () => {
    expect(
      appErrors({
        image: IMAGE,
        name: "recettes",
        port: 3000,
        health: "/api/health",
        database: { extensions: ["postgis"] },
        auth: "oidc",
        groups: ["famille"],
        volumes: { uploads: "/app/uploads" },
        backup: { stop: false },
        env: { GF_AUTH_GENERIC_OAUTH_CLIENT_ID: "${oidc.clientId}" },
      }),
    ).toEqual([]);
  });

  it.each(["auth", "gate", "status"])("rejects the reserved name %s", (name) => {
    expect(appErrors({ name, image: IMAGE, auth: "public" })).toEqual([expect.stringContaining("reserved")]);
  });

  it.each(["Recettes", "1app", "app-", "a--b", "my_app", "archived-recettes", "a".repeat(41)])(
    "rejects the invalid name %s",
    (name) => {
      expect(appErrors({ name, image: IMAGE, auth: "public" })).not.toEqual([]);
    },
  );

  it.each([
    "ghcr.io/someone/recettes:sha-abc123",
    "nodered/node-red:4.0.9",
    "postgres:17",
    "localhost:5000/app:1",
    `ghcr.io/someone/app@sha256:${"a".repeat(64)}`,
    `ghcr.io/someone/app:1.2@sha256:${"a".repeat(64)}`,
  ])("accepts the image %s", (image) => {
    expect(appErrors({ name: "app", image, auth: "public" })).toEqual([]);
  });

  it.each(["ghcr.io/someone/recettes", "ghcr.io/someone/recettes:latest", "Ghcr.io/X:1", "app:"])(
    "rejects the image %s",
    (image) => {
      expect(appErrors({ name: "app", image, auth: "public" })).not.toEqual([]);
    },
  );

  it("requires groups for oidc and forward, so not every account gets in", () => {
    expect(appErrors({ name: "app", image: IMAGE })).toEqual([expect.stringContaining("at least one group")]);
    expect(appErrors({ name: "app", image: IMAGE, auth: "forward" })).toEqual([
      expect.stringContaining("at least one group"),
    ]);
  });

  it("refuses groups where they would have no effect", () => {
    expect(appErrors({ name: "app", image: IMAGE, auth: "public", groups: ["famille"] })).toEqual([
      expect.stringContaining("no effect"),
    ]);
  });

  it("rejects unknown fields, to catch typos", () => {
    expect(appErrors({ name: "app", image: IMAGE, auth: "public", volume: { a: "/a" } })).toEqual([
      expect.stringContaining("volume"),
    ]);
  });

  it("allows health checks to be turned off for third-party apps", () => {
    expect(appErrors({ name: "app", image: IMAGE, auth: "public", health: false })).toEqual([]);
    expect(appErrors({ name: "app", image: IMAGE, auth: "public", health: "health" })).not.toEqual([]);
  });

  it("checks volumes", () => {
    expect(appErrors({ name: "app", image: IMAGE, auth: "public", volumes: { data: "data" } })).not.toEqual([]);
    expect(
      appErrors({ name: "app", image: IMAGE, auth: "public", volumes: { a: "/data", b: "/data" } }),
    ).toEqual([expect.stringContaining("two volumes")]);
  });

  it("checks env references", () => {
    expect(appErrors({ name: "app", image: IMAGE, auth: "public", env: { A: "${oidc.clientId}" } })).toEqual([
      expect.stringContaining("auth is not 'oidc'"),
    ]);
    expect(appErrors({ name: "app", image: IMAGE, auth: "public", env: { A: "${db.url}" } })).toEqual([
      expect.stringContaining("no database"),
    ]);
    expect(appErrors({ name: "app", image: IMAGE, auth: "public", env: { A: "${nope}" } })).toEqual([
      expect.stringContaining("unknown value"),
    ]);
    expect(
      appErrors({ name: "app", image: IMAGE, auth: "public", database: {}, env: { URL: "x${db.url}", N: 3 } }),
    ).toEqual([]);
  });

  it("refuses to redefine variables injected by the platform", () => {
    expect(appErrors({ name: "app", image: IMAGE, auth: "public", env: { DATABASE_URL: "x" } })).toEqual([
      expect.stringContaining("already provided"),
    ]);
  });
});

describe("site manifest", () => {
  it("is public by default", () => {
    expect(siteManifestSchema.parse({ name: "home", domains: ["example.com"] }).auth).toBe("public");
  });

  it("only supports public and forward auth (no container to run oidc)", () => {
    expect(siteManifestSchema.safeParse({ name: "home", auth: "oidc", groups: ["a"] }).success).toBe(false);
    expect(siteManifestSchema.safeParse({ name: "home", auth: "forward", groups: ["a"] }).success).toBe(true);
  });
});

describe("ssh keys", () => {
  it("accepts public keys", () => {
    expect(sshKeysSchema.safeParse({ keys: [{ name: "gaetan-mac", key: KEY }] }).success).toBe(true);
  });

  it("refuses an empty list, which would lock everyone out", () => {
    expect(sshKeysSchema.safeParse({ keys: [] }).success).toBe(false);
  });

  it("refuses private keys with a clear message", () => {
    const result = sshKeysSchema.safeParse({
      keys: [{ name: "oops", key: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----" }],
    });
    expect(result.error?.issues[0]?.message).toContain("PRIVATE key");
  });

  it("refuses duplicate names and duplicate keys", () => {
    const result = sshKeysSchema.safeParse({
      keys: [
        { name: "a", key: KEY },
        { name: "a", key: KEY.replace("gaetan@mac", "other") },
      ],
    });
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "'a' is listed twice",
      "is the same key as another entry",
    ]);
  });
});

describe("platform config", () => {
  it("accepts an IPv4 or IPv6 address for the first-admin page, and nothing else", () => {
    expect(platformConfigSchema.safeParse({ domain: "apps.example.com", auth: { setupFrom: "203.0.113.7" } }).success).toBe(true);
    expect(platformConfigSchema.safeParse({ domain: "apps.example.com", auth: { setupFrom: "2001:db8::1" } }).success).toBe(true);
    expect(platformConfigSchema.safeParse({ domain: "apps.example.com", auth: { setupFrom: "0.0.0.0/0" } }).success).toBe(false);
    expect(platformConfigSchema.safeParse({ domain: "apps.example.com", auth: { setupFrom: "anyone" } }).success).toBe(false);
  });
});
