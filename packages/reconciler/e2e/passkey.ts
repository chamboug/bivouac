/**
 * A software passkey for the end-to-end tests: what a phone or a password
 * manager answers to a WebAuthn ceremony, written out by hand so the tests
 * can sign in to Pocket ID without a browser (D109). One ES256 key, the
 * "none" attestation, user presence and verification always given.
 *
 * Only what Pocket ID asks for is implemented: a discoverable credential
 * created with `navigator.credentials.create`, then used without
 * `allowCredentials`.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

const b64url = (bytes: Buffer) => bytes.toString("base64url");
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();

/** The few CBOR items WebAuthn needs (RFC 8949): integers, byte and text strings, maps. */
function cbor(value: unknown): Buffer {
  const head = (major: number, length: number): Buffer => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
    if (length < 0x10000) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
    throw new Error("CBOR item too long for this encoder");
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, text.length), text]);
  }
  if (value instanceof Map) {
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])]);
  }
  throw new Error(`CBOR: cannot encode ${typeof value}`);
}

/** Flags of authenticator data: user present, user verified, attested credential data. */
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

interface CreationFields { challenge: string; rp: { id?: string }; user: { id: string }; pubKeyCredParams?: { alg: number }[] }
interface RequestFields { challenge: string; rpId?: string }

/** Pocket ID sends the options as they are, a browser wraps them in `publicKey`: both are read. */
type CreationOptions = CreationFields | { publicKey: CreationFields };
type RequestOptions = RequestFields | { publicKey: RequestFields };

export class SoftwarePasskey {
  private readonly key: { privateKey: KeyObject; publicKey: KeyObject } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  private readonly id = randomBytes(16);
  private userHandle: Buffer | undefined;
  private signCount = 0;

  /** `origin` is the identity provider's address, as a browser would report it. */
  constructor(private readonly origin: string) {}

  private rpId(given: string | undefined): string {
    return given ?? new URL(this.origin).hostname;
  }

  private clientData(type: "webauthn.create" | "webauthn.get", challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  /** The answer to `navigator.credentials.create`, as the browser sends it as JSON. */
  create(options: CreationOptions): unknown {
    const { challenge, rp, user, pubKeyCredParams } = "publicKey" in options ? options.publicKey : options;
    if (pubKeyCredParams && !pubKeyCredParams.some((param) => param.alg === -7)) throw new Error("the relying party does not accept ES256");
    this.userHandle = Buffer.from(user.id, "base64url");
    const jwk = this.key.publicKey.export({ format: "jwk" });
    // COSE_Key (RFC 9053): kty EC2, alg ES256, crv P-256, x, y.
    const coseKey = cbor(new Map<number, unknown>([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(jwk.x ?? "", "base64url")],
      [-3, Buffer.from(jwk.y ?? "", "base64url")],
    ]));
    const length = Buffer.alloc(2);
    length.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([
      sha256(this.rpId(rp.id)), Buffer.from([UP | UV | AT]), Buffer.alloc(4),
      Buffer.alloc(16), length, this.id, coseKey,
    ]);
    const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: b64url(this.id),
      rawId: b64url(this.id),
      type: "public-key",
      authenticatorAttachment: "platform",
      // Asked for with credProps: a passkey (discoverable credential).
      clientExtensionResults: { credProps: { rk: true } },
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", challenge)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** The answer to `navigator.credentials.get`, with the user handle of a discoverable credential. */
  get(options: RequestOptions): unknown {
    if (!this.userHandle) throw new Error("no passkey created yet");
    const { challenge, rpId } = "publicKey" in options ? options.publicKey : options;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.signCount);
    const authData = Buffer.concat([sha256(this.rpId(rpId)), Buffer.from([UP | UV]), counter]);
    const clientData = this.clientData("webauthn.get", challenge);
    // ES256: ECDSA over SHA-256, DER-encoded, of authData || SHA-256(clientDataJSON).
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), this.key.privateKey);
    return {
      id: b64url(this.id),
      rawId: b64url(this.id),
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: b64url(this.userHandle),
      },
    };
  }
}
