#!/usr/bin/env node
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateCaddyfile, loadInstance } from "@bivouac/manifest";
import { CaddyError, validateCaddyfile } from "./caddy.js";
import { EXAMPLE_IPV6, IPV6_PLACEHOLDER, IgnitionError, buildButane, compileButane } from "./ignition.js";
import { GitHub, repositoryPath } from "./github.js";
import { Hetzner } from "./hetzner.js";
import { newHostKey } from "./hostkey.js";
import { RebuildError, cleanup, curlProbe, ignitionFor, instanceIdentity, rebuildTest } from "./rebuild.js";
import { SshRemote, scanHostKey } from "./remote.js";
import { rebuildReal } from "./rebuild-real.js";
import { resolve4 } from "node:dns/promises";
import { createInterface } from "node:readline/promises";

const USAGE = `Usage: bivy <command> [instance-dir]

Commands:
  validate [dir]              check an instance repo (manifests, keys, secrets, Butane, Caddyfile)
  ignition [dir] [-o file] [--ipv6 <address/64>]
                              print the server's Ignition config (JSON)

  rebuild [dir]               rebuild the real server from the latest nightly copy,
                              on the same IPs (D91). Erases the server: a decision
                              of its own, with a typed confirmation (rule 5)
      --plan                  only read, and say what it would do
      --server-type <type>    for a new server, when no cx23 can be ordered
      --without-fresh-backup  the old server is gone: accept losing what was
                              written since its last nightly copy
      --ssh-key <file>        default ~/.ssh/id_ed25519

  rebuild --test [dir]        rebuild a temporary copy of the platform from the
                              latest nightly copy, check it, then delete it (D91)
      --keep                  leave the test server running after the checks
      --cleanup               delete what a test created (only that)
      --location, --server-type   where the test server goes (default: cx23
                              where it can be ordered)
      --ssh-key <file>        default ~/.ssh/id_ed25519
      --age-key <file>        default ~/.config/sops/age/keys.txt
      --hetzner-token <file>  default ~/.config/bivouac/hetzner-token
      --github-token <file>   default ~/.config/bivouac/github-rebuild-token

[dir] defaults to the current directory.`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      ipv6: { type: "string" },
      help: { type: "boolean", short: "h" },
      test: { type: "boolean" },
      keep: { type: "boolean" },
      cleanup: { type: "boolean" },
      plan: { type: "boolean" },
      "without-fresh-backup": { type: "boolean" },
      location: { type: "string" },
      "server-type": { type: "string" },
      "ssh-key": { type: "string" },
      "age-key": { type: "string" },
      "hetzner-token": { type: "string" },
      "github-token": { type: "string" },
    },
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
      return ignition(root, values.output, values.ipv6);
    case "rebuild":
      return rebuild(root, values);
    default:
      console.error(`Unknown command '${command}'.\n\n${USAGE}`);
      return 1;
  }
}

