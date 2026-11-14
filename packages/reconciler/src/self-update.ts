import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { reconcilerImageSchema } from "@bivouac/manifest";
import { writeIfChanged } from "./base.js";
import type { Observation } from "./alerts.js";
import type { Docker } from "./docker.js";

/**
 * The reconciler moves itself to the version named in the instance repo's
 * `platform.yml` (D50):
 *
 *   1. the systemd unit placed by Ignition runs the image named by
 *      `BIVOUAC_RECONCILER_IMAGE`: the version installed with the server,
 *      overridden by `image.env` in the state directory once written;
 *   2. when `platform.yml` names another version, the reconciler pulls it,
 *      checks that it starts (`main.js selftest`, without network or
 *      mounts), writes `image.env` and exits;
 *   3. systemd starts it again (`Restart=always`), on the new image.
 *
 * The version is read on its own, BEFORE the rest of the instance is
 * validated: an older reconciler that does not understand a newer field
 * would otherwise refuse every commit, including its own update.
 *
 * A new version is on trial until its first pass that applies cleanly
 * (D61). Before writing `image.env`, the reconciler writes `trial.env`
 * (the new version and the one it leaves). The host script
 * `/opt/bivouac/reconciler-trial`, run by systemd before each start, counts
 * the starts of a version on trial; at the fourth, it writes the previous
 * version back to `image.env` and the failed one to `refused.env`. The
 * previous version reads `refused.env` and does not move to that version
 * again until `platform.yml` names another one. A version that crashes after
 * its first pass is not rolled back: the heartbeat reports it (D45).
 */

/** Read by the systemd unit (`EnvironmentFile=`), relative to the state directory. */
export const IMAGE_ENV_FILE = join("reconciler", "image.env");
/** The version on trial and the one it replaced, written before `image.env`. */
export const TRIAL_FILE = join("reconciler", "trial.env");
/** Starts of the version on trial, counted by the host script. */
export const TRIAL_STARTS_FILE = join("reconciler", "trial.starts");
/** A version the host script rolled back from, written by that script. */
export const REFUSED_FILE = join("reconciler", "refused.env");

const DIGEST = /@sha256:[a-f0-9]{64}$/;

/** The value of `KEY=value` in an env file, without sourcing it. */
function envValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return undefined;
}

/** The repository part of an image reference, without tag or digest. */
export function imageRepository(image: string): string {
  return image.replace(/@sha256:[a-f0-9]{64}$/, "").replace(/:[^/:]*$/, "");
}

/**
 * The reconciler image named in `platform.yml`, read on its own. Undefined
 * when absent or invalid: validation of the whole instance reports why.
 */
