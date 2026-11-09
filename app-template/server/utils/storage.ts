// User files, always through this module (D72). No framework dependency: an
// app in another framework can copy this file as it is.
//
// - By default, files live in STORAGE_DIR, the volume declared in the manifest.
// - When S3_BUCKET is set, they live in that bucket (S3_ENDPOINT, S3_REGION,
//   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY).
//
// The database stores keys ("photos/123.jpg"), never paths or URLs.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export interface Storage {
  put(key: string, body: Uint8Array): Promise<void>;
  /** The file's content, or null if there is none. */
  get(key: string): Promise<Uint8Array | null>;
  /** Does nothing if the file does not exist. */
  delete(key: string): Promise<void>;
}

export function assertValidKey(key: string): void {
  const segments = key.split("/");
  const invalid =
    key.length === 0 ||
    key.length > 1024 ||
    key.includes("\\") ||
    /[\u0000-\u001f]/.test(key) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (invalid) throw new Error("Invalid storage key");
}

export function diskStorage(root: string): Storage {
  const base = resolve(root);
  const pathOf = (key: string): string => {
    assertValidKey(key);
    const path = resolve(join(base, key));
    // A second lock, in case a key ever got past the check above.
    if (!path.startsWith(base + sep)) throw new Error("Invalid storage key");
    return path;
  };
  return {
    async put(key, body) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },
    async get(key) {
      try {
        return await readFile(pathOf(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
  };
}

export interface S3Options {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

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
  return {
    async put(key, body) {
      assertValidKey(key);
      const { PutObjectCommand } = await sdk;
      await (await clientPromise).send(new PutObjectCommand({ Bucket, Key: key, Body: body }));
    },
    async get(key) {
      assertValidKey(key);
      const { GetObjectCommand, NoSuchKey } = await sdk;
      try {
        const reply = await (await clientPromise).send(new GetObjectCommand({ Bucket, Key: key }));
        return (await reply.Body?.transformToByteArray()) ?? null;
      } catch (error) {
        if (error instanceof NoSuchKey) return null;
        throw error;
      }
    },
    async delete(key) {
      assertValidKey(key);
      const { DeleteObjectCommand } = await sdk;
      await (await clientPromise).send(new DeleteObjectCommand({ Bucket, Key: key }));
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
