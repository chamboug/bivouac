import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolve4 } from "node:dns/promises";
import * as prompts from "@clack/prompts";
import { loadInstance } from "@bivouac/manifest";
import { AgeKeyError, keepIdentity, pastedIdentity } from "./agekey.js";
import { CredentialError, credential, readCredential } from "./credentials.js";
import { GitHub, repositoryPath } from "./github.js";
import { Cancelled, type Guide } from "./guide.js";
import { Hetzner } from "./hetzner.js";
import { newHostKey } from "./hostkey.js";
import { RebuildError, cleanup, curlProbe, ignitionFor, instanceIdentity, readState, rebuildTest, unfinishedTest, type TestState } from "./rebuild.js";
import { checkoutProblems, rebuildReal, type RealState } from "./rebuild-real.js";
import { SshRemote, scanHostKey } from "./remote.js";
import { machineSshKey } from "./ssh-key.js";
import { TerminalProgress, duration, interactive, onInterrupt, terminalGuide } from "./terminal.js";

/**
 * `bivy rebuild` and `bivy rebuild --test`, guided (D93): what the terminal
 * adds around rebuild.ts and rebuild-real.ts. With a person at the terminal,
 * each choice is a question; without one (a script, Claude), each has a
 * flag or a safe default, and nothing that erases is ever confirmed.
 */

type Values = Record<string, string | boolean | undefined>;

const config = (file: string) => join(homedir(), ".config", "bivouac", file);
const DEFAULT_AGE_KEY = join(homedir(), ".config", "sops", "age", "keys.txt");
const DEFAULT_GITHUB_TOKEN = config("github-rebuild-token");

/** One run's way of talking: a guide only when a person is at the terminal. */
function terminal() {
  const tty = interactive();
  const progress = new TerminalProgress(tty);
  const guide: Guide | undefined = tty ? progress.around(terminalGuide) : undefined;
  return { tty, progress, guide, log: progress.log };
}

/**
 * The age key, found before anything is rented or erased: the file given,
 * SOPS's own file, or pasted from the password manager and checked against
 * the instance's .sops.yaml. Kept in memory for the run; written to disk
 * only if the person says so.
 */
function ageKeySource(root: string, given: string | undefined, guide: Guide | undefined, log: (message: string) => void) {
  let identity: Buffer | undefined;
  const sops = () => readFileSync(join(root, ".sops.yaml"), "utf8");
  const path = given ?? DEFAULT_AGE_KEY;
  const fromFile = () => instanceIdentity(readFileSync(path, "utf8"), sops());
  return {
    prepare: async () => {
      if (identity) return;
      if (given || existsSync(path)) {
        identity = fromFile();
        return;
      }
      if (!guide) throw new RebuildError(`no age key in ${path}: pass --age-key <file>, or run in a terminal to paste it`);
      log(`The age key is not in ${path}. Copy it from your password manager: it starts with AGE-SECRET-KEY-1.`);
      const pasted = await guide.secret("The age key (hidden as you type, or paste it):");
      if (!pasted) throw new RebuildError("no age key given: nothing was done");
      try {
        identity = pastedIdentity(pasted, sops());
      } catch (error) {
        if (error instanceof AgeKeyError) throw new RebuildError(error.message);
        throw error;
      }
      log("  it is the key of this instance's secrets");
      const keep = await guide.select("Keep the age key on this computer?", [
        { value: "once", label: "Use it for this run only (recommended on a computer that is not yours)" },
        { value: "keep", label: `Keep it in ${path}, where SOPS looks for it`, hint: "readable by you only; needed to edit the instance's secrets here" },
      ]);
      if (keep === "keep") {
        keepIdentity(path, identity);
        log(`  kept in ${path}`);
      }
    },
    get: (): Buffer => {
      identity ??= fromFile();
      return identity;
    },
  };
}

/** The typed confirmation of a real rebuild: a person at a terminal only, never a pipe or a script (rule 5). */
async function typed(question: string, progress: TerminalProgress): Promise<string> {
  if (!interactive()) throw new RebuildError("a rebuild is confirmed by typing in a terminal: none here");
  progress.pause();
  const answer = await prompts.text({ message: question.trim() });
  if (prompts.isCancel(answer)) throw new Cancelled();
  return answer ?? "";
}

const asText = (values: Values) => (name: string) => (typeof values[name] === "string" ? (values[name] as string) : undefined);

export async function rebuildCommand(root: string, values: Values, hetznerToken: (path: string | undefined) => Promise<string | undefined>): Promise<number> {
  return values.test ? testRebuild(root, values, hetznerToken) : realRebuild(root, values, hetznerToken);
}

