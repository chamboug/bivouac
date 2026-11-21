#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateCaddyfile, loadInstance, withStatusApp } from "@bivouac/manifest";
import { CaddyError, validateCaddyfile } from "./caddy.js";
import { EXAMPLE_IPV6, IPV6_PLACEHOLDER, IgnitionError, buildButane, compileButane } from "./ignition.js";
import { rebuildCommand } from "./rebuild-cli.js";
import { SshError, execCommand, serverAddress, splitAtDoubleDash, sshArguments } from "./ssh.js";
import * as prompts from "@clack/prompts";
import { type AskSecret, CredentialError, credential } from "./credentials.js";
import { resolve4 } from "node:dns/promises";
import { INIT_USAGE, initCli } from "./init-cli.js";
import { printBanner } from "./banner.js";
import { RemoteError, SshRemote, streamSsh } from "./remote.js";
import { parseLines, restoreCommand } from "./restore.js";
import { pin } from "./pin.js";
import { loginLink } from "./login-link.js";
import { StatusError, TOO_OLD, backupStep, describeState, readState, reconcilerCommand } from "./status.js";
import { TerminalProgress, interactive, terminalGuide } from "./terminal.js";
import { REFUSED, SETTABLE, SecretError, setSecret } from "./secret.js";
import { RebuildError, instanceIdentity } from "./rebuild.js";
import { checkoutProblems } from "./rebuild-real.js";
import { SopsError, dockerSops } from "./sops.js";

const USAGE = `Usage: bivy <command> [instance-dir]

Commands:
  validate [dir]              check an instance repo (manifests, keys, secrets, Butane, Caddyfile)
  ignition [dir] [-o file] [--ipv6 <address/64>]
                              print the server's Ignition config (JSON)

  pin reconciler|status <commit>
                              move the reconciler or the status page to the
                              version CI published for a commit of main: finds
                              its digest on GHCR, writes that one line of
                              platform.yml with the release tag Renovate follows
                              (v1.0.<n>, D109), then validates (D106). Commits nothing.
      --instance <dir>        the instance repo (default: the current directory)

  ssh [dir]                   open a shell on the server, as core
  exec [app] [-- command...]  run a command in an app's container; with no
                              command, a shell; with no app, choose it from a list
      --instance <dir>        the instance repo (default: the current directory)
      --ssh-key <file>        default ~/.ssh/id_ed25519

  status [dir]                how the platform is: containers, last pass, backups,
                              host, open incidents; only reads (D104)
      --json                  the server's answer as it is
  backup [dir]                back up the platform now, instead of waiting for
                              the night, and follow it to its end; before any
                              change that can lose data (D89)
      --restore-test          also run the weekly restore test right after

  login-link <user> [dir]     a one-time sign-in link for a Pocket ID user, by
                              username or email, for an admin who lost every
                              passkey (D107). Valid once, for one hour. It is a
                              credential: shown only to a person at a terminal,
                              never to a script or to Claude, and never written
                              anywhere.

  secret set <path> [dir]     change one value of secrets/platform.sops.yaml (D108),
                              typed twice with hidden input; every other value is
                              kept and checked. Commits nothing. Paths: mail.password,
                              pocket_id.static_api_key, backup.b2_key_id,
                              backup.b2_application_key, alerts.pushover_token,
                              alerts.pushover_user, alerts.healthchecks.<heartbeat|
                              backup|restore>, ghcr.username, ghcr.token
      --from-file <file>      read the value from a file of mode 600 the owner
                              typed, outside the instance repo; deleted once done
      --age-key <file>        default ~/.config/sops/age/keys.txt

  restore [app]               bring one app's data back to a backup copy, on the
                              running server (D101). Replaces live data: confirmed
                              by typing the app's name in a terminal. In a
                              terminal, it asks what the options below say.
      --plan                  only read, and say what it would do
      --snapshot <id>         this copy (default: the latest nightly one)
      --before <date>         the latest nightly copy at or before that day (UTC)
      --only database|files   one part only (default: both)
      --instance <dir>        the instance repo (default: the current directory)
      --ssh-key <file>        default ~/.ssh/id_ed25519

  rebuild [dir]               rebuild the real server from its backups, on the
                              same IPs (D91). Erases the server: a decision of its
                              own, with a typed confirmation (rule 5). In a
                              terminal, it asks what the options below say.
      --plan                  only read, and say what it would do
      --server-type <type>    for a new server, when no cx23 can be ordered
      --without-fresh-backup  the old server is gone: accept losing what was
                              written since its last nightly copy
      --snapshot <id>         bring back this backup copy, not the latest
      --abandon               forget a rebuild that stopped before erasing anything
      --ssh-key <file>        default ~/.ssh/id_ed25519
      --age-key <file>        default ~/.config/sops/age/keys.txt (in a terminal,
                              it can also be pasted)

  rebuild --test [dir]        rebuild a temporary copy of the platform from its
                              backups, check it, then delete it (D91). In a
                              terminal, it asks what the options below say.
      --yes                   rent the test server without asking
      --keep                  leave the test server running after the checks
      --cleanup               delete what a test created (only that)
      --location, --server-type   where the test server goes (default: cx23
                              where it can be ordered)
      --snapshot <id>         bring back this backup copy, not the latest
      --ssh-key <file>        default ~/.ssh/id_ed25519
      --age-key <file>        default ~/.config/sops/age/keys.txt
      --hetzner-token <file>  default ~/.config/bivouac/hetzner-token
      --github-token <file>   default ~/.config/bivouac/github-rebuild-token

${INIT_USAGE}

[dir] defaults to the current directory.`;

