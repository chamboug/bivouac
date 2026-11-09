import { hkdfSync } from "node:crypto";
import * as client from "openid-client";
import type { H3Event, SessionConfig } from "h3";
import { getRequestURL } from "h3";

export interface SessionUser {
  sub: string;
  name: string;
  email?: string;
  groups: string[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

let discovered: Promise<client.Configuration> | undefined;

export function oidcConfig(): Promise<client.Configuration> {
  // A failed discovery is not kept: the next sign-in tries again.
  discovered ??= discover().catch((error) => {
    discovered = undefined;
    throw error;
  });
  return discovered;
}

function discover(): Promise<client.Configuration> {
  const issuer = new URL(required("OIDC_ISSUER"));
  // Plain HTTP is only ever accepted for an identity provider on this machine
  // (local development and tests), never for a real address.
  const options = LOOPBACK.has(issuer.hostname) ? { execute: [client.allowInsecureRequests] } : undefined;
  return client.discovery(issuer, required("OIDC_CLIENT_ID"), required("OIDC_CLIENT_SECRET"), undefined, options);
}

// The platform gives apps no session key, so one is derived from the OIDC
// client secret: nothing to store, and rotating that secret signs everyone out.
function derivedKey(info: string): string {
  return Buffer.from(hkdfSync("sha256", required("OIDC_CLIENT_SECRET"), "", info, 32)).toString("base64url");
}

// The "__Host-" prefix makes browsers refuse the cookie unless it is Secure,
// on the exact host and on path "/": apps on sibling subdomains cannot set it.
const prefix = import.meta.dev ? "" : "__Host-";
const cookie = { httpOnly: true, secure: !import.meta.dev, sameSite: "lax", path: "/" } as const;

export function sessionConfig(): SessionConfig {
  return {
    name: `${prefix}bivouac-session`,
    password: derivedKey("bivouac-app-session-v1"),
    // Groups are read at sign-in: a change takes effect within a day at most.
    maxAge: 24 * 60 * 60,
    cookie,
    sessionHeader: false,
  };
}

// Holds the one-time values of a sign-in in progress, for ten minutes.
export function loginConfig(): SessionConfig {
  return {
    name: `${prefix}bivouac-login`,
    password: derivedKey("bivouac-app-login-v1"),
    maxAge: 10 * 60,
    cookie,
    sessionHeader: false,
  };
}

export function callbackUrl(event: H3Event): URL {
  // Host is passed on by the reverse proxy, which only routes declared names;
  // the identity provider also refuses any address not registered for this app.
  const { protocol, host } = getRequestURL(event, { xForwardedProto: true });
  return new URL(`${protocol}//${host}/auth/callback`);
}

// Only a path on this site: "//evil.example" and "/\evil.example" are URLs
// on another site for a browser.
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return "/";
  return value;
}
