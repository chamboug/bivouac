import { migrate } from "drizzle-orm/postgres-js/migrator";
import { markMigrated, useDb } from "../utils/db";

// Migrations run at startup and are additive only. The server already listens
// while they run, so the health check answers 503 until they are finished. If
// one fails the process stops: the health check never passes, and the
// platform goes back to the previous image.
export default defineNitroPlugin(() => {
  if (import.meta.dev || import.meta.prerender) {
    markMigrated();
    return;
  }
  migrate(useDb(), { migrationsFolder: process.env.MIGRATIONS_DIR ?? "server/db/migrations" }).then(markMigrated, (error) => {
    console.error("Migration failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
});
