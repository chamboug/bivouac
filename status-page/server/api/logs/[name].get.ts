import { createError, defineEventHandler, getQuery, getRouterParam, setHeader } from "h3";

export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const name = getRouterParam(event, "name") ?? "";
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) throw createError({ statusCode: 400, statusMessage: "Invalid container name" });
  const lines = Math.min(1000, Math.max(1, Number(getQuery(event).lines) || 200));
  const answer = await reconciler(`/v1/logs/${name}?lines=${lines}`);
  if (answer.status === 404) throw createError({ statusCode: 404, statusMessage: "No such container" });
  if (!answer.ok) throw createError({ statusCode: 502, statusMessage: `The reconciler answered ${answer.status}` });
  // Shown as text by the page, never as HTML.
  setHeader(event, "content-type", "text/plain; charset=utf-8");
  return answer.text();
});
