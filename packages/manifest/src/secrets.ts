import { parse } from "yaml";

/**
 * Checks, WITHOUT decrypting anything, that a SOPS file is fully encrypted
 * (D35). CI never has the age key: actual decryption is checked by the
 * reconciler and by the weekly restore test.
 *
 * Format verified by encrypting a sample with SOPS v3.13.3 and age:
 * every value becomes `ENC[AES256_GCM,data:…,iv:…,tag:…,type:…]`, and a
 * top-level `sops` map holds the `mac` and one `age` entry per recipient.
 */

const ENCRYPTED_VALUE =
  /^ENC\[AES256_GCM,data:[A-Za-z0-9+/=]*,iv:[A-Za-z0-9+/=]+,tag:[A-Za-z0-9+/=]+,type:(str|int|float|bool|bytes|comment)\]$/;

const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

export interface SecretsCheck {
  errors: string[];
  recipients: string[];
}

export function checkEncryptedFile(content: string): SecretsCheck {
  const errors: string[] = [];
  let document: unknown;
  try {
    document = parse(content);
  } catch (error) {
    return { errors: [`is not valid YAML: ${(error as Error).message}`], recipients: [] };
  }
  if (!isMap(document)) {
    return { errors: ["is not a SOPS-encrypted YAML file (expected a map at the top level)"], recipients: [] };
  }

  const { sops: metadata, ...data } = document;
  if (!isMap(metadata)) {
    return { errors: ["is not encrypted with SOPS (no 'sops' section): encrypt it before committing"], recipients: [] };
  }
  if (typeof metadata.mac !== "string" || !ENCRYPTED_VALUE.test(metadata.mac)) {
    errors.push("has no valid SOPS integrity code ('sops.mac')");
  }

  const recipients: string[] = [];
  if (!Array.isArray(metadata.age) || metadata.age.length === 0) {
    errors.push("is not encrypted for any age key ('sops.age' is empty)");
  } else {
    for (const entry of metadata.age) {
      const recipient = isMap(entry) ? entry.recipient : undefined;
      const encryptedKey = isMap(entry) ? entry.enc : undefined;
      if (typeof recipient !== "string" || !AGE_RECIPIENT.test(recipient)) {
        errors.push("has an invalid age recipient in 'sops.age'");
      } else if (typeof encryptedKey !== "string" || !encryptedKey.includes("BEGIN AGE ENCRYPTED FILE")) {
        errors.push(`has no encrypted data key for ${recipient}`);
      } else {
        recipients.push(recipient);
      }
    }
  }

  const leaves = collectLeaves(data, []);
  if (leaves.length === 0) {
    errors.push("contains no secrets");
  }
  for (const { path, value } of leaves) {
    if (typeof value !== "string" || !ENCRYPTED_VALUE.test(value)) {
      errors.push(`has a value in plain text at '${path.join(".")}'`);
    }
  }

  return { errors, recipients };
}

/** Reads the age recipients from the instance's `.sops.yaml`. */
export function readSopsConfigRecipients(content: string): { errors: string[]; recipients: string[] } {
  let config: unknown;
  try {
    config = parse(content);
  } catch (error) {
    return { errors: [`is not valid YAML: ${(error as Error).message}`], recipients: [] };
  }
  const rules = isMap(config) ? config.creation_rules : undefined;
  if (!Array.isArray(rules) || rules.length !== 1 || !isMap(rules[0])) {
    return { errors: ["must contain exactly one entry in 'creation_rules'"], recipients: [] };
  }
  const age = rules[0].age;
  const recipients = (Array.isArray(age) ? age : typeof age === "string" ? age.split(",") : [])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value !== "");
  const errors: string[] = [];
  if (recipients.length === 0) {
    errors.push("lists no age recipient in 'creation_rules[0].age'");
  }
  for (const recipient of recipients) {
    if (!AGE_RECIPIENT.test(recipient)) {
      errors.push(`has an invalid age recipient: ${recipient}`);
    }
  }
  return { errors, recipients };
}

/** Text that must never appear anywhere in the instance repo. */
export const FORBIDDEN_CONTENT: { pattern: RegExp; message: string }[] = [
  { pattern: /AGE-SECRET-KEY-1[0-9A-Z]{20,}/, message: "contains an age PRIVATE key" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, message: "contains a PRIVATE key" },
];

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectLeaves(value: unknown, path: string[]): { path: string[]; value: unknown }[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectLeaves(item, [...path, String(index)]));
  }
  if (isMap(value)) {
    return Object.entries(value).flatMap(([key, item]) => collectLeaves(item, [...path, key]));
  }
  return [{ path, value }];
}
