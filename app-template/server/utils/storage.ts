// User files, always through this module (D72). No framework dependency: an
// app in another framework can copy this file as it is.
//
// - By default, files live in STORAGE_DIR, the volume declared in the manifest.
// - When S3_BUCKET is set, they live in that bucket (S3_ENDPOINT, S3_REGION,
//   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY).
//
// The database stores keys ("photos/123.jpg"), never paths or URLs.
//
// Small files go through `put` and `get`, which hold the whole file in memory.
// Large files (anything over a few MB) never do: they arrive in parts
// (`createUpload`, `uploadPart`, `completeUpload`) and are read as a stream
// (`open`). The server has little memory, shared by every app.
//
// What this module guarantees: nothing is read or written outside the app's
// directory (or bucket), and an upload ID only works with the key it was
// created for. What it does NOT check: who may touch which key. The app makes
// keys itself, on the server, keeps (upload ID, key, owner) in its database
// when an upload starts, and takes them from there, never from the request.
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open as openFile, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** An error the app may show the visitor as "not found" or "bad request"; anything else is a real failure. */
export class StorageError extends Error {
  constructor(readonly code: "invalid-key" | "unknown-upload" | "invalid-upload", message: string) {
    super(message);
  }
}

/** S3's smallest part (except the last), kept in both modes so that an app behaves the same. */
export const MIN_PART_SIZE = 5 * 1024 * 1024;
/** Each part is held in memory: refused above this. The app's route must refuse larger bodies before reading them. */
export const MAX_PART_SIZE = 16 * 1024 * 1024;
export const MAX_PARTS = 10_000;

export interface StoredFile {
  size: number;
  /**
   * A Node stream. Send it with `pipeline(body, response)`: it then waits for
   * slow clients and stops reading when the client goes away. Whoever does
   * not read it to the end must call `body.destroy()`.
   */
  body: Readable;
}

export interface Storage {
  /** Small files only: the whole body is in memory. */
  put(key: string, body: Uint8Array): Promise<void>;
  /** Small files only. The file's content, or null if there is none. */
  get(key: string): Promise<Uint8Array | null>;
  /** The file as a stream, with its size, or null if there is none. */
  open(key: string): Promise<StoredFile | null>;
  /** Does nothing if the file does not exist. */
  delete(key: string): Promise<void>;

  /**
   * Starts a file sent in parts; returns the upload's ID. Nothing exists at
   * `key` until `completeUpload`. An upload that is never completed must be
   * aborted, or its parts stay (see also `cleanupUploads`).
   */
  createUpload(key: string): Promise<string>;
  /**
   * Stores part `partNumber` (1, 2, 3…). Every part but the last must be at
   * least MIN_PART_SIZE, and none above MAX_PART_SIZE (8 MB is a good size).
   * Sending the same part again replaces it. Returns the part's tag, to give
   * back to `completeUpload`.
   */
  uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<string>;
  /**
   * Joins the parts into the file at `key` (replacing any file there) and
   * returns its size. `tags[i]` is the tag of part i + 1. Only one call wins.
   * Do not count on retrying after a failure: on disk the upload is gone
   * afterwards, even if joining failed. Start a new upload instead.
   */
  completeUpload(key: string, uploadId: string, tags: string[]): Promise<number>;
  /** Removes an unfinished upload's parts. Does nothing if there are none. */
  abortUpload(key: string, uploadId: string): Promise<void>;
  /**
   * Removes every unfinished upload untouched for more than `olderThanMs`
   * (at least an hour: a shorter delay could remove an upload in progress).
   * Returns how many were removed. Call it now and then (when an upload
   * starts, for example).
   */
  cleanupUploads(olderThanMs: number): Promise<number>;
}

/** `cleanupUploads` refuses shorter delays (tests may lower it). */
export const MIN_CLEANUP_AGE = 60 * 60 * 1000;

function assertCleanupAge(olderThanMs: number, minimum: number): void {
  if (!(olderThanMs >= minimum)) throw new Error(`cleanupUploads needs at least ${minimum} ms`);
}

export function assertValidKey(key: string): void {
  const segments = key.split("/");
  const invalid =
    key.length === 0 ||
    // Bytes, not characters: S3 allows 1024 bytes, most disks 255 per name.
    Buffer.byteLength(key) > 1024 ||
    key.includes("\\") ||
    /[\u0000-\u001f]/.test(key) ||
    // No hidden names: the disk mode keeps its work in ".uploads".
    segments.some((segment) => segment === "" || segment.startsWith(".") || Buffer.byteLength(segment) > 255);
  if (invalid) throw new StorageError("invalid-key", "Invalid storage key");
}