async function testRebuild(root: string, values: Values, hetznerToken: (path: string | undefined) => Promise<string | undefined>): Promise<number> {
  const text = asText(values);
  if (values.plan || values["without-fresh-backup"] || values.abandon) {
    console.error("--plan, --without-fresh-backup and --abandon are for the real 'bivy rebuild' only.");
    return 1;
  }
  const instance = loadInstance(root);
  if (!instance.platform) {
    console.error("platform.yml is invalid: run 'bivy validate' for details.");
    return 1;
  }
  const { platform, apps } = instance;
  const repository = repositoryPath(platform.repository);
  const githubTokenPath = text("github-token") ?? DEFAULT_GITHUB_TOKEN;
  const stateFile = config("rebuild-test.json");
  const knownHosts = config("known_hosts-rebuild-test");
  // --cleanup only deletes through Hetzner's API: no key asked for.
  const identity = values.cleanup ? "" : await machineSshKey(text("ssh-key"));
  if (identity === undefined) return 1;
  const { progress, guide, log } = terminal();

  log(values.cleanup
    ? "Deleting what a rebuild test created: only what carries its label, never the real server."
    : "This builds a temporary copy of your platform from its backups, on a server rented by the hour (about €0.01),\nchecks it against the real one, then deletes it. Your real server is not touched.");
  const hetzner = await hetznerToken(text("hetzner-token"));
  if (!hetzner) return 1;
  const age = ageKeySource(root, text("age-key"), guide, log);
  const github = () => {
    try {
      return new GitHub(readCredential({ path: githubTokenPath, what: "the temporary GitHub token" }), repository);
    } catch (error) {
      if (error instanceof CredentialError) throw new RebuildError(error.message);
      throw error;
    }
  };
  const deps = {
    hetzner: new Hetzner(hetzner),
    github,
    remote: (host: string) => new SshRemote(host, identity, knownHosts),
    scanHostKey,
    newHostKey: () => newHostKey(),
    publicIpv4: async () => {
      const response = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new RebuildError(`api.ipify.org answered HTTP ${response.status}: cannot tell this Mac's IPv4`);
      return (await response.text()).trim();
    },
    ignition: ignitionFor(root),
    ageKey: age.get,
    prepareAgeKey: age.prepare,
    probe: (host: string, address: string, path: string) => curlProbe(host, address, path, true),
    probeReal: (host: string, path: string) => curlProbe(host, undefined, path, false),
    stateFile,
    knownHosts,
    log,
    guide,
    progress,
    sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    now: Date.now,
  };

  const leftBehind = () => existsSync(stateFile)
    ? `The test server may still be running, billed, with a copy of the data: run 'bivy rebuild --test' again to carry on or delete it
(or 'bivy rebuild --test --cleanup' from a script).${existsSync(githubTokenPath) ? `\nThe temporary GitHub token is still in ${githubTokenPath}; it expires within a day.` : ""}`
    : undefined;
  const release = onInterrupt(progress, leftBehind);
  let cleanupOnly = values.cleanup === true;
  try {
    if (!cleanupOnly) {
      const unfinished = await unfinishedTest(deps);
      if (unfinished === "quit") {
        log("Nothing was changed. The unfinished test's server may still be running: run 'bivy rebuild --test' again to carry on or delete it.");
        return 1;
      }
      cleanupOnly = unfinished === "clean up";
    }
    if (!cleanupOnly && !readState<TestState>(stateFile)?.done.includes("deploy key")) {
      // Asked now, before renting anything, rather than halfway through.
      await credential({
        path: githubTokenPath,
        what: "the temporary GitHub token",
        hint: `A temporary GitHub token is needed, to give the test server read access to the instance repo. Create it here (the form is filled in):
  https://github.com/settings/personal-access-tokens/new?name=bivouac-rebuild-test&description=Deploy+key+of+a+rebuild+test&expires_in=1&administration=write
Under "Repository access", choose "Only select repositories" → ${repository}, nothing else. It expires tomorrow; you delete it at the end.`,
      }, guide ? (message) => guide.secret(message) : undefined, log);
    }
    if (!cleanupOnly) {
      const state = await rebuildTest(deps, { root, keep: values.keep === true, location: text("location"), serverType: text("server-type"), snapshot: text("snapshot"), yes: values.yes === true });
      const seconds = Math.round((Date.now() - Date.parse(state.startedAt)) / 1000);
      log(`\n✓ Your platform came back on the test server in ${duration(seconds)}: Pocket ID has the real signing keys${apps.length > 0 ? `, and ${apps.map((app) => app.name).join(", ")} answer${apps.length === 1 ? "s" : ""}` : ""}.`);
      log(`  Steps (seconds): ${JSON.stringify(state.timings)}`);
      if (values.keep) {
        log(`The test server is still running at ${state.ipv4}, billed €${state.hourly}/hour, with a copy of the data. Delete it with: bivy rebuild --test --cleanup`);
        return 0;
      }
    }
    progress.start("Deleting everything the test created");
    const problems = await cleanup(deps, existsSync(githubTokenPath));
    if (problems.length > 0) {
      progress.fail("Some of what the test created is still there");
      console.error(`✗ Clean-up incomplete:\n  ${problems.join("\n  ")}`);
      return 1;
    }
    progress.stop("Everything the test created is deleted", 0);
    const next = new Date(Date.now());
    next.setUTCMonth(next.getUTCMonth() + 3);
    const ownToken = githubTokenPath === DEFAULT_GITHUB_TOKEN && existsSync(githubTokenPath);
    if (ownToken) rmSync(githubTokenPath);
    log(`
What is left for you:
  1. Delete the temporary GitHub token 'bivouac-rebuild-test': https://github.com/settings/personal-access-tokens
     ${ownToken ? "(bivy already deleted its copy on this computer.)" : `(then delete its copy: ${githubTokenPath})`}
  2. Run the next test in three months, around ${next.toISOString().slice(0, 10)} (the platform reminds you, D44).`);
    return 0;
  } catch (error) {
    progress.pause();
    console.error(`✗ ${error instanceof Cancelled ? "Stopped at your request." : (error as Error).message}`);
    // The test server may hold the age key and a full copy of the data.
    const hint = leftBehind();
    if (hint) console.error(hint);
    return 1;
  } finally {
    release();
  }
}

