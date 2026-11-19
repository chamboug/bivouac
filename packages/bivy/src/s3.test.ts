import { describe, expect, it } from "vitest";
import { checkDestination, checkEndpoint, regionOf, resticRepository, signV4 } from "./s3.js";

describe("SigV4", () => {
  it("gives the signature of AWS's own example (GET Object with a Range header)", () => {
    // AWS docs, "Signature Calculations for the Authorization Header", example "GET Object".
    const headers = signV4(
      { method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", query: {}, headers: { range: "bytes=0-9" } },
      { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" },
      new Date("2013-05-24T00:00:00Z"),
    );
    expect(headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
});

describe("destination", () => {
  const destination = { endpoint: "s3.eu-central-003.backblazeb2.com", bucket: "my-backups", region: "eu-central-003", accessKeyId: "id", secretAccessKey: "secret" };
  const answer = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("reads addresses and regions", () => {
    expect(checkEndpoint("https://S3.eu-central-003.backblazeb2.com/")).toBe("s3.eu-central-003.backblazeb2.com");
    expect(() => checkEndpoint("s3.example.com/path")).toThrow(/host name/);
    expect(regionOf("s3.eu-central-003.backblazeb2.com")).toBe("eu-central-003");
    expect(regionOf("minio.example.org")).toBe("us-east-1");
    expect(resticRepository(destination)).toBe("s3:https://s3.eu-central-003.backblazeb2.com/my-backups");
  });

  it("accepts an empty bucket the key can list, and never sends the secret", async () => {
    let seen: RequestInit | undefined;
    const fetch = (async (_url: string, init: RequestInit) => {
      seen = init;
      return new Response("<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await checkDestination(destination, fetch, new Date());
    expect(JSON.stringify(seen)).not.toContain("secret\"");
    expect(JSON.stringify(seen)).toContain("Credential=id/");
  });

  it("refuses a bucket that holds something, and explains refusals", async () => {
    await expect(checkDestination(destination, answer(200, "<KeyCount>1</KeyCount><Contents><Key>config</Key></Contents>"), new Date())).rejects.toThrow(/not empty/);
    await expect(checkDestination(destination, answer(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>"), new Date())).rejects.toThrow(/secret key does not match/);
    await expect(checkDestination(destination, answer(404, "<Error><Code>NoSuchBucket</Code></Error>"), new Date())).rejects.toThrow(/no such bucket/);
  });
});