async function main(argv: string[]): Promise<number> {
  // init and configure parse their own flags (init-cli.ts).
  if (argv[0] === "init" || argv[0] === "configure") return initCli(argv);
  // What follows `--` belongs to the command run in a container, never to bivy.
  const { own, command: inner } = splitAtDoubleDash(argv);
  const { positionals, values } = parseArgs({
    args: own,
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
      abandon: { type: "boolean" },
      location: { type: "string" },
      "server-type": { type: "string" },
      "ssh-key": { type: "string" },
      "age-key": { type: "string" },
      "hetzner-token": { type: "string" },
      "github-token": { type: "string" },
      snapshot: { type: "string" },
      before: { type: "string" },
      only: { type: "string" },
      yes: { type: "boolean" },
      instance: { type: "string" },
      json: { type: "boolean" },
      "restore-test": { type: "boolean" },
      "from-file": { type: "string" },
    },
  });
  const [command, directory = "."] = positionals;
  if (values.help || !command) {
    printBanner();
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
      return rebuildCommand(root, values, hetznerToken);
    case "ssh":
      return ssh(values.instance ? resolve(values.instance) : root, undefined, [], values["ssh-key"]);
    case "exec":
      return ssh(resolve(values.instance ?? "."), positionals[1] ?? null, inner, values["ssh-key"]);
    case "restore":
      return restore(resolve(values.instance ?? "."), positionals[1], values);
    case "pin":
      return pinImage(resolve(values.instance ?? "."), positionals[1], positionals[2]);
    case "status":
      return status(values.instance ? resolve(values.instance) : root, values["ssh-key"], values.json === true);
    case "backup":
      return backup(values.instance ? resolve(values.instance) : root, values["ssh-key"], values["restore-test"] === true);
    case "login-link":
      return loginLinkCli(positionals[1], values.instance ? resolve(values.instance) : resolve(positionals[2] ?? "."), values["ssh-key"]);
    case "secret":
      return secret(positionals.slice(1), values["from-file"], values["age-key"]);
    default:
      console.error(`Unknown command '${command}'.\n\n${USAGE}`);
      return 1;
  }
}