async function realRebuild(root: string, values: Values, hetznerToken: (path: string | undefined) => Promise<string | undefined>): Promise<number> {
  const text = asText(values);
  if (values.keep || values.cleanup || values.yes || text("location") || text("github-token")) {
    console.error("--keep, --cleanup, --yes, --location and --github-token are for 'bivy rebuild --test' only.");
    return 1;
  }
  const instance = loadInstance(root);
  const repository = instance.platform ? repositoryPath(instance.platform.repository) : "<owner>/<instance repo>";
  // --abandon only forgets an unfinished rebuild: no key asked for.
  const identity = values.abandon ? "" : await machineSshKey(text("ssh-key"));
  if (identity === undefined) return 1;
  const knownHosts = config("known_hosts");
  const stateFile = config("rebuild.json");
  const { progress, guide, log } = terminal();
  const plan = values.plan === true;

  if (!plan && !values.abandon) {
    log("This ERASES the platform's server and brings it back from its backups, on the same addresses.\nUse it only when the server is broken or lost; 'bivy rebuild --test' checks the backups without touching anything.");
  }
  const hetzner = await hetznerToken(text("hetzner-token"));
  if (!hetzner) return 1;
  const age = ageKeySource(root, text("age-key"), guide, log);
  const deps = {
    hetzner: new Hetzner(hetzner),
    remote: (host: string) => new SshRemote(host, identity, knownHosts),
    scanHostKey,
    newHostKey: () => newHostKey(),
    ignition: ignitionFor(root),
    ageKey: age.get,
    prepareAgeKey: age.prepare,
    probeReal: (host: string, path: string) => curlProbe(host, undefined, path, false),
    resolve: (name: string) => resolve4(name),
    checkout: () => checkoutProblems(root),
    ask: (question: string) => typed(question, progress),
    stateFile,
    knownHosts,
    log,
    // --plan only reads: no question at all.
    guide: plan ? undefined : guide,
    progress,
    sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    now: Date.now,
  };
  const release = onInterrupt(progress, () => existsSync(stateFile)
    ? "Run 'bivy rebuild' again: it carries on from where it stopped (a step already done is never repeated), and puts the server's protection back first if it was lifted."
    : "Nothing was erased.");
  try {
    if (!values.abandon) log("Looking at your server, its addresses and its backups…");
    const result = await rebuildReal(deps, { root, plan, abandon: values.abandon === true, serverType: text("server-type"), withoutFreshBackup: values["without-fresh-backup"] === true, snapshot: text("snapshot") });
    progress.pause();
    if ("problems" in result) return result.problems.length > 0 ? 1 : 0;
    if ("abandoned" in result) return 0;
    const done: RealState = result;
    log(`
✓ Your platform is back on ${done.ipv4}, with the same addresses and its data.
What is left for you:
  1. Remove the OLD deploy key on GitHub: https://github.com/${repository}/settings/keys
     Keep only 'bivouac-server-${done.run}'.
  2. Tomorrow morning, check on the status page that the night's backup ran (the first one waits for the next night, D74).
The platform's known_hosts from before the rebuild is kept in ${done.knownHostsBackup ?? "(none)"}.`);
    return 0;
  } catch (error) {
    progress.pause();
    console.error(`✗ ${error instanceof Cancelled ? "Stopped at your request." : (error as Error).message}`);
    if (existsSync(stateFile)) console.error("Run 'bivy rebuild' again to carry on from where it stopped: a step already done is never repeated.");
    return 1;
  } finally {
    release();
  }
}
