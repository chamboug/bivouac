import pg from "pg";

/** A database and the role that owns it. Names are validated by the manifest schema. */
export interface DatabaseSpec {
  name: string;
  password: string;
  extensions: string[];
}

export interface PostgresServer {
  host: string;
  port: number;
  superuserPassword: string;
}

/**
 * Brings one database to its spec and returns what it changed:
 *
 * - a login role named like the database, with the derived password;
 * - the database, owned by that role, that no other role may connect to
 *   (`REVOKE CONNECT ... FROM PUBLIC`);
 * - the declared extensions.
 *
 * Nothing is ever dropped (D18). Whether the password is right is checked by
 * logging in with it, since Postgres only keeps a salted hash.
 */
export async function ensureDatabase(server: PostgresServer, spec: DatabaseSpec): Promise<string[]> {
  const changes: string[] = [];
  const role = pg.escapeIdentifier(spec.name);
  await withClient(server, "postgres", "postgres", server.superuserPassword, async (admin) => {
    const roles = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [spec.name]);
    if (roles.rowCount === 0) {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD ${pg.escapeLiteral(spec.password)}`);
      changes.push(`role ${spec.name}`);
    }
    const databases = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [spec.name]);
    if (databases.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${role} OWNER ${role}`);
      changes.push(`database ${spec.name}`);
    }
    // Cheap and harmless to repeat: no other role can ever connect.
    await admin.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${role} FROM PUBLIC`);
    if (!(await canLogIn(server, spec)) && roles.rowCount !== 0) {
      await admin.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${pg.escapeLiteral(spec.password)}`);
      changes.push(`password of ${spec.name}`);
    }
  });
  if (spec.extensions.length > 0) {
    await withClient(server, spec.name, "postgres", server.superuserPassword, async (admin) => {
      const present = await admin.query<{ extname: string }>("SELECT extname FROM pg_extension");
      const installed = new Set(present.rows.map((row) => row.extname));
      for (const extension of spec.extensions) {
        if (!installed.has(extension)) {
          // Installed in public; pg_catalog is still searched first, being left out.
          await admin.query("SET search_path = public");
          await admin.query(`CREATE EXTENSION IF NOT EXISTS ${pg.escapeIdentifier(extension)}`);
          await admin.query("SET search_path = pg_catalog");
          changes.push(`extension ${extension} in ${spec.name}`);
        }
      }
    });
  }
  return changes;
}

async function canLogIn(server: PostgresServer, spec: DatabaseSpec): Promise<boolean> {
  try {
    await withClient(server, spec.name, spec.name, spec.password, async () => {});
    return true;
  } catch (error) {
    // 28P01: invalid_password. Anything else is a real problem.
    if ((error as { code?: string }).code === "28P01") return false;
    throw error;
  }
}

/**
 * Apps may not connect to the databases every server has (`postgres`,
 * `template1`), where they could list every role and database. The
 * reconciler and Pocket ID are unaffected: the first is superuser, the
 * second only uses its own database. Cheap and harmless to repeat.
 */
export async function closePlatformDatabases(server: PostgresServer): Promise<void> {
  await withClient(server, "postgres", "postgres", server.superuserPassword, async (admin) => {
    await admin.query("REVOKE CONNECT, TEMPORARY ON DATABASE postgres, template1 FROM PUBLIC");
  });
}

/**
 * An empty database for a restore, beside the live one: owned by the app's
 * role, closed to every other role, with the app's declared extensions.
 * The name must be one no app can have (`bivouac_…`, D56). A leftover of an
 * earlier restore under that name is replaced: it was never in use.
 */
export async function createRestoreTarget(server: PostgresServer, target: string, owner: string, extensions: string[]): Promise<void> {
  await withClient(server, "postgres", "postgres", server.superuserPassword, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(target)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(target)} OWNER ${pg.escapeIdentifier(owner)}`);
    await admin.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${pg.escapeIdentifier(target)} FROM PUBLIC`);
  });
  if (extensions.length === 0) return;
  await withClient(server, target, "postgres", server.superuserPassword, async (admin) => {
    await admin.query("SET search_path = public");
    for (const extension of extensions) await admin.query(`CREATE EXTENSION IF NOT EXISTS ${pg.escapeIdentifier(extension)}`);
    await admin.query("SET search_path = pg_catalog");
  });
}

export async function databaseExists(server: PostgresServer, name: string): Promise<boolean> {
  return withClient(server, "postgres", "postgres", server.superuserPassword, async (admin) => {
    return ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount ?? 0) > 0;
  });
}

/**
 * Puts the restored database in the live one's place, in one transaction:
 * either both renames happen or neither does, so the app's name always
 * points to a whole database. The live one is kept under `previous`,
 * never dropped (D18). Sessions still open on either are closed first; the
 * app itself is already stopped.
 */
export async function swapDatabases(server: PostgresServer, live: string, restored: string, previous: string): Promise<void> {
  await withClient(server, "postgres", "postgres", server.superuserPassword, async (admin) => {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1) AND pid <> pg_backend_pid()", [[live, restored]]);
    const exists = ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [live])).rowCount ?? 0) > 0;
    await admin.query("BEGIN");
    try {
      if (exists) await admin.query(`ALTER DATABASE ${pg.escapeIdentifier(live)} RENAME TO ${pg.escapeIdentifier(previous)}`);
      await admin.query(`ALTER DATABASE ${pg.escapeIdentifier(restored)} RENAME TO ${pg.escapeIdentifier(live)}`);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  });
}

/** Total size of these databases, an upper bound for their uncompressed dumps. */
export async function databasesBytes(server: PostgresServer, names: string[]): Promise<number> {
  return withClient(server, "postgres", "postgres", server.superuserPassword, async (admin) => {
    const result = await admin.query<{ total: string }>("SELECT coalesce(sum(pg_database_size(datname)), 0) AS total FROM pg_database WHERE datname = ANY($1)", [names]);
    return Number(result.rows[0]?.total ?? 0);
  });
}

/** One number from one database, read as superuser. */
export async function countIn(server: PostgresServer, database: string, sql: string): Promise<number> {
  return withClient(server, database, "postgres", server.superuserPassword, async (admin) => {
    const result = await admin.query<{ count: string }>(sql);
    return Number(result.rows[0]?.count ?? 0);
  });
}

async function withClient<T>(
  server: PostgresServer,
  database: string,
  user: string,
  password: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    host: server.host,
    port: server.port,
    database,
    user,
    password,
    // A database that stops answering must not hold the reconciler forever.
    connectionTimeoutMillis: 15_000,
    query_timeout: 120_000,
    // The owner of a database can set its search_path, and that setting would
    // apply to the superuser too: an app could get its own functions run with
    // the superuser's rights. Startup options win over database settings.
    ...(user === "postgres" ? { options: "-c search_path=pg_catalog" } : {}),
  });
  await client.connect();
  try {
    if (user === "postgres") {
      // Statements carrying a password (CREATE/ALTER ROLE) must never be
      // copied into the server log if they fail.
      await client.query("SET log_min_error_statement = panic; SET log_statement = none");
    }
    return await work(client);
  } finally {
    await client.end();
  }
}

/** `postgres://role:password@host:port/database`, as given to an app (D19). */
export function connectionString(server: Pick<PostgresServer, "host" | "port">, spec: DatabaseSpec): string {
  return `postgres://${spec.name}:${spec.password}@${server.host}:${server.port}/${spec.name}`;
}

/** Postgres identifiers cannot contain `-`: an app's database is its name with `_`. */
export function databaseName(app: string): string {
  return app.replaceAll("-", "_");
}
