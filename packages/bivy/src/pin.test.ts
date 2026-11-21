import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PinError, findImageLine, pin, replaceImage, tagFor } from "./pin.js";

const OLD_RECONCILER = `ghcr.io/owner/bivouac-reconciler:sha-1111111@sha256:${"a".repeat(64)}`;
const OLD_STATUS = `ghcr.io/owner/bivouac-status:sha-2222222@sha256:${"b".repeat(64)}`;

const PLATFORM = `# The platform's base domain.
domain: apps.example.org

# Exact version (D61): a tag can be published again.
reconciler:
  image: ${OLD_RECONCILER}   # kept

# Status page (D96).
status:
  # same publisher
  image: "${OLD_STATUS}"
  groups: [admins]

apps:
  image: ghcr.io/owner/bivouac-reconciler:not-this-one
`;

const INDEX = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] });
const DIGEST = `sha256:${createHash("sha256").update(INDEX).digest("hex")}`;

interface Registry {
  /** repository → tag → manifest body */
  images: Record<string, Record<string, string>>;
  header?: string;
  type?: string;
}

/** A fake GHCR: anonymous tokens for the repositories it holds, manifests by tag. */
function registry({ images, header, type = "application/vnd.oci.image.index.v1+json" }: Registry) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url: url.href, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.pathname === "/token") {
      const repository = /^repository:(.+):pull$/.exec(url.searchParams.get("scope") ?? "")?.[1] ?? "";
      if (!images[repository]) return new Response(JSON.stringify({ errors: [{ code: "DENIED" }] }), { status: 403 });
      return Response.json({ token: `token-${repository}` });
    }
    const match = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(url.pathname);
    const repository = match?.[1] ?? "";
    if ((init?.headers as Record<string, string>)?.Authorization !== `Bearer token-${repository}`) return new Response("", { status: 401 });
    const body = images[repository]?.[match?.[2] ?? ""];
    if (body === undefined) return new Response("", { status: 404 });
    const digest = header ?? `sha256:${createHash("sha256").update(body).digest("hex")}`;
    return new Response(body, { status: 200, headers: { "content-type": type, "docker-content-digest": digest } });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

function run(fake: ReturnType<typeof registry>, part: string | undefined, commit: string | undefined, validate = () => 0, text = PLATFORM) {
  const file = { text, writes: 0 };
  const lines: string[] = [];
  const result = pin(
    {
      read: () => file.text,
      write: (value) => {
        file.text = value;
        file.writes++;
      },
      fetch: fake.fetch,
      validate: () => validate(),
      log: (line) => lines.push(line),
    },
    part,
    commit,
  );
  return result.then((code) => ({ code, file, output: lines.join("\n") }));
}

