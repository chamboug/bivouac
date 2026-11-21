import * as client from "openid-client";
import { defineEventHandler, deleteCookie, sendRedirect, useSession } from "h3";
import { callbackUrl, oidcConfig, sessionConfig } from "../../utils/oidc";

export default defineEventHandler(async (event) => {
  const session = await useSession<{ idToken?: string }>(event, sessionConfig());
  const idToken = session.data.idToken;
  await session.clear();
  const { name, cookie } = sessionConfig();
  deleteCookie(event, name!, cookie === false ? undefined : cookie);
  // Also end the session at the identity provider: otherwise the next page
  // would sign the user straight back in. With the ID token as proof, Pocket
  // ID ends it at once and sends the browser back here; without it, Pocket ID
  // only asks the user to confirm, and closing that page keeps them signed
  // in for up to 30 days (D102).
  const config = await oidcConfig();
  if (!config.serverMetadata().end_session_endpoint) return sendRedirect(event, "/", 303);
  if (!idToken) return sendRedirect(event, client.buildEndSessionUrl(config).href, 303);
  const target = client.buildEndSessionUrl(config, {
    id_token_hint: idToken,
    post_logout_redirect_uri: new URL("/", callbackUrl(event)).href,
  });
  return sendRedirect(event, target.href, 303);
});
