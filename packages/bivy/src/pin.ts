// `bivy pin reconciler|status <commit>` (D106): moves one platform image to
// the version CI published for a commit, pinned by the digest of what the
// registry serves for its tag, as `docker buildx imagetools inspect` reports it.
// Written with the release tag of the same digest (`v1.0.<n>`), the one
// Renovate orders in the instance repo (D109).
import { createHash } from "node:crypto";

export class PinError extends Error {}

export type Part = "reconciler" | "status";

/** The package each part names, under the owner already in platform.yml. */
const PACKAGES: Record<Part, string> = { reconciler: "bivouac-reconciler", status: "bivouac-status" };

/**
 * What a tag may point to. CI pushes a multi-architecture index; a plain
 * manifest is taken as imagetools would take it, its own digest then.
 */
const MEDIA_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];

/** CI tags each image `sha-<first 7 characters of the commit>` (ci.yml). */
export function tagFor(commit: string): string {
  const bare = commit.trim().toLowerCase().replace(/^sha-/, "");
  if (!/^[0-9a-f]{7,40}$/.test(bare)) {
    throw new PinError(`'${commit}' is not a commit: give its hash (at least 7 characters), as in git log.`);
  }
  return `sha-${bare.slice(0, 7)}`;
}

export interface ImageLine {
  /** Index of the line in the file. */
  index: number;
  /** The image as written, without quotes. */
  value: string;
  /** Owner on GHCR, read from the value. */
  owner: string;
}

const IMAGE_LINE = /^(\s+image:\s*)(["']?)([^"'\s#]+)\2(\s*(?:#.*)?)$/;

/**
 * The `image:` line of the top-level `reconciler:` or `status:` block, found
 * as text: the file is never re-serialized (D48), so comments and layout stay.
 */
export function findImageLine(text: string, part: Part): ImageLine {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^${part}:\\s*(#.*)?$`).test(line));
  if (start === -1) {
    throw new PinError(
      part === "status"
        ? "platform.yml has no status block: turning the status page on is runbook section 17, then bivy pin moves it."
        : "platform.yml has no reconciler block.",
    );
  }
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^\S/.test(line) && !line.startsWith("#")) break; // the next top-level key
    const match = IMAGE_LINE.exec(line);
    if (!match) continue;
    const value = match[3] ?? "";
    const image = new RegExp(`^ghcr\\.io/([a-z0-9][a-z0-9-]*)/${PACKAGES[part]}[:@]`).exec(value);
    if (!image) {
      throw new PinError(`${part}.image is '${value}', not ghcr.io/<owner>/${PACKAGES[part]}: bivy pin only moves the platform's own image.`);
    }
    return { index, value, owner: image[1] ?? "" };
  }
  throw new PinError(`platform.yml has no ${part}.image line bivy can read (one line, 'image: <value>').`);
}

/** The file with only that line's value changed. */
export function replaceImage(text: string, line: ImageLine, image: string): string {
  const lines = text.split("\n");
  lines[line.index] = (lines[line.index] ?? "").replace(IMAGE_LINE, (_all, before: string, quote: string, _old: string, after: string) => `${before}${quote}${image}${quote}${after}`);
  return lines.join("\n");
}

type Fetch = typeof globalThis.fetch;

/**
 * An anonymous pull token for a repository on GHCR: the packages are public,
 * so no credential of the owner is ever sent.
 */
async function pullToken(fetch: Fetch, repository: string): Promise<string> {
  const tokenResponse = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${repository}:pull`)}`, { signal: AbortSignal.timeout(30_000) });
  if (!tokenResponse.ok) {
    throw new PinError(`GHCR gives no access to ${repository} (${tokenResponse.status}): the package does not exist, or it is not public.`);
  }
  const body = (await tokenResponse.json()) as { token?: string; access_token?: string };
  const token = body.token ?? body.access_token;
  if (!token) throw new PinError("GHCR answered without a token.");
  return token;
}

/**
 * The digest of what GHCR serves for a tag, hashed here so the digest is the
 * one of the bytes received, and checked against the registry's header.
 * Undefined when the tag does not exist.
 */
