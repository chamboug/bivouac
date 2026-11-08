import { BlockList } from "node:net";
import { z } from "zod";
import { ALLOWED_EXTENSIONS } from "./platform.js";

/**
 * Names that can never be used for an app or a site, because the platform
 * already serves them on the same domain (D34, D40).
 */
export const RESERVED_NAMES = ["auth", "gate", "status"] as const;

/**
 * Environment variables the platform injects itself (D19). An app's `env`
 * block may not redefine them: it only adds aliases for third-party apps.
 */
export const INJECTED_ENV = [
  "PORT",
  "DATABASE_URL",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM",
] as const;

/**
 * Values an `env` entry may reference with `${...}`, and what each one needs
 * in the manifest to exist.
 */
export const ENV_REFERENCES = {
  "app.url": null,
  "db.url": "database",
  "oidc.issuer": "oidc",
  "oidc.clientId": "oidc",
  "oidc.clientSecret": "oidc",
  "smtp.host": null,
  "smtp.port": null,
  "smtp.user": null,
  "smtp.password": null,
  "smtp.from": null,
} as const satisfies Record<string, "database" | "oidc" | null>;

export type EnvReference = keyof typeof ENV_REFERENCES;

const MAX_NAME_LENGTH = 40;

/**
 * Names Postgres keeps for itself: databases every server has, and role
 * names it refuses (`pg_*`, `public`, `current_user`…). An app's database
 * and role take the app's name with `-` turned into `_`.
 */
const POSTGRES_NAMES = ["postgres", "template0", "template1", "public", "none", "current-user", "current-role", "session-user"] as const;

/**
 * An app or site name. It becomes a DNS label (`<name>.apps.example.com`)
 * and, with `-` turned into `_`, a Postgres database and role name. The
 * length limit leaves room for the archive suffix (D18) within Postgres'
 * 63-character identifier limit.
 */
export const nameSchema = z
  .string()
  .max(MAX_NAME_LENGTH, `must be at most ${MAX_NAME_LENGTH} characters`)
  .regex(
    /^[a-z]([a-z0-9-]*[a-z0-9])?$/,
    "must use lowercase letters, digits and hyphens, start with a letter and not end with a hyphen",
  )
  .refine((name) => !name.includes("--"), "must not contain two hyphens in a row")
  .refine(
    (name) => !(RESERVED_NAMES as readonly string[]).includes(name),
    `is reserved by the platform (${RESERVED_NAMES.join(", ")})`,
  )
  .refine((name) => !name.startsWith("archived"), "must not start with 'archived' (used for archived apps)")
  .refine(
    (name) => !name.startsWith("bivouac") && !name.startsWith("pg-") && !(POSTGRES_NAMES as readonly string[]).includes(name),
    `would clash with the platform's own containers or with names Postgres keeps ('bivouac…', 'pg-…', ${POSTGRES_NAMES.join(", ")})`,
  );

export const hostnameSchema = z
  .string()
  .max(253)
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "must be a lowercase domain name such as example.com",
  );

export const groupSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "must use lowercase letters, digits, '_' and '-'");

/**
 * A container image reference with an explicit tag or digest. `latest` is
 * refused: rolling back to "the previous image" (D21) only works if every
 * deployment names an exact image.
 */
export const imageSchema = z.string().superRefine((image, ctx) => {
  const digestMatch = /@sha256:[a-f0-9]{64}$/.exec(image);
  const withoutDigest = digestMatch ? image.slice(0, digestMatch.index) : image;
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const repository = hasTag ? withoutDigest.slice(0, lastColon) : withoutDigest;
  const tag = hasTag ? withoutDigest.slice(lastColon + 1) : undefined;

  const repoPattern = /^([a-z0-9.-]+(:[0-9]+)?\/)?[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/;
  if (!repoPattern.test(repository)) {
    ctx.addIssue({ code: "custom", message: "is not a valid image name" });
    return;
  }
  if (tag !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) {
    ctx.addIssue({ code: "custom", message: "has an invalid tag" });
    return;
  }
  if (tag === undefined && !digestMatch) {
    ctx.addIssue({ code: "custom", message: "must name an exact version (a tag such as ':sha-abc123', or a digest)" });
    return;
  }
  if (tag === "latest") {
    ctx.addIssue({ code: "custom", message: "must not use ':latest': name an exact version so rollbacks are possible" });
  }
});

const authSchema = z.enum(["oidc", "forward", "public", "local"]);
export type AuthMode = z.infer<typeof authSchema>;

const envValueSchema = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((value) => String(value));

const ENV_REFERENCE_PATTERN = /\$\{([^}]*)\}/g;

export function envReferences(value: string): string[] {
  return [...value.matchAll(ENV_REFERENCE_PATTERN)].map((match) => match[1] ?? "");
}

