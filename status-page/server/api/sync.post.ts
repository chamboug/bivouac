import { createError, defineEventHandler } from "h3";

// The page's only action (D3). The shared layer refuses it from another origin.
export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const answer = await reconciler("/v1/sync", { method: "POST" });
  if (answer.status === 429) return { started: false, reason: "A sync was asked for less than 10 seconds ago." };
  if (!answer.ok) throw createError({ statusCode: 502, statusMessage: `The reconciler answered ${answer.status}` });
  const body = (await answer.json()) as { started: boolean };
  return { started: body.started, reason: body.started ? null : "A pass is already running." };
});
