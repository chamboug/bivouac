import { defineEventHandler, deleteCookie, sendRedirect, useSession } from "h3";
import { oidcConfig, sessionConfig } from "../../utils/oidc";

export default defineEventHandler(async (event) => {
  const session = await useSession(event, sessionConfig());
  await session.clear();
  const { name, cookie } = sessionConfig();
  deleteCookie(event, name!, cookie === false ? undefined : cookie);
  // Also end the session at the identity provider: otherwise the next page
  // would sign the user straight back in.
  const endpoint = (await oidcConfig()).serverMetadata().end_session_endpoint;
  return sendRedirect(event, endpoint ?? "/", 303);
});
