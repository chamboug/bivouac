import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import type { z } from "zod";
import {
  APP_SECRETS_DIRECTORY,
  appManifestSchema,
  appSecretNameProblem,
  platformConfigSchema,
  siteManifestSchema,
  sshKeysSchema,
  type AppManifest,
  type PlatformConfig,
  type SiteManifest,
  type SshKeys,
} from "./schema.js";
import { FORBIDDEN_CONTENT, checkEncryptedFile, encryptedEntries, readSopsConfigRecipients } from "./secrets.js";

/**
 * Layout of an instance repo (created from `template/`):
 *
 *   platform.yml          base domain
 *   ssh-keys.yml          public keys allowed to log in as `core`
 *   apps/<name>.yml       one manifest per app
 *   sites/<name>.yml      one manifest per static site…
 *   sites/<name>/         …and its files
 *   secrets/*.sops.yaml   SOPS-encrypted secrets
 *   secrets/apps/<name>.sops.yaml   an app's own secrets, as environment variables
 *   .sops.yaml            SOPS config (age recipients)
 *   butane/server.bu      Butane base, keys are added from ssh-keys.yml
 */

export interface ValidationError {
  file: string;
  message: string;
}

export interface Instance {
  platform: PlatformConfig | undefined;
  sshKeys: SshKeys | undefined;
  apps: AppManifest[];
  sites: SiteManifest[];
  errors: ValidationError[];
}

const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

export function loadInstance(root: string): Instance {
  const errors: ValidationError[] = [];
  const report = (file: string, message: string) => errors.push({ file, message });

  const platform = loadYaml(root, "platform.yml", platformConfigSchema, report);
  const sshKeys = loadYaml(root, "ssh-keys.yml", sshKeysSchema, report);
  const apps = loadManifests(root, "apps", appManifestSchema, report);
  const sites = loadManifests(root, "sites", siteManifestSchema, report);

  checkSiteDirectories(root, sites, report);
  checkUniqueHosts(apps, sites, platform, report);
  checkSecrets(root, apps, report);
  checkLinks(root, "secrets", report);
  checkForbiddenContent(root, report);

  return { platform, sshKeys, apps, sites, errors };
}

function loadYaml<S extends z.ZodType>(
  root: string,
  file: string,
  schema: S,
  report: (file: string, message: string) => void,
): z.output<S> | undefined {
  const path = join(root, file);
  if (!existsSync(path)) {
    report(file, "is missing");
    return undefined;
  }
  let document: unknown;
  try {
    document = parse(readFileSync(path, "utf8"));
  } catch (error) {
    report(file, `is not valid YAML: ${(error as Error).message}`);
    return undefined;
  }
  const result = schema.safeParse(document ?? {});
  if (!result.success) {
    for (const issue of result.error.issues) {
      const where = issue.path.length > 0 ? `'${issue.path.join(".")}' ` : "";
      report(file, `${where}${issue.message}`);
    }
    return undefined;
  }
  return result.data;
}

function loadManifests<S extends z.ZodType<{ name: string }>>(
  root: string,
  directory: string,
  schema: S,
  report: (file: string, message: string) => void,
): z.output<S>[] {
  const path = join(root, directory);
  if (!existsSync(path)) {
    return [];
  }
  const manifests: z.output<S>[] = [];
  for (const entry of readdirSync(path).sort()) {
    const file = `${directory}/${entry}`;
    if (entry.startsWith(".")) {
      continue;
    }
    if (statSync(join(path, entry)).isDirectory()) {
      continue;
    }
    if (!entry.endsWith(".yml")) {
      report(file, "is not a '.yml' file and would be ignored: rename it or remove it");
      continue;
    }
    const manifest = loadYaml(root, file, schema, report);
    if (!manifest) {
      continue;
    }
    const expected = entry.slice(0, -".yml".length);
    if (manifest.name !== expected) {
      report(file, `'name' is '${manifest.name}' but the file is named '${expected}.yml': they must match`);
      continue;
    }
    manifests.push(manifest);
  }
  return manifests;
}

function checkSiteDirectories(
  root: string,
  sites: SiteManifest[],
  report: (file: string, message: string) => void,
): void {
  const sitesPath = join(root, "sites");
  for (const site of sites) {
    const directory = join(sitesPath, site.name);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      report(`sites/${site.name}.yml`, `has no 'sites/${site.name}/' directory with the site's files`);
    } else if (!existsSync(join(directory, "index.html"))) {
      report(`sites/${site.name}/`, "has no index.html");
    }
  }
  if (!existsSync(sitesPath)) {
    return;
  }
  for (const entry of readdirSync(sitesPath)) {
    if (statSync(join(sitesPath, entry)).isDirectory() && !existsSync(join(sitesPath, `${entry}.yml`))) {
      report(`sites/${entry}/`, `has no manifest 'sites/${entry}.yml'`);
    }
  }
}