function assertValidPart(partNumber: number, body: Uint8Array): void {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
    throw new StorageError("invalid-upload", "Invalid part number");
  }
  if (body.byteLength > MAX_PART_SIZE) throw new StorageError("invalid-upload", "Part too large");
}

function assertValidPartList(tags: string[]): void {
  if (tags.length === 0 || tags.length > MAX_PARTS) throw new StorageError("invalid-upload", "Invalid part list");
}

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function diskStorage(root: string, minCleanupAge = MIN_CLEANUP_AGE): Storage {
  const base = resolve(root);
  const work = join(base, ".uploads");
  const pathOf = (key: string): string => {
    assertValidKey(key);
    const path = resolve(join(base, key));
    // A second lock, in case a key ever got past the check above.
    if (!path.startsWith(base + sep)) throw new StorageError("invalid-key", "Invalid storage key");
    return path;
  };
  const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
  // Written aside then renamed: a reader sees the whole file or the old one,
  // and two writers never write into the same file.
  const writeAtomically = async (path: string, body: Uint8Array): Promise<void> => {
    await mkdir(work, { recursive: true });
    const temporary = join(work, `put-${randomUUID()}`);
    try {
      await writeFile(temporary, body);
      await mkdir(dirname(path), { recursive: true });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  // The ID is ours (a UUID), but it comes back from the app: check its form
  // before it becomes part of a path, then that it belongs to this key.
  const uploadDir = async (key: string, uploadId: string): Promise<string> => {
    pathOf(key);
    if (!UPLOAD_ID.test(uploadId)) throw new StorageError("unknown-upload", "Unknown upload");
    const dir = join(work, uploadId);
    let owner: string;
    try {
      owner = await readFile(join(dir, "key"), "utf8");
    } catch (error) {
      if (missing(error)) throw new StorageError("unknown-upload", "Unknown upload");
      throw error;
    }
    if (owner !== key) throw new StorageError("unknown-upload", "Unknown upload");
    return dir;
  };
  return {
    async put(key, body) {
      await writeAtomically(pathOf(key), body);
    },
    async get(key) {
      try {
        return await readFile(pathOf(key));
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async open(key) {
      const path = pathOf(key);
      // Size and content from the same open file, even if it is replaced meanwhile.
      let handle;
      try {
        handle = await openFile(path, "r");
      } catch (error) {
        if (missing(error) || (error as NodeJS.ErrnoException).code === "EISDIR") return null;
        throw error;
      }
      try {
        const info = await handle.stat();
        if (!info.isFile()) {
          await handle.close();
          return null;
        }
        return { size: info.size, body: handle.createReadStream() };
      } catch (error) {
        await handle.close();
        throw error;
      }
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },

    async createUpload(key) {
      pathOf(key);
      const uploadId = randomUUID();
      const dir = join(work, uploadId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "key"), key);
      return uploadId;
    },
    async uploadPart(key, uploadId, partNumber, body) {
      assertValidPart(partNumber, body);
      const dir = await uploadDir(key, uploadId);
      const part = join(dir, `part-${partNumber}`);
      const temporary = `${part}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, body);
        await rename(temporary, part);
      } catch (error) {
        await rm(temporary, { force: true });
        // Completed or aborted meanwhile.
        if (missing(error)) throw new StorageError("unknown-upload", "Unknown upload");
        throw error;
      }
      return String(partNumber);
    },
    async completeUpload(key, uploadId, tags) {
      const path = pathOf(key);
      assertValidPartList(tags);
      const dir = await uploadDir(key, uploadId);
      // Claimed by renaming it: if two calls race, one rename fails, and late
      // parts or aborts no longer find the upload.
      const claimed = join(work, `completing-${randomUUID()}`);
      try {
        await rename(dir, claimed);
      } catch (error) {
        if (missing(error)) throw new StorageError("unknown-upload", "Unknown upload");
        throw error;
      }
      try {
        const parts: string[] = [];
        for (let number = 1; number <= tags.length; number++) {
          if (tags[number - 1] !== String(number)) throw new StorageError("invalid-upload", `Part ${number} has the wrong tag`);
          const part = join(claimed, `part-${number}`);
          const info = await stat(part).catch(() => null);
          if (!info?.isFile()) throw new StorageError("invalid-upload", `Part ${number} is missing`);
          if (number < tags.length && info.size < MIN_PART_SIZE) throw new StorageError("invalid-upload", `Part ${number} is too small`);
          parts.push(part);
        }
        // Joined inside the claimed directory, then moved into place: a
        // reader never sees a half-written file.
        const joined = join(claimed, "joined");
        await pipeline(
          (async function* () {
            for (const part of parts) yield* createReadStream(part);
          })(),
          createWriteStream(joined, { flags: "wx" }),
        );
        const { size } = await stat(joined);
        await mkdir(dirname(path), { recursive: true });
        await rename(joined, path);
        return size;
      } finally {
        await rm(claimed, { recursive: true, force: true });
      }
    },
    async abortUpload(key, uploadId) {
      let dir: string;
      try {
        dir = await uploadDir(key, uploadId);
      } catch (error) {
        // Already gone: nothing to do. A malformed ID or another key's upload is still refused.
        if (error instanceof StorageError && error.code === "unknown-upload" && UPLOAD_ID.test(uploadId)) {
          const exists = await stat(join(work, uploadId)).then(() => true, () => false);
          if (!exists) return;
        }
        throw error;
      }
      await rm(dir, { recursive: true, force: true });
    },
    async cleanupUploads(olderThanMs) {
      assertCleanupAge(olderThanMs, minCleanupAge);
      let names: string[];
      try {
        names = await readdir(work);
      } catch (error) {
        if (missing(error)) return 0;
        throw error;
      }
      const limit = Date.now() - olderThanMs;
      let removed = 0;
      for (const name of names) {
        const entry = join(work, name);
        const info = await stat(entry).catch(() => null);
        // Creation time is not kept everywhere; the last change is close enough.
        if (!info || info.mtimeMs > limit) continue;
        await rm(entry, { recursive: true, force: true });
        if (UPLOAD_ID.test(name)) removed++;
      }
      return removed;
    },
  };
}

export interface S3Options {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Tests only. */
  minCleanupAge?: number;
}

/**
 * In S3 mode, also give the bucket a lifecycle rule that aborts incomplete
 * multipart uploads after a few days, in case `cleanupUploads` is never called.
 */
export function s3Storage(options: S3Options): Storage {
  // Loaded on first use: disk mode never pays for the S3 library.
  const sdk = import("@aws-sdk/client-s3");
  const clientPromise = sdk.then(
    ({ S3Client }) =>
      new S3Client({
        region: options.region ?? "garage",
        ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
        ...(options.accessKeyId && options.secretAccessKey
          ? { credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } }
          : {}),
      }),
  );
  const Bucket = options.bucket;
  const isMissing = async (error: unknown): Promise<boolean> => {
    const { NoSuchKey, NotFound } = await sdk;
    return error instanceof NoSuchKey || error instanceof NotFound;
  };
  const isUnknownUpload = async (error: unknown): Promise<boolean> => {
    const { NoSuchUpload } = await sdk;
    return error instanceof NoSuchUpload;
  };
  return {
    async put(key, body) {
      assertValidKey(key);
      const { PutObjectCommand } = await sdk;
      await (await clientPromise).send(new PutObjectCommand({ Bucket, Key: key, Body: body }));
    },
    async get(key) {
      assertValidKey(key);
      const { GetObjectCommand } = await sdk;
      try {
        const reply = await (await clientPromise).send(new GetObjectCommand({ Bucket, Key: key }));
        return (await reply.Body?.transformToByteArray()) ?? null;
      } catch (error) {
        if (await isMissing(error)) return null;
        throw error;
      }
    },
    async open(key) {
      assertValidKey(key);
      const { GetObjectCommand } = await sdk;
      let reply;
      try {
        reply = await (await clientPromise).send(new GetObjectCommand({ Bucket, Key: key }));
      } catch (error) {
        if (await isMissing(error)) return null;
        throw error;
      }
      // In Node, the SDK's body is a Node stream.
      const body = reply.Body as unknown as Readable | undefined;
      if (!(body instanceof Readable) || reply.ContentLength === undefined) {
        // Not read: release the connection.
        if (body instanceof Readable) body.destroy();
        throw new Error("The bucket gave no readable body");
      }
      return { size: reply.ContentLength, body };
    },
    async delete(key) {
      assertValidKey(key);
      const { DeleteObjectCommand } = await sdk;
      await (await clientPromise).send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    async createUpload(key) {
      assertValidKey(key);
      const { CreateMultipartUploadCommand } = await sdk;
      const reply = await (await clientPromise).send(new CreateMultipartUploadCommand({ Bucket, Key: key }));
      if (!reply.UploadId) throw new Error("The bucket gave no upload ID");
      return reply.UploadId;
    },
    async uploadPart(key, uploadId, partNumber, body) {
      assertValidKey(key);
      assertValidPart(partNumber, body);
      const { UploadPartCommand } = await sdk;
      try {
        const reply = await (await clientPromise).send(
          new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body }),
        );
        if (!reply.ETag) throw new Error("The bucket gave no part tag");
        return reply.ETag;
      } catch (error) {
        if (await isUnknownUpload(error)) throw new StorageError("unknown-upload", "Unknown upload");
        throw error;
      }
    },
    async completeUpload(key, uploadId, tags) {
      assertValidKey(key);
      assertValidPartList(tags);
      const { CompleteMultipartUploadCommand, HeadObjectCommand, ListPartsCommand } = await sdk;
      const client = await clientPromise;
      try {
        // Checked here as on disk: not every S3 server enforces part sizes.
        const sizes = new Map<number, number>();
        let marker: string | undefined;
        do {
          const page = await client.send(
            new ListPartsCommand({ Bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
          );
          for (const part of page.Parts ?? []) sizes.set(part.PartNumber ?? 0, part.Size ?? 0);
          const next = page.IsTruncated ? page.NextPartNumberMarker : undefined;
          // A server repeating the same page must not loop forever.
          marker = next !== undefined && next !== marker ? next : undefined;
        } while (marker);
        for (let number = 1; number <= tags.length; number++) {
          const size = sizes.get(number);
          if (size === undefined) throw new StorageError("invalid-upload", `Part ${number} is missing`);
          if (number < tags.length && size < MIN_PART_SIZE) throw new StorageError("invalid-upload", `Part ${number} is too small`);
        }
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: tags.map((ETag, index) => ({ ETag, PartNumber: index + 1 })) },
          }),
        );
      } catch (error) {
        if (await isUnknownUpload(error)) throw new StorageError("unknown-upload", "Unknown upload");
        throw error;
      }
      const head = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
      return head.ContentLength ?? 0;
    },
    async abortUpload(key, uploadId) {
      assertValidKey(key);
      const { AbortMultipartUploadCommand } = await sdk;
      try {
        await (await clientPromise).send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
      } catch (error) {
        if (!(await isUnknownUpload(error))) throw error;
      }
    },
    async cleanupUploads(olderThanMs) {
      assertCleanupAge(olderThanMs, options.minCleanupAge ?? MIN_CLEANUP_AGE);
      const { AbortMultipartUploadCommand, ListMultipartUploadsCommand } = await sdk;
      const client = await clientPromise;
      const limit = Date.now() - olderThanMs;
      let removed = 0;
      let keyMarker: string | undefined;
      let uploadIdMarker: string | undefined;
      for (;;) {
        const page = await client.send(
          new ListMultipartUploadsCommand({ Bucket, KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker }),
        );
        for (const upload of page.Uploads ?? []) {
          if (!upload.Key || !upload.UploadId || !upload.Initiated) continue;
          if (upload.Initiated.getTime() > limit) continue;
          try {
            await client.send(new AbortMultipartUploadCommand({ Bucket, Key: upload.Key, UploadId: upload.UploadId }));
            removed++;
          } catch (error) {
            if (!(await isUnknownUpload(error))) throw error;
          }
        }
        if (!page.IsTruncated) break;
        if (page.NextKeyMarker === keyMarker && page.NextUploadIdMarker === uploadIdMarker) break;
        keyMarker = page.NextKeyMarker;
        uploadIdMarker = page.NextUploadIdMarker;
      }
      return removed;
    },
  };
}

let storage: Storage | undefined;

export function useStorageFiles(env: NodeJS.ProcessEnv = process.env): Storage {
  storage ??= env.S3_BUCKET
    ? s3Storage({
        bucket: env.S3_BUCKET,
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      })
    : diskStorage(env.STORAGE_DIR ?? "/app/uploads");
  return storage;
}
