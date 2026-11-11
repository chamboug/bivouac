import { describe, expect, it } from "vitest";
import { appManifestSchema, platformConfigSchema, siteManifestSchema, sshKeysSchema } from "./schema.js";

const IMAGE = "ghcr.io/someone/recettes:sha-abc123";
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBmN1jW3cGmRk2c3Jx4m8b9e0Y3tB0v6pLqW2x1Yy7Zz owner@mac";

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
      mcp: false,
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

  it("only accepts well-known Postgres extensions", () => {
    expect(appErrors({ name: "geo", image: IMAGE, auth: "public", database: { extensions: ["postgis", "pg_trgm"] } })).toEqual([]);
    expect(appErrors({ name: "geo", image: IMAGE, auth: "public", database: { extensions: ["plpython3u"] } })).toEqual([
      expect.stringContaining("not an allowed extension"),
    ]);
  });

  it.each(["auth", "gate", "status"])("rejects the reserved name %s", (name) => {
    expect(appErrors({ name, image: IMAGE, auth: "public" })).toEqual([expect.stringContaining("reserved")]);
  });

  it.each(["postgres", "template1", "bivouac", "bivouac-pocket-id", "pg-stat", "public", "current-user"])("rejects %s, used by the platform", (name) => {
    expect(appErrors({ name, image: IMAGE, auth: "public" })).toEqual([expect.stringContaining("clash")]);
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

  it("lets an oidc app open an MCP endpoint for Claude, and no other kind (D85)", () => {
    expect(appErrors({ name: "biblio", image: IMAGE, groups: ["famille"], mcp: true })).toEqual([]);
    expect(appErrors({ name: "biblio", image: IMAGE, auth: "public", mcp: true })).toEqual([expect.stringContaining("needs auth 'oidc'")]);
    expect(appErrors({ name: "biblio-mcp", image: IMAGE, auth: "public" })).toEqual([expect.stringContaining("'-mcp'")]);
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
    expect(sshKeysSchema.safeParse({ keys: [{ name: "owner-mac", key: KEY }] }).success).toBe(true);
  });

  it("refuses keys on several lines, odd spacing, control characters and damaged keys", () => {
    const message = (key: string) => sshKeysSchema.safeParse({ keys: [{ name: "a", key }] }).error?.issues[0]?.message;
    const [type, data] = KEY.split(" ") as [string, string];
    expect(message(`${KEY}\n`)).toBeUndefined();
    expect(message(`${type} ${data}`)).toBeUndefined();
    for (const key of [`${KEY}\n${KEY}`, `${KEY} café`, `${type}\t${data} x`, `${type}  ${data}`, `${KEY}\u0007`, `command="sh" ${KEY}`]) {
      expect(message(key), JSON.stringify(key)).toMatch(/^is not an SSH public key on one line/);
    }
    // Cut short, or declared with another type than the one inside.
    expect(message(`${type} ${data.slice(0, 40)}`)).toMatch(/^is damaged/);
    expect(message(`ssh-rsa ${data} x`)).toMatch(/^is damaged/);
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
        { name: "a", key: KEY.replace("owner@mac", "other") },
      ],
    });
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "'a' is listed twice",
      "is the same key as another entry",
    ]);
  });
});

describe("backup destination", () => {
  const base = {
    domain: "apps.example.com",
    repository: "git@github.com:example/bivouac-platform.git",
    reconciler: { image: "ghcr.io/example/bivouac-reconciler:sha-abc1234" },
  };
  const parse = (repository: string) => platformConfigSchema.safeParse({ ...base, backup: { repository } }).success;

  it("accepts an S3 address over HTTPS", () => {
    expect(parse("s3:https://s3.example.com/my-bucket")).toBe(true);
  });

  it.each(["s3:http://s3.example.com/bucket", "b2:bucket", "/srv/backups", "s3:https://s3.example.com/", "s3:https://s3.example.com/bucket;rm"])("refuses %s", (repository) => {
    expect(parse(repository)).toBe(false);
  });
});

