import { z } from "zod";

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
  .refine((name) => !name.startsWith("archived"), "must not start with 'archived' (used for archived apps)");

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
        extensions: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/, "is not a valid extension name")).default([]),
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

export const platformConfigSchema = z.strictObject({
  /** Base domain of the platform: apps are served on `<name>.<domain>`. */
  domain: hostnameSchema,
});

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
  const [type, data] = key.trim().split(/\s+/);
  if (!type || !SSH_KEY_TYPES.includes(type) || !data || !/^[A-Za-z0-9+/]+={0,3}$/.test(data)) {
    ctx.addIssue({ code: "custom", message: "is not an SSH public key (expected 'ssh-ed25519 AAAA… comment')" });
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
