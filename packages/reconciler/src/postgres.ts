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
          await admin.query(`CREATE EXTENSION IF NOT EXISTS ${pg.escapeIdentifier(extension)}`);
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

async function withClient<T>(
  server: PostgresServer,
  database: string,
  user: string,
  password: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ host: server.host, port: server.port, database, user, password });
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