export const appManifestSchema = z
  .strictObject({
    name: nameSchema,
    image: imageSchema,
    port: z.number().int().min(1).max(65535).default(3000),
    health: z
      .union([z.string().regex(/^\/\S*$/, "must be a path starting with '/'"), z.literal(false)])
      .default("/api/health"),
    database: z
      .strictObject({
        extensions: z
          .array(
            z.enum(ALLOWED_EXTENSIONS, {
              error: `is not an allowed extension (allowed: ${ALLOWED_EXTENSIONS.join(", ")})`,
            }),
          )
          .default([]),
      })
      .optional(),
    auth: authSchema.default("oidc"),
    groups: z.array(groupSchema).default([]),
    volumes: z
      .record(
        z.string().regex(/^[a-z][a-z0-9-]*$/, "volume names use lowercase letters, digits and hyphens"),
        z.string().regex(/^\/[^\0]*[^/]$/, "must be an absolute path such as /app/uploads"),
      )
      .default({}),
    backup: z.strictObject({ stop: z.boolean().default(false) }).default({ stop: false }),
    env: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "is not a valid variable name"), envValueSchema)
      .default({}),
    domains: z.array(hostnameSchema).default([]),
  })
  .superRefine((app, ctx) => {
    checkGroups(app.auth, app.groups, ctx);

    const paths = Object.values(app.volumes);
    for (const [index, path] of paths.entries()) {
      if (paths.indexOf(path) !== index) {
        ctx.addIssue({ code: "custom", path: ["volumes"], message: `two volumes are mounted at ${path}` });
      }
    }

    for (const [key, value] of Object.entries(app.env)) {
      if ((INJECTED_ENV as readonly string[]).includes(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["env", key],
          message: `is already provided by the platform and cannot be redefined`,
        });
      }
      for (const reference of envReferences(value)) {
        if (!(reference in ENV_REFERENCES)) {
          ctx.addIssue({
            code: "custom",
            path: ["env", key],
            message: `refers to unknown value \${${reference}} (known: ${Object.keys(ENV_REFERENCES).join(", ")})`,
          });
          continue;
        }
        const needs = ENV_REFERENCES[reference as EnvReference];
        if (needs === "database" && !app.database) {
          ctx.addIssue({ code: "custom", path: ["env", key], message: `uses \${${reference}} but the app declares no database` });
        }
        if (needs === "oidc" && app.auth !== "oidc") {
          ctx.addIssue({ code: "custom", path: ["env", key], message: `uses \${${reference}} but auth is not 'oidc'` });
        }
      }
    }
  });

export const siteManifestSchema = z
  .strictObject({
    name: nameSchema,
    auth: z.enum(["public", "forward"]).default("public"),
    groups: z.array(groupSchema).default([]),
    domains: z.array(hostnameSchema).default([]),
  })
  .superRefine((site, ctx) => checkGroups(site.auth, site.groups, ctx));

function checkGroups(auth: AuthMode, groups: string[], ctx: z.RefinementCtx): void {
  if ((auth === "oidc" || auth === "forward") && groups.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["groups"],
      message: `auth '${auth}' needs at least one group, otherwise every account could get in`,
    });
  }
  if ((auth === "public" || auth === "local") && groups.length > 0) {
    ctx.addIssue({ code: "custom", path: ["groups"], message: `has no effect with auth '${auth}'` });
  }
  if (new Set(groups).size !== groups.length) {
    ctx.addIssue({ code: "custom", path: ["groups"], message: "contains the same group twice" });
  }
}

/**
 * Name of the reconciler image, whoever publishes it: the CI of a Bivouac
 * monorepo publishes `ghcr.io/<owner>/bivouac-reconciler:sha-<commit>`.
 */
export const RECONCILER_IMAGE_NAME = /^ghcr\.io\/[a-z0-9]([a-z0-9-]*[a-z0-9])?\/bivouac-reconciler$/;

/**
 * The reconciler's image. It runs with the Docker socket, so it can do
 * anything on the server: only an exact version of a Bivouac reconciler
 * image is accepted, never another image (D50).
 */
export const reconcilerImageSchema = imageSchema.superRefine((image, ctx) => {
  const digest = /@sha256:[a-f0-9]{64}$/.exec(image);
  const withoutDigest = digest ? image.slice(0, digest.index) : image;
  const tag = /:([^/:]*)$/.exec(withoutDigest)?.[1];
  const name = tag === undefined ? withoutDigest : withoutDigest.slice(0, -tag.length - 1);
  if (!RECONCILER_IMAGE_NAME.test(name)) {
    ctx.addIssue({ code: "custom", message: "must be a Bivouac reconciler image (ghcr.io/<owner>/bivouac-reconciler)" });
    return;
  }
  // Only the tags CI publishes for one commit: a tag such as ':main' moves,
  // and the server would keep whatever it pulled first.
  if (tag !== undefined && !/^sha-[0-9a-f]{7,40}$/.test(tag)) {
    ctx.addIssue({ code: "custom", message: "must name one commit's image (':sha-<commit>') or a digest, never a moving tag" });
  }
});

