# Decision log

One short entry per decision: context, choice, rejected alternatives. Entries D1 to D40 come from the Q&A session on the project brief (3–5 November 2026). A decision revised later keeps its number, and the revision is added underneath, dated.

"Verified" means a source was checked at decision time; sources are listed in [`CLAUDE.md`](../CLAUDE.md).

---

### D1 — Repo layout
- **Context**: the brief did not say where the CLI and the reconciler would live.
- **Choice**: a public monorepo `bivouac` (CLI, reconciler, schema, templates, docs), and one private instance repo `bivouac-platform` per installation.
- **Rejected**: a private monorepo with public GHCR packages and the CLI as a Docker image (possible, but `npx` would require authentication, and the repo would lose its showcase value).

### D2 — Reconciler trigger
- **Context**: the brief hesitated between a webhook and a pass every minute.
- **Choice**: poll Git every minute, with a read-only deploy key.
- **Rejected**: webhook (one more public endpoint and secret, to gain at best one minute).

### D3 — On-demand sync
- **Context**: the owner wanted to be able to force a deployment.
- **Choice**: `POST /sync` on the reconciler's internal API, without parameters, at most once every 10 s, exposed by a status page button and by an MCP tool. It is the only write action of that API.
- **Rejected**: nothing; the risk is low, since the call only brings an idempotent pass forward.

### D4 — Where rule 7's memory lives
- **Context**: the monorepo is public, and the operations log contains production details.
- **Choice**: `CLAUDE.md` and the decision log in the public monorepo, written as a product ("operations delegated to a supervised agent"), with nothing personal. The operations log and a short `CLAUDE.md` in the private instance repo.
- **Rejected**: keeping everything private.

### D5 — Deploying a new app version
- **Context**: the manifest pins an image tag, but nothing said who updates it. Principle 4 of the brief also contradicted rule 2.
- **Choice**: after the build, the app repo's workflow opens a PR on `bivouac-platform`, merged automatically if CI is green. Principle 4 is aligned with rule 2.
- **Rejected**: Renovate (verified: one run every 4 hours on the free plan, and it cannot order `sha-…` tags); a moving `:main` tag (no longer "as code").

### D6 — Runtime
- **Context**: the CLI and the reconciler are written in TypeScript.
- **Choice**: Node LTS everywhere.
- **Rejected**: Bun and Deno (less well known, against rule 9).

### D7 — No secrets in Ignition
- **Context**: the brief put the age key in Ignition, hence in the Hetzner user-data. Verified: user-data can be read from the server at `http://169.254.169.254/hetzner/v1/userdata`.
- **Choice**: Ignition contains only public keys, the sshd config and the systemd unit. The age key and the deploy key are placed over SSH by `bivy`. The metadata service is blocked from Docker networks.
- **Rejected**: secrets in user-data.
- **Revised (7 November 2026)**: the block is a small nftables table of our own rather than a `DOCKER-USER` rule (D62).

### D8 — Docker socket and status page
- **Context**: the status page is exposed (behind Pocket ID) but must read health and logs.
- **Choice**: only the reconciler has the socket; it exposes a read-only internal API, reachable only from the Docker network.
- **Rejected**: mounting the socket in the status page.

### D9 — Restore testing
- **Context**: the brief listed the rebuild test as "not a priority", although restoring is the number-one criterion.
- **Choice**: an automatic test every week (`restic check`, then the latest dump restored into a temporary Postgres), and a full rebuild as a condition for moving to prod (see D39).
- **Rejected**: never testing.

### D10 — Auth modes in v1
- **Context**: the brief announced three modes and listed four.
- **Choice**: `oidc`, `forward`, `public` and `local`, all in v1.
- **Rejected**: postponing `local`.

### D11 — Claude's SSH key
- **Context**: Claude has no persistent identity.
- **Choice**: a dedicated `bivouac-claude` key on the owner's Mac, separate from his own. Accepted limitation: login as `core` (sudo, Docker), so read-only is a matter of discipline.
- **Rejected**: a truly read-only user (illusory, since reading Docker logs already requires root-equivalent access).

### D12 — Managing authorized SSH keys
- **Context**: Ignition runs only on first boot.
- **Choice**: one key per machine and per use, never copied. Public keys are listed in `bivouac-platform` and synced by the reconciler into `authorized_keys.d`. Every change is a high-risk PR.
- **Rejected**: keys only in Ignition (a rebuild for every addition); a private key shared between machines.

### D13 — Domain scheme
- **Context**: the domain is `example.org`.
- **Choice**: `*.apps.example.org`.
- **Rejected**: `*.bivouac.example.org` (the project name would be baked into the passkeys); `*.example.org` (the session cookie would be shared with the whole domain).

### D14 — Derived secrets
- **Context**: per-database `pg_dump` does not back up roles; Pocket ID lets you choose an OIDC client's secret (verified).
- **Choice**: every secret generated by the platform is `HMAC(master secret, "<use>:<app>")`. The master secret is in SOPS. Rotation is done with a version suffix.
- **Rejected**: storing generated secrets in a table or file that must be backed up.

### D15 — Protecting Pocket ID's `/setup`
- **Context**: `/setup` creates the first admin for whoever gets there first (verified).
- **Choice**: Caddy only allows `/setup` from the owner's IP during `bivy init`, then the route is removed.
- **Rejected**: relying on being fast.
- **Revised (8 November 2026)**: only the exception for the owner's IP is removed once the admin exists. `/setup` and `/api/signup/setup` stay refused for good: it costs nothing, and it covers an empty Pocket ID after a reinstallation.

### D16 — restic to B2
- **Context**: verified, the restic docs recommend B2's S3 API over the native B2 backend.
- **Choice**: the S3-compatible API.
- **Rejected**: the native B2 backend; rclone.

