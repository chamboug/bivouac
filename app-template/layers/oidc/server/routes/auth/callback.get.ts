import * as client from "openid-client";
import { createError, defineEventHandler, deleteCookie, getRequestURL, sendRedirect, useSession } from "h3";
import { callbackUrl, loginConfig, oidcConfig, safeReturnTo, sessionConfig } from "../../utils/oidc";

interface LoginData {
  verifier?: string;
  state?: string;
  nonce?: string;
  returnTo?: string;
}

export default defineEventHandler(async (event) => {
  const login = await useSession<LoginData>(event, loginConfig());
  const { verifier, state, nonce, returnTo } = login.data;
  // One attempt per sign-in, whatever happens next.
  await login.clear();
  const { name, cookie } = loginConfig();
  deleteCookie(event, name!, cookie === false ? undefined : cookie);
  if (!verifier || !state || !nonce) {
    throw createError({ statusCode: 400, statusMessage: "No sign-in in progress" });
  }

  const current = callbackUrl(event);
  current.search = getRequestURL(event).search;

  let claims: client.IDToken | undefined;
  try {
    const tokens = await client.authorizationCodeGrant(await oidcConfig(), current, {
      pkceCodeVerifier: verifier,
      expectedState: state,
      expectedNonce: nonce,
      idTokenExpected: true,
    });
    claims = tokens.claims();
  } catch (error) {
    console.error("Sign-in failed:", error instanceof Error ? error.message : "unknown error");
    throw createError({ statusCode: 403, statusMessage: "Sign-in failed" });
  }
  if (!claims) throw createError({ statusCode: 403, statusMessage: "Sign-in failed" });

  const session = await useSession(event, sessionConfig());
  await session.clear();
  await session.update({
    user: {
      sub: claims.sub,
      name: String(claims.name ?? claims.preferred_username ?? claims.email ?? claims.sub),
      email: typeof claims.email === "string" ? claims.email : undefined,
      groups: Array.isArray(claims.groups) ? claims.groups.map(String) : [],
    },
  });
  return sendRedirect(event, safeReturnTo(returnTo), 302);
});
