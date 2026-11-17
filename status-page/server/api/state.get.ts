import { createError, defineEventHandler } from "h3";

export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const answer = await reconciler("/v1/state");
  if (!answer.ok) throw createError({ statusCode: 502, statusMessage: `The reconciler answered ${answer.status}` });
  return answer.json();
});
