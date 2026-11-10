import { describe, expect, it } from "vitest";
import { platformSecretsSchema, registryLogin, type PlatformSecrets } from "./secrets.js";

const base = {
  master_secret: "m".repeat(32),
  pocket_id: { encryption_key: "e".repeat(16), static_api_key: "s".repeat(16) },
};

describe("registryLogin", () => {
  const secrets = platformSecretsSchema.parse({ ...base, ghcr: { username: "owner", token: "ghp_x" } }) as PlatformSecrets;

  it("sends the GHCR token to GHCR only", () => {
    expect(registryLogin(secrets, "ghcr.io/owner/app:sha-abc1234")).toEqual({
      username: "owner",
      password: "ghp_x",
      serveraddress: "ghcr.io",
    });
  });

  it.each(["docker.io/library/caddy:2", "caddy:2", "ghcr.io.example.com/owner/app:1", "evil.com/ghcr.io/app:1"])(
    "keeps it from %s",
    (image) => {
      expect(registryLogin(secrets, image)).toBeUndefined();
    },
  );

  it("sends nothing when there is no token", () => {
    expect(registryLogin(platformSecretsSchema.parse(base) as PlatformSecrets, "ghcr.io/owner/app:1")).toBeUndefined();
  });

  it("refuses an empty token", () => {
    expect(platformSecretsSchema.safeParse({ ...base, ghcr: { username: "owner", token: "" } }).success).toBe(false);
  });
});

describe("registryAuthHeader", () => {
  it("keeps the base64 padding and uses URL-safe characters", async () => {
    const { registryAuthHeader } = await import("./docker.js");
    for (const username of ["a", "ab", "abc"]) {
      const login = { username, password: "p+/?>", serveraddress: "ghcr.io" };
      const header = registryAuthHeader(login);
      expect(header.length % 4).toBe(0);
      expect(header).not.toMatch(/[+/]/);
      expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual(login);
    }
  });
});