function validate(root: string): number {
  const instance = loadInstance(root);
  const errors = [...instance.errors];
  if (instance.sshKeys && instance.platform) {
    try {
      compileButane(buildButane(root, instance.platform, instance.sshKeys, readFileSync(join(root, "butane", "server.bu"), "utf8").includes(IPV6_PLACEHOLDER) ? EXAMPLE_IPV6 : undefined));
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

function ignition(root: string, output: string | undefined, ipv6: string | undefined): number {
  const instance = loadInstance(root);
  if (!instance.sshKeys || !instance.platform) {
    console.error("platform.yml or ssh-keys.yml is invalid: run 'bivy validate' for details.");
    return 1;
  }
  try {
    const json = compileButane(buildButane(root, instance.platform, instance.sshKeys, ipv6));
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

const config = (file: string) => join(homedir(), ".config", "bivouac", file);

/**
 * A credential from a file of mode 600, typed by the owner in a real
 * terminal (runbook section 0). Never printed, never passed on a command line.
 */
function secretFile(path: string, what: string): string {
  if (!existsSync(path)) {
    throw new RebuildError(`${what} is missing: type it into ${path} in a real terminal (runbook section 0):\n  read -rs "v?${what}: "; echo; (umask 077; printf '%s' "$v" > ${path}); unset v`);
  }
  if ((statSync(path).mode & 0o077) !== 0) throw new RebuildError(`${path} can be read by others: chmod 600 it`);
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new RebuildError(`${path} is empty`);
  return value;
}

async function rebuild(root: string, values: Record<string, string | boolean | undefined>): Promise<number> {
  const text = (name: string) => (typeof values[name] === "string" ? (values[name] as string) : undefined);
  if (!values.test) return realRebuild(root, values, text);
  const githubTokenPath = text("github-token") ?? config("github-rebuild-token");
  const instance = loadInstance(root);
  if (!instance.platform) {
    console.error("platform.yml is invalid: run 'bivy validate' for details.");
    return 1;
  }
  const repository = repositoryPath(instance.platform.repository);
  const knownHosts = config("known_hosts-rebuild-test");
  const identity = text("ssh-key") ?? join(homedir(), ".ssh", "id_ed25519");
  const deps = {
    hetzner: new Hetzner(secretFile(text("hetzner-token") ?? config("hetzner-token"), "the Hetzner token")),
    github: () => {
      if (!existsSync(githubTokenPath)) {
        console.log(`A temporary GitHub token is needed, to add the test server's read-only deploy key. Create it at
  https://github.com/settings/personal-access-tokens/new?name=bivouac-rebuild-test&description=Deploy+key+of+a+rebuild+test&expires_in=1&administration=write
choosing "Only select repositories" → ${repository} (nothing else), and delete it once the test is over:
the test's deploy key goes with it.`);
      }
      return new GitHub(secretFile(githubTokenPath, "the temporary GitHub token"), repository);
    },
    remote: (host: string) => new SshRemote(host, identity, knownHosts),
    scanHostKey,
    newHostKey: () => newHostKey(),
    publicIpv4: async () => {
      const response = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new RebuildError(`api.ipify.org answered HTTP ${response.status}: cannot tell this Mac's IPv4`);
      return (await response.text()).trim();
    },
    ignition: ignitionFor(root),
    ageKey: () => instanceIdentity(readFileSync(text("age-key") ?? join(homedir(), ".config", "sops", "age", "keys.txt"), "utf8"), readFileSync(join(root, ".sops.yaml"), "utf8")),
    probe: (host: string, address: string, path: string) => curlProbe(host, address, path, true),
    probeReal: (host: string, path: string) => curlProbe(host, undefined, path, false),
    stateFile: config("rebuild-test.json"),
    knownHosts,
    log: (message: string) => console.log(message),
    sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    now: Date.now,
  };
  try {
    if (!values.cleanup) {
      const state = await rebuildTest(deps, { root, keep: values.keep === true, location: text("location"), serverType: text("server-type") });
      const minutes = Math.round((Date.now() - Date.parse(state.startedAt)) / 60_000);
      console.log(`\n✓ The platform came back on the test server, ${minutes} minutes after the start. Steps (seconds): ${JSON.stringify(state.timings)}`);
      if (values.keep) {
        console.log(`The test server is still running at ${state.ipv4} (€${state.hourly}/hour). Delete it with: bivy rebuild --test --cleanup`);
        return 0;
      }
    }
    const problems = await cleanup(deps, existsSync(githubTokenPath));
    if (problems.length > 0) {
      console.error(`✗ Clean-up incomplete:\n  ${problems.join("\n  ")}`);
      return 1;
    }
    console.log(`✓ Everything the test created is deleted. Now delete the temporary GitHub token on GitHub
  (Settings → Developer settings → Fine-grained tokens), then: rm ${githubTokenPath}`);
    return 0;
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    if (!values.cleanup && existsSync(config("rebuild-test.json"))) {
      // The test server may hold the age key and a full copy of the data.
      console.error("The test server may still be running, billed, with a copy of the data: run again to carry on, or delete it with\n  bivy rebuild --test --cleanup");
    }
    return 1;
  }
}

async function realRebuild(root: string, values: Record<string, string | boolean | undefined>, text: (name: string) => string | undefined): Promise<number> {
  if (values.keep || values.cleanup || text("location") || text("github-token")) {
    console.error("--keep, --cleanup, --location and --github-token are for 'bivy rebuild --test' only.");
    return 1;
  }
  const identity = text("ssh-key") ?? join(homedir(), ".ssh", "id_ed25519");
  const knownHosts = config("known_hosts");
  const deps = {
    hetzner: new Hetzner(secretFile(text("hetzner-token") ?? config("hetzner-token"), "the Hetzner token")),
    remote: (host: string) => new SshRemote(host, identity, knownHosts),
    scanHostKey,
    newHostKey: () => newHostKey(),
    ignition: ignitionFor(root),
    ageKey: () => instanceIdentity(readFileSync(text("age-key") ?? join(homedir(), ".config", "sops", "age", "keys.txt"), "utf8"), readFileSync(join(root, ".sops.yaml"), "utf8")),
    probeReal: (host: string, path: string) => curlProbe(host, undefined, path, false),
    resolve: (name: string) => resolve4(name),
    ask: async (question: string) => {
      // Only a person at a terminal can confirm: never a pipe or a script.
      if (!process.stdin.isTTY) throw new RebuildError("a rebuild is confirmed by typing in a terminal: none here");
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await terminal.question(question);
      } finally {
        terminal.close();
      }
    },
    stateFile: config("rebuild.json"),
    knownHosts,
    log: (message: string) => console.log(message),
    sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    now: Date.now,
  };
  try {
    const result = await rebuildReal(deps, { root, plan: values.plan === true, serverType: text("server-type"), withoutFreshBackup: values["without-fresh-backup"] === true });
    if ("problems" in result) return result.problems.length > 0 ? 1 : 0;
    console.log(`\n✓ The platform is back on ${result.ipv4}. Now:
  - remove the OLD deploy key on GitHub (repo Settings → Deploy keys; keep '${"bivouac-server-" + result.run}');
  - check tomorrow that the first nightly backup ran (it waits for the next night, D74);
  - the platform's known_hosts before the rebuild is kept in ${result.knownHostsBackup ?? "(none)"}.`);
    return 0;
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    if (existsSync(config("rebuild.json"))) console.error("Run the same command again to carry on from where it stopped: a step already done is never repeated.");
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
