import { createError, type H3Event } from "h3";

/**
 * The reconciler's internal API (D8): given to this page by the platform as
 * BIVOUAC_API_URL and BIVOUAC_API_TOKEN. The token never leaves the server
 * side of this page.
 */
export async function reconciler(path: string, init: { method?: string } = {}): Promise<Response> {
  const url = process.env.BIVOUAC_API_URL;
  const token = process.env.BIVOUAC_API_TOKEN;
  if (!url || !token) throw createError({ statusCode: 503, statusMessage: "The reconciler's API is not configured" });
  try {
    return await fetch(`${url}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw createError({ statusCode: 502, statusMessage: "The reconciler does not answer" });
  }
}

/**
 * The identity provider already lets only these groups in (the client's
 * allowed groups); checked again here, so a mistake there does not open the
 * page to every invited user.
 */
export function requireAdmin(event: H3Event): void {
  const allowed = (process.env.BIVOUAC_STATUS_GROUPS ?? "").split(",").filter(Boolean);
  const groups = event.context.user?.groups ?? [];
  if (allowed.length === 0 || !groups.some((group) => allowed.includes(group))) {
    throw createError({ statusCode: 403, statusMessage: "Reserved to the platform's admins" });
  }
}
