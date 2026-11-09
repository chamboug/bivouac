import { createError, defineEventHandler, getHeader, getRequestURL, getSession, sendRedirect } from "h3";
import { sessionConfig, type SessionUser } from "../utils/oidc";

// Everything requires a signed-in user, unless listed here. A new page or
// route is therefore protected without anyone having to think about it.
// (Files in public/ are the exception: they are served before this runs.)
const PUBLIC_PATHS = new Set([
  "/api/health",
  "/favicon.ico",
  // Nuxt renders error pages through this internal path.
  "/__nuxt_error",
  "/auth/login",
  "/auth/callback",
  "/auth/logout",
]);

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.has(path) || path.startsWith("/_nuxt/") || path.startsWith("/_fonts/");
}

// The router sees the path as sent, this check sees it normalized: a path
// with ".." would be judged on one and served on the other. No real link
// contains one, so they are refused outright.
const DOT_SEGMENT = /(^|\/|\\|%2f|%5c)(\.|%2e){1,2}(\/|\\|%2f|%5c|$)/i;

// All apps share one registrable domain, so browsers send the cookie on
// requests coming from a sibling app: SameSite does not separate them.
function isSameOrigin(fetchSite: string | undefined, origin: string | undefined, host: string | undefined): boolean {
  if (fetchSite) return fetchSite === "same-origin";
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

declare module "h3" {
  interface H3EventContext {
    user?: SessionUser;
  }
}

export default defineEventHandler(async (event) => {
  if (DOT_SEGMENT.test((event.node.req.url ?? "").split("?")[0]!)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid path" });
  }
  if (
    event.method !== "GET" &&
    event.method !== "HEAD" &&
    !isSameOrigin(getHeader(event, "sec-fetch-site"), getHeader(event, "origin"), getHeader(event, "host"))
  ) {
    throw createError({ statusCode: 403, statusMessage: "Cross-origin request refused" });
  }

  const url = getRequestURL(event);
  if (isPublic(url.pathname)) return;

  const session = await getSession<{ user?: SessionUser }>(event, sessionConfig());
  if (session.data.user) {
    event.context.user = session.data.user;
    return;
  }

  if (url.pathname.startsWith("/api/") || event.method !== "GET") {
    throw createError({ statusCode: 401, statusMessage: "Sign-in required" });
  }
  const returnTo = encodeURIComponent(url.pathname + url.search);
  return sendRedirect(event, `/auth/login?returnTo=${returnTo}`, 302);
});