function validate(root: string): number {
  const instance = loadInstance(root);
  const errors = [...instance.errors];
  // The server runs this image with the Docker socket: a tag can be pushed
  // again by whoever can publish the package, a digest names one content
  // (D61). Required here, at merge time, rather than in the schema, so a
  // reconciler that reads an older platform.yml still finds its version.
  if (instance.platform && !/@sha256:[a-f0-9]{64}$/.test(instance.platform.reconciler.image)) {
    errors.push({
      file: "platform.yml",
      message: "reconciler.image must be pinned by digest (ghcr.io/<owner>/bivouac-reconciler:v<x.y.z>@sha256:<digest> or :sha-<commit>@…, D61, D109)",
    });
  }
  // The status page holds the token of the reconciler's API: the same rule.
  const status = instance.platform?.status;
  if (status && !/@sha256:[a-f0-9]{64}$/.test(status.image)) {
    errors.push({
      file: "platform.yml",
      message: "status.image must be pinned by digest (ghcr.io/<owner>/bivouac-status:v<x.y.z>@sha256:<digest> or :sha-<commit>@…)",
    });
  }
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
    const generated = generateCaddyfile(instance.platform, withStatusApp(instance.platform, instance.apps), instance.sites);
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

/** `bivy pin` (D106): one line of platform.yml, then the checks of bivy validate. */
function pinImage(root: string, part: string | undefined, commit: string | undefined): Promise<number> {
  const file = join(root, "platform.yml");
  if (!existsSync(file)) {
    console.error(`No platform.yml in ${root}: run bivy from the instance repo, or pass --instance <dir>.`);
    return Promise.resolve(1);
  }
  return pin(
    {
      read: () => readFileSync(file, "utf8"),
      write: (text) => writeFileSync(file, text),
      fetch: (...args) => globalThis.fetch(...args),
      validate: () => validate(root),
      log: (line) => console.log(line),
    },
    part,
    commit,
  );
}

/**
 * `bivy ssh` (app undefined) and `bivy exec` (app given, or null to choose
 * it): find the server and connect, with the platform's own known_hosts.
 */
async function ssh(root: string, app: string | null | undefined, command: string[], sshKey: string | undefined): Promise<number> {
  const instance = loadInstance(root);
  if (!instance.platform) {
    console.error(`No valid platform.yml in ${root}: run bivy from the instance repo, or pass it (bivy ssh <dir>, bivy exec --instance <dir>).`);
    return 1;
  }
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const identity = sshKey ?? join(homedir(), ".ssh", "id_ed25519");
  const knownHosts = config("known_hosts");
  if (!existsSync(identity)) {
    console.error(`No SSH key at ${identity}: pass the right one with --ssh-key <file>.`);
    return 1;
  }
  if (!existsSync(knownHosts)) {
    console.error(`No known host key for the platform in ${knownHosts}: without it, nothing proves the server is ours (runbook section 8).`);
    return 1;
  }

  let remote: string | undefined;
  if (app !== undefined) {
    const names = instance.apps.map((entry) => entry.name).sort();
    let chosen = app;
    if (chosen === null) {
      if (!tty) {
        console.error(`Which app? bivy exec <app> -- <command>. Apps: ${names.join(", ") || "none"}.`);
        return 1;
      }
      const answer = await prompts.select({ message: "Which app?", options: names.map((name) => ({ value: name, label: name })) });
      if (prompts.isCancel(answer)) return 1;
      chosen = answer;
    }
    if (!names.includes(chosen)) {
      console.error(`No app '${chosen}' in this instance. Apps: ${names.join(", ") || "none"}.`);
      return 1;
    }
    remote = execCommand(chosen, command, tty);
  }

  try {
    const host = await serverAddress(instance.platform.domain, resolve4);
    const result = spawnSync("ssh", sshArguments(host, identity, knownHosts, { tty, remote }), { stdio: "inherit" });
    if (result.error) throw new SshError(`could not start ssh: ${result.error.message}`);
    return result.status ?? 1;
  } catch (error) {
    if (!(error instanceof SshError)) throw error;
    console.error(`✗ ${error.message}`);
    return 1;
  }
}

/** `bivy restore [app]` (D101): the server found as for bivy exec, then restore.ts. */
async function restore(root: string, app: string | undefined, values: Record<string, string | boolean | undefined>): Promise<number> {
  const instance = loadInstance(root);
  if (!instance.platform) {
    console.error(`No valid platform.yml in ${root}: run bivy from the instance repo, or pass --instance <dir>.`);
    return 1;
  }
  const text = (name: string) => (typeof values[name] === "string" ? (values[name] as string) : undefined);
  const identity = text("ssh-key") ?? join(homedir(), ".ssh", "id_ed25519");
  const knownHosts = config("known_hosts");
  if (!existsSync(identity)) {
    console.error(`No SSH key at ${identity}: pass the right one with --ssh-key <file>.`);
    return 1;
  }
  if (!existsSync(knownHosts)) {
    console.error(`No known host key for the platform in ${knownHosts}: without it, nothing proves the server is ours (runbook section 8).`);
    return 1;
  }
  let host: string;
  try {
    host = await serverAddress(instance.platform.domain, resolve4);
  } catch (error) {
    if (!(error instanceof SshError)) throw error;
    console.error(`✗ ${error.message}`);
    return 1;
  }
  const tty = interactive();
  const progress = new TerminalProgress(tty);
  const ssh = new SshRemote(host, identity, knownHosts);
  return restoreCommand(
    {
      apps: instance.apps,
      progress,
      log: progress.log,
      guide: tty ? progress.around(terminalGuide) : undefined,
      typed: tty
        ? async (message) => {
            progress.pause();
            const answer = await prompts.text({ message });
            return prompts.isCancel(answer) ? "" : (answer ?? "");
          }
        : undefined,
      remote: {
        run: (command) => ssh.run(command, { timeoutMs: 15 * 60_000 }),
        stream: async (command, onLine) => {
          // Ctrl-C: said, never acted on. The restore runs on the server, whose ssh is out of the keyboard's reach.
          const refuse = () => progress.log("  A restore cannot be stopped halfway: it carries on on the server. Wait for its end.");
          process.on("SIGINT", refuse);
          try {
            return await streamSsh(host, identity, knownHosts, command, onLine);
          } finally {
            process.off("SIGINT", refuse);
          }
        },
      },
    },
    { app, snapshot: text("snapshot"), before: text("before"), only: text("only"), plan: values.plan === true },
  );
}

/** The server, found and checked as for bivy exec; undefined after saying why it cannot be reached. */
async function server(root: string, sshKey: string | undefined): Promise<{ host: string; identity: string; knownHosts: string; domain: string } | undefined> {
  const instance = loadInstance(root);
  if (!instance.platform) {
    console.error(`No valid platform.yml in ${root}: run bivy from the instance repo, or pass it (bivy status <dir>).`);
    return undefined;
  }
  const identity = sshKey ?? join(homedir(), ".ssh", "id_ed25519");
  const knownHosts = config("known_hosts");
  if (!existsSync(identity)) {
    console.error(`No SSH key at ${identity}: pass the right one with --ssh-key <file>.`);
    return undefined;
  }
  if (!existsSync(knownHosts)) {
    console.error(`No known host key for the platform in ${knownHosts}: without it, nothing proves the server is ours (runbook section 8).`);
    return undefined;
  }
  try {
    return { host: await serverAddress(instance.platform.domain, resolve4), identity, knownHosts, domain: instance.platform.domain };
  } catch (error) {
    if (!(error instanceof SshError)) throw error;
    console.error(`✗ ${error.message}`);
    return undefined;
  }
}

/** `bivy status` (D104): only reads. */
async function status(root: string, sshKey: string | undefined, json: boolean): Promise<number> {
  const target = await server(root, sshKey);
  if (!target) return 1;
  try {
    const result = new SshRemote(target.host, target.identity, target.knownHosts).run(reconcilerCommand("status"), { timeoutMs: 60_000 });
    const state = readState(result);
    if (json) {
      console.log(JSON.stringify(state, null, 2));
      return 0;
    }
    const { lines, problems } = describeState(state);
    console.log(lines.join("\n"));
    console.log("");
    if (problems.length === 0) {
      console.log("✓ Nothing to look at.");
      return 0;
    }
    console.log(`✗ ${problems.length} thing${problems.length > 1 ? "s" : ""} to look at:`);
    for (const problem of problems) console.log(`  · ${problem}`);
    return 1;
  } catch (error) {
    if (!(error instanceof StatusError) && !(error instanceof RemoteError)) throw error;
    console.error(`✗ ${error.message}`);
    return 1;
  }
}

/** `bivy backup` (D104): asks the running reconciler for a backup now, and follows it. */
async function backup(root: string, sshKey: string | undefined, restoreTest: boolean): Promise<number> {
  const target = await server(root, sshKey);
  if (!target) return 1;
  // Ctrl-C leaves bivy only: the backup runs in the reconciler, on the server.
  const leave = () => {
    console.log("\n  The backup carries on on the server: bivy status shows how it ended.");
    process.exit(130);
  };
  process.on("SIGINT", leave);
  try {
    const result = await streamSsh(target.host, target.identity, target.knownHosts, reconcilerCommand("backup-now", restoreTest ? ["--restore-test"] : []), (text) => {
      const line = parseLines(text)[0];
      const sentence = line ? backupStep(line) : undefined;
      if (sentence) console.log(`· ${sentence}`);
    });
    if (result.status === 0) return 0;
    if (result.status === TOO_OLD) console.error("✗ The server's reconciler is older than this command: move it to a newer version first (runbook section 8).");
    else if (result.status === 255) console.error(`✗ The connection was lost (${result.stderr.trim().split("\n").at(-1) ?? "ssh failed"}). A backup already started carries on: bivy status shows how it ended.`);
    return 1;
  } finally {
    process.off("SIGINT", leave);
  }
}

/** `bivy login-link <user>` (D107): login-link.ts, with the server found as for bivy status. */
function loginLinkCli(login: string | undefined, root: string, sshKey: string | undefined): Promise<number> {
  return loginLink(login, {
    interactive: interactive(),
    server: async () => {
      const target = await server(root, sshKey);
      if (!target) return undefined;
      const ssh = new SshRemote(target.host, target.identity, target.knownHosts);
      return {
        domain: target.domain,
        run: (command) => {
          try {
            return ssh.run(command, { timeoutMs: 60_000 });
          } catch (error) {
            if (!(error instanceof RemoteError)) throw error;
            return { status: 255, stdout: "", stderr: error.message };
          }
        },
      };
    },
    show: (text) => console.log(text),
    error: (text) => console.error(text),
  });
}

/** `bivy secret set <path> [dir]` (D108): one value changed, checked, nothing committed. */
async function secret(args: string[], valueFile: string | undefined, ageKey: string | undefined): Promise<number> {
  const [action, path, directory = "."] = args;
  if (action !== "set" || !path) {
    console.error(`Usage: bivy secret set <path> [dir]. Paths: ${Object.keys(SETTABLE).join(", ")}.`);
    return 1;
  }
  const root = resolve(directory);
  const keyFile = ageKey ?? join(homedir(), ".config", "sops", "age", "keys.txt");
  try {
    if (!Object.hasOwn(REFUSED, path) && Object.hasOwn(SETTABLE, path) && !existsSync(keyFile)) throw new SecretError(`no age key at ${keyFile}: pass the right one with --age-key <file>`);
    const result = await setSecret({
      sops: dockerSops,
      identity: () => instanceIdentity(readFileSync(keyFile, "utf8"), readFileSync(join(root, ".sops.yaml"), "utf8")),
      ask: askSecret,
      // Two values changed one after the other are pushed together: the secrets file may already differ.
      checkout: () => checkoutProblems(root, ["secrets/platform.sops.yaml"]),
      log: console.log,
    }, root, path, valueFile);
    if (!result.changed) {
      console.log(`✓ ${path} already holds that value: nothing was changed.`);
      return 0;
    }
    console.log(`✓ ${path} changed in secrets/platform.sops.yaml; every other value checked unchanged.`);
    console.log("  Nothing is committed: commit and push it from the instance repo.");
    console.log(`  Once pushed: ${result.effect}`);
    return 0;
  } catch (error) {
    if (!(error instanceof SecretError) && !(error instanceof SopsError) && !(error instanceof RebuildError)) throw error;
    console.error(`✗ ${error.message}`);
    if (valueFile && existsSync(valueFile)) console.error(`  The value is still in ${resolve(valueFile)}: run this again once fixed, or delete it.`);
    return 1;
  }
}

const config = (file: string) => join(homedir(), ".config", "bivouac", file);

/** Hidden input, for a person at a terminal only: a script is never asked (D93). */
const askSecret: AskSecret | undefined = process.stdin.isTTY && process.stdout.isTTY
  ? async (message) => {
      const answer = await prompts.password({ message });
      return prompts.isCancel(answer) ? undefined : answer;
    }
  : undefined;

const HETZNER_HINT = "bivy needs a Hetzner API token (Read & Write) of the platform's project: Hetzner Console → the project → Security → API tokens.";

/** The Hetzner token, asked for the first time; undefined (after saying why) when it cannot be had. */
async function hetznerToken(path: string | undefined): Promise<string | undefined> {
  try {
    return await credential({ path: path ?? config("hetzner-token"), what: "the Hetzner token", hint: HETZNER_HINT }, askSecret);
  } catch (error) {
    if (!(error instanceof CredentialError)) throw error;
    console.error(`✗ ${error.message}`);
    return undefined;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