async function manifestDigest(fetch: Fetch, token: string, repository: string, tag: string): Promise<string | undefined> {
  const response = await fetch(`https://ghcr.io/v2/${repository}/manifests/${tag}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: MEDIA_TYPES.join(", ") },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new PinError(`GHCR answered ${response.status} for ghcr.io/${repository}:${tag}.`);
  const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!MEDIA_TYPES.includes(type)) throw new PinError(`ghcr.io/${repository}:${tag} is not an image (${type || "no media type"}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const header = response.headers.get("docker-content-digest");
  if (header && header !== digest) {
    throw new PinError(`GHCR says ${header} for ghcr.io/${repository}:${tag}, but what it sent is ${digest}: nothing was changed.`);
  }
  return digest;
}

/** The digest of what GHCR serves for the tag; an error when there is none. */
export async function resolveDigest(fetch: Fetch, owner: string, name: string, tag: string): Promise<string> {
  const repository = `${owner}/${name}`;
  const digest = await manifestDigest(fetch, await pullToken(fetch, repository), repository, tag);
  if (!digest) throw new PinError(`No ${tag} for ghcr.io/${repository}: CI has not published that commit (yet), or it is not a commit of main.`);
  return digest;
}

/** CI also tags each image `v1.0.<run number>` (D109), which Renovate can order. */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
/** Release tags looked at, newest first, before giving up: the one wanted is nearly always the newest. */
const RELEASE_LOOKUPS = 20;

function compareReleases(a: string, b: string): number {
  const left = RELEASE_TAG.exec(a)?.slice(1).map(Number) ?? [];
  const right = RELEASE_TAG.exec(b)?.slice(1).map(Number) ?? [];
  for (let index = 0; index < 3; index++) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The release tag CI pushed with the commit's tag: the `v<x.y.z>` tag whose
 * digest is the same. Undefined for a version published before D109.
 */
export async function findReleaseTag(fetch: Fetch, owner: string, name: string, digest: string): Promise<string | undefined> {
  const repository = `${owner}/${name}`;
  const token = await pullToken(fetch, repository);
  const tags: string[] = [];
  let next: string | undefined = `https://ghcr.io/v2/${repository}/tags/list?n=1000`;
  for (let page = 0; next && page < 20; page++) {
    const response: Response = await fetch(next, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new PinError(`GHCR answered ${response.status} for the tags of ghcr.io/${repository}.`);
    tags.push(...(((await response.json()) as { tags?: string[] | null }).tags ?? []));
    const link = /<([^>]+)>\s*;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
    const following = link ? new URL(link, "https://ghcr.io") : undefined;
    // The pull token only ever goes to GHCR, whatever a page points to.
    if (following && following.origin !== "https://ghcr.io") throw new PinError(`GHCR pointed the next page of tags elsewhere (${following.origin}): nothing was changed.`);
    next = following?.href;
  }
  const releases = tags.filter((tag) => RELEASE_TAG.test(tag)).sort(compareReleases).slice(0, RELEASE_LOOKUPS);
  for (const tag of releases) {
    if ((await manifestDigest(fetch, token, repository, tag)) === digest) return tag;
  }
  return undefined;
}

export interface PinDependencies {
  read: () => string;
  write: (text: string) => void;
  fetch: Fetch;
  /** The same checks as bivy validate; 0 when the instance is valid. */
  validate: () => number;
  log: (line: string) => void;
}

/** Finds the digest, writes the line, validates (or puts the file back), and says the way back. */
export async function pin(dependencies: PinDependencies, part: string | undefined, commit: string | undefined): Promise<number> {
  const { log } = dependencies;
  try {
    if (part !== "reconciler" && part !== "status") throw new PinError("Which image? bivy pin reconciler <commit>, or bivy pin status <commit>.");
    if (!commit) throw new PinError(`Which version? bivy pin ${part} <commit>: a commit of the monorepo's main, whose CI is green.`);
    const tag = tagFor(commit);
    const original = dependencies.read();
    const line = findImageLine(original, part);
    const digest = await resolveDigest(dependencies.fetch, line.owner, PACKAGES[part], tag);
    // Written with its release tag, so Renovate can follow it (D109).
    const release = await findReleaseTag(dependencies.fetch, line.owner, PACKAGES[part], digest);
    const image = `ghcr.io/${line.owner}/${PACKAGES[part]}:${release ?? tag}@${digest}`;
    if (image === line.value) {
      log(`✓ ${part}.image is already ${image}: nothing to change.`);
      return 0;
    }
    dependencies.write(replaceImage(original, line, image));
    let valid = false;
    try {
      valid = dependencies.validate() === 0;
    } finally {
      if (!valid) dependencies.write(original);
    }
    if (!valid) {
      log(`✗ With the new version the instance is not valid (above): platform.yml is back as it was.`);
      return 1;
    }
    log("");
    log(`✓ ${part}.image in platform.yml:`);
    log(`  was  ${line.value}`);
    log(`  now  ${image}`);
    log("");
    if (!release) {
      log(`! ${tag} has no release tag (v<x.y.z>, published from D109 on): Renovate cannot follow`);
      log(`  this version, and leaves ${part}.image alone until a newer one is pinned.`);
    }
    log("Nothing is committed or pushed: the server moves once this change is on main.");
    log(`The way back: write the "was" value back in ${part}.image, then commit and push.`);
    return 0;
  } catch (error) {
    if (!(error instanceof PinError)) {
      if (error instanceof Error && (error.name === "TimeoutError" || error instanceof TypeError)) {
        log(`✗ GHCR could not be reached (${error.message}): nothing was changed.`);
        return 1;
      }
      throw error;
    }
    log(`✗ ${error.message}`);
    return 1;
  }
}
