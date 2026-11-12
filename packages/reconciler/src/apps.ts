import { AUTH_SUBDOMAIN, PLATFORM_NETWORKS, appContainerName, envReferences, type AppManifest } from "@bivouac/manifest";
import type { Runtime } from "./base.js";
import { ensureContainer, waitFor } from "./containers.js";
import { appBeingRestored, interruptedRestore } from "./lock.js";
import { PocketId } from "./pocket-id.js";
import { connectionString, databaseName, ensureDatabase, type PostgresServer } from "./postgres.js";
import { deriveSecret, registryLogin, type PlatformSecrets } from "./secrets.js";

/**
 * Where an `oidc` app receives the user back from Pocket ID, on each of its
 * hosts. A platform convention, to be followed by the app template (layer 4).
 * Third-party apps with a fixed path will need a manifest field.
 */
export const OIDC_CALLBACK_PATH = "/auth/callback";

export interface AppResult {
  name: string;
  /** True when the app is running and healthy: only then does Caddy route to it. */
  routed: boolean;
  changes: string[];
  failure?: string;
}

export interface AppContext {
  runtime: Runtime;
  secrets: PlatformSecrets;
  domain: string;
  postgres: PostgresServer;
  pocketId: PocketId;
}

/**
 * One app: its database, its OIDC client, then its container. A new
 * container must pass its health check before Caddy routes to it; if it
 * does not, it is stopped and stays stopped until its manifest changes
 * (D21). Rolling back to the previous image comes in layer 6.
 */
export async function ensureApp(context: AppContext, app: AppManifest): Promise<AppResult> {
  const changes: string[] = [];
  const { runtime } = context;
  if (runtime.pausedApps.has(app.name)) return { name: app.name, routed: true, changes };
  // Stopped on purpose by a restore of its data (restore.ts): left alone meanwhile.
  if (appBeingRestored(runtime.stateDir) === app.name) return { name: app.name, routed: true, changes };
  if (interruptedRestore(runtime.stateDir) === app.name) {
    return { name: app.name, routed: false, changes, failure: "a restore of its data was interrupted: it stays stopped until it is restored again (runbook section 14)" };
  }
  const values = await appValues(context, app, changes);
  const container = appContainerName(app.name);

  const result = await ensureContainer(
    runtime.docker,
    {
      name: container,
      image: app.image,
      networks: { [PLATFORM_NETWORKS.apps.name]: null },
      env: appEnvironment(app, values),
      mounts: Object.entries(app.volumes).map(([volume, target]) => ({
        type: "volume" as const,
        // `_` appears in neither an app nor a volume name: two apps can
        // never end up with the same volume.
        source: `${container}_${volume}`,
        target,
      })),
    },
    // App images may be private (D17): pulled with the GHCR token.
    async (image) => {
      const login = registryLogin(context.secrets, image);
      try {
        await runtime.pull(image, login);
      } catch (error) {
        // Say which secret to renew: a rejected token stops every GHCR app.
        const message = (error as Error).message;
        if (login && /denied|unauthorized/i.test(message)) {
          throw new Error(`${message} (GHCR refused the token in the secrets file: expired, revoked, or no access to this image?)`);
        }
        throw error;
      }
    },
    { restartStopped: false },
  );

  if (result === "left-stopped") {
    return { name: app.name, routed: false, changes, failure: "failed its health check earlier: fix the image and change the manifest" };
  }
  if (result !== "unchanged") {
    changes.push(`container ${container} ${result}`);
  }
  if (result === "unchanged") {
    return { name: app.name, routed: true, changes };
  }
  try {
    await waitFor(() => checkHealth(container, app), runtime.healthTimeout, `${app.name}'s health check`);
    return { name: app.name, routed: true, changes };
  } catch (error) {
    await runtime.docker.stopContainer(container);
    return { name: app.name, routed: false, changes, failure: (error as Error).message };
  }
}

/** The values an app may receive, computed from the manifest and the master secret. */
async function appValues(context: AppContext, app: AppManifest, changes: string[]): Promise<Record<string, string>> {
  const { secrets, domain, postgres, pocketId } = context;
  const hosts = [`${app.name}.${domain}`, ...app.domains];
  const values: Record<string, string> = { "app.url": `https://${hosts[0]}` };

  if (app.database) {
    const database = {
      name: databaseName(app.name),
      password: deriveSecret(secrets.master_secret, `db:${databaseName(app.name)}`),
      extensions: app.database.extensions,
    };
    changes.push(...(await ensureDatabase(postgres, database)));
    values["db.url"] = connectionString(postgres, database);
  }

  if (app.auth === "oidc") {
    const secret = deriveSecret(secrets.master_secret, `oidc:${app.name}`);
    changes.push(
      ...(await pocketId.ensureClient({
        id: app.name,
        callbackUrls: hosts.map((host) => `https://${host}${OIDC_CALLBACK_PATH}`),
        logoutCallbackUrls: hosts.map((host) => `https://${host}/`),
        secret,
        groups: app.groups,
      })),
    );
    values["oidc.issuer"] = `https://${AUTH_SUBDOMAIN}.${domain}`;
    values["oidc.clientId"] = app.name;
    values["oidc.clientSecret"] = secret;
  }

  // Claude's client for the app's MCP (D85), or none. Only oidc apps can
  // have one: other apps never call the identity provider.
  const mcpClient = `${app.name}-mcp`;
  if (app.auth === "oidc" && app.mcp) {
    const resource = `https://${hosts[0]}/mcp`;
    changes.push(...(await pocketId.ensureMcpClient({ id: mcpClient, app: app.name, resource, groups: app.groups })));
    values["mcp.resource"] = resource;
  } else if (app.auth === "oidc") {
    changes.push(...(await pocketId.removeMcpClient(mcpClient)));
  }
  return values;
}

/**
 * The standard variables (D19), then the manifest's `env` block with its
 * `${...}` references replaced. The schema already refused references to
 * values the app does not have; SMTP is not provided yet.
 */
export function appEnvironment(app: AppManifest, values: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { PORT: String(app.port) };
  if (values["db.url"]) env.DATABASE_URL = values["db.url"];
  if (values["oidc.issuer"]) {
    env.OIDC_ISSUER = values["oidc.issuer"];
    env.OIDC_CLIENT_ID = values["oidc.clientId"] ?? "";
    env.OIDC_CLIENT_SECRET = values["oidc.clientSecret"] ?? "";
  }
  if (values["mcp.resource"]) env.MCP_RESOURCE = values["mcp.resource"];
  for (const [key, template] of Object.entries(app.env)) {
    for (const reference of envReferences(template)) {
      if (values[reference] === undefined) {
        throw new Error(`apps/${app.name}.yml: \${${reference}} is not available yet on this platform`);
      }
    }
    env[key] = template.replace(/\$\{([^}]*)\}/g, (_, reference: string) => values[reference] ?? "");
  }
  return env;
}

/**
 * Called by the reconciler itself over the platform network, so an app
 * image needs no `curl` inside. Any 2xx answer is healthy. An app with
 * `health: false` only has to stay running.
 */
export async function checkHealth(container: string, app: AppManifest): Promise<true | string> {
  if (app.health === false) return true;
  try {
    // No redirects: an app must not send the reconciler elsewhere.
    const response = await fetch(`http://${container}:${app.port}${app.health}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    return response.ok ? true : `answering HTTP ${response.status}`;
  } catch (error) {
    return `unreachable (${(error as Error).cause instanceof Error ? ((error as Error).cause as Error).message : (error as Error).message})`;
  }
}
