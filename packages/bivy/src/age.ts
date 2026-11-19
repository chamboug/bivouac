import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";

/**
 * The age master key (D35), made by bivy itself with Node's X25519, so no
 * tool has to be downloaded for it. An age X25519 identity is 32 random
 * bytes, written in Bech32 (BIP 173, not Bech32m) with the prefix
 * `age-secret-key-` in upper case; its recipient is the X25519 public key,
 * in Bech32 with the prefix `age` (age's format specification, C2SP
 * age.md, "The X25519 recipient type"). Checked against sops itself in
 * age.test.ts.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit++) if ((top >>> bit) & 1) checksum ^= GENERATOR[bit] as number;
  }
  return checksum >>> 0;
}

const expand = (prefix: string) => [...[...prefix].map((char) => char.charCodeAt(0) >> 5), 0, ...[...prefix].map((char) => char.charCodeAt(0) & 31)];

/** 8-bit bytes → 5-bit groups, padded. */
function toWords(bytes: Uint8Array): number[] {
  const words: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((accumulator >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((accumulator << (5 - bits)) & 31);
  return words;
}

export function bech32(prefix: string, bytes: Uint8Array): string {
  const words = toWords(bytes);
  const checksum = polymod([...expand(prefix), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const tail = Array.from({ length: 6 }, (_, index) => (checksum >>> (5 * (5 - index))) & 31);
  return `${prefix}1${[...words, ...tail].map((word) => CHARSET[word]).join("")}`;
}

export interface AgeIdentity {
  /** `AGE-SECRET-KEY-1…`: shown once to the owner, never logged. */
  secret: string;
  /** `age1…`: goes into `.sops.yaml`. */
  recipient: string;
}

/** The recipient of a 32-byte X25519 secret. */
export function recipientOf(secretBytes: Buffer): string {
  if (secretBytes.length !== 32) throw new Error("an X25519 secret is 32 bytes");
  // PKCS#8 wrapping of a raw X25519 private key (RFC 8410): a fixed prefix, then the 32 bytes.
  const der = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), secretBytes]);
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const x = createPublicKey(privateKey).export({ format: "jwk" }).x;
  if (!x) throw new Error("X25519 gave no public key");
  return bech32("age", Buffer.from(x, "base64url"));
}

export function newAgeIdentity(random: (size: number) => Buffer = randomBytes): AgeIdentity {
  const secretBytes = random(32);
  return { secret: bech32("age-secret-key-", secretBytes).toUpperCase(), recipient: recipientOf(secretBytes) };
}

/** The key file as age-keygen writes it, which sops and `instanceIdentity` read. */
export function keyFile(identity: AgeIdentity, created: Date): string {
  return `# created: ${created.toISOString()}\n# public key: ${identity.recipient}\n${identity.secret}\n`;
}
