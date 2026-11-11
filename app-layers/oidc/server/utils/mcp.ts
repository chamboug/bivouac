import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as client from "openid-client";
import type { H3Event } from "h3";
import { createError, getHeader, setResponseHeader } from "h3";
import { oidcConfig, type SessionUser } from "./oidc";

// Claude reaches an app's MCP at /mcp with an access token from the identity
// provider, never with the session cookie (D85). The platform sets
// MCP_RESOURCE (the address tokens must be issued for) only for an app whose
// manifest says `mcp: true`; without it, /mcp does not exist.
//
// Checked on Pocket ID v2.19.2 (11 Nov. 2026): access tokens are JWTs typed
// "at+jwt", signed with the provider's published keys, whose `aud` holds the
// resource and whose `client_id` is "<app>-mcp". Only that client may ask for
// that resource, and only for people in the app's groups.

export const MCP_PATH = "/mcp";
const ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

export function mcpResource(): string | undefined {
  return process.env.MCP_RESOURCE || undefined;
}

/** RFC 9728: what Claude reads first, to learn where to sign in. */
export function protectedResourceMetadata(resource: string) {
  return {
    resource,
    authorization_servers: [process.env.OIDC_ISSUER],
    bearer_methods_supported: ["header"],
    // Name and groups come from the identity provider's userinfo.
    scopes_supported: ["openid", "profile", "email", "groups"],
  };
}

function metadataUrl(resource: string): string {
  const url = new URL(resource);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

async function keys(config: client.Configuration) {
  const uri = config.serverMetadata().jwks_uri;
  if (!uri) throw new Error("The identity provider publishes no keys");
  jwks ??= createRemoteJWKSet(new URL(uri));
  return jwks;
}

// Name and groups for a token, kept until it expires (at most 5 minutes):
// one call to the identity provider per token, not per request.
const people = new Map<string, { user: SessionUser; until: number }>();

function refuse(event: H3Event, resource: string, error?: string): never {
  const details = error ? `, error="${error}"` : "";
  setResponseHeader(event, "www-authenticate", `Bearer resource_metadata="${metadataUrl(resource)}"${details}`);
  throw createError({ statusCode: 401, statusMessage: "Access token required" });
}

/** The person behind a valid access token, or a 401 that tells Claude where to sign in. */
export async function mcpUser(event: H3Event, resource: string): Promise<SessionUser> {
  const header = getHeader(event, "authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
  if (!match) refuse(event, resource);
  const token = match[1]!;

  const config = await oidcConfig();
  let payload;
  try {
    ({ payload } = await jwtVerify(token, await keys(config), {
      issuer: config.serverMetadata().issuer,
      audience: resource,
      typ: "at+jwt",
      algorithms: ALGORITHMS,
      requiredClaims: ["sub", "exp"],
    }));
  } catch {
    refuse(event, resource, "invalid_token");
  }
  // Belt and braces: the provider only issues this audience to this client.
  if (payload.client_id !== `${process.env.OIDC_CLIENT_ID}-mcp`) refuse(event, resource, "invalid_token");

  const key = createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  const known = people.get(key);
  if (known && known.until > now) return known.user;

  let info: client.UserInfoResponse;
  try {
    info = await client.fetchUserInfo(config, token, payload.sub!);
  } catch {
    refuse(event, resource, "invalid_token");
  }
  const user: SessionUser = {
    sub: payload.sub!,
    name: typeof info.name === "string" && info.name ? info.name : (info.preferred_username as string | undefined) ?? payload.sub!,
    email: typeof info.email === "string" ? info.email : undefined,
    groups: Array.isArray(info.groups) ? info.groups.filter((group): group is string => typeof group === "string") : [],
  };
  if (people.size > 1000) people.clear();
  people.set(key, { user, until: Math.min(payload.exp! * 1000, now + 5 * 60 * 1000) });
  return user;
}
