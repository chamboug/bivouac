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

### D32 — Claude's access to the platform MCP
- **Choice**: the reconciler serves a stdio MCP, launched over SSH. Nothing is publicly exposed.
- **Rejected**: an MCP exposed by the status page with `@nuxtjs/mcp-toolkit` (it would require OAuth authentication of MCP clients against Pocket ID, which from memory is not supported).

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
