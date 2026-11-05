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
- **Context**: Gaëtan wanted to be able to force a deployment.
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
- **Choice**: a dedicated `bivouac-claude` key on Gaëtan's Mac, separate from his own. Accepted limitation: login as `core` (sudo, Docker), so read-only is a matter of discipline.
- **Rejected**: a truly read-only user (illusory, since reading Docker logs already requires root-equivalent access).

### D12 — Managing authorized SSH keys
- **Context**: Ignition runs only on first boot.
- **Choice**: one key per machine and per use, never copied. Public keys are listed in `bivouac-platform` and synced by the reconciler into `authorized_keys.d`. Every change is a high-risk PR.
- **Rejected**: keys only in Ignition (a rebuild for every addition); a private key shared between machines.

### D13 — Domain scheme
- **Context**: the domain is `xaet.fr`.
- **Choice**: `*.apps.xaet.fr`.
- **Rejected**: `*.bivouac.xaet.fr` (the project name would be baked into the passkeys); `*.xaet.fr` (the session cookie would be shared with the whole domain).

### D14 — Derived secrets
- **Context**: per-database `pg_dump` does not back up roles; Pocket ID lets you choose an OIDC client's secret (verified).
- **Choice**: every secret generated by the platform is `HMAC(master secret, "<use>:<app>")`. The master secret is in SOPS. Rotation is done with a version suffix.
- **Rejected**: storing generated secrets in a table or file that must be backed up.

### D15 — Protecting Pocket ID's `/setup`
- **Context**: `/setup` creates the first admin for whoever gets there first (verified).
- **Choice**: Caddy only allows `/setup` from Gaëtan's IP during `bivy init`, then the route is removed.
- **Rejected**: relying on being fast.

### D16 — restic to B2
- **Context**: verified, the restic docs recommend B2's S3 API over the native B2 backend.
- **Choice**: the S3-compatible API.
- **Rejected**: the native B2 backend; rclone.

### D17 — Private app images
- **Context**: verified, GHCR only accepts classic PATs.
- **Choice**: private app images, pulled with a classic `read:packages` PAT without expiration, stored in SOPS.
- **Rejected**: public images (Gaëtan's choice).

### D18 — Removing an app
- **Choice**: a final `pg_dump` sent to restic with the `archive` tag, then the database and the volume are renamed `archived_<app>_<date>`. Actual deletion only happens on Gaëtan's explicit action.
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
- **Choice**: a Nuxt-only template. Apps in another framework (Gaëtan's Next app) follow the contract by hand.
- **Rejected**: a Next template, as long as there is no second Next app.

### D24 — Server and IP
- **Context**: Gaëtan has a CX23 with the IPv4 `5.75.230.119`, which can be wiped.
- **Choice**: wipe this server to install Flatcar and reuse the IP as a Primary IP (`auto_delete=false`), with explicit confirmation before destruction. `xaet.fr` and `www.xaet.fr` serve a static page.
- **Rejected**: a second server during a migration (nothing important runs on the current one).

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

### D28 — Komodo and doco-cd
- **Choice**: rejected; the container part stays custom code (about a hundred lines with the Docker API).
- **Rejected**: Komodo and doco-cd (one more component, with its own UI and its own state).

### D29 — Postgres major versions
- **Choice**: Renovate excludes them. They are upgraded through a dump-then-restore procedure, as a high-risk change.
- **Rejected**: letting Renovate propose the image change (Postgres would refuse to start).

### D30 — Server access to the instance repo
- **Choice**: a read-only deploy key, created by `bivy` through the GitHub API and placed over SSH. During a rebuild, the new one is created before the old one is revoked.
- **Rejected**: deploy key in SOPS (chicken and egg: the repo must be read to decrypt it).

### D31 — How `bivy` reaches the APIs
- **Context**: neither `gh`, `hcloud` nor `sops` is installed on Gaëtan's Mac.
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
- **Choice**: a fine-grained `bivouac-deploy` PAT, limited to `bivouac-platform` and stored in SOPS, set on each app repo by the "new app" skill. The age key is therefore also on Gaëtan's Mac.
- **Rejected**: the age key in the private repo (a single leak would expose every secret); a GitHub organization (organization secrets are not available to private repos on the free plan).

### D37 — Decisions postponed until before prod
- **Choice**: the email login code and alerting (channel, tools) will be decided before moving to prod. In the meantime, no email code (Pocket ID's default) and no external monitor.

### D38 — Lost machine and CLI reminders
- **Choice**: `bivy machine add` generates a key and opens the PR adding it, removing the lost key if needed. If the Mac is lost, secrets are rotated with Gaëtan's consent. `bivy init` blocks until the age key is declared stored, and reminds him to store the restic password and the GitHub recovery codes. The only lockout scenario would be losing both GitHub access and the password manager.

### D39 — Low-cost rebuild test
- **Choice**: `bivy rebuild --test` creates a temporary server billed by the hour, restores, checks, then destroys everything. It never touches the real IP or DNS. It is a condition for moving to prod.
- **Rejected**: a permanent second VPS.

### D40 — Auth hostnames
- **Choice**: Pocket ID on `auth.apps.xaet.fr` (final, visible in the passkey dialog), Tinyauth on `gate.apps.xaet.fr`.
- **Rejected**: `id.apps.xaet.fr`, `connexion.apps.xaet.fr`, `idp.apps.xaet.fr` (jargon).

### D41 — Language
- **Context**: the monorepo is public and meant as a showcase; French would limit its audience. Gaëtan reads English, but finds the subject hard even in French. (5 November 2026)
- **Choice**: the public monorepo is entirely in English, including PRs (English only, in plain language for rule 3). Conversations with Gaëtan stay in French. The private instance repo stays in French.
- **Rejected**: a French public repo; a mixed repo; two versions of the brief (they would drift apart); a French summary section in public PRs.

### D42 — Resource usage display
- **Context**: Gaëtan wants to see CPU, RAM and disk usage. (5 November 2026)
- **Choice**: the reconciler samples host and container usage every minute into a small Postgres table kept 30 days; the status page shows current values and history. The pre-prod alerting decision must include a disk alert above 80%.
- **Rejected**: current values only (no history); Prometheus + Grafana (two more components, several hundred MB of RAM, from memory).

### D43 — Environments
- **Context**: should there be a dedicated dev instance? (5 November 2026)
- **Choice**: no permanent extra instance. Apps are developed locally against the end-to-end test platform; a `<app>-preview` manifest tries an app on the real server; platform changes go through end-to-end CI and `bivy rebuild --test`.
- **Rejected**: a permanent dev instance (Gaëtan's first idea: a second server to pay for and maintain, with separate Pocket ID accounts).
