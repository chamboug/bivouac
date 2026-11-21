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

## MCP for Claude (optional)

- With `mcp: true` in the app's manifest, the platform sets `MCP_RESOURCE` and Claude can connect to `/mcp`, signing in through the identity provider (D85). Without it, `/mcp` answers 404.
- The shared code checks the access token before the app sees the request: a route at `server/routes/mcp.ts` finds the person in `event.context.user`, and `event.context.mcp` is true. Refuse the request when it is not (the cookie never opens `/mcp`). The session cookie's origin check does not apply there: tokens are never sent by browsers on their own.
- Use `@modelcontextprotocol/sdk`, stateless (`sessionIdGenerator: undefined`, JSON answers), one small server per request. Every tool acts as that person, with the same rules as the pages: name the person's `sub` in every query. Mark tools that change or delete things (`destructiveHint`), and tell Claude in the server's instructions to ask before deleting.
- Read the body with a size limit before handing it to the transport.
- Tests: the fake identity provider hands out tokens at `/test/access-token?aud=<MCP_RESOURCE>&client_id=<OIDC_CLIENT_ID>-mcp` (see `test/e2e/mcp.spec.ts`).

## User files

- Never use `fs` directly: only `useStorageFiles()` from `server/utils/storage.ts`.
- The database stores keys (`photos/123.jpg`), never paths or full URLs. Keys have no hidden segments (`.x`).
- `put` and `get` hold the whole file in memory: small files only (a few MB). The server's memory is small and shared by every app. Larger files arrive in parts of about 8 MB (`createUpload`, `uploadPart`, `completeUpload`; every part but the last at least `MIN_PART_SIZE`, none above `MAX_PART_SIZE`) and are read with `open`, as a Node stream sent with `pipeline` (see `server/api/files/`).
- **The module keeps files inside the app's directory; it does not know who owns what.** The app makes keys itself, on the server. When an upload starts, it stores (upload ID, key, owner) in the database, and every later call takes them from there, never from the request: otherwise one user could overwrite another's file.
- A route receiving a part refuses the request **before** reading its body when `content-length` is missing or above `MAX_PART_SIZE` (answer 411 or 413): otherwise a client could send gigabytes into memory.
- A failed `completeUpload` is not retried: start a new upload.
- Call `cleanupUploads(24 * 60 * 60 * 1000)` now and then (when an upload starts, for example), and limit how much each user may store: a full disk stops the database of every app.
- Files are served through an app route (`server/api/files/`), which refuses every file until the app writes `mayRead` there: decide from the app's own records (who uploaded it, who it is shared with), never from the request. Return true only for files meant for every signed-in user.
- The directory must be declared as a volume in the manifest: `volumes: { uploads: /app/uploads }`. Anything written elsewhere is lost at the next deployment and is not backed up.

## Interface

Nuxt UI: use the `nuxt-ui` MCP server (`.mcp.json`), or `https://ui.nuxt.com/llms.txt`, rather than memory.

- **Every app lets the person choose its theme**: automatic (follows the device), light or dark. The template's home page has `UColorModeSelect` in its header; keep it there or move it to a settings page reachable from every screen, never remove it. The choice is kept on the device. `app/app.vue` sets the browser's `theme-color` to the page's background for the chosen theme: keep it. Check every screen in both themes.
- Write the app in its people's language: `htmlAttrs.lang` in `nuxt.config.ts`, `lang` in the web manifest, and Nuxt UI's locale on `UApp` (`<UApp :locale="fr">` with `import { fr } from "@nuxt/ui/locale"`), which also translates the theme choice.

## Phone and icon

The app can be added to a phone's home screen and then opens like an app (`public/manifest.webmanifest`, `display: standalone`).

- **Its own name and icon, from the first version.** Replace "App" in `nuxt.config.ts` (`title`) and in the web manifest (`name`, `short_name` of 12 characters at most, `theme_color` and `background_color`). Draw `public/icon.svg` for this app: a full square with its own background (no rounded corners, no transparency: phones cut the shape themselves), the drawing inside the central circle 80% wide, simple enough to read at 32 pixels. Then `npm run icons` draws the PNGs (favicon, iPhone, Android) and commit them all. Leaving the template's tent makes every app look the same on the home screen.
- **Opened from the home screen, there is no browser bar**: no address, no back or reload button, no tabs. So every screen other than the home one has its own way back (a back button in its header, or a tab bar); no screen is a dead end, error pages included (a link home); nothing relies on reloading to show fresh data; links to other sites open in a new tab (`target="_blank"`), otherwise they take the app's place.
- A bar fixed to the bottom of the screen sits under the iPhone's home bar: add `viewport-fit=cover` to the viewport and pad the bar with `env(safe-area-inset-bottom)`, then check on a real phone.
- iOS takes the home-screen icon from `apple-touch-icon`, not from the manifest; Android from the manifest. To try the installed version: on the Mac, Chrome's "Install" in the address bar on `http://localhost:3000` opens it in its own window, without the browser bar.
- `public/` is readable by anyone, signed in or not: the icon and manifest hold nothing private.

## Deployment

Pushing to `main` runs the tests, builds the image and, when the repo holds the deployment token, opens a PR on the instance repo changing the image in the manifest; that PR usually merges by itself, so a push puts the version online with no one else looking. Without the token, the platform's admin changes the image by hand. Nothing is built on the server.

## How a change is made

1. Run `dev:local` and let the person who asked try the change in their own browser at `http://localhost:3000`; change, let them try again, until they say it is right. Your own checks (light, dark, phone width, each role) come before their try, never instead of it.
2. Then `npm test`, `npm run build`, `npm run test:e2e`, and commit.
3. Before a push that touches who sees or changes what, files or uploads, fetching addresses users type, or the database's structure, a fresh agent, one that did not write the change, reviews it: no one reaches another person's data (pages, API, files, MCP); the files route decides from the app's records; nothing changes on GET; no secret or personal data in the code or the bundles; no fetch reaches private addresses; migrations only add. Check its findings yourself, fix what matters, and tell the person what is left.
4. Push only once the person has agreed.

## Working locally

```bash
npm ci
npm run dev:local   # the app on http://localhost:3000, signed in as "Dev"
npm test
```

Check changes here, never on the real server. `dev:local` needs Docker: it starts a Postgres (`<folder>-dev-pg`, kept between runs, reachable from this machine only), applies the migrations, signs in through the tests' fake identity provider and reloads on every change. The fake person's groups come from `DEV_GROUPS` (`famille` by default; set it to the groups the app maps to roles). Check every interface change there, in light and dark and at phone width, before pushing. Claude Code's preview starts it from `.claude/launch.json`.

Do not run `npm run build` while `dev:local` runs: it downloads the shared layers again and breaks the dev server. Stop it first, or restart it afterwards. Another app's `dev:local` at the same time needs other ports (`DEV_APP_PORT`, `DEV_PG_PORT`, `DEV_ISSUER_PORT`).

`npm run test:e2e` needs `npm run build` first and a Postgres in `DATABASE_URL`. With the dev Postgres, use a database of its own so the tests do not mix with your trial data: `docker exec <folder>-dev-pg createdb -U postgres e2e 2>/dev/null || true`, then `DATABASE_URL=postgres://postgres:dev@localhost:55433/e2e npm run test:e2e`.

After restarting `dev:local` with other `DEV_GROUPS`, sign out or use a private window: the old session may keep the old groups.
