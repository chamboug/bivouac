import * as client from "openid-client";
import { defineEventHandler, getQuery, sendRedirect, useSession } from "h3";
import { callbackUrl, loginConfig, oidcConfig, safeReturnTo } from "../../utils/oidc";

export default defineEventHandler(async (event) => {
  const config = await oidcConfig();
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();

  const login = await useSession(event, loginConfig());
  await login.update({ verifier, state, nonce, returnTo: safeReturnTo(getQuery(event).returnTo) });

  const target = client.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl(event).href,
    scope: "openid profile email groups",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return sendRedirect(event, target.href, 302);
});
