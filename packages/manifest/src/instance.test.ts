import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadInstance } from "./instance.js";
import { checkEncryptedFile } from "./secrets.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");
const template = join(here, "..", "..", "..", "template");

const SSH_KEY = readFileSync(join(fixtures, "ssh-key.pub"), "utf8").trim();
const RECIPIENT = readFileSync(join(fixtures, "age-recipient.txt"), "utf8").trim();
const ENCRYPTED = readFileSync(join(fixtures, "platform.sops.yaml"), "utf8");

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A copy of the template, filled in the way `bivy init` will fill it. */
export function makeInstance(): string {
  const root = mkdtempSync(join(tmpdir(), "bivouac-instance-"));
  roots.push(root);
  cpSync(template, root, { recursive: true });
  write(root, "ssh-keys.yml", `keys:\n  - name: fixture\n    key: ${SSH_KEY}\n`);
  write(root, ".sops.yaml", `creation_rules:\n  - path_regex: ^secrets/.*\\.sops\\.yaml$\n    age: ${RECIPIENT}\n`);
  write(root, "secrets/platform.sops.yaml", ENCRYPTED);
  return root;
}

function write(root: string, file: string, content: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

function errorsOf(root: string): string[] {
  return loadInstance(root).errors.map(({ file, message }) => `${file}: ${message}`);
}

describe("instance repo", () => {
  it("the empty template fails only because it has no SSH key yet", () => {
    const root = mkdtempSync(join(tmpdir(), "bivouac-template-"));
    roots.push(root);
    cpSync(template, root, { recursive: true });
    expect(errorsOf(root)).toEqual([expect.stringMatching(/^ssh-keys\.yml: 'keys' must list at least one key/)]);
  });

  it("a filled-in template is valid", () => {
    expect(errorsOf(makeInstance())).toEqual([]);
  });

  it("loads apps and sites", () => {
    const root = makeInstance();
    write(root, "apps/recettes.yml", "image: ghcr.io/someone/recettes:sha-abc123\nname: recettes\ngroups: [famille]\n");
    write(root, "sites/home.yml", "name: home\ndomains: [example.com, www.example.com]\n");
    write(root, "sites/home/index.html", "<!doctype html>");
    const instance = loadInstance(root);
    expect(instance.errors).toEqual([]);
    expect(instance.apps.map((app) => app.name)).toEqual(["recettes"]);
    expect(instance.sites.map((site) => site.domains)).toEqual([["example.com", "www.example.com"]]);
  });

  it("requires the file name to match the app name", () => {
    const root = makeInstance();
    write(root, "apps/recipes.yml", "image: ghcr.io/someone/recettes:1\nname: recettes\nauth: public\n");
    expect(errorsOf(root)).toEqual([expect.stringContaining("must match")]);
  });

  it("refuses files that would silently be ignored", () => {
    const root = makeInstance();
    write(root, "apps/recettes.yaml", "image: ghcr.io/someone/recettes:1\nname: recettes\nauth: public\n");
    expect(errorsOf(root)).toEqual([expect.stringContaining("not a '.yml' file")]);
  });

  it("refuses an app and a site with the same name, or a shared domain", () => {
    const root = makeInstance();
    write(root, "apps/home.yml", "image: a/b:1\nname: home\nauth: public\ndomains: [example.com]\n");
    write(root, "sites/home.yml", "name: home\n");
    write(root, "sites/home/index.html", "");
    write(root, "sites/other.yml", "name: other\ndomains: [example.com]\n");
    write(root, "sites/other/index.html", "");
    expect(errorsOf(root)).toEqual([
      "sites/home.yml: uses 'name:home', already used by apps/home.yml",
      "sites/other.yml: uses 'example.com', already used by apps/home.yml",
    ]);
  });

  it("refuses a custom domain inside the platform domain", () => {
    const root = makeInstance();
    write(root, "apps/a.yml", "image: a/b:1\nname: a\nauth: public\ndomains: [b.apps.example.com]\n");
    expect(errorsOf(root)).toEqual([expect.stringContaining("inside the platform domain")]);
  });

  it("checks that each site has its files, and each site folder its manifest", () => {
    const root = makeInstance();
    write(root, "sites/home.yml", "name: home\n");
    write(root, "sites/orphan/index.html", "");
    expect(errorsOf(root)).toEqual([
      "sites/home.yml: has no 'sites/home/' directory with the site's files",
      "sites/orphan/: has no manifest 'sites/orphan.yml'",
    ]);
  });

  it("refuses a secrets file in plain text", () => {
    const root = makeInstance();
    write(root, "secrets/oops.sops.yaml", "hetzner_token: real-token\n");
    expect(errorsOf(root)).toEqual([expect.stringContaining("secrets/oops.sops.yaml: is not encrypted with SOPS")]);
  });

  it("refuses a secrets file with one value left in plain text", () => {
    const root = makeInstance();
    write(root, "secrets/platform.sops.yaml", ENCRYPTED.replace(/^hetzner_token: .*$/m, "hetzner_token: real-token"));
    expect(errorsOf(root)).toEqual([
      "secrets/platform.sops.yaml: has a value in plain text at 'hetzner_token'",
    ]);
  });

  it("refuses secrets encrypted for another key than the one in .sops.yaml", () => {
    const root = makeInstance();
    const other = "age1" + "q".repeat(58);
    write(root, ".sops.yaml", `creation_rules:\n  - age: ${other}\n`);
    expect(errorsOf(root)).toEqual([expect.stringContaining("not encrypted for exactly the age keys")]);
  });

  it("refuses secrets outside secrets/", () => {
    const root = makeInstance();
    write(root, "db.sops.yaml", ENCRYPTED);
    expect(errorsOf(root)).toEqual([expect.stringContaining("secrets must be YAML files in 'secrets/'")]);
  });

  it("finds private keys anywhere in the repo", () => {
    const root = makeInstance();
    write(root, "notes.txt", "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ\n");
    write(root, "sites/home.yml", "name: home\n");
    write(root, "sites/home/index.html", "-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(errorsOf(root)).toEqual([
      "notes.txt: contains an age PRIVATE key: remove it from the repo and treat it as leaked",
      "sites/home/index.html: contains a PRIVATE key: remove it from the repo and treat it as leaked",
    ]);
  });
});

describe("encrypted file check", () => {
  it("accepts a real SOPS file and reads its recipient", () => {
    expect(checkEncryptedFile(ENCRYPTED)).toEqual({ errors: [], recipients: [RECIPIENT] });
  });

  it("refuses a file whose integrity code was removed", () => {
    expect(checkEncryptedFile(ENCRYPTED.replace(/^ {4}mac: .*$/m, "")).errors).toEqual([
      "has no valid SOPS integrity code ('sops.mac')",
    ]);
  });

  it("refuses a file with an added plain-text value", () => {
    expect(checkEncryptedFile(`${ENCRYPTED}\nextra: 42\n`).errors).toEqual(["has a value in plain text at 'extra'"]);
  });
});
