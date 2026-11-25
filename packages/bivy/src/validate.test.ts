import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateInstance } from "./validate.js";

const here = dirname(fileURLToPath(import.meta.url));
const key = readFileSync(join(here, "..", "..", "manifest", "fixtures", "ssh-key.pub"), "utf8").trim();

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const problems = (root: string) => validateInstance(root).errors.map(({ file, message }) => `${file}: ${message}`);

describe("bivy validate", () => {
  it("says butane/server.bu is missing, instead of failing on it", () => {
    const root = mkdtempSync(join(tmpdir(), "bivy-validate-"));
    roots.push(root);
    cpSync(join(here, "..", "..", "..", "template"), root, { recursive: true });
    writeFileSync(join(root, "ssh-keys.yml"), `keys:\n  - name: fixture\n    key: ${key}\n`);
    rmSync(join(root, "butane", "server.bu"));
    expect(problems(root)).toEqual(["butane/server.bu: butane/server.bu is missing"]);
  });

  it("answers for a folder that does not exist", () => {
    expect(problems(join(tmpdir(), "bivy-validate-nowhere"))).toEqual(["platform.yml: is missing"]);
  });
});
