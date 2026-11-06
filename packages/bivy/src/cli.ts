#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateCaddyfile, loadInstance } from "@bivouac/manifest";
import { CaddyError, validateCaddyfile } from "./caddy.js";
import { IgnitionError, buildButane, compileButane } from "./ignition.js";

const USAGE = `Usage: bivy <command> [instance-dir]

Commands:
  validate [dir]              check an instance repo (manifests, keys, secrets, Butane, Caddyfile)
  ignition [dir] [-o file]    print the server's Ignition config (JSON)

[dir] defaults to the current directory.`;

function main(argv: string[]): number {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { output: { type: "string", short: "o" }, help: { type: "boolean", short: "h" } },
  });
  const [command, directory = "."] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const root = resolve(directory);

  switch (command) {
    case "validate":
      return validate(root);
    case "ignition":
      return ignition(root, values.output);
    default:
      console.error(`Unknown command '${command}'.\n\n${USAGE}`);
      return 1;
  }
}

function validate(root: string): number {
  const instance = loadInstance(root);
  const errors = [...instance.errors];
  if (instance.sshKeys) {
    try {
      compileButane(buildButane(root, instance.sshKeys));
    } catch (error) {
      if (!(error instanceof IgnitionError)) throw error;
      errors.push({ file: "butane/server.bu", message: error.message });
    }
  }
  // Only check the Caddyfile when the manifests themselves are valid: an
  // invalid manifest is left out of the instance and would hide its route.
  if (instance.platform && errors.length === 0) {
    const generated = generateCaddyfile(instance.platform, instance.apps, instance.sites);
    errors.push(...generated.errors);
    if (generated.errors.length === 0) {
      try {
        validateCaddyfile(generated.caddyfile);
      } catch (error) {
        if (!(error instanceof CaddyError)) throw error;
        errors.push({ file: "(generated Caddyfile)", message: error.message });
      }
    }
  }

  if (errors.length > 0) {
    console.error(`✗ ${errors.length} problem${errors.length > 1 ? "s" : ""} found:\n`);
    for (const { file, message } of errors) {
      console.error(`  ${file}: ${message}`);
    }
    return 1;
  }
  console.log(
    `✓ Instance is valid: ${instance.apps.length} app(s), ${instance.sites.length} site(s), ` +
      `${instance.sshKeys?.keys.length ?? 0} SSH key(s).`,
  );
  return 0;
}

function ignition(root: string, output: string | undefined): number {
  const instance = loadInstance(root);
  if (!instance.sshKeys) {
    console.error("ssh-keys.yml is invalid: run 'bivy validate' for details.");
    return 1;
  }
  try {
    const json = compileButane(buildButane(root, instance.sshKeys));
    if (output) {
      writeFileSync(output, json);
    } else {
      process.stdout.write(json);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof IgnitionError)) throw error;
    console.error(error.message);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