describe("platform config", () => {
  const base = {
    domain: "apps.example.com",
    repository: "git@github.com:example/bivouac-platform.git",
    reconciler: { image: "ghcr.io/example/bivouac-reconciler:sha-abc1234" },
  };
  const parse = (changes: Record<string, unknown>) => platformConfigSchema.safeParse({ ...base, ...changes });
  const messages = (changes: Record<string, unknown>) =>
    parse(changes).error?.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) ?? [];

  it("accepts an IPv4 or IPv6 address for the first-admin page, and nothing else", () => {
    expect(parse({ auth: { setupFrom: "203.0.113.7" } }).success).toBe(true);
    expect(parse({ auth: { setupFrom: "2001:db8::1" } }).success).toBe(true);
    expect(parse({ auth: { setupFrom: "0.0.0.0/0" } }).success).toBe(false);
    expect(parse({ auth: { setupFrom: "anyone" } }).success).toBe(false);
  });

  it("refuses private, loopback, link-local and other non-public addresses for the first-admin page", () => {
    for (const address of [
      "10.209.0.1", "172.17.0.1", "192.168.1.10", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "::1", "::", "fe80::1", "fd00::1", "::ffff:10.209.0.1", "ff02::1",
    ]) {
      expect(parse({ auth: { setupFrom: address } }).success, address).toBe(false);
    }
    expect(messages({ auth: { setupFrom: "10.209.0.1" } })[0]).toMatch(/public address/);
    expect(parse({ auth: { setupFrom: "88.191.205.91" } }).success).toBe(true);
    expect(parse({ auth: { setupFrom: "2a01:e0a:ff3:56c0::1" } }).success).toBe(true);
  });

  it("describes the mail account without its password, on port 587 only", () => {
    const mail = { host: "smtp.example.com", from: "contact@example.com", user: "contact@example.com" };
    expect(parse({ mail }).data?.mail?.port).toBe(587);
    expect(parse({ mail: { ...mail, port: 465 } }).success).toBe(false);
    expect(parse({ mail: { ...mail, from: "nobody" } }).success).toBe(false);
    expect(parse({ mail: { ...mail, password: "secret" } }).success).toBe(false);
  });

  it("needs the repo's address on GitHub over SSH", () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ repository: "git@github.com:Some-Owner/my.instance.git" }).success).toBe(true);
    for (const repository of [
      "https://github.com/example/bivouac-platform.git",
      "git@gitlab.com:example/bivouac-platform.git",
      "git@github.com:example/bivouac-platform",
      "git@github.com:example/bivouac platform.git",
      "git@github.com:-example/x.git",
    ]) {
      expect(messages({ repository })).toEqual([expect.stringMatching(/^repository: must be the repo's SSH address/)]);
    }
    expect(parse({ repository: undefined }).success).toBe(false);
  });

  it("needs an exact version of a Bivouac reconciler image, and nothing else", () => {
    for (const image of [
      "ghcr.io/example/bivouac-reconciler:sha-abc1234",
      `ghcr.io/example/bivouac-reconciler@sha256:${"a".repeat(64)}`,
      `ghcr.io/example/bivouac-reconciler:sha-abc1234@sha256:${"a".repeat(64)}`,
    ]) {
      expect(parse({ reconciler: { image } }).success).toBe(true);
    }
    expect(messages({ reconciler: { image: "ghcr.io/example/bivouac-reconciler" } })).toEqual([
      expect.stringMatching(/^reconciler\.image: must name an exact version/),
    ]);
    expect(messages({ reconciler: { image: "ghcr.io/example/bivouac-reconciler:latest" } })).toContain(
      "reconciler.image: must name one commit's image (':sha-<commit>') or a digest, never a moving tag",
    );
    for (const image of ["ghcr.io/example/bivouac-reconciler:main", "ghcr.io/example/bivouac-reconciler:v1", "ghcr.io/example/bivouac-reconciler:sha-XYZ1234"]) {
      expect(messages({ reconciler: { image } })).toEqual([
        "reconciler.image: must name one commit's image (':sha-<commit>') or a digest, never a moving tag",
      ]);
    }
    for (const image of [
      "docker.io/example/bivouac-reconciler:sha-abc1234",
      "ghcr.io/example/other:sha-abc1234",
      "ghcr.io/example/bivouac-reconciler-evil:sha-abc1234",
      "ghcr.io/example/sub/bivouac-reconciler:sha-abc1234",
      "ghcr.io/bivouac-reconciler:sha-abc1234",
    ]) {
      expect(messages({ reconciler: { image } })).toEqual([
        "reconciler.image: must be a Bivouac reconciler image (ghcr.io/<owner>/bivouac-reconciler)",
      ]);
    }
    expect(parse({ reconciler: { image: base.reconciler.image, tag: "x" } }).success).toBe(false);
  });
});
