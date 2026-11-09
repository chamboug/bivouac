// A tiny identity provider for tests: it signs in "Test User" without asking.
// It checks what a real one would: the redirect address and the PKCE proof.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const port = Number(process.env.FAKE_ISSUER_PORT ?? 4010);
const issuer = `http://localhost:${port}`;
const clientId = "test-client";
const clientSecret = "test-secret-test-secret-test-secret";
const redirectUri = `http://localhost:${process.env.APP_PORT ?? 3100}/auth/callback`;
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "1", alg: "RS256", use: "sig" };
const codes = new Map();

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  if (url.pathname === "/.well-known/openid-configuration") {
    return json(res, 200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      end_session_endpoint: `${issuer}/logout`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
  if (url.pathname === "/authorize") {
    const q = url.searchParams;
    if (q.get("redirect_uri") !== redirectUri || q.get("client_id") !== clientId) return json(res, 400, { error: "invalid_request" });
    const code = randomUUID();
    codes.set(code, { challenge: q.get("code_challenge"), nonce: q.get("nonce") });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state"));
    back.searchParams.set("iss", issuer);
    res.writeHead(302, { location: back.href });
    return res.end();
  }
  if (url.pathname === "/token") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    const saved = codes.get(form.get("code"));
    codes.delete(form.get("code"));
    const proof = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const authorized = form.get("client_secret") === clientSecret || req.headers.authorization === `Basic ${basic}`;
    if (!saved || proof !== saved.challenge || !authorized) return json(res, 400, { error: "invalid_grant" });
    const idToken = await new SignJWT({ nonce: saved.nonce, name: "Test User", email: "test@example.org", groups: ["famille"] })
      .setProtectedHeader({ alg: "RS256", kid: "1" })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return json(res, 200, { access_token: randomUUID(), token_type: "Bearer", id_token: idToken, expires_in: 300 });
  }
  json(res, 404, { error: "not_found" });
}).listen(port, "127.0.0.1");
