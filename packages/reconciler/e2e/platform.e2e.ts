/**
 * End-to-end tests of the reconciler on the miniature platform. The tests
 * run in order and share one platform: each step builds on the previous one,
 * like passes on a real server.
 */
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CADDY_ADDRESS,
  DOMAIN,
  TEST_APP_IMAGE,
  buildImages,
  createPlatform,
  destroyPlatform,
  docker,
  inspect,
  pocketIdApi,
  psql,
  RECONCILER_BROKEN,
  RECONCILER_NEWER,
  RECONCILER_RUNNING,
  readStateFile,
  removeStateFile,
  run,
  runOnce,
  reachableFromApps,
  throughCaddy,
  tokenAnswer,
  type PassOutput,
  type Platform,
} from "./platform.ts";

const platformYml = (image: string) =>
  `domain: ${DOMAIN}\nrepository: git@github.com:example/bivouac-platform.git\nreconciler:\n  image: ${image}\n`;

const derive = (master: string, purpose: string) => createHmac("sha256", master).update(purpose).digest("hex");

const RECETTES = `name: recettes
image: ${TEST_APP_IMAGE}
auth: oidc
groups: [famille]
database: { extensions: [postgis] }
volumes: { uploads: /data/uploads }
env:
  TEST_APP_URL: \${app.url}
  TEST_CLIENT_ID: \${oidc.clientId}
`;

const BIBLIO = `name: biblio
image: ${TEST_APP_IMAGE}
auth: public
`;

interface ContainerState {
  Id: string;
  HostConfig: { CapDrop: string[] | null; SecurityOpt: string[] | null };
  State: { Running: boolean; Status: string; Health?: { Status: string } };
  Config: { Env: string[] };
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
}

const changesOf = (pass: PassOutput) =>
  (pass.logs.find((line) => line.message.startsWith("pass ")) as { changes?: string[] } | undefined)?.changes ?? [];

let platform: Platform;
let first: PassOutput;

beforeAll(() => {
  destroyPlatform();
  buildImages();
  platform = createPlatform();
  platform.commit({ "apps/recettes.yml": RECETTES, "apps/biblio.yml": BIBLIO }, "two apps");
  first = runOnce(platform);
});

afterAll(() => {
  if (!process.env.BIVOUAC_E2E_KEEP) destroyPlatform();
});

