import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgeKeyError, ageRecipient, bech32Decode, bech32Encode, keepIdentity, pastedIdentity, x25519Public } from "./agekey.js";

// RFC 7748, section 6.1: Alice's X25519 key pair.
const ALICE_PRIVATE = Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex");
const ALICE_PUBLIC = Buffer.from("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", "hex");
const IDENTITY = bech32Encode("age-secret-key-", ALICE_PRIVATE).toUpperCase();
const RECIPIENT = bech32Encode("age", ALICE_PUBLIC);

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("age keys (D93)", () => {
  it("computes X25519 public keys (RFC 7748 test vector)", () => {
    expect(x25519Public(ALICE_PRIVATE).equals(ALICE_PUBLIC)).toBe(true);
  });

  it("reads Bech32 (BIP 173 test vectors) and round-trips", () => {
    expect(bech32Decode("A12UEL5L").hrp).toBe("a");
    expect(bech32Decode("abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw").bytes.toString("hex")).toBe("00443214c74254b635cf84653a56d7c675be77df");
    expect(bech32Encode("abcdef", Buffer.from("00443214c74254b635cf84653a56d7c675be77df", "hex"))).toBe("abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw");
    expect(() => bech32Decode("A12UEL5M")).toThrow(/checksum/);
    expect(() => bech32Decode("A12uEL5L")).toThrow(/mixed case/);
    expect(RECIPIENT).toMatch(/^age1[0-9a-z]{58}$/);
    expect(IDENTITY).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
  });

  it("finds the recipient of an identity", () => {
    expect(ageRecipient(IDENTITY)).toBe(RECIPIENT);
    expect(() => ageRecipient(RECIPIENT)).toThrow(/not an age secret key/);
  });

  it("accepts a pasted key only when it is the instance's, and never echoes it", () => {
    const sops = `creation_rules:\n  - age: ${RECIPIENT}\n`;
    expect(pastedIdentity(`  ${IDENTITY}\n`, sops).toString()).toBe(`# public key: ${RECIPIENT}\n${IDENTITY}\n`);
    const other = bech32Encode("age", Buffer.alloc(32, 7));
    const wrong = (() => {
      try {
        pastedIdentity(IDENTITY, `creation_rules:\n  - age: ${other}\n`);
      } catch (error) {
        return error as AgeKeyError;
      }
    })();
    expect(wrong?.message).toMatch(/not the one the instance's secrets are encrypted for/);
    expect(wrong?.message).not.toContain(IDENTITY);
    // One character mistyped: the checksum catches it.
    const typo = IDENTITY.slice(0, 30) + (IDENTITY[30] === "Q" ? "P" : "Q") + IDENTITY.slice(31);
    expect(() => pastedIdentity(typo, sops)).toThrow(/damaged/);
    expect(() => pastedIdentity(`${IDENTITY} extra`, sops)).toThrow(/holds no spaces/);
  });

  it("keeps the key in a new file only, readable by its owner", () => {
    const dir = mkdtempSync(join(tmpdir(), "bivy-age-"));
    dirs.push(dir);
    const path = join(dir, "sops", "age", "keys.txt");
    keepIdentity(path, Buffer.from(`# public key: ${RECIPIENT}\n${IDENTITY}\n`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "sops", "age")).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8")).toContain(`# public key: ${RECIPIENT}\n${IDENTITY}`);
    expect(() => keepIdentity(path, Buffer.from("x"))).toThrow(/not overwritten/);
  });
});
