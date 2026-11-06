import { describe, expect, it } from "vitest";
import { appManifestSchema } from "@bivouac/manifest";
import { appEnvironment } from "./apps.js";
import { createBody, fingerprint, parsePorts } from "./containers.js";
import { demultiplex } from "./docker.js";
import { deriveSecret } from "./secrets.js";

describe("derived secrets (D14)", () => {
  it("are HMAC-SHA256 in hexadecimal, the same every time", () => {
    // Reference computed independently: printf db:recettes | openssl dgst -sha256 -hmac master
    expect(deriveSecret("master", "db:recettes")).toBe("419c660c9f7804ba64d27132fc4dbe79569cedf1e7409eddb89a05ad5287683f");
    expect(deriveSecret("master", "db:recettes")).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveSecret("master", "db:recettes")).toBe(deriveSecret("master", "db:recettes"));
    expect(deriveSecret("master", "db:recettes")).not.toBe(deriveSecret("master", "oidc:recettes"));
    expect(deriveSecret("other", "db:recettes")).not.toBe(deriveSecret("master", "db:recettes"));
  });
});

describe("Docker exec output", () => {
  it("separates stdout and stderr frames", () => {
    const frame = (stream: number, text: string) => {
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(Buffer.byteLength(text), 4);
      return Buffer.concat([header, Buffer.from(text)]);
    };
    const buffer = Buffer.concat([frame(1, "out "), frame(2, "err"), frame(1, "put")]);
    expect(demultiplex(buffer)).toEqual({ stdout: "out put", stderr: "err" });
  });
});

describe("container fingerprint", () => {
  it("does not depend on the order of environment variables", () => {
    const a = createBody({ name: "x", networks: {}, image: "i:1", env: { A: "1", B: "2" } });
    const b = createBody({ name: "x", networks: {}, image: "i:1", env: { B: "2", A: "1" } });
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("changes with the image, the variables or the inputs", () => {
    const base = fingerprint(createBody({ name: "x", networks: {}, image: "i:1" }));
    expect(fingerprint(createBody({ name: "x", networks: {}, image: "i:2" }))).not.toBe(base);
    expect(fingerprint(createBody({ name: "x", networks: {}, image: "i:1", env: { A: "1" } }))).not.toBe(base);
    expect(fingerprint(createBody({ name: "x", networks: {}, image: "i:1", inputs: "abc" }))).not.toBe(base);
  });
});

describe("Caddy ports", () => {
  it("parses container=host pairs", () => {
    expect(parsePorts("80/tcp=80, 443/tcp=443,443/udp=443")).toEqual({
      "80/tcp": ["80"],
      "443/tcp": ["443"],
      "443/udp": ["443"],
    });
    expect(parsePorts("443/tcp=127.0.0.1:8443")).toEqual({ "443/tcp": ["127.0.0.1:8443"] });
    expect(() => parsePorts("443=443")).toThrow(/port\/protocol/);
  });
});

describe("app environment (D19)", () => {
  const values = {
    "app.url": "https://grafana.apps.example.com",
    "db.url": "postgres://grafana:pw@bivouac-postgres:5432/grafana",
    "oidc.issuer": "https://auth.apps.example.com",
    "oidc.clientId": "grafana",
    "oidc.clientSecret": "s3cret",
  };

  it("injects the standard variables and resolves the env block", () => {
    const app = appManifestSchema.parse({
      name: "grafana",
      image: "grafana/grafana:12.0.0",
      groups: ["admin"],
      database: {},
      env: { GF_SERVER_ROOT_URL: "${app.url}", GF_AUTH_GENERIC_OAUTH_CLIENT_ID: "${oidc.clientId}", PLAIN: 1 },
    });
    expect(appEnvironment(app, values)).toEqual({
      PORT: "3000",
      DATABASE_URL: values["db.url"],
      OIDC_ISSUER: values["oidc.issuer"],
      OIDC_CLIENT_ID: "grafana",
      OIDC_CLIENT_SECRET: "s3cret",
      GF_SERVER_ROOT_URL: "https://grafana.apps.example.com",
      GF_AUTH_GENERIC_OAUTH_CLIENT_ID: "grafana",
      PLAIN: "1",
    });
  });

  it("refuses SMTP values, not provided yet", () => {
    const app = appManifestSchema.parse({
      name: "mailer",
      image: "example/mailer:1.0.0",
      auth: "public",
      env: { HOST: "${smtp.host}" },
    });
    expect(() => appEnvironment(app, { "app.url": "https://mailer.apps.example.com" })).toThrow(/not available yet/);
  });
});
