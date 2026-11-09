import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

let connection: ReturnType<typeof postgres> | undefined;
let migrated = false;

export function markMigrated(): void {
  migrated = true;
}

export function isMigrated(): boolean {
  return migrated;
}

export function sql() {
  if (!connection) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    connection = postgres(url, { max: 5 });
  }
  return connection;
}

export function useDb() {
  return drizzle(sql());
}
