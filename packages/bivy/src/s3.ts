import { createHash, createHmac } from "node:crypto";

/**
 * Backup destination contract (D93): any S3-compatible storage, reached by
 * restic over HTTPS (D16). Nothing here is specific to one provider; a
 * provider is only a preset that fills the address (`B2` below).
 *
 * bivy only checks that the key can list the bucket and that the bucket is
 * empty (a new platform starts a new restic repository: the reconciler runs
 * `restic init` before its first backup, D74). It never writes or deletes.
 */

export interface S3Destination {
  /** `s3.eu-central-003.backblazeb2.com`: host only, HTTPS always. */
  endpoint: string;
  bucket: string;
  /** Signing region; most providers accept their own region name, read from the address when it holds one. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface BackupPreset {
  id: string;
  label: string;
  /** Where to make the bucket and the key, shown before asking. */
  help: string;
  /** Builds the address from the region the person names, when the provider has a pattern. */
  endpoint?: (region: string) => string;
}

export const PRESETS: BackupPreset[] = [
  {
    id: "b2",
    label: "Backblaze B2",
    help: [
      "In Backblaze (the region is chosen at sign-up, for the whole account, and cannot be changed):",
      "  1. Buckets → Create a Bucket: private, a unique name; Lifecycle Settings → keep prior versions 30 days.",
      "  2. Application Keys → Add a New Application Key: only this bucket, Read and Write.",
      "     (A key that cannot delete is safer: runbook section 12 makes one with B2's own API.)",
      "  3. Note the bucket's Endpoint (s3.<region>.backblazeb2.com), the keyID and the applicationKey.",
    ].join("\n"),
    endpoint: (region) => `s3.${region}.backblazeb2.com`,
  },
  {
    id: "s3",
    label: "Another S3-compatible storage",
    help: [
      "At your storage provider: a private, empty bucket, and an access key limited to that bucket",
      "(list, read and write; no delete if the provider allows it). Note its HTTPS endpoint (host name),",
      "its region, the access key ID and the secret key.",
    ].join("\n"),
  },
];

export class S3Error extends Error {}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export function checkEndpoint(endpoint: string): string {
  const host = endpoint.trim().replace(/^https:\/\//, "").replace(/\/$/, "").toLowerCase();
  if (!HOST.test(host)) throw new S3Error(`'${endpoint}' is not a host name (like s3.eu-central-003.backblazeb2.com)`);
  return host;
}

export function checkBucket(bucket: string): string {
  if (!BUCKET.test(bucket)) throw new S3Error(`'${bucket}' is not a bucket name restic accepts here (lower case letters, digits and dashes)`);
  return bucket;
}

/** The region in the address (`s3.<region>.…`), else the most common default. */
export function regionOf(endpoint: string): string {
  return /^s3[.-]([a-z0-9-]+)\.(backblazeb2\.com|amazonaws\.com|wasabisys\.com)$/.exec(endpoint)?.[1] ?? "us-east-1";
}

/** As restic names it, and platform.yml's `backup.repository` (D16). */
export const resticRepository = (destination: Pick<S3Destination, "endpoint" | "bucket">) => `s3:https://${destination.endpoint}/${destination.bucket}`;

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/**
 * AWS Signature Version 4 for one request with no body (AWS docs, "Signature
 * Calculations for the Authorization Header"). Header names are lower case.
 * Checked against AWS's own example in s3.test.ts.
 */
export function signV4(request: { method: string; host: string; path: string; query: Record<string, string>; headers?: Record<string, string> }, credentials: { accessKeyId: string; secretAccessKey: string; region: string }, now: Date): Record<string, string> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payload = sha256("");
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const query = Object.keys(request.query).sort().map((key) => `${encode(key)}=${encode(request.query[key] as string)}`).join("&");
  const headers: Record<string, string> = { host: request.host, ...request.headers, "x-amz-content-sha256": payload, "x-amz-date": amzDate };
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = names.map((name) => `${name}:${String(headers[name]).trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonical = [request.method, request.path, query, canonicalHeaders, signedHeaders, payload].join("\n");
  const scope = `${day}/${credentials.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), credentials.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const { host: _host, ...sent } = headers;
  return { ...sent, Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

/**
 * Lists at most one object of the bucket (path-style, which restic also
 * uses by default for other providers). Throws with a plain reason when the
 * key cannot, or when the bucket already holds something.
 */
export async function checkDestination(destination: S3Destination, fetch: typeof globalThis.fetch, now: Date): Promise<void> {
  const path = `/${destination.bucket}`;
  const query = { "list-type": "2", "max-keys": "1" };
  const headers = signV4({ method: "GET", host: destination.endpoint, path, query }, destination, now);
  let response: Response;
  try {
    response = await fetch(`https://${destination.endpoint}${path}?list-type=2&max-keys=1`, { headers, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new S3Error(`could not reach https://${destination.endpoint}: ${(error as Error).message}`);
  }
  const body = await response.text();
  if (!response.ok) {
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? `HTTP ${response.status}`;
    const hints: Record<string, string> = {
      NoSuchBucket: "no such bucket at this address",
      InvalidAccessKeyId: "the access key ID is not known there",
      SignatureDoesNotMatch: "the secret key does not match the access key ID",
      AccessDenied: "the key may not list this bucket",
      AuthorizationHeaderMalformed: "the region is wrong for this address",
    };
    throw new S3Error(`the storage refused: ${hints[code] ?? code}`);
  }
  if (/<Contents>/.test(body) || /<KeyCount>[1-9]/.test(body)) {
    throw new S3Error(`the bucket ${destination.bucket} is not empty: a new platform needs an empty bucket (an old restic repository would have another password)`);
  }
}