function checkUniqueHosts(
  apps: AppManifest[],
  sites: SiteManifest[],
  platform: PlatformConfig | undefined,
  report: (file: string, message: string) => void,
): void {
  const owners = new Map<string, string>();
  const claim = (host: string, file: string) => {
    const owner = owners.get(host);
    if (owner) {
      report(file, `uses '${host}', already used by ${owner}`);
    } else {
      owners.set(host, file);
    }
  };
  const entries = [
    ...apps.map((app) => ({ ...app, file: `apps/${app.name}.yml` })),
    ...sites.map((site) => ({ ...site, file: `sites/${site.name}.yml` })),
  ];
  for (const entry of entries) {
    claim(`name:${entry.name}`, entry.file);
    for (const domain of entry.domains) {
      if (platform && (domain === platform.domain || domain.endsWith(`.${platform.domain}`))) {
        report(entry.file, `domain '${domain}' is inside the platform domain: use the app name instead`);
        continue;
      }
      claim(domain, entry.file);
    }
  }
}

function checkSecrets(root: string, apps: AppManifest[], report: (file: string, message: string) => void): void {
  const files = walk(root).filter(
    (file) =>
      file !== ".sops.yaml" && (file.startsWith("secrets/") || /\.sops\.(ya?ml|json|env)$/.test(file)),
  );
  if (files.length === 0) {
    return;
  }

  let expected: string[] | undefined;
  const configPath = join(root, ".sops.yaml");
  if (!existsSync(configPath)) {
    report(".sops.yaml", "is missing: it says which age key the secrets are encrypted for");
  } else {
    const config = readSopsConfigRecipients(readFileSync(configPath, "utf8"));
    config.errors.forEach((message) => report(".sops.yaml", message));
    expected = config.errors.length === 0 ? config.recipients : undefined;
  }

  for (const file of files) {
    const appSecrets = new RegExp(`^${APP_SECRETS_DIRECTORY}/([^/]+)\\.sops\\.yaml$`).exec(file);
    if (!appSecrets && !/^secrets\/[^/]+\.sops\.yaml$/.test(file)) {
      report(file, `secrets must be YAML files named '<name>.sops.yaml', in 'secrets/' or, for an app's own, in '${APP_SECRETS_DIRECTORY}/'`);
      continue;
    }
    const content = readFileSync(join(root, file), "utf8");
    const result = checkEncryptedFile(content);
    result.errors.forEach((message) => report(file, message));
    if (appSecrets && result.errors.length === 0) {
      checkAppSecrets(file, content, apps.find((app) => app.name === appSecrets[1]), appSecrets[1] ?? "", report);
    }
    if (expected && result.errors.length === 0) {
      const actual = [...result.recipients].sort().join(",");
      if (actual !== [...expected].sort().join(",")) {
        report(file, "is not encrypted for exactly the age keys listed in .sops.yaml: re-encrypt it (sops updatekeys)");
      }
    }
  }
}

/**
 * An app's secrets become its environment variables: one level of names,
 * each a string, none the platform provides, and the app must exist.
 */
function checkAppSecrets(
  file: string,
  content: string,
  app: AppManifest | undefined,
  name: string,
  report: (file: string, message: string) => void,
): void {
  if (!app) {
    report(file, `has no app 'apps/${name}.yml': remove it with the app, or name it after one`);
  }
  for (const entry of encryptedEntries(content)) {
    if (entry.nested) {
      report(file, `'${entry.name}' must hold one value, not a list or a map: each name becomes one environment variable`);
      continue;
    }
    if (entry.type !== "str") {
      report(file, `'${entry.name}' must be text: quote it before encrypting, so that the app receives exactly what was written`);
    }
    const problem = appSecretNameProblem(entry.name, app);
    if (problem) report(file, `'${entry.name}' ${problem}`);
  }
}

/**
 * The checks here only read plain files, and the reconciler would follow a
 * link: under `secrets/`, a link could give one app another's secrets.
 */
function checkLinks(root: string, directory: string, report: (file: string, message: string) => void): void {
  const path = join(root, directory);
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) checkLinks(root, file, report);
    else if (!entry.isFile()) report(file, "must be a plain file: links and other special files are refused here");
  }
}

function checkForbiddenContent(root: string, report: (file: string, message: string) => void): void {
  for (const file of walk(root)) {
    const content = readFileSync(join(root, file), "utf8");
    for (const { pattern, message } of FORBIDDEN_CONTENT) {
      if (pattern.test(content)) {
        report(file, `${message}: remove it from the repo and treat it as leaked`);
      }
    }
  }
}

function walk(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(root, path));
    } else if (entry.isFile()) {
      files.push(relative(root, path).split("\\").join("/"));
    }
  }
  return files.sort();
}
