import { createError, defineEventHandler, getRouterParam, setResponseHeaders } from "h3";
import { useStorageFiles } from "../../utils/storage";

// Files are served through a route, behind sign-in. An app whose files are
// not visible to every signed-in user adds its own access check here.
export default defineEventHandler(async (event) => {
  let content: Uint8Array | null;
  try {
    content = await useStorageFiles().get(getRouterParam(event, "key", { decode: true }) ?? "");
  } catch {
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
  if (!content) throw createError({ statusCode: 404, statusMessage: "Not found" });
  // Always a download, never rendered: an uploaded HTML file must not run on
  // the app's own address.
  setResponseHeaders(event, {
    "content-type": "application/octet-stream",
    "content-disposition": "attachment",
    "x-content-type-options": "nosniff",
  });
  return content;
});