/**
 * Address of the instance repo, read by the server with its deploy key.
 * GitHub over SSH only: the reconciler pins GitHub's host keys (D54).
 */
export const repositorySchema = z
  .string()
  .regex(
    /^git@github\.com:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+\.git$/,
    "must be the repo's SSH address on GitHub, such as git@github.com:owner/bivouac-platform.git",
  );

export const platformConfigSchema = z.strictObject({
  /** Base domain of the platform: apps are served on `<name>.<domain>`. */
  domain: hostnameSchema,
  /** This instance repo's own address, given to the reconciler by Ignition. */
  repository: repositorySchema,
  /**
   * The reconciler version the server runs. Ignition starts this one on a
   * new server; afterwards the reconciler moves itself to the version named
   * here (D50).
   */
  reconciler: z.strictObject({ image: reconcilerImageSchema }),
  auth: z
    .strictObject({
      /**
       * The only IP allowed to open Pocket ID's first-admin page, while the
       * instance is being installed (D15). Removed once the admin exists.
       */
      setupFrom: z
        .union([z.ipv4(), z.ipv6()], { error: "must be an IPv4 or IPv6 address" })
        .refine(isPublicAddress, {
          error:
            "must be a public address: Caddy sees private ones (Docker gateways) for traffic it does not know the source of, which would open the page to anyone",
        })
        .optional(),
    })
    .optional(),
});

/**
 * Addresses that are not a visitor's own public address. Over IPv6, and for
 * traffic from the apps, Caddy sees a Docker gateway (10.209.x.1, 172.17.0.1)
 * instead of the client (observed on the server, D67): `setupFrom` set to
 * such an address would let anyone open the first-admin page.
 */
const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) NON_PUBLIC.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 96], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) NON_PUBLIC.addSubnet(net, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = address.includes(":") ? "ipv6" : "ipv4";
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is refused outright: written that way,
  // it never matches what Caddy sees. (A `::ffff:0:0/96` rule in a BlockList
  // would also match every plain IPv4 address, observed on Node 26.)
  if (family === "ipv6" && /^::ffff:/i.test(address)) return false;
  return !NON_PUBLIC.check(address, family);
}

const SSH_KEY_TYPES = [
  "ssh-ed25519",
  "sk-ssh-ed25519@openssh.com",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ecdsa-sha2-nistp256@openssh.com",
  "ssh-rsa",
];

export const sshPublicKeySchema = z.string().superRefine((key, ctx) => {
  if (key.includes("PRIVATE KEY")) {
    ctx.addIssue({ code: "custom", message: "is a PRIVATE key: never put it in Git, use the .pub file" });
    return;
  }
  // One line: type, base64 data and an optional printable ASCII comment, each
  // separated by one space. The host script that applies the keys checks
  // the same pattern (butane/server.bu): a key accepted here is never
  // refused there, and one entry can never hide a second line.
  const match = /^(\S+) ([A-Za-z0-9+/]+={0,3})( [\x20-\x7e]*)?$/.exec(key.trim());
  const [, type, data] = match ?? [];
  if (!type || !data || !SSH_KEY_TYPES.includes(type)) {
    ctx.addIssue({ code: "custom", message: "is not an SSH public key on one line (expected 'ssh-ed25519 AAAA… comment')" });
    return;
  }
  // The data starts with the key type again, as a length-prefixed string:
  // a damaged copy-paste would lock its owner out.
  const blob = Buffer.from(data, "base64");
  const length = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  if (blob.length < 4 + length + 16 || blob.subarray(4, 4 + length).toString("latin1") !== type) {
    ctx.addIssue({ code: "custom", message: `is damaged: its data is not a complete '${type}' key (copy the .pub file again)` });
  }
});

export const sshKeysSchema = z
  .strictObject({
    keys: z
      .array(
        z.strictObject({
          name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must use lowercase letters, digits and hyphens"),
          key: sshPublicKeySchema,
        }),
      )
      .min(1, "must list at least one key, otherwise nobody can log in to the server"),
  })
  .superRefine((file, ctx) => {
    const names = file.keys.map((entry) => entry.name);
    const keys = file.keys.map((entry) => entry.key.trim().split(/\s+/).slice(0, 2).join(" "));
    names.forEach((name, index) => {
      if (names.indexOf(name) !== index) {
        ctx.addIssue({ code: "custom", path: ["keys", index, "name"], message: `'${name}' is listed twice` });
      }
    });
    keys.forEach((key, index) => {
      if (keys.indexOf(key) !== index) {
        ctx.addIssue({ code: "custom", path: ["keys", index, "key"], message: "is the same key as another entry" });
      }
    });
  });

export type AppManifest = z.infer<typeof appManifestSchema>;
export type SiteManifest = z.infer<typeof siteManifestSchema>;
export type PlatformConfig = z.infer<typeof platformConfigSchema>;
export type SshKeys = z.infer<typeof sshKeysSchema>;
