---
name: new-app
description: Create a new web app hosted on a Bivouac server, from the idea to its first sign-in. Use when someone wants to start a new app ("new app", "nouvelle app"), not to change an existing one.
---

# New app

Takes one idea to a running app at `https://<name>.<apps domain>`. The person may write apps without running the server, and may not know what a container or a manifest is. Talk to them in their language and in plain words; explain a term the first time it matters, or avoid it.

**Two roles.** The *author* writes the app. The *admin* runs the Bivouac server and keeps its *platform repo*: the private Git repo that describes everything the server runs. They may be the same person. Unless the author is the admin, everything the server needs ends up as one message the author forwards to the admin.

**Covers** Nuxt apps whose users sign in with the platform's accounts (`auth: oidc`), the only kind the app template builds. For an app open to the public, with its own accounts, or in another framework, stop after step 1: say plainly that the platform needs work first, and draft the request to the admin.

## 0. Check the machine

Needed: `git` with a way to push to GitHub, Node 26 or later, Docker running (to try the app locally). Optional: `gh`, signed in (`gh auth status`); without it, the person does a few steps in the browser, from links you give. Say what is missing and how to install it; do not go on without the three needed.

## 1. Agree on the app (one round)

One message, with a proposal for each answer:

- what the app does, in two sentences, and for whom;
- **its name**. It becomes the address, the GitHub repo, the database and the image at once, so the repo must have exactly this name, and the platform refuses a bad one only after all of these exist. Check every rule now: lowercase letters, digits and hyphens; starts with a letter; ends with a letter or digit; at most 40 characters; no `--`; does not start with `archived`, `bivouac` or `pg-`; does not end with `-mcp`; not one of `auth`, `gate`, `status`, `postgres`, `template0`, `template1`, `public`, `none`, `current-user`, `current-role`, `session-user`;
- **who may enter**: one or more groups of the platform's accounts (for example `<name>` for users and `<name>-admin` for those who manage it); the server creates new groups itself;
- **what it keeps**: what the database holds; whether people upload files (photos, documents), and roughly how big;
- whether Claude may use the app on someone's behalf (an MCP: Claude signs in as that person and sees only their data);
- **the server**: does the person run it? If yes, where is the platform repo on this machine? If not, who does, and what is the apps' address (for example `apps.example.org`), if they know it;
- **where the repo lives on GitHub**. Recommend the GitHub organization the admin uses for apps, with the author as a member: the server downloads app images with the admin's GitHub access, which reaches the admin's own account and organizations, not the author's personal account. If the author still wants their own account, the admin will have to be given read access to the image (GitHub: the package's settings, *Manage access*). Also ask whether anyone else will change the code.

Keep the answers: they become the app's `CLAUDE.md` and, if needed, the message to the admin.

## 2. Plan the data

Before any code, write down with the person:

- **tables**: what each holds, and who owns each row. A row a person owns carries their account ID (`sub`), never their email;
- **files**: only through the template's storage module, never `fs`. The database stores a key (`photos/123.jpg`), never a path or an address. Files are served by an app route that checks who may read each one. They live in one declared directory (a *volume*), the only place that is kept and backed up. Set a size limit per file and per person: a full disk stops every app on the server;
- **changes over time**: within one version the database only grows (new tables and columns). Dropping or renaming takes two versions, so the previous one keeps working if the new one is rolled back.

## 3. The GitHub repo

Private, empty (no README, licence or `.gitignore`), named exactly `<name>`. With `gh`: `gh repo create <account>/<name> --private`, after saying what it does. Without: give `https://github.com/new` (owner `<account>`, name `<name>`, private) and wait for "done".

## 4. Copy the template

The template is in the public Bivouac repo; reading it needs no account.

```bash
tmp=$(mktemp -d)
git clone --depth 1 https://github.com/chamboug/bivouac "$tmp"
mkdir <folder>/<name>
git -C "$tmp" archive HEAD app-template | tar -x -C <folder>/<name> --strip-components=1
```

`<folder>` is where the person keeps projects (ask); stop if `<name>` already exists there. `git archive` takes only the files under version control. Note the template's commit (`git -C "$tmp" rev-parse --short HEAD`), then remove `$tmp`.

In the app's folder:

1. `git init -b main`, with the Git identity already set on the machine; remote `<account>/<name>` on GitHub, over SSH or HTTPS, as their Git already does. Check it now with `git ls-remote origin`: an error here means pushing will fail too.
2. First commit, the template untouched: "Start from the Bivouac app template (<commit>)". Later diffs then show only what the app changed.
3. `npm pkg set name=<name>`, then `npm install --package-lock-only` so the lockfile follows; commit.
4. At the top of `CLAUDE.md`, a "This app" section: what it does, groups and roles, the data plan of step 2, MCP or not. Keep the template's sections: they are the platform's rules.

The rest happens in a session opened in that folder: only there does Claude load the app's `CLAUDE.md`, the Nuxt UI tools (`.mcp.json`) and the preview (`.claude/launch.json`). Unless this session already is in it, tell the person to open one there and to call this skill again; it resumes at step 5. Write in the "This app" section which step comes next.

## 5. Build the app

Read the app's `CLAUDE.md` first. Work the way web developers do: a local server the person uses in their own browser, and nothing leaves the machine until they agree.

