import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertValidKey, diskStorage, s3Storage, type Storage } from "../server/utils/storage";

const dir = await mkdtemp(join(tmpdir(), "storage-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const modes: [string, Storage | undefined][] = [
  ["disk", diskStorage(dir)],
  [
    "s3",
    process.env.TEST_S3_BUCKET
      ? s3Storage({
          bucket: process.env.TEST_S3_BUCKET,
          endpoint: process.env.TEST_S3_ENDPOINT,
          accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY,
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
  });
});

describe("assertValidKey", () => {
  it.each(["", "/etc/passwd", "a//b", "a/./b", "..", "a\\b", "a\0b", "a/"])("refuses %j", (key) => {
    expect(() => assertValidKey(key)).toThrow();
  });
  it.each(["a", "photos/123.jpg", "a..b/c"])("accepts %j", (key) => {
    expect(() => assertValidKey(key)).not.toThrow();
  });
});
