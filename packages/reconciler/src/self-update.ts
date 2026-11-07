import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { reconcilerImageSchema } from "@bivouac/manifest";
import { writeIfChanged } from "./base.js";
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
 * Accepted limitation (MVP, D50): a new version that passes the self-test
 * but fails later cannot roll itself back. Apps keep running; the fix is
 * to remove `image.env` over SSH, which falls back to the installed version.
 */

/** Read by the systemd unit (`EnvironmentFile=`), relative to the state directory. */
export const IMAGE_ENV_FILE = join("reconciler", "image.env");

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
  /** Versions that failed, not retried until platform.yml names another one (like D21). */
  private readonly refused = new Set<string>();

  constructor(private readonly options: SelfUpdateOptions) {}

  /**
   * Returns the new image once `image.env` names it: the caller must then
   * exit so systemd restarts it. Returns undefined when there is nothing to
   * do or the new version was refused (logged once).
   */
  async check(checkout: string): Promise<string | undefined> {
    const { current, log } = this.options;
    const desired = readDesiredImage(checkout);
    if (!desired || desired === current || this.refused.has(desired)) return undefined;

    // Whoever can merge into the instance repo chooses this image, which
    // gets the Docker socket: never move to another publisher's image.
    if (imageRepository(desired) !== imageRepository(current)) {
      this.refuse(desired, `it is not published as ${imageRepository(current)}`);
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
    writeIfChanged(join(this.options.stateDir, IMAGE_ENV_FILE), `BIVOUAC_RECONCILER_IMAGE=${desired}\n`, 0o600);
    return desired;
  }

  private refuse(image: string, reason: string): void {
    this.refused.add(image);
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