### D17 — Private app images
- **Context**: verified, GHCR only accepts classic PATs.
- **Choice**: private app images, pulled with a classic `read:packages` PAT without expiration, stored in SOPS.
- **Rejected**: public images (the owner's choice).

### D18 — Removing an app
- **Choice**: a final `pg_dump` sent to restic with the `archive` tag, then the database and the volume are renamed `archived_<app>_<date>`. Actual deletion only happens on the owner's explicit action.
- **Rejected**: automatic deletion.

### D19 — Framework-agnostic platform contract
- **Context**: a Next app and third-party apps (Node-RED, Grafana) are planned.
- **Choice**: the manifest describes any image (port, health, `env` with values provided by the platform, `name → path` volumes, optional database).
- **Rejected**: one app type per framework.

### D20 — Backing up apps that store their data in files
- **Choice**: the `backup: { stop: true }` option stops the container for a few seconds during the nightly backup. Off by default.
- **Rejected**: copying live (risk of inconsistent SQLite files).

### D21 — Rollback and migrations
- **Choice**: a failed image is marked and not retried until the manifest changes. Migrations are additive only and run at startup; a destructive migration takes two deployments.
- **Rejected**: retrying on every pass (redeploy loop); rolling migrations back.

### D22 — Static sites
- **Choice**: files in the instance repo's `sites/<name>/`, served directly by Caddy, without a container.
- **Rejected**: one Docker image per HTML page.

### D23 — A single app template
- **Choice**: a Nuxt-only template. Apps in another framework (the owner's Next app) follow the contract by hand.
- **Rejected**: a Next template, as long as there is no second Next app.

### D24 — Server and IP
- **Context**: the owner has a CX23 with the IPv4 `203.0.113.10`, which can be wiped.
- **Choice**: wipe this server to install Flatcar and reuse the IP as a Primary IP (`auto_delete=false`), with explicit confirmation before destruction. `example.org` and `www.example.org` serve a static page.
- **Rejected**: a second server during a migration (nothing important runs on the current one).
- **Revised (6 November 2026)**: verified (Hetzner API): the CX23 can no longer be ordered in `fsn1`, the IP's location (still available in `nbg1` and `hel1`, an indicator without guarantee), and a Primary IP only goes to a server in its own location. A new CX23 costs €5.49 excl. VAT a month, while the current server is billed at an older price (€4.79 incl. VAT). The server is therefore **reinstalled in place** with Hetzner's `rebuild` action (snapshot and Ignition as `user_data`): same server, type, location, price and IP. Rejected: moving to `nbg1` with a new IP (higher price, one more DNS change, for the only benefit of exercising the "new server with an existing Primary IP" path, which `bivy rebuild --test` can exercise with a temporary IP). **Open for `bivy rebuild`**: if the server is lost and no CX23 is available in `fsn1`, choose between another type in `fsn1` (the cheapest available x86 one was €23.39 incl. VAT) and another location with a new IP and a DNS update. **Note (7 November 2026)**: the CX23 was then available in no location at all (`fsn1`, `nbg1`, `hel1`); the cheapest available x86 type with a 40 GB disk was the `cpx12` (€0.02208/hour incl. VAT).

### D25 — Server architecture
- **Choice**: x86 (the existing CX23).
- **Rejected**: Arm (CAX), which would require building every image for multiple architectures.

### D26 — IPv4 required
- **Context**: verified on 4 November 2026, GitHub (`github.com`, `api.github.com`, `ghcr.io`) and Brevo (`smtp-relay.brevo.com`) have no IPv6 address.
- **Choice**: keep IPv4 (€0.50/month), with IPv6 on top.
- **Rejected**: an IPv6-only server; a public NAT64 gateway.

### D27 — Settings behind Caddy
- **Context**: verified, Pocket ID's `TRUST_PROXY` is a list of IPs or CIDRs, not a boolean.
- **Choice**: `TRUST_PROXY` and Tinyauth's `TRUSTEDPROXIES` limited to Caddy's subnet. Tinyauth runs with `ACLS_POLICY=deny`.
- **Rejected**: `TRUST_PROXY=true`.
- **Revised (6 November 2026)**: `TRUST_PROXY` is Caddy's single fixed address on the internal network, not a subnet: apps share a subnet with Caddy and could otherwise pass for it (D56).

### D28 — Komodo and doco-cd
- **Choice**: rejected; the container part stays custom code (about a hundred lines with the Docker API).
- **Rejected**: Komodo and doco-cd (one more component, with its own UI and its own state).

### D29 — Postgres major versions
- **Choice**: Renovate excludes them. They are upgraded through a dump-then-restore procedure, as a high-risk change.
- **Rejected**: letting Renovate propose the image change (Postgres would refuse to start).

### D30 — Server access to the instance repo
- **Choice**: a read-only deploy key, created by `bivy` through the GitHub API and placed over SSH. During a rebuild, the new one is created before the old one is revoked.
- **Rejected**: deploy key in SOPS (chicken and egg: the repo must be read to decrypt it).
- **Revised (8 November 2026)**: the key is generated on the server, and added to GitHub by hand for now (D66).

### D31 — How `bivy` reaches the APIs
- **Context**: neither `gh`, `hcloud` nor `sops` is installed on the owner's Mac.
- **Choice**: `bivy` talks directly to the official APIs. It connects to GitHub with a temporary fine-grained PAT (7 days), created through a pre-filled link and never stored.
- **Rejected**: depending on `gh`; an OAuth App with device flow (one more component).
- **Note (9 November 2026)**: `gh` is now on the owner's Mac for Claude's own work (D78). `bivy` still does not depend on it.

### D32 — Claude's access to the platform MCP
- **Choice**: the reconciler serves a stdio MCP, launched over SSH. Nothing is publicly exposed.
- **Rejected**: an MCP exposed by the status page with `@nuxtjs/mcp-toolkit` (it would require OAuth authentication of MCP clients against Pocket ID, which from memory is not supported).
- **Note (11 November 2026)**: the "from memory" was wrong. Pocket ID v2.19 issues access tokens for MCP clients (verified, D85), and apps now open an MCP that way. The platform MCP itself stays on SSH: it holds the Docker socket's power, and SSH keys already guard it.

### D33 — Scheduling backups
- **Choice**: the reconciler triggers the nightly backups and the restore test, running restic in an ephemeral container.
- **Rejected**: a dedicated cron container (one more component); a systemd timer placed by Ignition (cannot be updated without a rebuild).

### D34 — Reserved names
- **Choice**: `auth`, `gate` and `status` are rejected by CI as app names.

### D35 — CI does not decrypt secrets
- **Context**: the brief planned SOPS decryption in CI, which would require giving the age key to GitHub.
- **Choice**: CI checks, without the key, that every secrets file is encrypted and well-formed. Actual decryption is checked by the reconciler and by the restore test.
- **Rejected**: the age key in GitHub Actions secrets.

### D36 — Deployment token for app repos
- **Context**: verified, on GitHub Free organization secrets are not available to private repos.
- **Choice**: a fine-grained `bivouac-deploy` PAT, limited to `bivouac-platform` and stored in SOPS, set on each app repo by the "new app" skill. The age key is therefore also on the owner's Mac.
- **Rejected**: the age key in the private repo (a single leak would expose every secret); a GitHub organization (organization secrets are not available to private repos on the free plan).

### D37 — Decisions postponed until before prod
- **Choice**: the email login code and alerting (channel, tools) will be decided before moving to prod. In the meantime, no email code (Pocket ID's default) and no external monitor.
- **Revised (5 November 2026)**: alerting is decided by D45 and built in the safety-net layer, before any real data. The email login code is still postponed.

### D38 — Lost machine and CLI reminders
- **Choice**: `bivy machine add` generates a key and opens the PR adding it, removing the lost key if needed. If the Mac is lost, secrets are rotated with the owner's consent. `bivy init` blocks until the age key is declared stored, and reminds the owner to store the restic password and the GitHub recovery codes. The only lockout scenario would be losing both GitHub access and the password manager.

### D39 — Low-cost rebuild test
- **Choice**: `bivy rebuild --test` creates a temporary server billed by the hour, restores, checks, then destroys everything. It never touches the real IP or DNS. It is a condition for moving to prod.
- **Rejected**: a permanent second VPS.

### D40 — Auth hostnames
- **Choice**: Pocket ID on `auth.apps.example.org` (final, visible in the passkey dialog), Tinyauth on `gate.apps.example.org`.
- **Rejected**: `id.apps.example.org`, `connexion.apps.example.org`, `idp.apps.example.org` (jargon).

### D41 — Language
- **Context**: the monorepo is public and meant as a showcase; French would limit its audience. The owner reads English, but finds the subject hard even in French. (5 November 2026)
- **Choice**: the public monorepo is entirely in English, including PRs (English only, in plain language for rule 3). Conversations with the owner stay in French. The private instance repo stays in French.
- **Rejected**: a French public repo; a mixed repo; two versions of the brief (they would drift apart); a French summary section in public PRs.

### D42 — Resource usage display
- **Context**: the owner wants to see CPU, RAM and disk usage. (5 November 2026)
- **Choice**: the reconciler samples host and container usage every minute into a small Postgres table kept 30 days; the status page shows current values and history. The pre-prod alerting decision must include a disk alert above 80%.
- **Rejected**: current values only (no history); Prometheus + Grafana (two more components, several hundred MB of RAM, from memory).

### D43 — Environments
- **Context**: should there be a dedicated dev instance? (5 November 2026)
- **Choice**: no permanent extra instance. Apps are developed locally against the end-to-end test platform; a `<app>-preview` manifest tries an app on the real server; platform changes go through end-to-end CI and `bivy rebuild --test`.
- **Rejected**: a permanent dev instance (the owner's first idea: a second server to pay for and maintain, with separate Pocket ID accounts).

### D44 — Maintenance promise and building in layers
- **Context**: maintenance must stay minimal: the owner does not want to run infrastructure by hand. Reviewing the project (5 November 2026), two risks stood out: "zero maintenance" cannot be met by anything connected to the internet (security fixes, changing third-party APIs, end-of-life versions, expiring tokens or cards), and a platform this large risks being abandoned halfway, or forgotten until nobody dares touch it. The owner still wants to build Bivouac as a real personal project, not a minimal setup.
- **Choice**: the promise becomes "zero config, maintenance that is rare, guided and never silent": a few interventions a year, each announced by an alert and handled in one Claude session and one merged PR. Alerts move to the start of the build, alongside backups (D45). The build order is reorganized in layers, each useful on its own, with a first real app at step 4; the CLI automates a written runbook that comes first. The four auth modes stay in scope, but `forward` and `local` are built when an app needs them, which revises "all in v1" in D10. `bivy rebuild --test` is run before prod, then every 3 months, with a reminder sent by the reconciler.
- **Rejected**: aiming for a platform that never needs touching (impossible, and it hides the cost); a minimal Compose-only setup with no CLI or reconciler (the owner wants the product as a personal project); a managed PaaS such as Railway, Fly.io or Render (cost per app, no shared login for the family).

### D45 — Alerts: Pushover and healthchecks.io
- **Context**: D37 postponed the alerting channel. The owner already has a Pushover account. Verified (pushover.net/api and /pricing, 5 November 2026): POST to `https://api.pushover.net/1/messages.json` with an application token and a user key, no OAuth; 10,000 messages per month per account, shared by all its applications, then HTTP 429 until the 1st of the month; $4.99 one-time purchase per platform, no subscription for individuals; priority 1 bypasses quiet hours, priority 2 repeats until acknowledged; at most 2 concurrent requests, no retry on a 4xx. Verified (healthchecks.io, same day): free plan with 20 checks and a native Pushover integration. Verified by DNS lookup: both services have IPv4 and IPv6.
- **Choice**: Pushover is the only alert channel. The reconciler sends what it can see itself (failed deployment or rollback, disk above 80%, backup or restore test failure, secrets that fail to decrypt, the quarterly rebuild-test reminder), one alert per change of state with at most one reminder a day. healthchecks.io is the dead man's switch for what a dead server cannot report: nightly backup, weekly restore test, reconciler heartbeat. The Pushover token, user key and ping URLs are in SOPS. Default priority, priority 1 for a full disk and a silent server; priority 2 is not used.
- **Rejected**: email alerts (easy to miss, and they depend on Brevo, itself something that can fail); an alert on every reconciler pass (would use up the quota in a week); UptimeRobot for now (the heartbeat and the per-app health checks cover the essentials); a self-hosted monitor (it would go down with the server).
- **Accepted limitation**, from memory, to be checked: healthchecks.io's addresses appear to be at Hetzner, so a Hetzner-wide outage could silence the switch along with the server.

### D46 — License
- **Context**: the monorepo is public; without a license, nobody may legally reuse the code. The owner hesitated between MIT and AGPLv3. (5 November 2026)
- **Choice**: MIT for the whole monorepo. The app template lives in this repo and every app created from it copies its code; under AGPL, anyone using the template would have to offer their app's source to its users, which would make the template useless to others. The scenario AGPL protects against (a company reselling the software as a hosted service without sharing changes) is unlikely for a self-hosting tool.
- **Rejected**: AGPLv3 (see above); AGPL for the platform with MIT for the templates (two licenses in one repo, complexity for little benefit).

### D47 — Monorepo tooling
- **Context**: start of the foundations layer (5 November 2026). Versions verified the same day: Node 26 is the active LTS (nodejs.org release index), TypeScript 7.0.2, Zod 4.6.7, Vitest 5.1.0, Butane v0.29.0, SOPS v3.13.3.
- **Choice**: npm workspaces (npm ships with Node, nothing else to install), TypeScript in strict mode, Zod for the manifest schema, Vitest for tests, Node 26 LTS. Butane runs in its official container, like SOPS later (D31).
- **Rejected**: pnpm (stricter about undeclared dependencies and faster, but one more tool to install on the Mac, in CI and in images, for a repo with a handful of packages).

### D48 — Instance repo validation rules
- **Context**: the first version of `bivy validate`, run by the instance repo's CI on every PR (5 November 2026).
- **Choice**:
  - The instance repo's workflow calls a reusable workflow in the public monorepo, so improving the checks needs no change in the instance. Verified (GitHub docs): a workflow stored in a public repository can be called from any repository.
  - Images must name an exact version (tag or digest); `latest` is refused, since rolling back to the previous image (D21) needs exact images.
  - `oidc` and `forward` require at least one group: an app without groups would let every Pocket ID account in. Groups are refused where they have no effect (`public`, `local`).
  - Unknown fields are refused, so a typo is never silently ignored. So are files in `apps/` or `sites/` that are not `.yml`, and a manifest whose `name` differs from its file name.
  - `ssh-keys.yml` is the only list of SSH keys: Butane holds none, they are appended to it when generating Ignition. An empty list is refused (it would lock everyone out), and so is a private key.
  - Secrets: every file in `secrets/` must be SOPS-encrypted with no value left in plain text, and encrypted for exactly the age keys in `.sops.yaml`. Format verified by encrypting a sample with SOPS v3.13.3. Any file containing an age or SSH private key fails validation, wherever it is.
  - Butane is compiled with `--strict`: a warning fails the check. This caught a real trap: a YAML 1.2 parser reads `mode: 0600` as decimal 600, while Butane reads it as octal. The CLI therefore never re-serializes the Butane file.
- **Not yet**: `caddy validate` on the generated Caddyfile comes with the reconciler, which generates it (layer 2).
- **Revised (6 November 2026)**: done. `bivy validate` generates the Caddyfile with the same code as the reconciler and runs `caddy validate` (Caddy 2.11.9, in its container) on it; like Butane, a warning fails the check.

### D49 — OVH API key scope
- **Context**: the owner creates the OVH keys used for DNS (5 November 2026). Verified (OVHcloud API guide and the official `python-ovh` README): script credentials are created at `https://api.eu.ovhcloud.com/createToken/` (the brief still had the older `eu.api.ovh.com`), rights can be pre-filled in the URL, and three keys are issued (application key, application secret, consumer key).
- **Choice**: rights limited to GET, POST and PUT on `/domain/zone/example.org/*`, unlimited validity. No DELETE: a record to remove is removed by hand in the OVH interface, or the right is added when a real need appears. Stricter than the brief, which planned `/domain/zone*` (every zone of the account).
- **To check at first use**, with a read before any write: that this path covers creating records, updating the SPF record and the zone refresh.
- **Rejected**: rights on every zone (needless access to the owner's other domains); DELETE "just in case".
- **Checked (8 November 2026)**: creating a record and the zone refresh both work with this scope. The SPF update is still to be exercised (step 10).

### D50 — Reconciler versions
- **Context**: the Butane started the reconciler with the moving `:main` tag, against D5 and D48 (exact versions only). Ignition only runs on first boot, so it cannot carry later versions. (6 November 2026)
- **Choice**: CI publishes `ghcr.io/<owner>/bivouac-reconciler:sha-<7 characters>` after the tests pass on `main`. The Butane starts an exact version; afterwards, the version to run is declared in the instance repo's `platform.yml` (Renovate can propose updates). The reconciler writes it to a file read by its systemd unit and restarts on the new image. Observed: the package was anonymously pullable right after its first publication, although the GitHub docs say a new package is private by default.
- **Accepted limitation (MVP)**: a broken new version cannot roll itself back; it is fixed over SSH, then in Git. The end-to-end tests in CI are the safeguard. To revisit before prod.
- **Status**: built (7 November 2026, D60, D61).
- **Rejected**: keeping `:main` (no exact rollback); a rebuild for every reconciler version.

### D51 — Postgres image
- **Context**: the brief planned an image shipping PostGIS and pgvector. Verified (Docker Hub, 6 November 2026): Postgres 18 is the current major (19 is at rc1); the official `postgis/postgis:18-3.7` image does not include pgvector.
- **Choice**: `postgis/postgis:18-3.7`, without pgvector. An image of our own (PostGIS + pgvector) will be built in CI the day an app needs pgvector.
- **Rejected**: building our own image now (one more thing to maintain, for no app).
- **Note (6 November 2026)**: verified, the image has no arm64 build. On an Apple Silicon Mac the local platform runs it under amd64 emulation (slower first start, works).

### D52 — Pocket ID settings
- **Context**: verified (Pocket ID docs and swagger, v2.19.2 is the latest release, 6 November 2026): port 1411; `TRUST_PROXY` is `false`, `true` or a list of IPs/CIDRs; `STATIC_API_KEY` (at least 16 characters, admin rights) and `ENCRYPTION_KEY` have `_FILE` variants; `ALLOW_INSECURE_CALLBACK_URLS` defaults to `true`; the health check is the `/app/pocket-id healthcheck` command; an OIDC client's chosen secret is set through `POST /api/oidc/clients/{id}/secrets` (at least 16 characters), not at creation. The docs site describes the unreleased version: every call is checked against v2.19.2 by the end-to-end tests.
- **Choice**: `TRUST_PROXY` set to Caddy's Docker subnet only (D27), `ALLOW_INSECURE_CALLBACK_URLS=false`, secrets passed as `_FILE`. D14 still holds.
- **Revised (6 November 2026)**: the API was checked on a real v2.19.2 container, and the end-to-end tests check it again on every change. Findings: creating a client also creates a random secret, and a client can hold several; `PUT /api/oidc/clients/{id}` replaces the whole client, and leaving out `isGroupRestricted` turns it off and empties the allowed groups; setting the allowed groups alone does not turn the restriction on. The reconciler therefore always sends the full client with `isGroupRestricted: true`, then the groups, then leaves exactly one secret: the derived one, checked against the token endpoint (`invalid_grant` for a right secret with a bogus code, `invalid_client` for a wrong one). Also set, from the v2.19.2 source: `FILE_BACKEND=database` (uploads go into Postgres and its backups, no volume), `ANALYTICS_DISABLED=true` (no heartbeat to analytics.pocket-id.org), and `DB_CONNECTION_STRING_FILE`. `AUTO_CREATE_OIDC_CLIENT_SECRET` exists but is an application setting, not reliable from the environment. The container drops to UID 1000.

### D53 — Generated Caddyfile
- **Context**: the reconciler generates the Caddyfile (6 November 2026).
- **Choice**: upstreams are reached by container name on the shared Docker network (`bivouac-pocket-id:1411`, `bivouac-app-<name>:<port>`); Caddy's admin API listens only inside its container (`admin localhost:2019`) and the reconciler reloads it with `docker exec`. Pocket ID's first-admin page and API (`/setup`, `/api/signup/setup`) are always refused, except from the IP in `platform.yml`'s `auth.setupFrom` during installation (D15); verified with `caddy adapt` that the refusal is evaluated before the proxy. Auth `forward` and static sites are refused with an error until they are built, instead of being served unprotected.
- **To check on the server**: that Caddy sees the client's real IP, including over IPv6 (Docker's userland proxy would replace it with the gateway's).

### D54 — Reconciler pass rules
- **Context**: first version of the reconciler (6 November 2026).
- **Choice**: the checkout is a shallow clone, then fetch and hard reset with `git clean`, so a change made by hand on the server never survives a pass. A commit that fails validation applies nothing: the server keeps the last valid state. Generated files are written atomically and only when they change, so a pass with no change does nothing. GitHub's SSH host keys are pinned in the image (from `api.github.com/meta`), and SSH refuses any other key.

### D55 — Reconciler: containers through the Docker API
- **Context**: step 5 of layer 2, the reconciler runs the base services and the apps (6 November 2026). Verified: Docker 29.7 accepts API 1.40 to 1.55; Flatcar stable 4757.2.3 ships Docker 28.2.2. Pull, create, start, inspect (health) and exec work over the socket with plain HTTP; exec output is multiplexed in 8-byte-header frames.
- **Choice**:
  - The Docker Engine API is spoken with Node's own HTTP module, pinned to API 1.48 (checked at startup; verified 7 November 2026 in Docker's API version matrix: 1.48 is Docker 28.0's, and Docker 28.2 accepts up to 1.50), with timeouts (15 min for a pull, 2 for anything else). Postgres through node-postgres, the reconciler's only new dependency.
  - Each container carries a fingerprint of its full spec (and of the secret files it reads) in a label; a pass recreates it only when the fingerprint changes. Images are pulled only when missing, so base images are pinned by digest (Renovate bumps them).
  - Base services (Postgres, Pocket ID, Caddy) use Docker health checks and come up in order. Apps are checked over HTTP by the reconciler itself, so an image needs no `curl`; redirects are not followed. Caddy routes to an app only once it is healthy; a new container that fails is stopped and stays stopped until the manifest changes (D21). Rolling back to the previous image is layer 6.
  - Caddy is reloaded with `docker exec caddy reload`; if it refuses the file, the previous Caddyfile is put back. Health checks use `127.0.0.1`: in Caddy's image `localhost` is `::1`, where the admin API does not listen (observed).
  - Generated files live in `/var/lib/bivouac`, mounted at the same path on the host and in the reconciler, since the containers it creates name host paths; checked at startup.
  - Logs: at most 3 × 10 MB per container.
- **Rejected**: a Docker library such as dockerode (rule 9); `psql` through `docker exec` (passwords on a command line); Docker health checks for apps (they need a tool inside the image).

### D56 — Network isolation and Postgres hardening
- **Context**: the rule 6 security review of step 5 (6 November 2026) found that apps shared a network with Pocket ID: on a fresh install, any app could call Pocket ID's first-admin API directly, bypassing Caddy, and with Docker's default `NET_RAW` capability (verified present on Docker 29.7) a compromised app could forge packets to impersonate Caddy or listen to the reconciler's calls carrying the admin API key.
- **Choice**:
  - Two networks with fixed subnets: `bivouac` (10.209.0.0/24: apps, Caddy, Postgres, reconciler) and `bivouac-internal` (10.209.1.0/24: Pocket ID, Caddy, Postgres, reconciler). Docker assigns addresses only from the upper half; Caddy has the fixed address 10.209.1.10, the only one Pocket ID trusts.
  - Every container drops `NET_RAW` and runs with `no-new-privileges`.
  - Apps may only ask for allowlisted extensions (PostGIS family, pg_trgm, unaccent, citext, pgcrypto, hstore, btree_gin, btree_gist, fuzzystrmatch): extensions are created by the superuser in a database the app owns, a known route to privilege escalation for untrusted scripts. App names that clash with Postgres (`pg-…`, `public`, `postgres`, `template1`…) or the platform (`bivouac…`) are refused. `CONNECT` on `postgres` and `template1` is revoked from everyone. The reconciler's superuser sessions never log failing statements (they may carry a password).
  - Inside its container, the Postgres image trusts local connections without a password (its default `pg_hba.conf`); only someone who can already run `docker exec` (root) benefits, so it stays. Tests check passwords over the network.
- **To check on the server**: apps reach the public issuer URL through the server's own public IP.
- **Rejected**: one network for everything (above); not starting apps before the first admin exists (protects only the setup page, not the rest).

### D57 — Platform secrets file
- **Choice**: `secrets/platform.sops.yaml` in the instance repo holds `master_secret` (at least 32 characters), `pocket_id.encryption_key` and `pocket_id.static_api_key` (at least 16). Other entries (tokens used by `bivy`) may sit next to them. It is decrypted by sops v3.13.3, copied from its official image (pinned by digest) into the reconciler's image; a decryption failure applies nothing, and no error message ever quotes decrypted text. Derived secrets are `HMAC-SHA256(master_secret, purpose)` in hexadecimal; purposes in use: `postgres:superuser`, `db:<database>`, `oidc:<app>`. Secrets reach Postgres and Pocket ID as read-only files (`_FILE` variables), without a trailing newline, in a per-service directory under a `secrets/` directory closed to all but root; apps receive theirs in the environment, as the contract requires (D19). The future internal API must never expose container environments.
- **Rejected**: Pocket ID's keys derived from the master secret (rotating the master secret would then lose Pocket ID's signing keys); changing file ownership per container (Docker Desktop's file sharing does not let the container's root bypass permissions, so it breaks the local platform).

### D58 — OIDC callback convention
- **Choice**: an `oidc` app's client accepts `https://<host>/auth/callback` on each of its hosts, and `https://<host>/` after logout; the client ID is the app's name. A platform convention for the app template (layer 4); a manifest field will come with the first third-party app that needs another path.

### D59 — Miniature platform and end-to-end tests
- **Context**: D43 calls for a local platform started with one command, shared with the end-to-end tests.
- **Choice**: the tests build the reconciler image from the checkout and run it (`main.js once`) against a throwaway instance repo with a generated age key and secrets, on the local Docker; the reconciler then creates the real base services and two test apps. One test file, in order, like passes on a server: base services and isolation, secrets, databases, OIDC clients, routes and injected variables, a failed deployment, idempotence and repair of manual changes (34 tests, about 2 minutes on a Mac). Domain `apps.bivouac.localhost`, for which Caddy uses its own local authority (verified). The CI job `e2e` runs them, and the reconciler image is only published when they pass. `npm run platform:up` starts the same platform with the reconciler running every 10 s (Caddy on 127.0.0.1:8443); `platform:down` removes everything named `bivouac…`, and refuses on a machine holding `/etc/bivouac/age.key`.
- **Not covered yet**: a real login with a passkey (Playwright and a virtual authenticator, with the app template, layer 4).

### D60 — The reconciler version and the repo address live in platform.yml
- **Context**: step 6 of layer 2 (7 November 2026). The Butane must start an exact reconciler version (D50) and give the reconciler its repo address (D55), but Ignition only runs once, and the same values are needed later.
- **Choice**: `platform.yml` gains `repository` (the repo's SSH address on GitHub, the only host whose keys the reconciler pins, D54) and `reconciler.image`: an exact `sha-<commit>` tag or a digest of `ghcr.io/<owner>/bivouac-reconciler`, never a moving tag (`:main` and `:latest` are refused) and never another image, since it gets the Docker socket. `bivy ignition` fills the `@@REPOSITORY@@` and `@@RECONCILER_IMAGE@@` placeholders of `butane/server.bu` with them (text replacement of schema-checked values, which hold no space, quote or newline; the file is still never re-serialized, D48), and refuses an Ignition config above Hetzner's 32 KiB user-data limit. The unit passes the image through `${BIVOUAC_RECONCILER_IMAGE}`, which systemd expands to exactly one argument (verified, systemd.service man page). The reconciler runs without `NET_RAW` and with `no-new-privileges`, like every container (D56).
- **Rejected**: the values written directly in the Butane (two places that drift apart, and a rebuild months later would start an old version); reading the address from `git remote` (depends on how the repo was cloned).

### D61 — How the reconciler updates itself
- **Context**: D50 left the mechanism open. Verified (systemd.exec man page, 7 November 2026): values from `EnvironmentFile=` override `Environment=`, and the file is read just before each start.
- **Choice**: the unit sets the installed version with `Environment=BIVOUAC_RECONCILER_IMAGE=…` and reads `EnvironmentFile=-/var/lib/bivouac/reconciler/image.env`. On each pass, right after fetching Git and **before** validating the instance (an older version may not understand a newer field, and would otherwise refuse every commit, its own update included), the reconciler reads `reconciler.image` on its own. If it names another version of the **same** image repository, it pulls it, runs `main.js selftest` in a throwaway container (no network, mount or capability: the image starts and finds git, ssh and sops), writes `image.env` (0600) and exits; `Restart=always` brings it back on the new version. Another publisher's image, or a version that fails its self-test, is refused, logged once and not retried until `platform.yml` changes (like D21).
- **Accepted limitation (MVP)**: a version that passes the self-test but crashes later is restarted every 10 seconds forever; apps, Caddy, Pocket ID and Postgres keep running, but deployments, repairs, the SSH key sync and (later) backups and alerts stop, and reverting `platform.yml` does not help since the broken version is the one that would read it. The fix is over SSH: delete `image.env`, which falls back to the installed version, which then reads Git again. The healthchecks.io heartbeat (D45) will report it once built. Downgrades to an older `sha-` of the same image are accepted and logged. Before prod: an automatic fallback after repeated crashes, and the image pinned by digest (a tag can be pushed again by whoever can publish to the package).
- **Open**: D50 says Renovate can propose reconciler versions, but `sha-…` tags cannot be ordered (D5). Until a versioning scheme exists, updates are PRs by Claude.
- **Rejected**: a `.path` unit restarting the service (one more unit, for what an exit already does); no self-test (a broken image would loop at once).

### D62 — Metadata block: an nftables table of our own
- **Context**: D7 planned a `DOCKER-USER` rule, and asked whether it survives Docker restarts. Verified (Flatcar source and image contents, 7 November 2026): on Flatcar, `iptables` is the nftables-backed `xtables-nft-multi`; `nft` is in `/usr/bin`; Docker 28.2.2 ships as a system extension. Docker's own documentation does not say what happens to `DOCKER-USER` on restart (its firewall pages answered 404).
- **Choice**: Ignition writes `/etc/bivouac-metadata-block.nft`: table `inet bivouac_metadata`, chain on the forward hook (priority filter − 10), `ip daddr 169.254.169.254 counter reject`; idempotent (declare, flush, define, in one transaction). `bivouac-metadata-block.service` loads it, and a `docker.service` drop-in requires it and orders Docker after it: no container runs without the block, and Docker does not start if it cannot be loaded. Docker never touches this table, and a reject in one base chain is final whatever another accepts (from memory of the nftables documentation). Only forwarded traffic is affected: the host still reads its metadata at boot. The reconciler opens a connection to `169.254.169.254:80` on each pass and reports a failure if it succeeds (`BIVOUAC_METADATA_CHECK`, `off` on the local platform and in CI, where the cloud's own metadata service answers), so a removed block is never silent (D44). The rules are loaded twice in a throwaway container by the tests. Invariants: no container uses host networking (its traffic would skip the forward hook); `nft flush ruleset` is never run on the server. The reconciler, with the Docker socket, can bypass anything (D8).
- **To check on the server**: see "Points to check" in the brief.
- **Rejected**: a `DOCKER-USER` rule re-applied after each Docker restart (depends on Docker's undocumented handling of its chains, and Docker's own nftables mode has no `DOCKER-USER`, from memory); an IPv6 rule (Hetzner's metadata service is IPv4, from memory, and Docker networks have no IPv6).

### D63 — SSH key sync
- **Context**: D12 and "Points to check". Verified (Flatcar source, 7 November 2026): sshd reads only `~core/.ssh/authorized_keys`, regenerated by `update-ssh-keys` from the fragments in `authorized_keys.d/`; Ignition writes the `ignition` fragment, which would otherwise stay forever, so removing a key from `ssh-keys.yml` would not remove it. Verified (systemd.path man page): `PathChanged=` fires when a file open for writing is closed; a service that keeps failing makes the path unit fail too.
- **Choice**: at the start of each valid pass, before the secrets (a broken secrets file must not hold back a key change), the reconciler writes the keys to `/var/lib/bivouac/ssh/authorized_keys` through a temporary file outside that directory. On the host, `bivouac-ssh-keys.path` (plus a run at boot and every 15 minutes) starts `/opt/bivouac/sync-ssh-keys`, which works on a copy, checks every line again with the schema's own pattern, refuses an empty list, applies it with `update-ssh-keys -u core -a bivouac`, and only then removes every other fragment, so `ssh-keys.yml` is the only list. It writes `applied <sha256>` or `refused <sha256>: <reason>` to `ssh-status/applied`; the reconciler reports a list that is refused, not applied or never looked at after two minutes. The key schema now requires exactly one line, a printable ASCII comment, and data whose embedded type matches the declared one (a damaged copy-paste would lock its owner out). The reconciler needs no access to `core`'s home.
- **Rejected**: mounting `authorized_keys.d` into the reconciler (the brief's first plan: one more mount, and the host could not check the list on its own); `update-ssh-keys -D` for the provider's fragment (would make the metadata service fail at every boot, from memory).
- **To build before prod**: a rescue procedure if every key is lost (Hetzner rescue system, then edit `authorized_keys.d` on the root partition), in the runbook and tried once.
- **Done (8 November 2026)**: written (runbook, section 11) and tried on the real server, read-only. Observed: the rescue system's sshd accepts passwords, so SSH is limited to the owner's IP during the drill; Flatcar's root partition is `/dev/disk/by-partlabel/ROOT`.

### D64 — Who can write to the instance repo
- **Context**: the rule 6 reviews of step 6 (7 November 2026). Whoever can push to `main` of the instance repo controls the server: the SSH keys, the reconciler image (which has the Docker socket), every app image. The fine-grained `bivouac-deploy` PAT (D36), which can write contents, sits in every app repo, so a compromised app repo or dependency could push to `main` directly.
- **Choice**: recorded as a condition for the prod phase, not fixed in the MVP (no real data or users yet). To decide then: branch protection or rulesets on `main` if the plan allows them on a private repo (to check, from memory not on GitHub Free), otherwise a deployment path that cannot touch anything but an app's `image:` line (for example a workflow in the instance repo that applies only that change).


### D65 — Making the Flatcar snapshot
- **Context**: step 7 of layer 2 (7 November 2026), the first write to Hetzner. Verified: Flatcar stable is 4757.2.3 (`version.txt`); Flatcar signs the checksum list of each file with its image signing key (`F88CFEDEFF29A5B4D9523864E25D9AED0593B34A`); `hcloud-upload-image` v1.5.0 (21 June 2026) is the latest release; its source, read at the tag, creates a key and a server labelled `apricote.de/created-by=hcloud-upload-image`, writes the image without checking it, and cleans up with Go defers, which do not run when the process is killed; its `cleanup` command deletes every server and SSH key carrying that label, never images; its image is not signed. The Hetzner FAQ says a snapshot is not bound to a location. Hetzner tokens cannot be narrowed below "Read & Write on the whole project".
- **Choice**:
  - The image is downloaded on the Mac and checked (GPG signature by Flatcar's key, then SHA-512) in a throwaway container, and that very file is sent with `--image-path`, rather than letting the temporary server download a URL unchecked.
  - The tool runs pinned by digest, in a read-only container without capabilities, with a dedicated temporary token deleted right after; the main token never reaches it.
  - The existing server and Primary IP get Hetzner's delete protection first (a mistaken deletion fails; a malicious tool could still lift it). The server's `delete` and `rebuild` protection must have the same value (verified, API spec), so it is lifted before a rebuild.
  - The temporary server is a `cpx12` in `fsn1` (x86, 40 GB, the CX23's disk), since the default `cx23` was available nowhere.
  - Afterwards, the API is checked for leftovers: servers, SSH keys, Primary IPs and images carrying the tool's label. `bivy` must never use that label itself.
- **Result**: snapshot `flatcar-stable-4757.2.3` (labels `os=flatcar`, `flatcar-channel=stable`, `flatcar-version=4757.2.3`), stored as 0.55 GB, about €0.01 a month; the temporary server cost about €0.02 (one started hour). Its ID is in the instance repo's operations log.
- **Rejected**: `--image-url` (no integrity check: the HTTPS download only proves the CDN, not Flatcar's build); compiling the tool from its source (moves trust from the publisher's CI to the code read, at the cost of one more step; may be revisited when `bivy` automates this); the main token given to the tool.

### D66 — The deploy key is generated on the server
- **Context**: step 8 of layer 2 (8 November 2026). D30 had `bivy` create the deploy key through the GitHub API and copy it over SSH. Verified (GitHub's permission tables): adding a deploy key through the API takes a fine-grained PAT with "Administration: write" on the repo, which can also change the repo's settings.
- **Choice**: the key pair is generated **on the server** (`ssh-keygen`, `/etc/bivouac/deploy_key`, 0600 root); only the public key leaves it. For now the owner adds it by hand in the repo settings ("Allow write access" unchecked); `bivy` may do it through the API later, with a temporary PAT. Read-only is checked from the server: `git-receive-pack` with nothing to send is refused by GitHub ("marked as read only"), and the owner confirms "Read-only" in the settings page. Since `sha-461e530`, the reconciler looks for the key on every pass (no restart needed), and always pins GitHub's host keys, with or without a key.
- **Rejected**: generating it on the Mac and copying it (the private key would exist in two places, then need deleting); a long-lived PAT with administration rights.

### D67 — IPv6 on Flatcar, and no AAAA record yet
- **Context**: verified on the server (8 November 2026): Flatcar configures only DHCPv4 on Hetzner; the metadata service describes the IPv6 as static (`<prefix>::1/64`, gateway `fe80::1`), and nothing applies it. Docker networks have no IPv6 (D62), so Caddy's ports 80 and 443 over IPv6 go through Docker's userland proxy (`docker-proxy` listens on `[::]`, observed).
- **Choice**: the instance's Butane writes a drop-in for Flatcar's default network file (`zz-default.network.d/10-bivouac-ipv6.conf`) with the address and gateway of the server's Primary IPv6; the address lives in the instance repo, and changes with the IP. The server has IPv6 (SSH and outbound traffic work), but **no `AAAA` record** is published until Caddy sees real client addresses over IPv6: through the userland proxy it would see a Docker gateway address (from memory, to check), so every IPv6 visitor would share Pocket ID's rate limit, and `setupFrom` (D15, D53) could not recognize the owner.
- **Consequence for `setupFrom` (rule 6 review of the server, 8 November 2026)**: verified, IPv6 traffic and traffic from the apps reach Caddy through a Docker gateway (10.209.x.1, 172.17.0.1; the IPv6 NAT table has no DNAT rule, IPv4 has one). If `setupFrom` named such an address, anyone could open the first-admin page over the server's IPv6. The schema now refuses private, loopback, link-local, CGNAT, unique-local, multicast and IPv4-mapped addresses there; the owner opens `/setup` over IPv4.
- **Open**: how to give Caddy the real IPv6 address (IPv6 on the Docker network, disabling the userland proxy, or Caddy on the host network, which D62 forbids). To settle before an `AAAA` record.
- **Rejected**: a unit that reads the metadata service at boot (YAML parsing in shell, one more piece of code to break); fixing the address by hand over SSH (a rebuild would lose it).

### D68 — Pocket ID after a restart
- **Context**: observed on the server (8 November 2026): after `systemctl restart docker` or a reboot, Pocket ID v2.19.2 fails for about a minute (9 restarts by Docker): first Postgres is not ready, then "it appears that there's already one instance of Pocket ID running", apparently a lock left in the database by the stopped instance, which expires. It then starts on its own.
- **Choice**: accepted for now (logins fail for about a minute after the nightly update reboot). To look at before prod: the lock's lifetime in Pocket ID's source, a start order, or a clean stop of Pocket ID before Docker stops.

### D69 — Publishing the wildcard, and Pocket ID before its first admin
- **Context**: step 9 of layer 2 (8 November 2026). A certificate exposes Pocket ID to the internet before any admin exists, and `/setup` belongs to whoever gets there first. Certificates are public: the first unknown visitor came 14 seconds after issuance, and 7 other addresses within 3 minutes.
- **Choice**:
  - The rule 6 review runs **before** the DNS write, not after it. Verified on v2.19.2's source: `POST /api/signup/setup` is the only way to create the first admin, and open signup is disabled by default. About 70 path variants were tried locally behind the same Caddy, and 13 (GET and POST) on the real server over HTTPS: all refused, and none reached that route.
  - An `A` record only, with a 3600 s TTL: the Primary IP is fixed, and a shorter TTL would only help undo a mistake. Published within 10 seconds of the refresh on OVH's servers, 1.1.1.1 and 8.8.8.8 (negative caching: 60 s, the SOA minimum).
  - Caddy is restarted rather than left to its retry: it then asks Let's Encrypt's production endpoint directly (certificate in about 6 s, `http-01`).
  - **No change of Pocket ID's version while it has no admin**: the protection is one exact list of paths, checked against this version.
- **Emergency stop**: close 80/tcp, 443/tcp and 443/udp at the Hetzner firewall, IPv4 and IPv6. Removing the DNS record closes nothing (the IP can be targeted directly), and the reconciler restarts a stopped Caddy. If an unwanted admin ever appeared, Pocket ID's data would have to be reset as well.
- **Observed**: over IPv6 and from containers, Pocket ID sees a Docker gateway (`10.209.0.1`) instead of the client (D67): traffic from every app through the public URL shares one rate-limit bucket (100 requests/s for the API, from the review of `rate_limit.go`), to keep in mind if an app calls it heavily. On the Mac, Node 25's `fetch` fails TLS with `eu.api.ovh.com` (`record overflow`), while `curl` works and Node reaches `api.eu.ovhcloud.com`: `bivy` should use the latter, after checking signed calls there.
- **Rejected**: reviewing after the certificate (the name is scanned within seconds).

### D70 — Pocket ID sends through the OVH mailbox, and its settings come from Git
- **Context**: step 10 of layer 2 (8 November 2026). The brief planned Brevo, with four DNS records and an account approval. The domain already has an OVH MX Plan (quota 1 of 1) with SPF and DKIM in place. Verified: OVH offers STARTTLS on `smtp.mail.ovh.net:587`, reachable from the server (Hetzner blocks 465); about 200 messages an hour per account (OVH docs); in Pocket ID v2.19.2, application settings are read from the environment only with `UI_CONFIG_DISABLED=true`; `SMTP_PASSWORD_FILE` exists; `SMTP_TLS` defaults to `none`; `starttls` fails if the server does not offer it, with certificate verification on (go-kit emailer v1.6.0).
- **Choice**: `platform.yml` gains an optional `mail` block (host, port 587 only, from, user); `mail.password` is in SOPS and reaches Pocket ID as a file. `UI_CONFIG_DISABLED=true`, so the settings screen is read-only, and `ALLOW_USER_SIGNUPS=withToken`: open signup stays refused, and with the default `disabled` the invitation pages would be hidden (found by the rule 6 review). No SPF change. `_dmarc.example.org` is added as `v=DMARC1; p=none`, without a report address: observation only, and it covers the whole domain's mail.
- **Result**: a real test message passed SPF and DKIM (`d=example.org`, OVH's selector 1), reached Gmail over TLS 1.3, and landed in spam. The DMARC record came after that test; the cause of the spam verdict is not known.
- **Rule**: the mailbox password opens the whole mailbox, and MX Plan has no send-only credential we could verify. **It is never given to apps.** `SMTP_*` for apps stays unimplemented until a send-only relay is chosen, before the first app that sends mail.
- **Accepted**: a Pocket ID compromise also yields the mailbox password, so the mailbox must hold nothing that matters; a spam incident would affect the reputation of the whole domain; `writeSecretFiles` leaves `smtp_password` on disk if `mail` is later removed.
- **Rejected**: Brevo now (one more service and account for a few messages a month; still a candidate for the apps' relay); application settings through the admin screen (not as code); renaming the mailbox to `no-reply@` (needs a reset that erases it, and replies and bounces are better received).

### D71 — Personal and instance details leave the public repo
- **Context**: the public repo stated the real domain, the server's IP, the owner's first name, personal history and where credentials are kept, contrary to D1. It is meant to be shown to others.
- **Choice**: `example.org` and `203.0.113.10` stand in for the real values; the real ones and the working preferences are in `INSTANCE.md` of the private instance repo. Git history was rewritten too, the commit author address became GitHub's `noreply` one, and earlier versions of the brief and of this log were dropped from history.
- **Accepted**: the owner's name stays in `LICENSE` and the GitHub handle in image and repo addresses, which the platform needs. A rewrite does not erase copies others may already have, and `sha-…` image tags from before the rewrite no longer match a commit.
- **Rejected**: keeping history as it was (the details would stay one click away).

### D72 — S3-ready apps, without an S3 server on the platform
- **Context**: files live in per-app Docker volumes, backed up every night. An app that outgrows the platform should be able to move to real object storage without a rewrite. Garage (S3-compatible, self-hosted) was considered. Verified (Garage docs, v2.5.0, Nov. 2026): per-bucket keys, an HTTP admin API, presigned URLs and multipart uploads are there; a single node is described as for tests only; custom secrets are reserved for migrations and restores, which does not fit derived secrets (D14); no documented way to copy the data directory of a running node, so a nightly backup would probably stop file access for every app.
- **Choice**: portability lives in the app, not on the server. Apps reach user files through one small storage module with two modes: the declared volume by default, S3 when `S3_BUCKET` is set. The Nuxt template ships it, and its tests run against both modes, with a throwaway Garage in CI only.
- **Rejected**: Garage or another S3 server in production for now: one more stateful component, a harder backup, and no gain on one server. A shared npm package for the module: copying one file is simpler for two apps.
- **Revisit when**: a third-party app only speaks S3, an app needs direct browser uploads, or the platform spans several machines or sites.
- **Open**: how the Next app stores files is not known yet; to check when it is onboarded.

### D73 — Where the backups go, and what the server's key can do
- **Context**: layer 3 (8 November 2026). The brief planned B2's EU Central region; the sign-up form did not offer it to the owner, although Backblaze's docs still list it. The cause is unknown. Verified (B2 and restic docs, then a real run against B2): the master key does not work with the S3 API; keys limited to one bucket do, with `listAllBucketNames`; by default a bucket keeps every version; a delete by name through the S3 API only needs `writeFiles` and hides the file; `b2_delete_file_version` is refused (401) without `deleteFiles`. The interface only offers "Read and Write" keys, so a narrower one is made through the API, with the master key, once. Restic 0.19.1 is the current release.
- **Choice**: a private bucket whose lifecycle rule keeps hidden files 30 days, and a server key with `listBuckets`, `listAllBucketNames`, `readBuckets`, `listFiles`, `readFiles` and `writeFiles` only. A compromised server can hide everything and read everything, but cannot destroy anything for 30 days. Credentials and the restic password are in SOPS (`backup.*`); the destination is `backup.repository` in `platform.yml`, S3 over HTTPS only. Restic encrypts before sending, so the region is about where ciphertext sits. Region of this instance: in its operations log.
- **Departs from the brief** on the region: moving later means a new account and a new upload, cheap while there is little data, to settle before real data.
- **Rejected**: "keep only the last version", which restic recommends (a server compromise could then destroy the history at once; the extra storage is negligible); waiting for support to open EU Central.
- **Before prod**: an independent monthly check from outside the server with a separate read-only key (the only other proof is the quarterly rebuild test, longer than the 30-day window), and a spending cap at B2.

### D74 — How the backup runs
- **Context**: D33, step C of layer 3. Findings in the existing code: Docker calls gave up after 2 minutes; exec output is buffered in memory; a pass cannot wait for a long job.
- **Choice**:
  - At 02:00 UTC, ahead of the reboot window, beside the passes. Failed: retried once, an hour later. Catches up if the server was off. A run has 110 minutes.
  - `pg_dump --format custom --compress 0` (restic compresses and deduplicates) in a throwaway container on the internal network, to a temporary name renamed on success, then `restic backup` with a fixed `--host`: restic groups snapshots by host, and a container's name changes every run, so retention would otherwise never remove anything (found by a real test).
  - **No state file means a new server: the first backup waits for the next night**, so an empty platform never becomes the latest copy. The repository is created only before the first success; afterwards a missing one is an alert, not a new empty history.
  - A database that cannot be dumped does not cost the others their copy: the snapshot is tagged `incomplete`, as is a restic partial read (exit 3), and is never used as the latest good one.
  - Refused when the dumps would take more than 80% of the free disk.
  - `backup: { stop: true }`: apps are written to `backup/paused.json` before being stopped, and restarted even after a crash or reboot; a pass leaves them alone meanwhile.
  - One-off containers remove their anonymous volumes, and leftovers of an interrupted run are removed at startup, containers first.
- **Accepted**: an app with `stop: true` stays down during the whole upload, not "a few seconds" (D20), on a first upload especially; a removed app leaves the nightly set without a final archive until layer 6 (D18); a self-update waits for a running backup, and the reconciliation is suspended meanwhile.
- **Rejected**: `restic backup --stdin` per database (one snapshot each); MinIO in the tests (the S3 path was tested against the real B2, the tests use a local repository).

### D75 — Retention and the restore test
- **Choice**: once a week after a backup that worked, normally Sunday (weeks start on Sunday in UTC): `forget` on snapshots tagged `nightly` (7 daily, 4 weekly, 6 monthly), `incomplete` ones kept 30 days, then `prune`; snapshots tagged `archive` (D18) are never considered. Then `restic check --read-data-subset 10%`, the latest `nightly` snapshot restored into a throwaway Postgres (`NetworkMode: none`, no secret, limited memory, processes and CPU), each dump loaded with `--no-owner --no-privileges --exit-on-error`, and compared with the live databases: a database with tables must come back with tables, and Pocket ID with at least one account. Each has its own alert; healthchecks.io has a check for the restore test.
- **Observed**: while its history is short, restic keeps the oldest snapshot too, so three in one day become two.
- **Limit**: this proves the data comes back, not that a passkey login works: only `bivy rebuild --test` does (D39). Dumps come from databases apps control: `pg_restore` as superuser is confined here, and must not be copied to `bivy rebuild` against the real Postgres.

### D76 — Alerts as built
- **Choice** (D45): a problem is announced after 3 passes in a row, repeated at most once a day, and announced as resolved after 3 clean passes. State is in memory and on disk; if the disk is full, it still works. At most 50 messages a day, then one saying so. Disk: above 80%, cleared at 75%, so a disk hovering at the limit does not flap. Alert text is redacted (URL passwords, `password=`, long tokens) and cut to fit. The credentials are copied after each successful decryption to a file only root can read, mounted in no container: without it, "the secrets cannot be decrypted" could not be sent. The heartbeat is only sent after a pass that ran, and is withheld once alerts have been undeliverable for a day, so losing the channel is not silent. `BIVOUAC_ALERTS=off` on the local platform. Verified by the owner: the Pushover integration is available on healthchecks.io's free plan.
- **Open**: a crash-looping app that started once may not raise an alert (`ensureContainer` sees it running, from memory); to handle with rollback in layer 6. Alert text is in English, as the code is.

### D77 — Superuser sessions and a database's own settings
- **Context**: rule 6 review of layer 3. A database's owner can run `ALTER DATABASE … SET search_path`, which also applies to the superuser logging in: an app could have its own functions run as superuser when the reconciler reads its database. The extension check had this flaw before layer 3.
- **Choice**: superuser sessions connect with `-c search_path=pg_catalog` (startup options win over database settings); extensions are created with `search_path = public`, pg_catalog still being searched first. All database calls have time limits (15 s to connect, 2 minutes per query). An end-to-end test plays the hostile app.

### D78 — `gh` for Claude on the owner's Mac
- **Context**: Claude followed CI with `curl` on the public API (about 60 requests an hour, no logs, fragile loops) and could not read the private instance repo's CI at all. PRs will matter from the prod phase on.
- **Choice**: `gh`, installed with Homebrew and logged in with a fine-grained PAT stored in the macOS keychain. It reaches only the monorepo and the instance repo, with contents read, Actions read, commit statuses read and pull requests write, and expires after 366 days. This is a tool for Claude's sessions, not a dependency of the product: D31 stands.
- **Verified (9 November 2026, on the real token)**: it reads runs, logs and the combined CI state of both repos, and no other private repo. Refused with a 403: creating a branch, rerunning a workflow, changing repo settings, listing secrets. Pushes stay on Git over SSH, as before. Merging a PR needs contents write (from GitHub's docs; not tried, no PR exists yet). `gh pr checks` is not tried either.
- **Rejected**: plain `gh auth login` (write access to every repo of the account); `GH_TOKEN`, which `gh`'s docs favor for fine-grained tokens, but which would leave the token in plain text in a shell profile; staying with `curl`.
- **Limit**: the expiry is not announced by an alert; `gh` fails visibly with a 401, and only Claude's work depends on it. Recreating it takes the owner one link and one command.

### D79 — The Nuxt app template as built
- **Context**: layer 4 needs the mold every app starts from. The platform gives apps neither a session key nor their public address.
- **Choice**: `app-template/` in the monorepo, outside the npm workspaces, with two layers (`platform`: database, migrations, health; `oidc`: sign-in). The session key is derived from the OIDC client secret by HKDF, and the callback address comes from the request's `Host`, so the reconciler needs no change. Sessions last 24 hours in an encrypted cookie, with no server-side revocation: removing someone or a group takes effect within a day. Everything is protected by default; requests with dot segments are refused, because the router and the check would read the path differently; requests that change something must come from the app's own origin, because sibling apps are the same site for browsers (`SameSite` does not separate them). `/api/health` answers 503 until migrations end, because Nitro does not wait for them before listening and the reconciler stops at the first 2xx.
- **Rejected**: a new platform-provided session variable (a reconciler change for no gain); `nuxt-auth-utils` (h3 sessions and `openid-client` are enough); `/auth/*` as a public prefix (a page added there would become public silently).
- **Open**: the deployment PR is opened but not merged automatically: `gh pr merge --auto` needs required checks on the instance repo, which do not exist yet (D5, D64), and without them it would merge before CI. Sign-in is tested against a small fake identity provider; the real Pocket ID advertises everything used (discovery document checked), and a real sign-in comes with the first app.

### D80 — Apps get the shared layers by exact commit, and Renovate per app
- **Context**: D79 copied the sign-in code and pinned dependencies into each app. Nothing would then update them, and a security fix would have to be redone by hand in every app.
- **Choice**: the layers live in `app-layers/` of the public monorepo and each app extends them at one exact commit, named once in `nuxt.config.ts` next to its release tag (`app-layers-v<x.y.z>`). No registry and no account. A commit rather than a tag, because a tag can be moved and this code guards every app. The app refuses to build if a layer's files are missing, because Nuxt only warns when it cannot load a layer, which would give an app with no sign-in. The template ships a `renovate.json`: weekly grouped updates, new layer versions at once, nothing merged automatically.
- **Publishing a layer change**: merge it (CI tests the layers of that commit), then tag that commit `app-layers-v<x.y.z>`.
- **Rejected**: copying the layers (fixes do not reach existing apps); an npm package (lockfile integrity and native Renovate support, but one more account and publishing token); a tag alone.
- **Open**: Renovate is not installed yet, on the instance repo or on app repos, although the brief describes it as chosen: the owner has to install the Mend app. Whether Renovate updates the commit together with the version is from memory: to check on its first real PR. A ruleset protecting release tags, from memory available on a public repo, is to add before the prod phase.

### D81 — Dormant apps: Renovate for the shared layers only, and a quarterly check
- **Context**: personal apps are usually left alone once finished. D80's weekly updates would give about one PR per app per week, soon ignored. Security-only updates are no better: an app freshly created from the template already shows 16 `npm audit` advisories (none high or critical, measured 9 Nov. 2026), mostly in build tools that are not in the image. Whether an advisory matters takes reading, not filtering.
- **Choice**: in app repos, Renovate only updates the pinned commit of the shared layers, and merges by itself when the app's tests pass. Everything else stays frozen until the quarterly check done with `bivy rebuild --test` (runbook section 13): high and critical advisories that run in the image and can be triggered from outside. Only minor and patch versions merge by themselves: a new major version, or a release tag that moved to another commit, stays a PR for the owner. This revises D80's weekly updates and "nothing merged automatically".
- **Rejected**: routine updates; Renovate on security advisories (noise); no Renovate at all (an urgent fix to the sign-in code would wait for someone to open a session).
- **Accepted**: between two checks a dependency flaw can stay open up to three months. Apps behind sign-in are reachable only by invited users; the exposed parts (Caddy, Pocket ID, the OS) are updated by the platform.
- **Preconditions, from the rule 6 review**: a ruleset blocking update and deletion of `app-layers-v*` before the first app installs Renovate (earlier than D80 said; availability on this plan from memory). Deployment PRs must not merge automatically (D79) while a layer version can reach them unreviewed: the deployment PR is today the one human step, and it does not say that sign-in code changed. A new tag is the only review of a layer release: tag only commits on `main` with green CI.
- **Open**: nothing alerts on a layer PR stuck on red tests in a dormant app, other than the quarterly check.

### D82 — Alerts tried for real, and every message at normal priority
- **Context**: step G of layer 3 (9 November 2026). Each case of D45 was caused on the real server and received on the owner's phone, with its end: quarterly reminder, disk above 80%, unreadable secrets, silent server, failed backup, failed deployment, failed restore test, missing backup. Rollback (D21) does not exist yet, so only the failed deployment could be tried.
- **Choice**:
  - **Normal priority everywhere, on the owner's decision**, revising D45 (priority 1 for a full disk and a silent server): nothing here is worth waking someone for, since one day of loss is accepted and a night repair is not expected. The reconciler no longer sends a priority at all; healthchecks.io's Pushover integration is at normal priority. Pushover's quiet hours decide what is silent at night.
  - The server's messages go to a Pushover delivery group, whose key replaces the user key in the secrets file (verified, Pushover docs: a group key is used in place of a user key). Changing which devices receive them needs no secret and no deployment.
  - **An alert keeps the first message of its incident.** Found by the trial: a failed deployment announced "failed its health check earlier", because the cause only exists on the first pass.
  - **The end of an incident reads "No longer happening: ..."**. Found by the trial: it repeated the problem word for word.
- **Learned** (verified, healthchecks.io source, `update_timeout`): changing a check's schedule so that it is already overdue marks it down **without any notification**, on purpose. To rehearse a missed ping, send a success first, then set a schedule whose next expected time is still ahead. The trial used a 10-minute schedule, so the real `0 2 * * *` with 3 hours of grace was not itself observed firing.
- **Accepted**: redaction also hides long paths and container IDs in alert text, which stays understandable; weakening it is not worth the risk. Still open from D76: an app that crashes after a healthy start.
- **Rejected**: a "simulate a failure" switch in production code (the restore test was failed for real, by killing its throwaway Postgres); a second healthchecks.io integration at high priority for the silent server.

### D83 — Apps are checked on the Mac with `npm run dev:local`
- **Context**: 11 November 2026. Changes to the first real app were being checked on the real server, after a push and a deployment, instead of on the Mac as in any web project: slow, and every try reached the users' server. D43 planned to develop apps against the miniature platform, which needs the reconciler, Pocket ID and Caddy for what is only a Nuxt page.
- **Choice**: the app template has `npm run dev:local` (`scripts/dev.sh`): a Postgres in Docker named after the app's folder, port bound to 127.0.0.1 and data kept in a named volume; migrations applied with `drizzle-kit migrate` (the shared layer skips them in dev); the end-to-end tests' fake identity provider, which signs in a "Dev" person whose groups come from `DEV_GROUPS`; then `nuxt dev`. `.claude/launch.json` lets Claude Code's preview start it. Every interface change is checked there, in light and dark and at phone width, before pushing. This revises D43 for apps; the miniature platform stays for the platform itself.
- **Rejected**: the miniature platform for app work (heavy, and real passkeys get in the way of quick checks); a Compose file (one more file for what a short script does).
- **Known pitfall**: `npm run build` while `dev:local` runs downloads the shared layers again into `node_modules/.c12` and breaks the dev server; documented in the template.

### D84 — Push notifications for apps: Web Push, with no relay (direction)
- **Context**: 11 November 2026. The owner asked whether apps could get a push notification relay, like the send-only mail relay planned in D70. No app needs it yet; this records a direction, not something built.
- **Why mail needs a relay and push does not**: mail needs one because Hetzner blocks outbound mail ports, a VPS IP delivers poorly, and the only credential we have opens the whole mailbox (D70). Web Push has none of these problems: the app sends one HTTPS request to the browser vendor's push service, which delivers to the device, and each app signs with its own key pair (VAPID), valid only for its own subscribers.
- **Direction**: when the first app needs it, no new container. A `push` module in the shared layers (D80), on the model of the storage module (D72): it stores device subscriptions in the app's own database and sends through a well-known library (`web-push` for Node, from memory, to be checked). The platform gives each app its VAPID keys like its other standard variables, ideally derived from the master secret (D14): if an app's keys change, every subscription silently stops working, so they must survive a rebuild unchanged.
- **To check before building** (from memory): on iPhone, Web Push only works once the user has added the app to the home screen (iOS 16.4 and later), a step to explain once per app; deriving a P-256 key pair from an HMAC is simple in principle but is custom cryptography, so it gets a rule 6 review, or else the keys are generated once per app and kept in SOPS, at the cost of one manual step per new app.
- **Rejected**: Pushover for users (it suits the owner's alerts, D45, but every user would need the app and a licence); self-hosted ntfy (one more component and one more app for every user, and from memory its instant delivery on iPhone still goes through the public ntfy.sh server); native push through APNs or FCM (needs native apps and developer accounts).

### D85 — An app may open an MCP for Claude, signed in through Pocket ID
- **Context**: 11 November 2026. The owner wants Claude to tag, edit and delete books in the first real app. Two ways were weighed with the owner: stdio over SSH, like the platform MCP (D32), or HTTP with an OAuth sign-in against Pocket ID. The owner chose HTTP, so Claude can use it from claude.ai and the phone app, not only from Claude Code on the Mac.
- **Verified** (Pocket ID v2.19.0 source, and a real v2.19.2 container on 11 Nov. 2026; Claude's connector docs and Claude Code docs, same day):
  - Pocket ID accepts public clients (no secret, PKCE enforced) and an `http://localhost/...` callback matches any port, even with `ALLOW_INSECURE_CALLBACK_URLS=false`. It has no dynamic client registration; client ID metadata documents exist but are off unless listed.
  - It has "APIs" (`/api/apis`): with `resource=<URL>` (RFC 8707), the access token is a JWT with `typ: at+jwt`, RS256, `aud` holding that URL and the issuer, `client_id` and `sub`; an authorize request naming an API the client was not given is refused. Groups are not in the access token; userinfo gives them. Refresh tokens come without `offline_access`, 30 days, renewed on use. The group restriction is checked at sign-in and on every token request.
  - Claude (web, desktop, phone) and Claude Code accept a pre-registered client ID with no secret ("Use your own OAuth client"; `claude mcp add --transport http --client-id`). Callbacks: `https://claude.ai/api/mcp/auth_callback`, and `http://localhost:<port>/callback` for Claude Code. Claude reads RFC 9728 metadata from the 401's `WWW-Authenticate`, sends `resource`, and refreshes tokens.
- **Choice**:
  - Manifest `mcp: true` (oidc apps only). The reconciler creates a public client `<app>-mcp`, shown as "Claude → <app>", restricted to the app's groups, with those two callbacks and **a passkey required every time** (`requiresReauthentication`; verified: the step cannot be skipped, even with a Pocket ID session), and an API whose resource is `https://<app host>/mcp`, given to that client alone and only on a person's behalf. The app gets `MCP_RESOURCE`. Without the flag, the client and the API are removed (Claude's tokens stop being renewed). App names may not end in `-mcp`.
  - The shared sign-in layer serves `/.well-known/oauth-protected-resource[/mcp]` and opens `/mcp` to bearer tokens only, never the cookie, so no origin check is needed there and a page on another site cannot act through it. A token passes when its signature matches the provider's keys, `typ` is `at+jwt`, `iss` is the provider, `aud` holds `MCP_RESOURCE`, it has not expired and `client_id` is `<app>-mcp`. Name and groups come from userinfo, cached until the token expires and at most 5 minutes. Without `MCP_RESOURCE`, those paths answer 404.
  - The app serves its own tools at `/mcp` (stateless Streamable HTTP, `@modelcontextprotocol/sdk`), as the signed-in person, under the same rules as its pages. Biblio is the first: list tags, search, read, edit, tag in bulk, delete (marked destructive; Claude is told to ask first).
- **Rejected**: stdio over SSH for app MCPs (Claude Code on the Mac only); passing the session cookie or a personal API key (long-lived, outside Pocket ID's groups and revocation); dynamic client registration (Pocket ID lacks it); the app's own sign-in client for Claude (it has a secret, and its tokens are not bound to `/mcp`).
- **Rule 6 review** (independent, 11 Nov. 2026): no flaw found in the token checks, the path matching or the per-person scoping. Medium risk raised and fixed: the claude.ai callback is the same for every Claude user, so a link prepared in someone else's Claude account, opened by a member already signed in to Pocket ID, could have connected that account to the member's data without a prompt; hence the passkey every time. Also fixed: only `oidc` apps call Pocket ID for this; JSON-RPC batches are refused; the app tells Claude that titles and authors are data, not instructions.
- **Accepted**: anyone in the app's groups can connect Claude to their own data in that app; that is the point. A deleted app leaves its `-mcp` client behind, like its sign-in client (harmless without the app). A book's title could still try to steer Claude; the damage stays within that person's library, and Claude asks before deleting. Pocket ID has no revocation endpoint: an access token stays valid up to its hour; removing the person from the group stops the next renewal.
- **Open**: whether a connector added on the web shows up in the phone app (Claude's docs do not say; to try).


### D86 — Deployment PRs merge by themselves, through a workflow of the instance repo
- **Context**: 11 November 2026. The first real app gave four deployment PRs in a day, each waiting for the owner's click, against D5. `gh pr merge --auto` needs required checks, and branch protection and rulesets are refused on a private repo of GitHub Free (verified: the API answers "Upgrade to GitHub Pro or make this repository public"). The owner chose the free way over GitHub Pro.
- **Choice**: a workflow of the instance repo (`merge-deployments.yml`, from the template) runs when Validate completes. It merges, with the instance repo's own temporary token and only at the commit Validate passed, a PR from a `deploy/` branch that changes one line of one `apps/<name>.yml`: the top-level `image:`, to another `sha-` tag of the same image repository, with a branch named after that app and tag. The app's deploy workflow compares the shared layers' commit (`layersCommit`) of the deployed version and the new one, and writes `Shared layers: unchanged`, `CHANGED` or `unknown` in the PR; only `unchanged` merges by itself, so a layer release brought by Renovate still waits for the owner (D81). It also closes the app's older deployment PRs, so an older build cannot be merged after a newer one. Anything else, including a failed merge, is left as before, with a notice in the run.
- **Rule 6 review** (independent, 11 Nov. 2026): nothing blocking; no injection path and no way found to fool the one-line check. Fixed from it: the script lives in the instance repo rather than being called from the monorepo's `main`, which would have given code from another repo write access to the instance repo; superseded PRs are closed; a failed merge is a notice, not a red run.
- **Rejected**: GitHub Pro for now (paid; it would also close D64); Claude merging (its `gh` token cannot, D78); merging any PR whose CI is green (a PR could change anything); calling the script from the monorepo (see the review).
- **Accepted**: this is a convenience, not a barrier: whoever holds the `bivouac-deploy` token can still push to `main` (D64), and the line in the PR is written by the app repo, which that same party controls. The marker covers Renovate's layer updates, not a code review: an app commit can still change its sign-in without touching `layersCommit`. `workflow_run` runs the workflow as it is on `main`, so a PR cannot change the rules that merge it. A merge by the workflow's token starts no other workflow, so Validate does not run again on `main` after it. Improving the script means copying it into each instance repo.

### D87 — App tests run in Playwright's image, not on Ubuntu's package mirrors
- **Context**: 11 November 2026. An app's CI failed twice in a row at `npx playwright install --with-deps chromium`: the GitHub runner could not resolve Ubuntu's package mirrors, so Chromium's libraries could not be installed and nothing was deployed. Unit tests and the build were green.
- **Choice**: the template's `test` job runs in Playwright's official image, at the exact version of `@playwright/test` in `package.json` (`mcr.microsoft.com/playwright:v1.65.0-noble`, `--user 1001`, as Playwright's CI guide shows; verified 11 Nov. 2026, the tag exists). Chromium and its libraries are already in it; Postgres is reached by its service name (`postgres:5432`). The first app ran it green (27 end-to-end tests) and deployed.
- **Accepted**: the image tag must follow `@playwright/test` by hand; a mismatch fails the run at once ("browser not found"), it does not pass silently. In the monorepo's CI, the template's checks are split the same way: `app-template` stays on the runner for what needs Docker (Garage for the S3 storage tests, the image build) and has no browser; `app-template-e2e` runs the end-to-end tests in Playwright's image (the outage hit this job too, the same day).
- **Rejected**: waiting and rerunning (the outage lasted over twenty minutes, and nothing stops it recurring); caching the apt packages (still apt, more to maintain).

### D88 — An app repo others can push to holds no deployment token
- **Context**: 11 November 2026. The second app was written by someone else, in their personal account, with the owner as collaborator. A fine-grained token is bound to one owner and cannot reach a repo where its holder is only a collaborator (verified, GitHub docs), so the repo moved to a free organization of the owner, with its author as a member. GitHub says anyone with write access to a repo can read its Actions secrets, and GitHub Free offers no protected branch, required review or protected environment on a private repo (verified, GitHub pricing and docs). The `bivouac-deploy` token in that repo would let its author push to the instance repo's `main`, which is root on the server (D64).
- **Choice**: such a repo's workflow tests, builds and pushes the image to GHCR, and stops there: no `bivouac-deploy` secret. The deployment change to `apps/<name>.yml` is made by hand (in the MVP phase, Claude pushes it; later, a deployment PR). Claude reads its CI with a second fine-grained `gh` token whose owner is that organization (D78). The server pulls the organization's private image with the existing `read:packages` token, the owner being an organization owner (verified on the server, 11 Nov. 2026).
- **Rejected**: storing the token there anyway (it hands the server to every writer of the repo); a classic PAT for `gh` (every private repo of the owner, in write); GitHub Team for environment protection (paid).
- **Accepted**: each new version of that app waits for a manual step. Apps written only by the owner keep D5 and D86.

### D89 — Real data on the server before the prod phase: the server is no longer disposable
- **Context**: 11 November 2026. The owner now keeps data they want to keep in two apps (an ebook library with its files, and a household food inventory), shared with invited people, and more apps will follow. Rule 2 says the prod phase starts when real data or an invited user arrives, and only once the conditions in "Before the prod phase" are met. The data came first: several conditions are still open (`bivy rebuild --test`, D37, the rule 6 review of the whole base, D61, D64, D67, D68, D73). Checked the same day on the server: the nightly backup ran at 02:00 UTC and copies every declared volume and every database; an app added during the day is only in the next night's copy.
- **Choice**: an interim phase, until the owner announces the prod phase.
  - **Kept from the MVP phase**: Claude still pushes to `main` and deploys without a PR; no new process for code.
  - **Dropped from the MVP phase**: "the server is disposable, we can break and rebuild everything". Destroying, reinstalling or rebuilding the server, recreating Postgres, or touching a database, a volume, the backup repository, the bucket, the master secret or Pocket ID's `ENCRYPTION_KEY` now needs the owner's consent (rule 5) **and** a backup that succeeded after the last change of data: if in doubt, force one first (runbook section 12) and check it ran.
  - **Before a change that touches the data path** (Postgres version or settings, volumes, the backup or archiving code, how the reconciler creates or renames databases and volumes): check that last night's backup succeeded, and say in the announcement how the data would come back.
  - **Experiments stay off the real server**: apps are tried with `dev:local` (D83), the platform on the miniature platform (D55); a destructive test on the server is no longer acceptable. App migrations are additive only (D21), now without exception.
  - **App data is the owner's and their guests'**: Claude does not delete it (through an app, its MCP or SQL) without asking first.
- **Became urgent** (were "before the prod phase"): a full `bivy rebuild --test` (D39), which is the only proof that the data comes back; a written procedure to restore **one** app's database and volume from restic without touching the others (the weekly test only restores dumps into a throwaway Postgres); the backup region (D73), cheap to move only while there is little data.
- **Rejected**: declaring the prod phase now (its conditions are not met, and PRs for every change would slow down the work that closes them); asking the owner to stop adding data until then (the point of the platform is to be used).

### D90 — Restoring one app's data
- **Context**: 12 November 2026, interim phase (D89). The nightly copy holds every app's dump and volumes, but nothing could put back the data of one app without touching the others; the weekly test only loads dumps into a throwaway Postgres. Verified (restic docs, stable): `restore <snapshot>:<subfolder>`, `--delete` limited to what `--include` matches (and refused with `--target` without one), `--dry-run`, and by default only the differing parts of existing files rewritten. Ownership restored as root: checked by the end-to-end test, not stated in the docs.
- **Choice**: a `restore-app` command of the reconciler, run by hand with `docker exec` (runbook section 14). Without `--yes` it only says what it would do. It first sends the app's current data to restic (`pre-restore`, `app:<app>`), so a restore can be undone and nothing written since the copy is lost; then stops the app, loads the dump into a new database as the app's own role and swaps it in with the live one in one transaction, keeping the replaced one renamed (`bivouac_r<time>_<db>`), and brings the volumes back in place with `restic restore --delete` limited to each volume. Extensions are left out of the dump's list: the platform creates the declared ones. One lock file (`backup/lock.json`, created only if absent) keeps the nightly job and a restore apart; passes leave the app alone while the lock names it, and the reconciler does not move to a new version meanwhile. A restore cut short past its safety copy, or by a restart, leaves the app stopped and reported until a restore of it completes. A lock held by a restore for more than 3 hours is an alert, since no backup runs meanwhile.
- **Rejected**: restoring into a staging copy of the volume, then swapping (twice the disk, and Docker volumes cannot be renamed); dropping the replaced database (D18: never delete); `pg_restore` as superuser (D75); a request file picked up by the running reconciler (more moving parts than a lock); restoring several apps at once (one app is what the real cases need).
- **Observed** (end-to-end test): PostGIS's own table `spatial_ref_sys` is in the dump but owned by the superuser, so the app's role cannot load it; entries owned by `postgres` are left out with the extensions. Settings set on the database itself (`ALTER DATABASE … SET`) are not in a per-database dump and do not come back, as in the nightly copy already.
- **Not covered**: copying back a few rows or files written since the copy (by hand, from the safety copy or the kept database); `bivy rebuild` (layer 5) will restore every app, not with this command.
