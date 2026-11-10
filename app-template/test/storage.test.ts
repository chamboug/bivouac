import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertValidKey, diskStorage, MAX_PART_SIZE, MIN_PART_SIZE, s3Storage, type Storage } from "../server/utils/storage";

async function readAll(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const dir = await mkdtemp(join(tmpdir(), "storage-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const modes: [string, Storage | undefined][] = [
  ["disk", diskStorage(dir, 1000)],
  [
    "s3",
    process.env.TEST_S3_BUCKET
      ? s3Storage({
          bucket: process.env.TEST_S3_BUCKET,
          endpoint: process.env.TEST_S3_ENDPOINT,
          accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY,
          minCleanupAge: 1000,
        })
      : undefined,
  ],
];

describe.each(modes)("%s storage", (_name, storage) => {
  it.skipIf(!storage)("stores, reads and deletes a file", async () => {
    const body = new TextEncoder().encode("hello");
    await storage!.put("photos/a/1.txt", body);
    expect(Buffer.from((await storage!.get("photos/a/1.txt"))!).toString()).toBe("hello");
    await storage!.delete("photos/a/1.txt");
    expect(await storage!.get("photos/a/1.txt")).toBeNull();
  });

  it.skipIf(!storage)("answers null for a missing file, and deleting one is harmless", async () => {
    expect(await storage!.get("nothing/here")).toBeNull();
    await expect(storage!.delete("nothing/here")).resolves.toBeUndefined();
  });

  it.skipIf(!storage)("refuses a key leaving the app's directory", async () => {
    await expect(storage!.get("../secret")).rejects.toThrow("Invalid storage key");
    await expect(storage!.put("a/../../b", new Uint8Array())).rejects.toThrow("Invalid storage key");
    await expect(storage!.open("../secret")).rejects.toThrow("Invalid storage key");
    await expect(storage!.createUpload("../b")).rejects.toThrow("Invalid storage key");
  });

  it.skipIf(!storage)("streams a stored file with its size", async () => {
    await storage!.put("stream/a.txt", new TextEncoder().encode("hello"));
    const file = await storage!.open("stream/a.txt");
    expect(file?.size).toBe(5);
    expect((await readAll(file!.body)).toString()).toBe("hello");
    expect(await storage!.open("stream/none")).toBeNull();
    await storage!.delete("stream/a.txt");
  });

  it.skipIf(!storage)("joins a file sent in parts, in order", async () => {
    const first = new Uint8Array(MIN_PART_SIZE).fill(1);
    const second = new Uint8Array(MIN_PART_SIZE).fill(2);
    const last = new TextEncoder().encode("end");
    const id = await storage!.createUpload("big/book.pdf");
    // Out of order, and part 2 sent twice: the second one wins.
    const tag3 = await storage!.uploadPart("big/book.pdf", id, 3, last);
    await storage!.uploadPart("big/book.pdf", id, 2, new Uint8Array(MIN_PART_SIZE).fill(9));
    const tag2 = await storage!.uploadPart("big/book.pdf", id, 2, second);
    const tag1 = await storage!.uploadPart("big/book.pdf", id, 1, first);
    expect(await storage!.open("big/book.pdf")).toBeNull();
    expect(await storage!.completeUpload("big/book.pdf", id, [tag1, tag2, tag3])).toBe(2 * MIN_PART_SIZE + 3);
    const content = await readAll((await storage!.open("big/book.pdf"))!.body);
    expect(content.length).toBe(2 * MIN_PART_SIZE + 3);
    expect(content[0]).toBe(1);
    expect(content[MIN_PART_SIZE]).toBe(2);
    expect(content.subarray(-3).toString()).toBe("end");
    await storage!.delete("big/book.pdf");
  });

  it.skipIf(!storage)("refuses a missing part or a small part before the last", async () => {
    await storage!.delete("big/holes.pdf");
    const id = await storage!.createUpload("big/holes.pdf");
    const tag1 = await storage!.uploadPart("big/holes.pdf", id, 1, new Uint8Array(10));
    const tag2 = await storage!.uploadPart("big/holes.pdf", id, 2, new Uint8Array(10));
    await expect(storage!.completeUpload("big/holes.pdf", id, [tag1, tag2])).rejects.toThrow();
    await expect(storage!.uploadPart("big/holes.pdf", id, 0, new Uint8Array(1))).rejects.toThrow("Invalid part number");
    await storage!.abortUpload("big/holes.pdf", id);
    expect(await storage!.open("big/holes.pdf")).toBeNull();
  });

  it.skipIf(!storage)("ties an upload to its key", async () => {
    const id = await storage!.createUpload("own/a.pdf");
    const tag = await storage!.uploadPart("own/a.pdf", id, 1, new Uint8Array(10));
    await expect(storage!.uploadPart("own/b.pdf", id, 1, new Uint8Array(10))).rejects.toThrow();
    await expect(storage!.completeUpload("own/b.pdf", id, [tag])).rejects.toThrow();
    expect(await storage!.open("own/b.pdf")).toBeNull();
    expect(await storage!.completeUpload("own/a.pdf", id, [tag])).toBe(10);
    await storage!.delete("own/a.pdf");
  });

  it.skipIf(!storage)("refuses a part above the maximum size", async () => {
    const id = await storage!.createUpload("big/huge.pdf");
    await expect(storage!.uploadPart("big/huge.pdf", id, 1, new Uint8Array(MAX_PART_SIZE + 1))).rejects.toThrow(
      "Part too large",
    );
    await storage!.abortUpload("big/huge.pdf", id);
  });

  it.skipIf(!storage)("lets only one of two simultaneous completions win, with a whole file", async () => {
    await storage!.delete("race/book.pdf");
    const id = await storage!.createUpload("race/book.pdf");
    const tags = [
      await storage!.uploadPart("race/book.pdf", id, 1, new Uint8Array(MIN_PART_SIZE).fill(7)),
      await storage!.uploadPart("race/book.pdf", id, 2, new TextEncoder().encode("tail")),
    ];
    const results = await Promise.allSettled([
      storage!.completeUpload("race/book.pdf", id, tags),
      storage!.completeUpload("race/book.pdf", id, tags),
    ]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const content = await readAll((await storage!.open("race/book.pdf"))!.body);
    expect(content.length).toBe(MIN_PART_SIZE + 4);
    expect(content.subarray(-4).toString()).toBe("tail");
    // The upload is gone: a late part is refused.
    await expect(storage!.uploadPart("race/book.pdf", id, 3, new Uint8Array(1))).rejects.toThrow();
    await storage!.delete("race/book.pdf");
  });

  it.skipIf(!storage)("cleans up uploads left unfinished", async () => {
    const id = await storage!.createUpload("left/behind.pdf");
    await storage!.uploadPart("left/behind.pdf", id, 1, new Uint8Array(10));
    expect(await storage!.cleanupUploads(60_000)).toBe(0);
    await expect(storage!.cleanupUploads(10)).rejects.toThrow("cleanupUploads needs");
    await new Promise((done) => setTimeout(done, 1100));
    expect(await storage!.cleanupUploads(1000)).toBeGreaterThanOrEqual(1);
    await expect(storage!.uploadPart("left/behind.pdf", id, 1, new Uint8Array(10))).rejects.toThrow();
  });

  it.skipIf(!storage)("forgets an aborted upload, and aborting twice is harmless", async () => {
    const id = await storage!.createUpload("big/gone.pdf");
    await storage!.uploadPart("big/gone.pdf", id, 1, new Uint8Array(10));
    await storage!.abortUpload("big/gone.pdf", id);
    await expect(storage!.abortUpload("big/gone.pdf", id)).resolves.toBeUndefined();
    await expect(storage!.uploadPart("big/gone.pdf", id, 1, new Uint8Array(10))).rejects.toThrow();
  });
});

describe("assertValidKey", () => {
  it.each(["", "/etc/passwd", "a//b", "a/./b", "..", "a\\b", "a\0b", "a/", ".uploads/x", "a/.hidden", "é".repeat(513), `${"a".repeat(256)}/b`])("refuses %j", (key) => {
    expect(() => assertValidKey(key)).toThrow();
  });
  it.each(["a", "photos/123.jpg", "a..b/c"])("accepts %j", (key) => {
    expect(() => assertValidKey(key)).not.toThrow();
  });
});

describe("disk storage, upload IDs", () => {
  const disk = diskStorage(dir);
  it.each(["../../etc", "x", "00000000-0000-0000-0000-00000000000g"])("refuses the made-up ID %j", async (id) => {
    await expect(disk.uploadPart("a/b", id, 1, new Uint8Array(1))).rejects.toThrow("Unknown upload");
    await expect(disk.completeUpload("a/b", id, ["1"])).rejects.toThrow("Unknown upload");
    await expect(disk.abortUpload("a/b", id)).rejects.toThrow("Unknown upload");
  });
  it("refuses a well-formed ID it never gave", async () => {
    await expect(disk.uploadPart("a/b", "00000000-0000-4000-8000-000000000000", 1, new Uint8Array(1))).rejects.toThrow(
      "Unknown upload",
    );
  });
});