export function readDesiredImage(checkout: string): string | undefined {
  const path = join(checkout, "platform.yml");
  if (!existsSync(path)) return undefined;
  let document: unknown;
  try {
    document = parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  const image = (document as { reconciler?: { image?: unknown } } | null)?.reconciler?.image;
  const parsed = reconcilerImageSchema.safeParse(image);
  return parsed.success ? parsed.data : undefined;
}

export interface SelfUpdateOptions {
  docker: Docker;
  stateDir: string;
  /** The image this reconciler runs, given by the systemd unit. */
  current: string;
  /** Pulls an image, with registry credentials when needed. */
  pull: (image: string) => Promise<void>;
  log: (message: string, fields?: Record<string, unknown>) => void;
}

/** Name of the throwaway container that runs a new version's self-test. */
export const SELFTEST_CONTAINER = "bivouac-reconciler-selftest";

export class SelfUpdater {
  /** Versions that failed, with why, not retried until platform.yml names another one (like D21). */
  private readonly refused = new Map<string, string>();
  /** The version platform.yml named on the last check. */
  private desired: string | undefined;

  constructor(private readonly options: SelfUpdateOptions) {
    const path = join(options.stateDir, REFUSED_FILE);
    const image = envValue(path, "BIVOUAC_REFUSED_IMAGE");
    if (image === options.current) {
      // Moved back by hand to the version once rolled back from: nothing to report.
      rmSync(path, { force: true });
    } else if (image) {
      const reason = `it crashed at start, and the server went back to ${options.current}`;
      this.refused.set(image, reason);
      options.log("a new reconciler version crashed at start: rolled back", { current: options.current, refused: image });
    }
  }

  /**
   * Returns the new image once `image.env` names it: the caller must then
   * exit so systemd restarts it. Returns undefined when there is nothing to
   * do or the new version was refused (logged once).
   */
  async check(checkout: string): Promise<string | undefined> {
    const { current, log, stateDir } = this.options;
    const desired = readDesiredImage(checkout);
    this.desired = desired;
    // platform.yml moved on from a version rolled back by the host: forget it.
    const rolledBack = envValue(join(stateDir, REFUSED_FILE), "BIVOUAC_REFUSED_IMAGE");
    if (desired && rolledBack !== undefined && rolledBack !== desired) rmSync(join(stateDir, REFUSED_FILE), { force: true });
    if (!desired || desired === current || this.refused.has(desired)) return undefined;

    // Whoever can merge into the instance repo chooses this image, which
    // gets the Docker socket: never move to another publisher's image.
    if (imageRepository(desired) !== imageRepository(current)) {
      this.refuse(desired, `it is not published as ${imageRepository(current)}`);
      return undefined;
    }
    // Once pinned by digest, never unpinned (D61): `bivy validate` requires
    // the digest, but a push to main can skip CI (D64). Tags alone stay
    // accepted from a version that has none (older servers, tests).
    if (DIGEST.test(current) && !DIGEST.test(desired)) {
      this.refuse(desired, "it is not pinned by digest (…@sha256:<digest>)");
      return undefined;
    }

    log("moving to a new reconciler version", { from: current, to: desired });
    try {
      if (!(await this.options.docker.imageExists(desired))) await this.options.pull(desired);
      await this.selftest(desired);
    } catch (error) {
      this.refuse(desired, (error as Error).message);
      return undefined;
    }
    // The trial first: if the new version never gets through a pass, the
    // host script knows where to go back to. A stale count never carries over.
    // A version still on trial is not a version to go back to: keep the
    // one that last proved itself.
    const trialFile = join(stateDir, TRIAL_FILE);
    const unproven = envValue(trialFile, "BIVOUAC_TRIAL_IMAGE") === current;
    const previous = (unproven && envValue(trialFile, "BIVOUAC_PREVIOUS_IMAGE")) || current;
    rmSync(join(stateDir, TRIAL_STARTS_FILE), { force: true });
    writeIfChanged(trialFile, `BIVOUAC_TRIAL_IMAGE=${desired}\nBIVOUAC_PREVIOUS_IMAGE=${previous}\n`, 0o600);
    writeIfChanged(join(stateDir, IMAGE_ENV_FILE), `BIVOUAC_RECONCILER_IMAGE=${desired}\n`, 0o600);
    return desired;
  }

  /**
   * Called after a pass that did not end in a move: the running version
   * started and got through a pass without crashing, and the host no longer
   * counts its starts. Passes that fail are reported by the alerts (D45);
   * the trial only covers versions that cannot stay up.
   */
  confirm(): void {
    const { stateDir, current, log } = this.options;
    const trial = join(stateDir, TRIAL_FILE);
    if (!existsSync(trial)) return;
    const image = envValue(trial, "BIVOUAC_TRIAL_IMAGE");
    rmSync(trial, { force: true });
    rmSync(join(stateDir, TRIAL_STARTS_FILE), { force: true });
    if (image === current) log("new reconciler version confirmed", { image: current });
  }

  /** A version platform.yml names but this server refused: reported until platform.yml changes. */
  observation(): Observation {
    const reason = this.desired ? this.refused.get(this.desired) : undefined;
    return {
      incidents: reason ? [{ key: `reconciler:${this.desired}`, message: `The new reconciler version ${this.desired} was refused: ${reason}` }] : [],
      checked: ["reconciler"],
    };
  }

  private refuse(image: string, reason: string): void {
    this.refused.set(image, reason);
    this.options.log("new reconciler version refused: staying on the current one", {
      current: this.options.current,
      refused: image,
      reason,
    });
  }

  /**
   * Starts the new image once with `main.js selftest`: no network, no
   * mount, no capability. It proves the image runs and finds its tools,
   * not that a whole pass works.
   */
  private async selftest(image: string): Promise<void> {
    const { docker } = this.options;
    await docker.removeContainer(SELFTEST_CONTAINER);
    await docker.createContainer(SELFTEST_CONTAINER, {
      Image: image,
      Cmd: ["node", "packages/reconciler/dist/main.js", "selftest"],
      HostConfig: { NetworkMode: "none", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] },
    });
    try {
      await docker.startContainer(SELFTEST_CONTAINER);
      const exitCode = await docker.waitContainer(SELFTEST_CONTAINER);
      if (exitCode !== 0) {
        const output = (await docker.logs(SELFTEST_CONTAINER)).trim().split("\n").pop() ?? "";
        throw new Error(`its self-test failed (exit code ${exitCode}): ${output.slice(0, 300)}`);
      }
    } finally {
      await docker.removeContainer(SELFTEST_CONTAINER);
    }
  }
}
