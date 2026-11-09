import { createError, defineEventHandler } from "h3";
import { isMigrated, sql } from "../utils/db";

export default defineEventHandler(async () => {
  if (!isMigrated()) throw createError({ statusCode: 503, statusMessage: "Starting" });
  try {
    await sql()`select 1`;
  } catch {
    throw createError({ statusCode: 503, statusMessage: "Database unreachable" });
  }
  return { status: "ok" };
});
