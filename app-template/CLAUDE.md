# App on Bivouac

A Nuxt app hosted on a Bivouac platform. The platform runs this image and provides its database, sign-in and backups.

## The contract

- The image listens on `PORT` (3000 by default) and answers on `/api/health`. If the health check fails after a deployment, the platform goes back to the previous image.
- The platform provides `DATABASE_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, according to the manifest. Do not rename them.
- **Migrations run at startup and are additive only**: add tables and columns, never drop or rename in the same deployment. A destructive change takes two deployments, so that the previous image keeps working. Change `server/db/schema.ts`, then `npm run db:generate`, and commit the generated files.

## Sign-in

- The sign-in and database code is shared by all apps and comes from the versions named in `nuxt.config.ts`: do not copy it into the app. A change to it belongs in the Bivouac monorepo (`app-layers/`). Renovate proposes new versions.
- The shared code protects **everything by default**: pages redirect to sign-in, `/api/*` answers 401. Only its own list of paths is public (health, sign-in, assets): a public page needs a change in the monorepo, on purpose. Files in `public/` and the client bundles are readable by anyone: no private data there.
- Requests that change something (POST, PUT, DELETE…) are refused unless they come from the app's own pages. Keep state changes off GET.
- On the server, the user is `event.context.user` (`sub`, `name`, `email`, `groups`). In a page: `useUser()`.
- Who can enter is decided by the manifest's `groups`. Roles inside the app are mapped from `user.groups`.
- Identify users by `sub`, never by email.

## User files

- Never use `fs` directly: only `useStorageFiles()` from `server/utils/storage.ts`.
- The database stores keys (`photos/123.jpg`), never paths or full URLs.
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
