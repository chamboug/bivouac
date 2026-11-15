import { pipeline } from "node:stream/promises";
import { createError, defineEventHandler, getRouterParam, setResponseHeaders, type H3Event } from "h3";
import { StorageError, useStorageFiles, type StoredFile } from "../../utils/storage";

/**
 * Who may download a file: **the app decides**, from its own records (who
 * uploaded it, which shared list it belongs to...), never from the request.
 * Refused by default, so a new app cannot serve every member's files to every
 * other member by forgetting this. For files truly meant for everyone signed
 * in, return true.
 */
function mayRead(_event: H3Event, _key: string): boolean | Promise<boolean> {
  // The template's own end-to-end tests only (playwright.config.ts): the platform never sets it.
  return process.env.TEMPLATE_TEST_FILES_OPEN === "1";
}

// Files are served through a route, behind sign-in, and only after mayRead.
export default defineEventHandler(async (event) => {
  const key = getRouterParam(event, "key", { decode: true }) ?? "";
  // The same answer as a missing file: a refusal says nothing about what exists.
  if (!(await mayRead(event, key))) throw createError({ statusCode: 404, statusMessage: "Not found" });
  let file: StoredFile | null;
  try {
    file = await useStorageFiles().open(key);
  } catch (error) {
    // Only a bad key is the visitor's fault; anything else is a real failure, logged as such.
    if (error instanceof StorageError && error.code === "invalid-key") throw createError({ statusCode: 404, statusMessage: "Not found" });
    throw error;
  }
  if (!file) throw createError({ statusCode: 404, statusMessage: "Not found" });
  // Always a download, never rendered: an uploaded HTML file must not run on
  // the app's own address.
  setResponseHeaders(event, {
    "content-type": "application/octet-stream",
    "content-disposition": "attachment",
    "content-length": String(file.size),
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
    "cache-control": "private, no-store",
  });
  // Node's pipeline, not h3's sendStream: it waits for slow clients, so a
  // large file is never piled up in memory, and stops reading the file when
  // the client goes away.
  // The response is ours from here: h3 must not try to answer as well.
  event._handled = true;
  try {
    await pipeline(file.body, event.node.res);
  } catch (error) {
    // The headers are gone: nothing more can be answered. A client leaving
    // mid-way is normal; anything else is logged.
    if ((error as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") {
      console.error("File download failed mid-way:", (error as Error).message);
    }
  }
});