describe("bivy pin", () => {
  it("names CI's tag from any spelling of the commit, and refuses what is not one", () => {
    expect(tagFor("4A764E9f00d1e2")).toBe("sha-4a764e9");
    expect(tagFor("sha-4a764e9")).toBe("sha-4a764e9");
    expect(() => tagFor("main")).toThrow(PinError);
    expect(() => tagFor("4a76")).toThrow(PinError);
  });

  it("finds the image line of the right block only, with its owner", () => {
    expect(findImageLine(PLATFORM, "reconciler")).toEqual({ index: 5, value: OLD_RECONCILER, owner: "owner" });
    expect(findImageLine(PLATFORM, "status")).toMatchObject({ index: 10, value: OLD_STATUS });
    expect(() => findImageLine("domain: x\n", "status")).toThrow(/runbook section 17/);
    expect(() => findImageLine("reconciler:\n  image: docker.io/someone/bivouac-reconciler:1\n", "reconciler")).toThrow(/platform's own image/);
    expect(() => findImageLine("reconciler:\n  image: ghcr.io/owner/other:1\n", "reconciler")).toThrow(/platform's own image/);
  });

  it("changes that one value, keeping comments, quotes and layout", () => {
    const changed = replaceImage(PLATFORM, findImageLine(PLATFORM, "status"), "ghcr.io/owner/bivouac-status:sha-3333333@sha256:c");
    expect(changed).toBe(PLATFORM.replace(OLD_STATUS, "ghcr.io/owner/bivouac-status:sha-3333333@sha256:c"));
  });

  it("pins the reconciler by the digest of the bytes GHCR serves, under the same owner", async () => {
    const fake = registry({ images: { "owner/bivouac-reconciler": { "sha-4a764e9": INDEX } } });
    const { code, file, output } = await run(fake, "reconciler", "4a764e9d1e2f");
    expect(code).toBe(0);
    const image = `ghcr.io/owner/bivouac-reconciler:sha-4a764e9@${DIGEST}`;
    expect(file.text).toBe(PLATFORM.replace(`image: ${OLD_RECONCILER}   # kept`, `image: ${image}   # kept`));
    expect(output).toContain(`was  ${OLD_RECONCILER}`);
    expect(output).toContain(`now  ${image}`);
    expect(output).toMatch(/Nothing is committed or pushed/);
    expect(output).toMatch(/way back/);
    // Anonymous: no credential is ever sent but the registry's own pull token.
    expect(fake.requests[0]?.url).toBe("https://ghcr.io/token?service=ghcr.io&scope=repository%3Aowner%2Fbivouac-reconciler%3Apull");
    expect(fake.requests[1]?.headers.Accept).toContain("application/vnd.oci.image.index.v1+json");
  });

  it("pins the status page, keeping its quotes", async () => {
    const fake = registry({ images: { "owner/bivouac-status": { "sha-4a764e9": INDEX } } });
    const { code, file } = await run(fake, "status", "4a764e9");
    expect(code).toBe(0);
    expect(file.text).toContain(`  image: "ghcr.io/owner/bivouac-status:sha-4a764e9@${DIGEST}"\n  groups: [admins]`);
    expect(file.text).toContain(`image: ${OLD_RECONCILER}`);
  });

  it("changes nothing when the tag does not exist, or the package is not public", async () => {
    const missingTag = await run(registry({ images: { "owner/bivouac-reconciler": {} } }), "reconciler", "4a764e9");
    expect(missingTag.code).toBe(1);
    expect(missingTag.output).toMatch(/No sha-4a764e9 .*CI has not published/);
    expect(missingTag.file.writes).toBe(0);
    const noPackage = await run(registry({ images: {} }), "reconciler", "4a764e9");
    expect(noPackage.output).toMatch(/no access to owner\/bivouac-reconciler/);
    expect(noPackage.file.writes).toBe(0);
  });

  it("refuses a registry whose header disagrees with what it sent, or what is not an image", async () => {
    const lying = await run(registry({ images: { "owner/bivouac-reconciler": { "sha-4a764e9": INDEX } }, header: `sha256:${"0".repeat(64)}` }), "reconciler", "4a764e9");
    expect(lying.code).toBe(1);
    expect(lying.output).toMatch(/but what it sent is/);
    expect(lying.file.writes).toBe(0);
    const notImage = await run(registry({ images: { "owner/bivouac-reconciler": { "sha-4a764e9": INDEX } }, type: "text/html" }), "reconciler", "4a764e9");
    expect(notImage.output).toMatch(/not an image/);
  });

  it("puts the file back when the instance is no longer valid, or validation fails", async () => {
    const fake = registry({ images: { "owner/bivouac-reconciler": { "sha-4a764e9": INDEX } } });
    const invalid = await run(fake, "reconciler", "4a764e9", () => 1);
    expect(invalid.code).toBe(1);
    expect(invalid.file.text).toBe(PLATFORM);
    expect(invalid.output).toMatch(/back as it was/);
    const thrown = { text: PLATFORM };
    await expect(
      pin({ read: () => thrown.text, write: (value) => (thrown.text = value), fetch: fake.fetch, validate: () => { throw new Error("docker missing"); }, log: () => {} }, "reconciler", "4a764e9"),
    ).rejects.toThrow("docker missing");
    expect(thrown.text).toBe(PLATFORM);
  });

  it("says when there is nothing to change, and asks what is missing", async () => {
    const image = `ghcr.io/owner/bivouac-reconciler:sha-4a764e9@${DIGEST}`;
    const fake = registry({ images: { "owner/bivouac-reconciler": { "sha-4a764e9": INDEX } } });
    const same = await run(fake, "reconciler", "4a764e9", () => 1, PLATFORM.replace(OLD_RECONCILER, image));
    expect(same.code).toBe(0);
    expect(same.file.writes).toBe(0);
    expect((await run(fake, "postgres", "4a764e9")).output).toMatch(/Which image/);
    expect((await run(fake, "reconciler", undefined)).output).toMatch(/Which version/);
  });
});