describe("a. base services", () => {
  it("applies the first pass without failure", () => {
    expect(first.logs.filter((line) => line.message !== "starting" && !line.message.startsWith("pass "))).toEqual([]);
    expect(first.status).toBe(0);
  });

  it("creates both networks with their fixed subnets, and Caddy at its fixed address", () => {
    type Network = { IPAM: { Config: { Subnet: string; IPRange: string }[] } };
    expect(inspect<Network>("bivouac").IPAM.Config).toEqual([
      { Subnet: "10.209.0.0/24", IPRange: "10.209.0.128/25", Gateway: "10.209.0.1" },
    ]);
    expect(inspect<Network>("bivouac-internal").IPAM.Config).toEqual([
      { Subnet: "10.209.1.0/24", IPRange: "10.209.1.128/25", Gateway: "10.209.1.1" },
    ]);
    expect(inspect<ContainerState>("bivouac-caddy").NetworkSettings.Networks["bivouac-internal"]?.IPAddress).toBe(CADDY_ADDRESS);
  });

  it("keeps Pocket ID out of the apps' network", () => {
    expect(Object.keys(inspect<ContainerState>("bivouac-pocket-id").NetworkSettings.Networks)).toEqual(["bivouac-internal"]);
    expect(reachableFromApps("http://bivouac-pocket-id:1411/healthz")).toBe(false);
    expect(reachableFromApps("http://bivouac-app-biblio:3000/api/health")).toBe(true);
  });

  it.each(["bivouac-postgres", "bivouac-pocket-id", "bivouac-caddy", "bivouac-app-recettes"])(
    "%s cannot forge packets nor gain privileges",
    (name) => {
      const { HostConfig } = inspect<ContainerState>(name);
      expect(HostConfig.CapDrop).toEqual(["NET_RAW"]);
      expect(HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    },
  );

  it.each(["bivouac-postgres", "bivouac-pocket-id", "bivouac-caddy"])("%s is healthy", (name) => {
    expect(inspect<ContainerState>(name).State.Health?.Status).toBe("healthy");
  });

  it("serves Pocket ID through Caddy, and refuses its first-admin page (D15)", () => {
    expect(throughCaddy(`auth.${DOMAIN}`, "/healthz").status).toBe(204);
    expect(throughCaddy(`auth.${DOMAIN}`, "/setup").status).toBe(403);
    expect(throughCaddy(`auth.${DOMAIN}`, "/api/signup/setup").status).toBe(403);
  });

  it.each(["/api/signup/setup", "//api/signup/setup", "/api/signup/setup/", "/API/signup/setup", "/%61pi/signup/setup", "/api/signup/./setup"])(
    "never lets POST %s reach Pocket ID's first-admin API",
    (path) => {
      // 403 is Caddy refusing; 404 is Pocket ID not knowing the path. Any
      // other answer means the request reached the real endpoint.
      expect([403, 404]).toContain(throughCaddy(`auth.${DOMAIN}`, path, "POST").status);
    },
  );

  it("only trusts the client IP forwarded by Caddy (D27)", () => {
    const env = inspect<ContainerState>("bivouac-pocket-id").Config.Env;
    expect(env).toContain(`TRUST_PROXY=${CADDY_ADDRESS}`);
    expect(env).toContain("ANALYTICS_DISABLED=true");
  });
});

describe("b. secrets", () => {
  it("gives Postgres its derived superuser password (D14)", () => {
    const login = psql("postgres", derive(platform.masterSecret, "postgres:superuser"), "postgres", "SELECT 1");
    expect(login.stderr).toBe("");
    expect(login.stdout.trim()).toBe("1");
    expect(psql("postgres", "wrong-password", "postgres", "SELECT 1").status).not.toBe(0);
  });

  it("passes secrets to containers as files, never in their environment", () => {
    const env = inspect<ContainerState>("bivouac-pocket-id").Config.Env.join("\n");
    expect(env).not.toContain(platform.staticApiKey);
    expect(env).not.toContain(derive(platform.masterSecret, "db:bivouac_pocket_id"));
  });

  it("applies nothing when the secrets cannot be decrypted", () => {
    const keyOfSomeoneElse = `${platform.root}/keys/other.key`;
    docker("run", "--rm", "--volume", `${platform.root}/keys:/keys`, "alpine:3.24", "sh", "-c",
      "apk add -q age >/dev/null && age-keygen -o /keys/other.key 2>/dev/null && chmod 644 /keys/other.key");
    const pass = runOnce(platform, { ageKey: keyOfSomeoneElse });
    expect(pass.status).toBe(1);
    expect(JSON.stringify(pass.logs)).toContain("could not decrypt secrets/platform.sops.yaml");
    expect(JSON.stringify(pass.logs)).not.toContain(platform.masterSecret);
  });
});

describe("c. a database per app", () => {
  const password = () => derive(platform.masterSecret, "db:recettes");

  it("creates the database, owned by the app's role, with its extensions", () => {
    const result = psql("recettes", password(), "recettes", "SELECT postgis_version() IS NOT NULL, current_user");
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("t|recettes");
  });

  it("keeps every other role out of it", () => {
    const pocketId = psql("bivouac_pocket_id", derive(platform.masterSecret, "db:bivouac_pocket_id"), "recettes", "SELECT 1");
    expect(pocketId.stderr).toContain("permission denied for database");
    const intoPocketId = psql("recettes", password(), "bivouac_pocket_id", "SELECT 1");
    expect(intoPocketId.stderr).toContain("permission denied for database");
  });

  it("keeps apps out of the databases every server has", () => {
    expect(psql("recettes", password(), "postgres", "SELECT 1").stderr).toContain("permission denied for database");
  });

  it("creates no database for an app that declares none", () => {
    const superuser = derive(platform.masterSecret, "postgres:superuser");
    expect(psql("postgres", superuser, "postgres", "SELECT count(*) FROM pg_database WHERE datname = 'biblio'").stdout.trim()).toBe("0");
  });
});

describe("d. an OIDC client per app", () => {
  it("restricts the client to the app's groups", () => {
    const client = pocketIdApi(platform, "GET", "/api/oidc/clients/recettes");
    expect(client.status).toBe(200);
    expect(client.body).toMatchObject({
      id: "recettes",
      isPublic: false,
      pkceEnabled: true,
      isGroupRestricted: true,
      callbackURLs: [`https://recettes.${DOMAIN}/auth/callback`],
      allowedUserGroups: [expect.objectContaining({ name: "famille" })],
    });
  });

  it("leaves exactly one secret, the derived one", () => {
    const secrets = pocketIdApi(platform, "GET", "/api/oidc/clients/recettes/secrets");
    expect(secrets.body).toHaveLength(1);
    expect(tokenAnswer("recettes", derive(platform.masterSecret, "oidc:recettes"))).toBe("invalid_grant");
    expect(tokenAnswer("recettes", "a-wrong-secret-of-some-length")).toBe("invalid_client");
  });

  it("creates no client for a public app", () => {
    expect(pocketIdApi(platform, "GET", "/api/oidc/clients/biblio").status).toBe(404);
  });
});

describe("e. app containers", () => {
  it("routes each app through Caddy once it is healthy", () => {
    expect(throughCaddy(`recettes.${DOMAIN}`, "/api/health").status).toBe(200);
    expect(throughCaddy(`biblio.${DOMAIN}`, "/api/health").status).toBe(200);
  });

  it("injects the standard variables and the env block (D19)", () => {
    expect(JSON.parse(throughCaddy(`recettes.${DOMAIN}`, "/env").body)).toEqual([
      "DATABASE_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_ISSUER", "PORT", "TEST_APP_URL", "TEST_CLIENT_ID",
    ]);
    const env = inspect<ContainerState>("bivouac-app-recettes").Config.Env;
    expect(env).toContain(`OIDC_ISSUER=https://auth.${DOMAIN}`);
    expect(env).toContain(`TEST_APP_URL=https://recettes.${DOMAIN}`);
    expect(env).toContain("TEST_CLIENT_ID=recettes");
    expect(JSON.parse(throughCaddy(`biblio.${DOMAIN}`, "/env").body)).toEqual(["PORT"]);
  });

  it("mounts the declared volumes", () => {
    expect(docker("volume", "ls", "--quiet", "--filter", "name=bivouac-app-recettes_uploads")).toBe("bivouac-app-recettes_uploads");
  });

  it("does not route a new version that fails its health check, and does not retry it", () => {
    platform.commit({ "apps/biblio.yml": `${BIBLIO}env: { TEST_FAIL_HEALTH: "1" }\n` }, "broken biblio");
    const failed = runOnce(platform);
    expect(failed.status).toBe(1);
    expect(failed.logs).toContainEqual(expect.objectContaining({ message: "app failed", app: "biblio" }));
    expect(inspect<ContainerState>("bivouac-app-biblio").State.Running).toBe(false);
    expect(throughCaddy(`biblio.${DOMAIN}`, "/api/health").status).not.toBe(200);
    expect(throughCaddy(`recettes.${DOMAIN}`, "/api/health").status).toBe(200);

    const again = runOnce(platform);
    expect(again.status).toBe(1);
    expect(changesOf(again)).toEqual([]);
    expect(inspect<ContainerState>("bivouac-app-biblio").State.Running).toBe(false);

    platform.commit({ "apps/biblio.yml": BIBLIO }, "fixed biblio");
    expect(runOnce(platform).status).toBe(0);
    expect(throughCaddy(`biblio.${DOMAIN}`, "/api/health").status).toBe(200);
  });
});

describe("f. idempotence", () => {
  it("changes nothing on a pass with nothing new", () => {
    const before = ["bivouac-postgres", "bivouac-pocket-id", "bivouac-caddy", "bivouac-app-recettes", "bivouac-app-biblio"]
      .map((name) => inspect<ContainerState>(name).Id);
    const pass = runOnce(platform);
    expect(pass.status).toBe(0);
    expect(pass.logs).toContainEqual(expect.objectContaining({ message: "pass unchanged", changes: [] }));
    const after = ["bivouac-postgres", "bivouac-pocket-id", "bivouac-caddy", "bivouac-app-recettes", "bivouac-app-biblio"]
      .map((name) => inspect<ContainerState>(name).Id);
    expect(after).toEqual(before);
  });

  it("repairs what was changed by hand", () => {
    docker("stop", "bivouac-pocket-id");
    const superuser = derive(platform.masterSecret, "postgres:superuser");
    psql("postgres", superuser, "postgres", "ALTER ROLE recettes PASSWORD 'changed-by-hand'");

    const pass = runOnce(platform);
    expect(pass.status).toBe(0);
    expect(changesOf(pass)).toEqual(expect.arrayContaining(["container bivouac-pocket-id started", "password of recettes"]));
    expect(psql("recettes", derive(platform.masterSecret, "db:recettes"), "recettes", "SELECT 1").stdout.trim()).toBe("1");
  });
});

describe("g. the reconciler moves itself to the version in platform.yml (D50)", () => {
  const IMAGE_ENV = "reconciler/image.env";

  it("stays on its version when the new one fails its self-test, and applies the pass as usual", () => {
    platform.commit({ "platform.yml": platformYml(RECONCILER_BROKEN) }, "broken reconciler");
    const pass = runOnce(platform);
    expect(pass.status).toBe(0);
    expect(pass.logs).toContainEqual(expect.objectContaining({
      message: "new reconciler version refused: staying on the current one",
      refused: RECONCILER_BROKEN,
      reason: expect.stringMatching(/self-test failed/),
    }));
    expect(pass.logs).toContainEqual(expect.objectContaining({ message: "pass unchanged" }));
    expect(readStateFile(platform, IMAGE_ENV)).toBeUndefined();
    expect(run("docker", ["inspect", "bivouac-reconciler-selftest"]).status).not.toBe(0);
  });

  it("refuses another publisher's image", () => {
    platform.commit({ "platform.yml": platformYml("ghcr.io/someone-else/bivouac-reconciler:sha-e2e0001") }, "foreign");
    const pass = runOnce(platform);
    expect(pass.logs).toContainEqual(expect.objectContaining({
      message: "new reconciler version refused: staying on the current one",
      reason: "it is not published as ghcr.io/example/bivouac-reconciler",
    }));
    expect(readStateFile(platform, IMAGE_ENV)).toBeUndefined();
  });

  it("moves to a new version before validating the rest, even a field it does not know", () => {
    platform.commit({ "platform.yml": `${platformYml(RECONCILER_NEWER)}from_the_future: true\n` }, "new reconciler");
    const pass = runOnce(platform);
    expect(pass.status).toBe(0);
    expect(pass.logs).toContainEqual(expect.objectContaining({
      message: "restarting on the new reconciler version",
      image: RECONCILER_NEWER,
    }));
    expect(pass.logs.some((line) => line.message.startsWith("pass "))).toBe(false);
    expect(readStateFile(platform, IMAGE_ENV)).toBe(`BIVOUAC_RECONCILER_IMAGE=${RECONCILER_NEWER}\n`);

    platform.commit({ "platform.yml": platformYml(RECONCILER_RUNNING) }, "back to the running version");
    removeStateFile(platform, IMAGE_ENV);
    expect(runOnce(platform).logs).toContainEqual(expect.objectContaining({ message: "pass unchanged" }));
  });
});