1. `npm ci`, then `DEV_GROUPS=<group>,<name>-admin npm run dev:local` (the groups of the fake signed-in person, comma-separated; without it, the person is in no group of this app). Give the person the address, `http://localhost:3000`, to open themselves. Keep it running for the whole step. To try another role, restart with other groups, then sign out or use a private window (the old session may keep the old groups).
2. The loop: change the code (the schema in `server/db/schema.ts`, then `npm run db:generate`; pages with Nuxt UI, through the `nuxt-ui` MCP, not from memory). The page reloads by itself. Say in one or two lines what changed and what to try; the person tries it and says what to change; again. Check light, dark, phone width and each role yourself before handing over, never in place of their try.
3. Early on, the app's own name and icon (its `CLAUDE.md`, "Phone and icon"): propose a drawing for `public/icon.svg`, let the person look at it, then `npm run icons`. The theme choice (automatic, light, dark) stays reachable; every screen but the home one has its own way back, since the app opened from a phone's home screen has no browser bar.
4. Tests along the way: keep the template's; add unit tests of who may see and change what, and one Playwright test of the main path.
5. Only when the person says it is right: `npm test`; stop `dev:local`; `npm run build`; then the end-to-end tests on a database of their own in the dev Postgres, which keeps running:
   ```bash
   docker exec <folder name>-dev-pg createdb -U postgres e2e 2>/dev/null || true
   DATABASE_URL=postgres://postgres:dev@localhost:55433/e2e npm run test:e2e
   ```
   (`<folder name>` in lowercase; another port if `DEV_PG_PORT` was set.) Then commit, saying what changed. Never push in this step: the first push comes after the review of step 6, and every later push only once the person has tried the change and agreed.

A small first version that works; the rest comes later.

## 6. Security review

Before the first push, a fresh agent, one that did not write the code, reads the app against this list; check each finding yourself before acting on it:

- no one reaches another person's data, through pages, API, files or the MCP: every query names the signed-in person or checks a group;
- the files route decides from the app's records, never from the request; uploads are limited;
- nothing changes on a GET;
- no secret or personal data in the code, in `public/` or in what the browser downloads;
- anything that fetches an address a user typed cannot reach private addresses;
- database changes only add.

Fix what matters. Tell the person in plain words what is left and why it is acceptable: an unlikely threat is named and offered for acceptance, not coded against.

## 7. First push and first image

`git push -u origin main`. GitHub tests the app and builds its image. With `gh`: `gh run watch`. Without: give `https://github.com/<account>/<name>/actions` and ask what it shows. Take the image's exact name from the run's log or the repo's *Packages*: `ghcr.io/<account in lowercase>/<name>:sha-<7 characters>`. "Propose deployment" then says there is nothing to propose (no deployment token, or the server does not know the app yet): expected.

## 8. Tell the server about the app

The server runs the app once the platform repo holds `apps/<name>.yml`, the app's *manifest*:

```yaml
# <Name>: <what it does, one line>.
# Repo <account>/<name>; <who may change its code>.
name: <name>
image: ghcr.io/<account in lowercase>/<name>:sha-<7>
database: {}
auth: oidc
groups: [<group>, <name>-admin]
volumes: { uploads: /app/uploads }   # only if it stores files
mcp: true                            # only if agreed
```

- **The author is the admin**: write it, and follow the platform repo's own rules (its `CLAUDE.md`) to push it or open a pull request; with no rules, open a pull request. Within minutes the server creates the database, the sign-in and the address: wait for `https://<name>.<apps domain>/api/health` to answer 200 (the apps domain is in the platform repo).
- **Someone else is**: write one message they can forward as is, in the person's language: what the app is, the repo, the manifest above, the groups and who goes in them, and step 9 with its warning. Then stop, and say what happens next: the app is online once the admin has done it.

## 9. Last settings (the admin)

1. **How new versions go online.** By default the admin does it: for each version the author tells them, and they change the `image:` line of the manifest.
   Automatic deployment needs the admin's deployment token in the app repo (*Settings, Secrets and variables, Actions*: variable `INSTANCE_REPO` = the platform repo as `owner/name`, secret `BIVOUAC_DEPLOY` = the token). **Whoever can push to that repo can then take over the server**, through that token. So only when all of these hold: the repo is in the admin's organization, and only the admin owns that organization; everyone with write access to the repo, and every GitHub app that can write to it, is trusted with the server (Renovate included: it can probably read the token); no deploy key can write to it; the organization requires two-factor authentication and its base permission is Read or None; workflows from forks get no secrets and no write token. Say this to the admin in plain words; the choice is theirs.
2. In the platform's accounts, put people in the app's groups, or invite newcomers with a link tied to those groups.
3. If Renovate covers only selected repositories of that account, add this one: it brings fixes of the shared sign-in code. The platform repo's rules may ask for more first.
4. Sign in at `https://<name>.<apps domain>` and try it.

With the token set, the next push to the app's `main` opens a "Deploy <name>" pull request on the platform repo, which merges by itself when only the app changed. The image of step 7 is already online: nothing changes until that next push.

## 10. Record

- The app's `CLAUDE.md` is its memory from now on: keep its "This app" section true.
- Later changes follow its section "How a change is made": the person tries each change locally and agrees before any push, and a sensitive change gets the review of step 6 again. Say so to the person: with automatic deployment, nobody else looks at a version before it goes online. If "Propose deployment" ever warns that the server does not know the app, tell the admin.
- The admin notes the new app wherever the platform repo keeps its history.
- If the template or this skill was wrong somewhere, say so: the fix belongs in the Bivouac repo.
