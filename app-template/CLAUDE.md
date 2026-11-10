# App on Bivouac

A Nuxt app hosted on a Bivouac platform. The platform runs this image and provides its database, sign-in and backups.

## The contract

- The image listens on `PORT` (3000 by default) and answers on `/api/health`. If the health check fails after a deployment, the platform goes back to the previous image.
- The platform provides `DATABASE_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, according to the manifest. Do not rename them.
- **Migrations run at startup and are additive only**: add tables and columns, never drop or rename in the same deployment. A destructive change takes two deployments, so that the previous image keeps working. Change `server/db/schema.ts`, then `npm run db:generate`, and commit the generated files.

## Sign-in

- The sign-in and database code is shared by all apps and comes from the versions named in `nuxt.config.ts`: do not copy it into the app. A change to it belongs in the Bivouac monorepo (`app-layers/`). Renovate updates them when a new version is published. No other dependency is updated automatically: leave versions alone unless there is a reason.
- The shared code protects **everything by default**: pages redirect to sign-in, `/api/*` answers 401. Only its own list of paths is public (health, sign-in, assets): a public page needs a change in the monorepo, on purpose. Files in `public/` and the client bundles are readable by anyone: no private data there.
- Requests that change something (POST, PUT, DELETE…) are refused unless they come from the app's own pages. Keep state changes off GET.
- The tests are what allows sign-in fixes to reach this app on their own: do not remove or weaken them.
- On the server, the user is `event.context.user` (`sub`, `name`, `email`, `groups`). In a page: `useUser()`.
- Who can enter is decided by the manifest's `groups`. Roles inside the app are mapped from `user.groups`.
- Identify users by `sub`, never by email.

## User files

- Never use `fs` directly: only `useStorageFiles()` from `server/utils/storage.ts`.
- The database stores keys (`photos/123.jpg`), never paths or full URLs. Keys have no hidden segments (`.x`).
- `put` and `get` hold the whole file in memory: small files only (a few MB). The server's memory is small and shared by every app. Larger files arrive in parts of about 8 MB (`createUpload`, `uploadPart`, `completeUpload`; every part but the last at least `MIN_PART_SIZE`, none above `MAX_PART_SIZE`) and are read with `open`, as a Node stream sent with `pipeline` (see `server/api/files/`).
- **The module keeps files inside the app's directory; it does not know who owns what.** The app makes keys itself, on the server. When an upload starts, it stores (upload ID, key, owner) in the database, and every later call takes them from there, never from the request: otherwise one user could overwrite another's file.
- A route receiving a part refuses the request **before** reading its body when `content-length` is missing or above `MAX_PART_SIZE` (answer 411 or 413): otherwise a client could send gigabytes into memory.
- A failed `completeUpload` is not retried: start a new upload.
- Call `cleanupUploads(24 * 60 * 60 * 1000)` now and then (when an upload starts, for example), and limit how much each user may store: a full disk stops the database of every app.
- Files are served through an app route (`server/api/files/`). If files are not meant for every signed-in user, check access there.
- The directory must be declared as a volume in the manifest: `volumes: { uploads: /app/uploads }`. Anything written elsewhere is lost at the next deployment and is not backed up.

## Interface

Nuxt UI: use the `nuxt-ui` MCP server (`.mcp.json`), or `https://ui.nuxt.com/llms.txt`, rather than memory.

## Deployment

Pushing to `main` runs the tests, builds the image and opens a PR on the instance repo changing the image in the manifest. Nothing is built on the server.

## Working locally

```bash
npm ci
npm run dev
npm test
```

`npm run test:e2e` needs `npm run build` first and a Postgres in `DATABASE_URL`.
