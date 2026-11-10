import { pipeline } from "node:stream/promises";
import { createError, defineEventHandler, getRouterParam, setResponseHeaders } from "h3";
import { StorageError, useStorageFiles, type StoredFile } from "../../utils/storage";

// Files are served through a route, behind sign-in. An app whose files are
// not visible to every signed-in user adds its own access check here.
export default defineEventHandler(async (event) => {
  let file: StoredFile | null;
  try {
    file = await useStorageFiles().open(getRouterParam(event, "key", { decode: true }) ?? "");
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
