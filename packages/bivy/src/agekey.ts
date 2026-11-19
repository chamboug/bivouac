import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The age key, when it is not where SOPS looks for it (D93): pasted from the
 * password manager, recognized as the instance's own before anything is done
 * with it, then used for this run only or kept where SOPS reads it.
 *
 * An age identity is an X25519 private key written in Bech32
 * (`AGE-SECRET-KEY-1…`); its recipient is the matching public key, also in
 * Bech32 (`age1…`). Node's crypto computes the public key; Bech32 (BIP 173)
 * is the few lines below.
 */

export class AgeKeyError extends Error {}

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit++) if ((top >>> bit) & 1) check ^= GENERATOR[bit] as number;
  }
  return check >>> 0;
}

const expand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

/** Regroups bits: 8 → 5 to encode, 5 → 8 to decode (BIP 173). */
function convert(data: number[], from: number, to: number, pad: boolean): number[] {
  let accumulator = 0;
  let bits = 0;
  const out: number[] = [];
  for (const value of data) {
    accumulator = (accumulator << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((accumulator >> bits) & ((1 << to) - 1));
    }
  }
  if (pad && bits > 0) out.push((accumulator << (to - bits)) & ((1 << to) - 1));
  else if (!pad && (bits >= from || ((accumulator << (to - bits)) & ((1 << to) - 1)) !== 0)) throw new AgeKeyError("invalid padding");
  return out;
}

export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convert([...bytes], 8, 5, true);
  const check = polymod([...expand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, index) => (check >>> (5 * (5 - index))) & 31);
  return `${hrp}1${[...data, ...checksum].map((value) => CHARSET[value]).join("")}`;
}

/** Decodes a Bech32 string of one case (age's are longer than BIP 173's 90 characters). */
export function bech32Decode(text: string): { hrp: string; bytes: Buffer } {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) throw new AgeKeyError("mixed case");
  const lower = text.toLowerCase();
  const separator = lower.lastIndexOf("1");
  if (separator < 1 || lower.length - separator < 7) throw new AgeKeyError("no separator or checksum");
  const hrp = lower.slice(0, separator);
  const data = [...lower.slice(separator + 1)].map((c) => CHARSET.indexOf(c));
  if (data.some((value) => value < 0)) throw new AgeKeyError("a character outside Bech32");
  if (polymod([...expand(hrp), ...data]) !== 1) throw new AgeKeyError("wrong checksum: a character was mistyped or left out");
  return { hrp, bytes: Buffer.from(convert(data.slice(0, -6), 5, 8, false)) };
}

/** PKCS #8 header of a raw X25519 private key (RFC 8410). */
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");

/** The raw X25519 public key of a raw private key. */
export function x25519Public(privateKey: Buffer): Buffer {
  if (privateKey.length !== 32) throw new AgeKeyError("an X25519 key is 32 bytes");
  const key = createPrivateKey({ key: Buffer.concat([X25519_PKCS8, privateKey]), format: "der", type: "pkcs8" });
  const jwk = createPublicKey(key).export({ format: "jwk" });
  return Buffer.from(String(jwk.x), "base64url");
}

/** `age1…` for an `AGE-SECRET-KEY-1…`. */
export function ageRecipient(identity: string): string {
  const { hrp, bytes } = bech32Decode(identity.trim());
  if (hrp !== "age-secret-key-") throw new AgeKeyError("this is not an age secret key (AGE-SECRET-KEY-1…)");
  return bech32Encode("age", x25519Public(bytes));
}

/** The recipients the instance's secrets are encrypted for, from .sops.yaml. */
export const sopsRecipients = (sopsConfig: string): string[] => sopsConfig.match(/age1[0-9a-z]{58}/g) ?? [];

/**
 * A pasted key, checked against the instance's recipients, in the form SOPS
 * key files have (`# public key:` above the key). Never echoes the key.
 */
export function pastedIdentity(pasted: string, sopsConfig: string): Buffer {
  const identity = pasted.trim();
  if (!/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(identity)) throw new AgeKeyError("an age key starts with AGE-SECRET-KEY-1 and holds no spaces: paste the whole key, nothing else");
  let recipient: string;
  try {
    recipient = ageRecipient(identity);
  } catch (error) {
    throw new AgeKeyError(`this age key is damaged (${(error as Error).message})`);
  }
  if (!sopsRecipients(sopsConfig).includes(recipient)) throw new AgeKeyError(`this age key (public key ${recipient}) is not the one the instance's secrets are encrypted for`);
  return Buffer.from(`# public key: ${recipient}\n${identity}\n`);
}

/** Keeps the key where SOPS reads it: a new file only, mode 600, in a folder of mode 700. */
export function keepIdentity(path: string, identity: Buffer): void {
  if (existsSync(path)) throw new AgeKeyError(`${path} already exists: not overwritten`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, Buffer.concat([Buffer.from("# kept by bivy\n"), identity]), { mode: 0o600, flag: "wx" });
}
