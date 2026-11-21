# Decision log

Why Bivouac is built the way it is: one entry per decision, with its context, the choice, the alternatives rejected and the risks accepted. An entry states what holds **today**; when a decision changed, its **History** line says what it was and when it changed. How things work in detail is in the code, the [runbook](runbook.md) and the [adapter contracts](adapters.md). Entries were condensed on 20 November 2026: the longer versions, with the full verification notes, rehearsal logs and review findings, are in Git history (`git show 014143f:docs/decisions.md`).

"Verified" means a source was checked at decision time; "from memory" means it was not.

## Index

Status: **current** unless marked. *Deferred*: recorded, not built. *Not built*: decided, waiting for a need.

| | Decision | |
|---|---|---|
| D1 | Public monorepo, private instance repo | |
| D2 | Reconciler polls Git every minute | |
| D3 | `POST /sync` for an immediate pass | |
| D4 | Brief and log public, operations log private | |
| D5 | App repo opens a deployment PR | see D86, D88, D92, D109 |
| D6 | Node LTS everywhere | |
| D7 | No secret in Ignition, metadata service blocked | |
| D8 | Docker socket in the reconciler only | |
| D9 | Weekly restore test, rebuild test before prod | |
| D10 | Four auth modes | `forward` not built |
| D11 | A dedicated SSH key for Claude | |
| D12 | One SSH key per machine, listed in Git | |
| D13 | `*.apps.example.org` | |
| D14 | Secrets derived from a master secret | |
| D15 | Pocket ID's `/setup` refused for good | |
| D16 | restic over S3 to B2 | |
| D17 | Private app images, classic `read:packages` PAT | |
| D18 | Removing an app archives, never deletes | not built |
| D19 | Framework-agnostic app contract | |
| D20 | `backup: { stop: true }` | |
| D21 | Failed image marked; additive migrations | rollback not built |
| D22 | Static sites served by Caddy | not built |
| D23 | One Nuxt app template | |
| D24 | Existing CX23 reinstalled in place | |
| D25 | x86, not Arm | |
| D26 | IPv4 required, IPv6 on top | |
| D27 | Pocket ID trusts only Caddy's address | |
| D28 | No Komodo or doco-cd | |
| D29 | Postgres majors by dump and restore | |
| D30 | Read-only deploy key | |
| D31 | `bivy` talks to official APIs directly | |
| D32 | Platform MCP over SSH | rejected, see D104 |
| D33 | The reconciler schedules backups | |
| D34 | Reserved app names | |
| D35 | CI never decrypts secrets | |
| D36 | The `bivouac-deploy` token | |
| D37 | No email login code | |
| D38 | Lost machine; secrets shown once | `bivy machine add` not built |
| D39 | `bivy rebuild --test` | |
| D40 | `auth.` and `gate.` hostnames | |
| D41 | Public repo in English | |
| D42 | Resource usage with 30 days of history | history not built |
| D43 | No permanent dev or staging instance | |
| D44 | "Rare, guided, never silent"; build in layers | |
| D45 | Alerts: Pushover and healthchecks.io | |
| D46 | MIT license | |
| D47 | npm workspaces, strict TypeScript, Zod, Vitest | |
| D48 | Instance repo validation rules | |
| D49 | OVH keys limited to one zone | |
| D50 | Reconciler published as exact versions | see D60, D61 |
| D51 | `postgis/postgis:18-3.7`, no pgvector | |
| D52 | Pocket ID settings and API facts | |
| D53 | Generated Caddyfile | |
| D54 | Reconciler pass rules | |
| D55 | Containers through the Docker API | |
| D56 | Two networks, hardened containers and Postgres | |
| D57 | Platform secrets file | |
| D58 | OIDC callback convention | |
| D59 | Miniature platform and end-to-end tests | |
| D60 | Reconciler version and repo address in `platform.yml` | |
| D61 | Reconciler self-update, digest, automatic fallback | extended by D109 |
| D62 | Metadata block: our own nftables table | |
| D63 | SSH key sync through a host script | |
| D64 | Who can write to the instance repo | accepted risk |
| D65 | Making the Flatcar snapshot | |
| D66 | Deploy key generated on the server | |
| D67 | IPv6 on Flatcar; no `AAAA` record | |
| D68 | Pocket ID's minute of failure after a restart | accepted |
| D69 | Publishing the wildcard before the first admin | |
| D70 | Pocket ID mails through the OVH mailbox | relay for apps open |
| D71 | Personal details out of the public repo | |
| D72 | S3-ready apps, no S3 server | |
| D73 | Backups at B2, a key that cannot delete | |
| D74 | How the nightly backup runs | |
| D75 | Retention and the weekly restore test | |
| D76 | Alerts as built | |
| D77 | Superuser sessions ignore database settings | |
| D78 | `gh` on the owner's Mac, for Claude | |
| D79 | The Nuxt app template | |
| D80 | Shared layers by exact commit | revised by D81 |
| D81 | Dormant apps: Renovate for the layers only | |
| D82 | Alerts tried for real; normal priority | |
| D83 | Apps checked on the Mac (`dev:local`) | |
| D84 | Web Push without a relay | *deferred* |
| D85 | App MCPs signed in through Pocket ID | |
| D86 | Deployment PRs merge by themselves | |
| D87 | App tests in Playwright's image | |
| D88 | No deployment token where others can push | narrowed by D92 |
| D89 | Real data: the interim phase | |
| D90 | Restoring one app (`restore-app`) | |
| D91 | `bivy rebuild` and `bivy rebuild --test` | |
| D92 | A trusted organization gets automatic deployments | |
| D93 | The CLI as a readable showcase | |
| D94 | Rule 6 review of the whole base | two items open |
| D95 | The interim phase stays | |
| D96 | Status page and internal API | |
| D97 | `local` apps and an app's own secrets | |
| D98 | The "new app" skill as a plugin | |
| D99 | `bivy init` and `bivy configure` | never run for real |
| D100 | Visual identity | |
| D101 | `bivy restore <app>` | |
| D102 | A Pocket ID sign-in lasts 30 days | |
| D103 | Apps installable on a phone, with a theme choice | |
| D104 | Claude works through `bivy`; a gap becomes a command | replaces D32 |
| D105 | `bivy status` and `bivy backup` | |
| D106 | `bivy pin reconciler\|status <commit>` | |
| D107 | `bivy login-link`: an admin's way back in | |
| D108 | `bivy secret set`: one platform secret changed | |
| D109 | Base images updated once a month by Renovate; rollback on a broken Caddy or Postgres | |

---

### D1 — Repo layout
- **Choice**: a public monorepo `bivouac` (CLI, reconciler, schema, templates, docs), and one private instance repo `bivouac-platform` per installation.
- **Rejected**: a private monorepo with public packages (`npx` would need authentication, and the repo would lose its showcase value).

### D2 — Reconciler trigger
- **Choice**: poll Git every minute, with a read-only deploy key.
- **Rejected**: a webhook (one more public endpoint and secret, to gain at best a minute).

### D3 — On-demand sync
- **Choice**: `POST /sync` on the reconciler's internal API, no parameters, at most once every 10 s, the API's only write; used by the status page's button.
- **Rejected**: nothing; it only brings an idempotent pass forward.

### D4 — Where rule 7's memory lives
- **Choice**: the brief and this log in the public monorepo, written as a product, with nothing personal; the operations log and a short `CLAUDE.md` in the private instance repo.
- **Rejected**: keeping everything private.

### D5 — Deploying a new app version
- **Choice**: after the build, the app repo's workflow opens a PR on the instance repo changing the image tag; it merges by itself when CI is green (how: D86; which repos hold the token: D88, D92).
- **Rejected**: Renovate (verified: one run every 4 hours on the free plan, and it cannot order `sha-…` tags); a moving `:main` tag (no longer "as code").

### D6 — Runtime
- **Choice**: Node LTS for the CLI and the reconciler. **Rejected**: Bun, Deno (less known, rule 9).

### D7 — No secrets in Ignition
- **Context**: verified, Hetzner user-data can be read from the server at `http://169.254.169.254/hetzner/v1/userdata`.
- **Choice**: Ignition holds only public keys, the sshd config and systemd units. The age key and the deploy key are placed over SSH. The metadata service is blocked from containers (D62). One exception: the provisional host key of a new server, swapped at the first connection (D91).
- **Rejected**: secrets in user-data.

### D8 — Docker socket
- **Choice**: only the reconciler mounts it; the status page reads through the reconciler's internal API (D96).
- **Rejected**: the socket in the status page.

### D9 — Restore testing
- **Choice**: every week, `restic check` and the latest dumps restored into a throwaway Postgres (D75); a full `bivy rebuild --test` before prod, then every 3 months (D39, D44).
- **History**: the first draft of the brief called the rebuild test "not a priority".

### D10 — Auth modes
- **Choice**: `oidc` (default), `forward` (Tinyauth), `public`, `local` (D97). `forward` is built when an app needs it (D44).
- **History**: first "all four in v1".

### D11 — Claude's SSH key
- **Choice**: a dedicated `bivouac-claude` key on the owner's Mac, revocable alone.
- **Accepted**: it logs in as `core` (sudo, Docker): read-only is discipline, not a barrier.
- **Rejected**: a "read-only" user (illusory: reading Docker logs already takes root-equivalent access).

### D12 — Authorized SSH keys
- **Choice**: one key per machine and per use, never copied; the only list is `ssh-keys.yml` in the instance repo, applied by the reconciler and a host script (D63). Every change is high-risk.
- **Rejected**: keys only in Ignition (a rebuild per key); a private key shared between machines.

### D13 — Domain scheme
- **Choice**: `*.apps.example.org`.
- **Rejected**: `*.bivouac.example.org` (the project name baked into passkeys); `*.example.org` (session cookies shared with the whole domain).

### D14 — Derived secrets
- **Context**: a per-database `pg_dump` does not keep roles; Pocket ID lets us choose an OIDC client's secret (verified).
- **Choice**: every secret the platform generates is `HMAC-SHA256(master secret, "<purpose>")`, never stored, recomputed identically after a rebuild. Purposes: `postgres:superuser`, `db:<database>`, `oidc:<app>`, `session:<app>` (D97), `api:status` (D96). Rotation: a version suffix.
- **Rejected**: storing generated secrets somewhere that must be backed up.

### D15 — Pocket ID's `/setup`
- **Context**: `/setup` creates the first admin for whoever gets there first (verified).
- **Choice**: `/setup` and `/api/signup/setup` are refused by Caddy for good, except from the owner's public IPv4 (`auth.setupFrom`) while the first admin is created (D53, D99).
- **History**: first "the route is removed after setup"; on 8 Nov. 2026 only the exception is removed, which also covers an empty Pocket ID after a reinstall.

### D16 — restic to B2
- **Choice**: B2 through its S3-compatible API, as restic's docs recommend (verified). **Rejected**: the native B2 backend; rclone.

### D17 — Private app images
- **Context**: verified, GHCR only accepts classic PATs.
- **Choice**: private images, pulled with a classic `read:packages` PAT without expiry, in SOPS. It reads every package of the owner, and nothing else. Also pulls images of the owner's organization (verified on the server, D88).
- **Rejected**: public images (the owner's choice).

### D18 — Removing an app *(not built)*
- **Choice**: a final `pg_dump` to restic tagged `archive`, then the database and volume renamed `archived_<app>_<date>`; actual deletion only on the owner's explicit action. Until it is built, removing a manifest only removes the route; the rest is removed by hand, with consent (runbook section 14). **Meanwhile the app's data leaves the nightly copies at once** (the backup lists current manifests only, D74) and older copies age out with retention: take a final copy by hand before removing a manifest.
- **Rejected**: automatic deletion.

### D19 — Framework-agnostic contract
- **Choice**: the manifest describes any image: port, health path, platform values renamed through `env`, `name → path` volumes, optional database. **Rejected**: one app type per framework.

### D20 — Apps that keep data in files
- **Choice**: `backup: { stop: true }` stops the container during the nightly backup; off by default.
- **Accepted**: the app is down for the whole upload, not "a few seconds" (D74).
- **Rejected**: copying live (inconsistent SQLite files).

### D21 — Failed deployments and migrations
- **Choice**: a container that fails its health check is stopped and its image marked, not retried until the manifest changes; migrations are additive only and run at startup (a destructive one takes two deployments), so the previous image can always run. Rolling back to the previous image automatically is *not built* (layer 6): today the app stays down until the manifest changes, with an alert.
- **Rejected**: retrying every pass (redeploy loop); rolling migrations back.

### D22 — Static sites *(not built)*
- **Choice**: files in the instance repo's `sites/<name>/` with a `sites/<name>.yml`, served by Caddy's `file_server`, no container. Until built, a site manifest fails validation rather than being served unprotected.
- **Rejected**: one image per HTML page.

### D23 — One app template
- **Choice**: Nuxt only. Apps in other frameworks follow the contract by hand (the first `local` app is Next.js, D97). **Rejected**: a Next template while there is a single Next app.

### D24 — Server and IP
- **Context**: the owner's CX23 in `fsn1`, with `203.0.113.10`. Verified (6 Nov. 2026): the CX23 could no longer be ordered in `fsn1`, a Primary IP only goes to a server in its location, and the existing server keeps an older, lower price.
- **Choice**: reinstall the existing server in place with Hetzner's `rebuild` action, keeping server, type, price and IP; the IP is a Primary IP with `auto_delete=false`. `example.org` and `www.example.org` serve a static page (D22).
- **Learned**: CX23 availability changes by the minute and by location. When none can be ordered in the IPs' location, a real rebuild onto a new server stops and lists the types orderable there (`--server-type` picks one, keeping IPs and DNS); another location means new IPs and a DNS change, done by hand, not by `bivy` (D91).
- **Rejected**: moving to another location with a new IP (higher price, one more DNS change).

### D25 — Architecture
- **Choice**: x86. **Rejected**: Arm (every image built for two architectures).

### D26 — IPv4 required
- **Context**: verified (4 Nov. 2026), `github.com`, `api.github.com`, `ghcr.io` have no IPv6.
- **Choice**: IPv4 (€0.50/month), IPv6 on top (D67). **Rejected**: IPv6 only; a public NAT64 gateway.

### D27 — Proxy trust
- **Choice**: Pocket ID's `TRUST_PROXY` (a list, not a boolean: verified) and Tinyauth's `TRUSTEDPROXIES` name only Caddy's fixed address on the internal network (D56); Tinyauth runs with `ACLS_POLICY=deny`.
- **History**: first Caddy's subnet; narrowed on 6 Nov. 2026, since apps share a subnet with Caddy and could pass for it.

### D28 — Komodo and doco-cd
- **Choice**: rejected; the container part is about a hundred lines against the Docker API (D55). They would add a component with its own UI and state.

### D29 — Postgres major versions
- **Choice**: Renovate never proposes them; they go through dump-then-restore, as a high-risk change. **Rejected**: letting Renovate bump the image (Postgres would refuse to start).

### D30 — Server access to the instance repo
- **Choice**: a read-only deploy key, generated on the server (D66) and added by the owner at a link; during a rebuild the new key is added first and the old one removed only once everything worked.
- **Rejected**: the deploy key in SOPS (the repo must be read to decrypt it).

### D31 — How `bivy` reaches the outside
- **Choice**: `bivy` talks directly to the official APIs (Hetzner, GitHub, OVH, healthchecks.io); SOPS, Butane and the snapshot tool run in pinned containers. It depends on neither `gh`, `hcloud` nor `sops`. GitHub tokens: none for `bivy init` (D99); a one-day fine-grained PAT for `bivy rebuild --test` only (D91).
- **Rejected**: depending on `gh`; an OAuth App with device flow (one more component).
- **History**: first a 7-day PAT for every command. `gh` is on the Mac since 9 Nov. 2026, for Claude's work only (D78).

### D32 — Platform MCP *(rejected, see D104)*
- **Was**: the reconciler would serve a stdio MCP launched over SSH (`ssh core@<server> docker exec bivouac-reconciler mcp`): nothing exposed, the SSH key as authentication, off the internet because it holds the Docker socket's power (unlike app MCPs, D85). An MCP served by the status page was rejected.
- **History**: dropped on 21 Nov. 2026 (D104), never built: Claude already reaches the server through `bivy` and a terminal, so an MCP would be a second way in for the same work, one more component, and one the owner cannot use.

### D33 — Scheduling backups
- **Choice**: the reconciler triggers the nightly backup and the weekly test, running restic in throwaway containers (D74, D75).
- **Rejected**: a cron container (one more component); a systemd timer from Ignition (cannot change without a rebuild).

### D34 — Reserved names
- **Choice**: `auth`, `gate` and `status` are refused as app names; so are names clashing with Postgres or the platform (D56) and names ending in `-mcp` (D85).

### D35 — CI never decrypts secrets
- **Choice**: CI checks, without the key, that every secrets file is encrypted and well-formed; decryption is checked by the reconciler on each pass and by the restore test.
- **Rejected**: the age key in GitHub Actions.

### D36 — The deployment token
- **Context**: verified, on GitHub Free organization secrets are not available to private repos.
- **Choice**: a fine-grained `bivouac-deploy` PAT, limited to the instance repo (contents and PRs, write), kept in the owner's password manager and set by the owner by hand, only on app repos that meet D92's conditions. Whoever holds it can push to the instance repo's `main` (D64).
- **History**: first in SOPS and set by the "new app" skill; changed on 19 Nov. 2026 (D98): Claude's `gh` token cannot set secrets.
- **Rejected**: the age key in a repo; organization secrets.

### D37 — No email login code
- **Choice** (settled 15 Nov. 2026): `EMAIL_ONE_TIME_ACCESS_AS_ADMIN_ENABLED` and `EMAIL_ONE_TIME_ACCESS_AS_UNAUTHENTICATED_ENABLED` stay `false`. Someone who lost their passkeys gets a one-time **Login Code** link from the admin, through any messaging app. The admin's own rescue: `bivy login-link <user>` (D107, runbook section 10).
- **Why**: verified (Pocket ID v2.19.2 source), a session opened with the self-service code can enroll a passkey without re-authentication, so every account would be as safe as its mailbox; the admin-sent code is the same link sent by mail, with no gain.
- **Revisit**: when an app opens to the general public, or the community outgrows help by hand.

### D38 — Lost machine, and secrets shown once
- **Choice**: `bivy machine add` (*not built*) makes a key on a new machine and opens the PR adding it, removing a lost one. A lost Mac means rotating secrets, with consent. Until it is built: runbook section 20. `bivy init` shows the age key and restic password once and waits until `stored` is typed. The only lockout: losing both GitHub access and the password manager.

### D39 — Low-cost rebuild test
- **Choice**: `bivy rebuild --test` builds a temporary server billed by the hour, restores, checks, destroys everything, never touching the real IPs or DNS (D91). Before prod, then quarterly, with a reminder from the reconciler. **Rejected**: a permanent second VPS.

### D40 — Auth hostnames
- **Choice**: Pocket ID on `auth.apps.example.org`, **final** (it is in every passkey; changing it invalidates them all); Tinyauth on `gate.apps.example.org` (invisible, can change). **Rejected**: `id.`, `connexion.`, `idp.` (jargon).

### D41 — Language
- **Choice**: the public monorepo entirely in English, PRs included, in plain language (rule 3); conversations with the owner and the instance repo in the language set in `INSTANCE.md`.
- **Rejected**: a French or mixed public repo; two versions of the brief (they would drift).

### D42 — Resource usage
- **Choice**: current CPU, memory and disk for the host and each container, on the status page (built, D96); one sample a minute kept 30 days in Postgres (*not built*: the store is to discuss). Disk alert above 80% (D45).
- **Rejected**: Prometheus and Grafana (two components, hundreds of MB of RAM, from memory).

### D43 — Environments
- **Choice**: no permanent dev or staging instance. Apps are developed on the Mac (`dev:local`, D83); an `<app>-preview` manifest tries an app on the real server; the platform is tested on the miniature platform (D59) and with `bivy rebuild --test`.
- **Rejected**: a permanent dev instance (a second server, with separate Pocket ID accounts).

### D44 — Maintenance promise and building in layers
- **Context**: nothing connected to the internet runs untouched for years; a large platform risks being abandoned halfway.
- **Choice**: the promise is "zero config, maintenance that is rare, guided and never silent": a few interventions a year, each announced by an alert and handled in one session and one PR. Built in layers, each useful alone: foundations, base on the VPS, safety net (backups and alerts), first real app, rebuilding without memory, the rest of the reconciler, then features on demand. `forward` and `local` come when an app needs them.
- **Rejected**: a platform that "never needs touching" (impossible, hides the cost); Compose alone (the owner wants the product); a managed PaaS (cost per app, no shared login).

### D45 — Alerts
- **Choice**: Pushover is the only channel; the reconciler calls its API directly. The server reports what it can see: failed deployment, disk above 80%, failed backup or restore test, secrets that fail to decrypt, the quarterly rebuild-test reminder. healthchecks.io is the dead man's switch for what a dead server cannot send: nightly backup, weekly restore test, reconciler heartbeat; it notifies Pushover itself. One alert per change of state, at most one reminder a day (D76). All at normal priority (D82).
- **Verified** (5 Nov. 2026): Pushover 10,000 messages a month per account, then HTTP 429; healthchecks.io free plan, 20 checks, native Pushover integration.
- **Accepted**: healthchecks.io's addresses seem to be at Hetzner (from memory), so a Hetzner-wide outage could silence both.
- **Rejected**: email alerts; an alert per pass (quota gone in a week); UptimeRobot for now; a self-hosted monitor (it dies with the server).

### D46 — License
- **Choice**: MIT for the whole monorepo: every app copies the template, and AGPL would force each app to publish its source. **Rejected**: AGPLv3; two licenses in one repo.

### D47 — Monorepo tooling
- **Choice**: npm workspaces, strict TypeScript, Zod for the manifest schema, Vitest, Node 26 LTS (verified 5 Nov. 2026); Butane and SOPS in their official containers. **Rejected**: pnpm (one more tool everywhere for a handful of packages).

### D48 — Instance repo validation (`bivy validate`)
- **Choice**: the instance CI calls a reusable workflow of the public monorepo (verified: callable from any repo), so improving checks needs no change in the instance. Rules:
  - exact image versions only (tag or digest; `latest` refused), since rollback needs exact images; the reconciler and status images need a digest (D61, D96);
  - `oidc` and `forward` require at least one group; groups are refused where they do nothing;
  - unknown fields, non-`.yml` files in `apps/` or `sites/`, and a `name` differing from its file name are refused;
  - `ssh-keys.yml` is the only key list, never empty, never a private key;
  - every file in `secrets/` SOPS-encrypted for exactly the keys in `.sops.yaml`; any file holding a private key fails, wherever it is;
  - Butane compiled with `--strict`, and `caddy validate` on the generated Caddyfile: a warning fails.
- **Learned**: a YAML 1.2 parser reads `mode: 0600` as decimal while Butane reads octal; the CLI never re-serializes the Butane file.

### D49 — OVH API keys
- **Choice**: keys created at `https://api.eu.ovhcloud.com/createToken/` with GET, POST and PUT on `/domain/zone/example.org/*` only, no DELETE (a record is removed by hand). Checked: creating a record and refreshing the zone work with this scope.
- **Rejected**: rights on every zone; DELETE "just in case".

### D50 — Reconciler versions
- **Choice**: CI publishes `ghcr.io/<owner>/bivouac-reconciler:sha-<commit>` once the tests pass on `main`; the instance names the version in `platform.yml` (D60) and the reconciler moves itself to it (D61).
- **Learned**: the package could be pulled anonymously right after its first publication, although GitHub's docs say new packages are private.
- **Rejected**: the moving `:main` tag; a rebuild per version.

### D51 — Postgres image
- **Choice**: `postgis/postgis:18-3.7` (no pgvector, no arm64 build: runs under emulation on Apple Silicon). An image of our own when an app needs pgvector.

### D52 — Pocket ID settings
- **Choice**: `TRUST_PROXY` = Caddy's fixed address (D27), `ALLOW_INSECURE_CALLBACK_URLS=false`, secrets as `_FILE` variables, `FILE_BACKEND=database` (uploads in Postgres and its backups), `ANALYTICS_DISABLED=true`, `UI_CONFIG_DISABLED=true` (settings from Git, D70).
- **Learned** (v2.19.2, checked on a real container and by the end-to-end tests): an OIDC client's chosen secret is set with `POST /api/oidc/clients/{id}/secrets`, and creating a client also creates a random one; `PUT /api/oidc/clients/{id}` replaces the whole client, and leaving out `isGroupRestricted` turns the restriction off and empties the groups. The reconciler therefore always sends the full client with `isGroupRestricted: true`, then the groups, and leaves exactly one secret, the derived one. The docs site describes unreleased versions: every call is checked by the end-to-end tests.

### D53 — Generated Caddyfile
- **Choice**: the reconciler generates it (the same code runs in `bivy validate`); upstreams by container name; Caddy's admin API only inside its container, reloaded by `docker exec`, with the previous file put back if Caddy refuses a new one. First-admin paths refused before the proxy (D15). `forward` and static sites fail validation until built.
- **Learned**: Caddy passes the client's real IPv4 to Pocket ID (verified on the server); over IPv6 and from containers it sees a Docker gateway (D67, D69).

### D54 — Reconciler pass rules
- **Choice**: a shallow checkout, fetched and hard-reset with `git clean`, so a hand change on the server never survives a pass. A commit that fails validation applies nothing (the last valid state stays). Generated files written atomically and only when they change. GitHub's SSH host keys pinned in the image.

### D55 — Containers through the Docker API
- **Choice**: the Engine API over Node's HTTP module, pinned to API 1.48 (Flatcar ships Docker 28.2), with timeouts; node-postgres for Postgres. Each container carries a fingerprint of its spec in a label and is recreated only when it changes. Base images pinned by digest and pulled only when missing. Base services use Docker health checks, apps are checked over HTTP by the reconciler (no `curl` needed in images). Generated files in `/var/lib/bivouac`, mounted at the same path in the reconciler. Logs capped at 3 × 10 MB per container.
- **Learned**: in Caddy's image `localhost` is `::1`, where the admin API does not listen: use `127.0.0.1`.
- **Rejected**: dockerode (rule 9); `psql` through `docker exec` (passwords on a command line); Docker health checks for apps.

### D56 — Network isolation and Postgres hardening
- **Context**: rule 6 review, 6 Nov. 2026: apps shared a network with Pocket ID, and Docker's default `NET_RAW` would let a compromised app forge packets.
- **Choice**:
  - two networks with fixed subnets: `bivouac` (10.209.0.0/24: apps, Caddy, Postgres, reconciler) and `bivouac-internal` (10.209.1.0/24: Pocket ID, Caddy, Postgres, reconciler, status page); Caddy has the fixed address 10.209.1.10;
  - every container drops `NET_RAW` and runs with `no-new-privileges`; none on the host network;
  - apps may only ask for allowlisted extensions (PostGIS family, pg_trgm, unaccent, citext, pgcrypto, hstore, btree_gin, btree_gist, fuzzystrmatch); `CONNECT` on `postgres` and `template1` revoked; superuser sessions never log failing statements.
- **Accepted**: the Postgres image trusts local connections inside its container (only root benefits). Apps reach each other on `bivouac` without Caddy (D94).

### D57 — Platform secrets file
- **Choice**: `secrets/platform.sops.yaml` holds `master_secret` (≥ 32 characters), Pocket ID's `encryption_key` and `static_api_key` (≥ 16), and the tokens and credentials of backups, alerts and mail. Decrypted by sops copied into the reconciler image; a failure applies nothing, and no message quotes decrypted text. Base services get secrets as read-only files without a trailing newline; apps get theirs in the environment (D19). The internal API never shows container environments.
- **Rejected**: deriving Pocket ID's keys from the master secret (rotating it would lose the signing keys).

### D58 — OIDC callback convention
- **Choice**: client ID = app name; callbacks `https://<host>/auth/callback`, logout to `https://<host>/`. A manifest field will come with the first third-party app that needs another path.

### D59 — Miniature platform and end-to-end tests
- **Choice**: the tests build the reconciler image and run it against a throwaway instance repo on the local Docker, with real Postgres, Pocket ID, Caddy and test apps, on `apps.bivouac.localhost` (Caddy's local authority). CI publishes the image only when they pass. `npm run platform:up` starts the same platform locally; `platform:down` refuses on a machine holding `/etc/bivouac/age.key`.

### D60 — Reconciler version and repo address in `platform.yml`
- **Choice**: `platform.yml` has `repository` (SSH address on GitHub) and `reconciler.image` (same image repository only; it gets the Docker socket). `bivy ignition` fills the Butane's placeholders from them, by text replacement of schema-checked values, and refuses an Ignition config above Hetzner's 32 KiB.
- **Rejected**: the values written in the Butane (two places that drift).

### D61 — How the reconciler updates itself
- **Choice**:
  - Right after fetching Git and **before** validating (an older version may not understand a newer field), the reconciler reads `reconciler.image`. For another version of the same image, it pulls it, runs `main.js selftest` in a throwaway container, writes `/var/lib/bivouac/reconciler/image.env` and exits; systemd (`Restart=always`, `EnvironmentFile=` read before each start: verified) brings it back on the new version. Another publisher's image, or a failed self-test, is refused with an alert until `platform.yml` changes.
  - **Pinned by digest** (`…:sha-<commit>@sha256:…`, the multi-architecture index's digest): required by `bivy validate`, and a reconciler already on a digest never moves to a tag alone, since a push to `main` skips CI (D64).
  - **Automatic fallback**: a new version is on trial until its first pass that does not end in a move, whatever its outcome. A host script run by `ExecStartPre=-` counts its starts; at the fourth (about 40 s of crashing) it puts back the last proven version and records the failed one, which is not retried; the owner is alerted. Rehearsed on a test server (14 Nov. 2026). A counter in a file, because systemd's start limits with `Restart=always` are not spelled out.
- **Accepted**: a version that crashes after its first pass is not rolled back (the heartbeat reports it); going back by hand means writing the wanted version to `image.env`, never deleting it (that falls back to the version from Ignition, possibly months old). Since D109, Renovate moves the reconciler once a month through its `v1.0.<n>` tag, and a version on trial whose new base image does not start goes back by itself.

### D62 — Metadata block: our own nftables table
- **Choice**: Ignition writes `/etc/bivouac-metadata-block.nft` (table `inet bivouac_metadata`, forward hook, priority filter − 10, `ip daddr 169.254.169.254 reject`), loaded by `bivouac-metadata-block.service`, which `docker.service` requires: no container runs without it. Only forwarded traffic is affected; the host still reads its metadata. The reconciler checks on each pass that the address is out of reach. Invariants: no container on the host network; never `nft flush ruleset` on the server. Verified on the server: refused from containers, still so after a Docker restart and a reboot.
- **Rejected**: a `DOCKER-USER` rule (Docker's handling of it across restarts is undocumented).
- **History**: replaces D7's first plan (8 Nov. 2026).

### D63 — SSH key sync
- **Context**: verified (Flatcar source), sshd reads only `~core/.ssh/authorized_keys`, regenerated by `update-ssh-keys` from `authorized_keys.d/`; Ignition's own fragment would otherwise stay forever.
- **Choice**: on each valid pass, first of all, the reconciler writes the list to `/var/lib/bivouac/ssh/authorized_keys`. On the host, `bivouac-ssh-keys.path` (plus at boot and every 15 minutes) runs `/opt/bivouac/sync-ssh-keys`, which checks every line again, refuses an empty list, applies it as the `bivouac` fragment and only then removes every other fragment. It writes `applied` or `refused` with a hash; the reconciler alerts on a list refused or not applied after two minutes. Lockout rescue: runbook section 11, tried 8 Nov. 2026.
- **Rejected**: mounting `authorized_keys.d` in the reconciler.

### D64 — Who can write to the instance repo
- **Context**: pushing to the instance repo's `main` is root on the server (SSH keys, reconciler image). Branch protection and rulesets are refused on a private repo of GitHub Free (verified).
- **Choice** (14 Nov. 2026): isolate the `bivouac-deploy` token. In app repos, the workflow that runs `npm ci` and builds never names it; a second workflow, `propose.yml`, started by `workflow_run`, opens the deployment PR, runs no app or dependency code, and always runs as it is on the default branch (verified: Actions scrubs secrets a workflow does not reference). One run at a time, only the tip of `main`, forks refused. **The isolation assumes GitHub-hosted runners** (a fresh virtual machine per job, verified); a self-hosted runner would break it.
- **Accepted**: whoever can write to an app repo that holds the token can read it and push to the instance repo's `main` (hence D88, D92).
- **Rejected**: GitHub Pro to protect `main` (about $4 a month, from memory; possible later if more people are invited); a GitHub App of our own.

### D65 — Making the Flatcar snapshot
- **Choice**: `hcloud-upload-image` (a third party's tool), pinned by digest, in a read-only container, with a temporary Hetzner token deleted right after. The image is downloaded on the Mac and checked (Flatcar's GPG signature, then SHA-512), and that file is sent with `--image-path`. Delete protection set on the server and its IP first. The API is checked afterwards for leftovers with the tool's label (`bivy` never uses that label).
- **Learned**: Hetzner tokens cannot be narrower than read-write on the whole project; a server's delete and rebuild protection must have the same value, so both are lifted before a rebuild; a snapshot is not bound to a location; the tool cleans up with Go defers, which do not run if it is killed.
- **Rejected**: `--image-url` (no integrity check); the main token given to the tool.

### D66 — The deploy key is generated on the server
- **Choice**: `ssh-keygen` on the server (`/etc/bivouac/deploy_key`, 0600); only the public key leaves it; the owner adds it as read-only at a link. Read-only is checked from the server (a push is refused). The reconciler picks the key up without a restart.
- **Rejected**: generating it on the Mac; adding it with a token (verified: it takes "Administration: write", which can delete the repo; and a key added with a PAT disappears with the PAT, D91).

### D67 — IPv6 on Flatcar; no `AAAA` record
- **Context**: verified, Flatcar configures only DHCPv4 at Hetzner, and Docker networks have no IPv6, so IPv6 visitors reach Caddy through Docker's userland proxy and look like a Docker gateway.
- **Choice**: the instance's Butane configures the Primary IPv6 statically (a drop-in for Flatcar's default network file). **No `AAAA` record** (settled 16 Nov. 2026): visitors come over IPv4 only; the server uses IPv6 for SSH and outbound traffic. `setupFrom` refuses private, gateway-like and IPv4-mapped addresses, so the first-admin page is never opened to a Docker gateway.
- **Accepted**: a visitor with no IPv4 at all cannot connect (rare, NAT64 usually helps, from memory). If ever wanted: IPv6 on the `bivouac` network (recreating it), with a rule 6 review.
- **Rejected**: a boot unit reading the metadata service; a hand-set address (lost at rebuild).

### D68 — Pocket ID after a restart
- **Choice**: accepted (15 Nov. 2026). Verified (v2.19.2 and its actor library): Pocket ID registers as the single actor host in its database, considered alive 90 s after its last health check; a new instance finding a live one exits until then. After a reboot (Postgres stops before Pocket ID unregisters), nobody can sign in for one or two minutes; open sessions are unaffected. Since D94, the reconciler stops a container cleanly before replacing it, so version changes no longer trigger it.
- **Rejected**: a systemd unit stopping Pocket ID before Docker; `HA_ENABLED`.

### D69 — Publishing the wildcard before the first admin
- **Choice**: the rule 6 review runs **before** the DNS write (certificates are public: the first unknown visitor came 14 s after issuance). An `A` record only, TTL 3600. No change of Pocket ID's version while it has no admin.
- **Emergency stop**: close 80/tcp, 443/tcp and 443/udp at the Hetzner firewall, IPv4 and IPv6 (removing the DNS record closes nothing). If an unwanted admin ever appeared, Pocket ID's data would have to be reset too.
- **Learned**: traffic from every app through the public URL reaches Pocket ID from one gateway address and shares one rate limit; Node's `fetch` fails TLS with `eu.api.ovh.com` from the Mac, `api.eu.ovhcloud.com` works.

### D70 — Pocket ID sends through the OVH mailbox
- **Choice**: `platform.yml` has an optional `mail` block (host, port 587 with STARTTLS only, from, user); the password is in SOPS and reaches Pocket ID as a file. `ALLOW_USER_SIGNUPS=withToken` (invitation pages need it; open sign-up stays refused). `_dmarc.example.org` is `p=none`, no report address. SPF already covers OVH; it is never duplicated.
- **Rule**: the mailbox password opens the whole mailbox: **never given to apps**. `SMTP_*` for apps stays unimplemented until a send-only relay is chosen; meanwhile an app sends through its own account, as its own secret (D97).
- **Accepted**: a Pocket ID compromise yields the mailbox password, so the mailbox holds nothing that matters; spam would hurt the domain's reputation; the password file stays on disk if `mail` is later removed. The first test message landed in Gmail's spam (cause unknown).
- **Rejected**: Brevo for Pocket ID (one more account for a few messages a month; still a candidate for the apps' relay); settings through the admin screen.

### D71 — Personal details out of the public repo
- **Choice**: `example.org` and `203.0.113.10` stand in for the real values, kept in the instance repo's `INSTANCE.md`; Git history was rewritten and commits use GitHub's `noreply` address.
- **Accepted**: the owner's name stays in `LICENSE` and the GitHub handle in image and repo addresses; copies made before the rewrite may exist.

### D72 — S3-ready apps, without an S3 server
- **Choice**: apps reach user files through one small storage module: the declared volume by default, S3 when `S3_BUCKET` is set. Its tests run against both, with a throwaway Garage in CI only.
- **Rejected**: Garage in production (one more stateful component, a harder backup, no gain on one server; verified, a single node is for tests only and its secrets cannot be derived).
- **Revisit when**: a third-party app only speaks S3, an app needs direct browser uploads, or the platform spans several machines.

### D73 — Where the backups go, and what the server's key can do
- **Choice**: a private B2 bucket in EU Central (since 13 Nov. 2026; the first sign-up did not offer it), whose lifecycle rule keeps hidden files 30 days. The server's key has `listBuckets`, `listAllBucketNames`, `readBuckets`, `listFiles`, `readFiles`, `writeFiles` only (made through the native API with the master key): a compromised server can hide and read everything but destroy nothing for 30 days. Credentials and the restic password in SOPS. Caps since 14 Nov. 2026: $0.10/day storage, $1/day downloads (a full restore fits in a day).
- **Learned** (verified): the master key does not work with the S3 API; without a card every cap is $0; caps reset at 00:00 GMT; a new account cannot create buckets until its email address is verified.
- **Accepted** (owner's choice): no independent monthly check from outside the server (unlikely risk: a takeover that hides the copies unnoticed for 30 days); recovering a hidden file is written from memory and untried (runbook section 12).
- **Rejected**: "keep only the last version" (a compromise could destroy the history at once); hidden files kept 100 days.

### D74 — How the nightly backup runs
- **Choice**: at 02:00 UTC, retried once an hour later, caught up if the server was off, 110 minutes at most. `pg_dump --format custom --compress 0` per database in a throwaway container, then one `restic backup` with a fixed `--host` (otherwise retention never removes anything). A database that cannot be dumped tags the copy `incomplete`, never used as the latest good one. Refused when the dumps would fill more than 80% of free disk. **A server with no backup state waits for the next night** (an empty platform never becomes the latest copy), and the repository is only created before the first success; afterwards a missing one is an alert.
- **Accepted**: a self-update waits for a running backup; a removed app leaves the nightly set with no final archive until D18 is built.

### D75 — Retention and the weekly restore test
- **Choice**: weekly, after a good backup: `forget` on `nightly` snapshots (7 daily, 4 weekly, 6 monthly), `incomplete` kept 30 days, `prune`; `archive` snapshots never touched. Then `restic check --read-data-subset 10%`, and the latest copy restored into a throwaway Postgres (no network, no secret, limited resources), each dump loaded with `--no-owner --no-privileges --exit-on-error` and compared with the live databases.
- **Limit**: proves the data comes back, not that a passkey login works (D39). `pg_restore` as superuser is confined to this throwaway Postgres and never used against the real one.

### D76 — Alerts as built
- **Choice**: a problem is announced after 3 failing passes in a row, repeated at most once a day, announced as resolved after 3 clean ones; at most 50 messages a day; disk alert at 80%, cleared at 75%. Alert text redacted (passwords, tokens). The credentials are copied after each successful decryption to a root-only file, so "secrets cannot be decrypted" can still be sent. The heartbeat is withheld once alerts have been undeliverable for a day. `BIVOUAC_ALERTS=off` on the local platform.
- **Open**: an app that crashes after a healthy start may not raise an alert (with rollback, layer 6).

### D77 — Superuser sessions ignore a database's own settings
- **Choice**: an app's role can `ALTER DATABASE … SET search_path`, which would apply to the superuser too; superuser sessions connect with `-c search_path=pg_catalog`. Every database call has time limits. An end-to-end test plays the hostile app.

### D78 — `gh` on the owner's Mac, for Claude
- **Choice**: `gh` with a fine-grained PAT in the macOS keychain, limited to the monorepo and the instance repo (contents, Actions and statuses read; PRs write), 366 days. Verified: it cannot push, merge, rerun a workflow or set secrets. A second token covers the owner's organization (D88, D92). Not a dependency of the product (D31).
- **Limit**: its expiry is not alerted; `gh` fails with a 401 and the owner makes a new one.
- **Rejected**: `gh auth login` (write access everywhere); `GH_TOKEN` in a shell profile.

### D79 — The Nuxt app template
- **Choice**: `app-template/`, outside the npm workspaces, extending the shared layers (D80): `platform` (database, migrations, health) and `oidc` (sign-in). The session key is derived from the OIDC client secret by HKDF; the callback address comes from `Host`. Sessions last 24 hours in an encrypted cookie, with no server-side revocation (removing someone takes effect within a day). Everything is protected by default; dot segments, backslashes and empty segments are refused, and decisions read the router's own path (D94); requests that change something must come from the app's own origin (sibling apps are the same site). `/api/health` answers 503 until migrations end.
- **Rejected**: `nuxt-auth-utils`; `/auth/*` as a public prefix.

### D80 — Shared layers by exact commit
- **Choice**: the layers live in `app-layers/` of the monorepo; each app extends them at one exact commit, named in `nuxt.config.ts` beside its release tag `app-layers-v<x.y.z>`; the build fails if a layer is missing (Nuxt would only warn, giving an app with no sign-in). Publishing: merge with green CI, then tag that commit on `main`. Release tags are protected by a ruleset.
- **Rejected**: copying the layers (fixes would not reach apps); an npm package (one more account and token); a tag alone (it can move).
- **History**: weekly Renovate updates of everything, revised by D81.

### D81 — Dormant apps
- **Context**: personal apps are left alone once finished; weekly update PRs would be ignored.
- **Choice**: in app repos Renovate only updates the shared layers' commit; minor and patch versions merge by themselves when tests pass, a major or a moved tag waits for the owner. Everything else is frozen until the quarterly check done with `bivy rebuild --test` (runbook section 13: high and critical advisories reachable from outside). Renovate is installed per app repo ("Only select repositories"), except in the owner's organization, where it covers every repo (D92).
- **Accepted**: a dependency flaw can stay open up to three months; nothing alerts on a layer PR stuck on red tests.
- **Rejected**: routine updates; Renovate on security advisories (noise).

### D82 — Alerts tried for real
- **Choice**: every case of D45 was caused on the real server and received on the owner's phone (9 Nov. 2026). **Every message at normal priority** (owner's choice: one day of loss is accepted, nothing is worth waking for); Pushover's quiet hours decide. Server messages go to a Pushover delivery group. An alert keeps the first message of its incident; its end reads "No longer happening: …".
- **Learned** (healthchecks.io source): changing a check's schedule so it is already overdue marks it down **without notifying**; to rehearse a missed ping, send a success first.
- **History**: D45 first gave priority 1 to a full disk and a silent server.

### D83 — Apps are checked on the Mac
- **Choice**: `npm run dev:local` in the template: Postgres in Docker on 127.0.0.1, migrations, the tests' fake identity provider (groups from `DEV_GROUPS`), `nuxt dev`. Every interface change is checked there (light, dark, phone width) before pushing, never on the real server.
- **Learned**: `npm run build` while `dev:local` runs breaks the dev server.
- **Rejected**: the miniature platform for app work (heavy; real passkeys get in the way).

### D84 — Web Push without a relay *(deferred)*
- **Context**: unlike mail (blocked ports, poor VPS reputation, an all-powerful mailbox password), Web Push is one HTTPS request per message, signed with the app's own VAPID keys.
- **Direction**: no new container. On iPhone, Web Push works only once the app is added to the home screen (from memory, to check). The first app that did it keeps its VAPID keys **in its own database**, so they come back with the backups; a shared module can follow that model when a second app needs push.
- **Rejected**: Pushover for users; self-hosted ntfy; native APNs or FCM.

### D85 — An app may open an MCP for Claude
- **Choice**: manifest `mcp: true` (`oidc` apps only). The reconciler creates a public Pocket ID client `<app>-mcp`, restricted to the app's groups, with Claude's callbacks (`https://claude.ai/api/mcp/auth_callback` and `http://localhost/callback`) and **a passkey required at every sign-in**, plus an API whose resource is `https://<host>/mcp`. The app gets `MCP_RESOURCE`. The shared layer serves the protected-resource metadata and opens `/mcp` to bearer tokens only, never the cookie, checking signature, `typ: at+jwt`, issuer, audience, expiry and `client_id`; groups come from userinfo (cached up to 5 minutes). Each person reaches only their own data.
- **Verified** (Pocket ID v2.19, Claude docs, 11 Nov. 2026): public clients with PKCE; a `localhost` callback matches any port; resource-bound JWT access tokens; refresh tokens 30 days; Claude accepts a pre-registered client ID without a secret.
- **Why a passkey every time**: claude.ai's callback is the same for every Claude user, so a link prepared in someone else's account could otherwise have connected it silently.
- **Accepted**: an access token stays valid up to its hour (no revocation endpoint); a book title could try to steer Claude, within that person's data.
- **Open**: whether a connector added on claude.ai shows up in the phone app.
- **Rejected**: stdio over SSH for app MCPs (Claude Code only); session cookies or personal API keys; dynamic client registration (Pocket ID lacks it).

### D86 — Deployment PRs merge by themselves
- **Choice**: `merge-deployments.yml` in the instance repo runs when Validate succeeds, and merges, at the validated commit, a PR from a `deploy/` branch that changes exactly the `image:` line of one `apps/<name>.yml` to another `sha-` tag of the same image repository, **and** says `Shared layers: unchanged`. `CHANGED` or `unknown` waits for the owner. Older deployment PRs of the app are closed. When several apps deploy at once, GitHub refuses a merge with "Base branch was modified" until it catches up: that one error is tried again up to five times (21 Nov. 2026, after four simultaneous deployments left one to the owner); any other refusal still waits for the owner. The script lives in the instance repo, so code from another repo never gets write access to it.
- **Accepted**: a convenience, not a barrier (D64); an app commit can change its sign-in without touching the layers; a merge by the workflow does not rerun Validate on `main`; improving the script means copying it into each instance repo.
- **Rejected**: GitHub Pro; merging any green PR.

### D87 — App tests run in Playwright's image
- **Choice**: the template's `test` job runs in `mcr.microsoft.com/playwright:v<version>-noble`, at the exact version of `@playwright/test`, after Ubuntu's mirrors failed twice. A mismatch fails at once.
- **Rejected**: rerunning and waiting; caching apt packages.

### D88 — An app repo others can push to holds no deployment token
- **Context**: GitHub says anyone with write access to a repo can read its Actions secrets, and GitHub Free has no protected branch or environment on a private repo (verified).
- **Choice**: such a repo builds and pushes its image, nothing more; its manifest is changed by hand. A fine-grained token cannot reach a repo where its holder is only a collaborator, so such apps live in the owner's organization.
- **History**: narrowed by D92 (14 Nov. 2026): an organization whose writers are all trusted with the server gets the token back.

### D89 — Real data before the prod phase: the interim phase
- **Context**: 11 Nov. 2026, two apps hold data the owner keeps, before the prod phase's conditions were met.
- **Choice**: Claude still pushes to `main` and deploys without a PR, but the server is no longer disposable: anything that can lose data (rebuilding the server, recreating Postgres, touching a database, a volume, the backup repository, the bucket, the master secret or Pocket ID's key) needs the owner's consent **and** a backup that succeeded after the last change of data (force one if in doubt, runbook section 12). Before a change to the **data path** (Postgres version or settings, volumes, the backup or archiving code, how databases and volumes are created or renamed), check that last night's backup succeeded and announce how the data would come back. Experiments happen on the Mac or the miniature platform. App data is never deleted without asking.
- **Rejected**: declaring prod at once; asking the owner to stop adding data.

### D90 — Restoring one app's data
- **Choice**: `restore-app`, a reconciler command run with `docker exec` (runbook section 14; guided by `bivy restore`, D101). Without `--yes` it only plans. It first sends the app's current data to restic (`pre-restore`), so it can be undone; stops the app; loads the dump into a new database **as the app's own role** and swaps it in one transaction, keeping the replaced one renamed (`bivouac_r<time>_<db>`); restores volumes with `restic restore --delete` limited to each volume. One lock keeps backups and restores apart. An interrupted restore leaves the app stopped and reported until a restore completes; a lock older than 3 hours is an alert. Rehearsed on the server with a throwaway app (13 Nov. 2026).
- **Learned**: PostGIS's `spatial_ref_sys` belongs to the superuser and is left out; settings set with `ALTER DATABASE … SET` are not in a per-database dump.
- **Rejected**: a staging copy of the volume (twice the disk); dropping the replaced database (D18); `pg_restore` as superuser (D75); several apps at once.

### D91 — Rebuilding the server: `bivy rebuild` and `--test`
- **On the server**: a **rebuild marker** (`/etc/bivouac/rebuild.json`, `rebuild` or `test`) placed by `bivy` before the keys. While the data is not back, a pass only applies SSH keys, decrypts secrets and starts Postgres: nothing ever starts on an empty database. `restore-platform` (run with `docker exec`) restores the latest `nightly` copy: each database as its own role with its derived password, extensions from the allowlist only, volumes into new volumes, then `restored.json`; the next pass starts everything. Every restic call of a rebuild uses `--no-lock` and writes nothing. **Test mode**, for the server's life: no backup, alert, healthchecks.io ping or mail; Caddy uses its local authority.
- **The host key without the console**: `bivy` makes an ED25519 key on the Mac and puts it in the compiled Ignition as the server's host key (Flatcar keeps a key already present: verified, and seen on the first run); the first, verified connection makes the server replace it, and from then on only the new key is trusted. The provisional key is readable in the user-data only by those who could already take the server (Hetzner, the token's holder, the server itself). A guard decodes every file source of the Ignition and refuses any other key.
- **`--test`**: a temporary CX23 wherever one can be ordered, its own IPs, and a firewall open to the Mac's IP only; everything labelled `bivouac-rebuild-test=<run>`, recorded locally, deleted at the end or by `--cleanup`; it never lifts a protection. A one-day fine-grained PAT ("Administration: write") adds the test's deploy key; deleting the token removes the key. **Proven** on 14 Nov. 2026: about 4 to 6 minutes, the copy (about 5 GB) restored in about 95 s, Pocket ID with the real signing keys, apps healthy, data identical, about €0.01, nothing left behind.
- **Real rebuild** (*built and tested against fake APIs, never run*; running it is the owner's decision, rule 5): `--plan` only reads. In place if the server exists, otherwise a new server on the Primary IPs; never touches DNS. The checkout must be exactly `origin/main`. It goes ahead only after the owner types the domain in a terminal; makes a fresh backup on the old server first (or `--without-fresh-backup`, refused while the platform still answers); checks Pocket ID's signing keys before and after; lifts protection only around Hetzner's `rebuild` and puts it back whatever happens; the owner adds the new deploy key by hand and removes the old one at the end. Claude never runs it without `--plan`.
- **Accepted**: the test server decrypts the real secrets (B2 key, GHCR token, mail password, master secret), reachable from the Mac only for an hour or two; that it writes nothing to the backups rests on code and tests. Apps on a test server sign in against the **real** Pocket ID (the issuer name resolves to it). An app's own scheduled job runs on the test server too (users of an app with a daily Web Push summary get a second one: they are warned before each test; revisit when a job reaches people outside the household or costs something).
- **Not proven by `--test`**: a passkey login in a browser (passkeys are bound to the real name), Let's Encrypt and DNS, moving the real Primary IPs.
- **Rejected**: `pg_restore` as superuser; reading the host key in the console; trusting it on first use; starting apps then swapping databases (they would migrate empty ones first); asking for the restic password (it is in SOPS).

### D92 — A trusted organization gets automatic deployments back
- **Choice**: app repos of the owner's organization hold the `bivouac-deploy` token again (D5, D86), on one condition, met by people and settings, not by GitHub: **everyone who can write to them is trusted with the server**. Only the owner and one trusted member; only the owner is an organization owner; two-factor required; base permission Read or None; fork workflows get no secrets and no write token; `actions/checkout` pinned by commit. An outside contributor works from a fork; a repo needing an outside writer goes back to D88.
- **Accepted**: the member's GitHub account, and the Claude GitHub app they use in that organization, become ways into the server; so may Renovate (Mend), if it can write workflows and so read the token (from memory, to check). Moving a repo there does not move its GHCR package: old images stay under the owner's account, kept until a quarterly test has brought the app back from the new one.
- **Rejected**: GitHub Team for protected environments (paid).

### D93 — The CLI: a readable showcase
- **Choice** (19 Nov. 2026, with the owner): `bivy` is a **readable showcase built for the owner's stack**, for a developer who is not an infrastructure person; no promise of support or releases. Generic where nearly free: backups to any S3-compatible storage, Pocket ID's mail through any SMTP server, DNS through OVH or a manual provider; servers stay Hetzner, alerts stay Pushover and healthchecks.io. Adapters arrive by PR, behind written contracts (`docs/adapters.md`), never as npm modules near the tokens. `bivy` asks for each credential itself (hidden input, a file under `~/.config/bivouac/` only its owner reads), speaks English, uses one checked, pinned prompt library (`@clack/prompts`), and every ordinary question has a flag or a safe default so Claude can drive it; typed consents and secrets shown once never have one. Order: `bivy ssh`/`exec`, `bivy init`, guided `bivy rebuild` (proven by a real `--test` on 19 Nov. 2026), `bivy restore` (D101). One short branch per step.
- **Rejected**: a community project; "usable alone" with versioned releases; adapters everywhere; the macOS keychain (Mac only).
- **Deferred**: an overview of the platform with diagrams.
- **History**: first deferred until after V1 (14 Nov. 2026).

### D94 — Rule 6 review of the whole base
- **Context**: 15 Nov. 2026: six lots (server, reconciler, `bivy` and host scripts, layers and template, workflows and tokens, who can take the server), each read by a fresh reviewer, every finding checked again.
- **Result**: nothing high. Fixed and deployed: the restore test checks Pocket ID's `users` is a plain table before reading it as superuser; apps capped at 1 GiB of memory, 512 processes and 20 Postgres sessions; containers stopped cleanly before replacement; `pg_dump` lock timeout of 5 minutes; HSTS and `nosniff`; the sign-in layer reads the router's own path; no npm install scripts in the reconciler build and instance CI; actions and Butane pinned; 2 GiB of zram swap (its return after a reboot not yet seen). The Claude GitHub app, found on every repo with write access, was limited to the monorepo and suspended by the owner.
- **Accepted, with a deadline**:
  - **Before Tinyauth (`forward`)**: apps reach each other directly on `bivouac`, without Caddy; an app protected only by Caddy would be open to its neighbours (for example one network per app, shared with Caddy).
  - **Before the first app with a Postgres extension**: missing extensions are recreated as superuser in the app's own `public` schema; install them in a schema the app does not own, or alert instead.
- **Accepted** (owner's choice): idle SSH connections can keep sshd busy; a transient Pocket ID or Postgres error drops a route for one pass; after a rebuild the "never create a new repository" guard waits for the first backup; a few narrow races and redaction gaps; SSH port forwarding allowed (the keys already give root); an empty lock file on a full disk blocks backups without a server alert (healthchecks.io still alerts); an app commit could point its layers at a fork's commit (the PR says `CHANGED` and waits for the owner).

### D95 — The interim phase stays
- **Context**: 17 Nov. 2026, every prod condition met or accepted. GitHub Free cannot stop a red PR from being merged on the private instance repo; only the deployment merge workflow and the reconciler's own validation stand in the way.
- **Choice**: the owner keeps D89's interim phase. Claude pushes to `main`; D89's rules on data and rule 5's consents hold; app deployments keep D86.
- **Accepted**: a valid but wrong change by Claude reaches the server within a minute with no second reader; never merge a red PR.
- **History**: until 21 Nov. 2026 base images were updated by Claude, when it thought of it; since then Renovate does it once a month (D109).
- **Rejected for now**: the prod phase as rule 2 writes it; GitHub Pro.

### D96 — Status page and internal API
- **Choice**: the reconciler serves an API on port 8080 (`packages/reconciler/src/api.ts`): `GET /v1/state` (containers, last pass, backups, open incidents, host disk, memory and swap), `GET /v1/logs/<container>` (at most 1000 lines and 1 MiB, never Postgres's), `POST /v1/sync` (D3). It never shows environments, mounts or commands. Connections from outside the internal network are closed before a byte is read, and every request carries a token derived from the master secret, compared in constant time. The page (`status-page/`, image `bivouac-status`, Nuxt with the `oidc` layer) is an app the reconciler runs when `platform.yml` has `status: { image, groups }`, on the internal network only; the image must come from the reconciler's publisher, pinned by digest. Its only action is "Sync now".
- **Accepted**: the page sits beside Pocket ID and Postgres, and holds the API token; app logs shown to admins can hold personal data; removing someone from the admin group takes up to a day.
- **Rejected for now**: a third network for the page alone; pending Renovate PRs on the page (one more GitHub token on the server).

### D97 — `local` apps and an app's own secrets
- **Choice**:
  - **`local`**: the app signs its own users in with Better Auth (verified v1.7.25: Next App Router, mail through a function the app gives, rate limits, `X-Forwarded-For`). The platform creates no IdP client and gives `SESSION_SECRET` = `HMAC(master secret, "session:<app>")`.
  - **An app's own secrets**: `secrets/apps/<app>.sops.yaml`, a flat map of upper-case names to text, each an environment variable of that app. The check reads the names (SOPS leaves them in clear), never the values: the app must exist, values single text, no link, and no name the platform provides or keeps (`PORT`, `DATABASE_URL`, `SESSION_SECRET`, `MCP_RESOURCE`, `OIDC_*`, `SMTP_*`, `BIVOUAC_*`) or the manifest's `env` sets. A file that cannot be decrypted keeps the running version on line and raises an alert. Runbook section 18.
  - Verified end to end: Caddy replaces a client-sent `X-Forwarded-For`, so a `local` app may count sign-in attempts per address (neighbours can still forge it, D94).
- **Accepted**: app secrets sit in the container's environment, like `DATABASE_URL`; a `local` app's sign-in code is outside the shared layers, so "Shared layers: unchanged" says nothing about it; a rebuild test server gives apps their real secrets.
- **Rejected**: a Pocket ID account for every reader (an admin step per person; sign-up tokens last at most 31 days); the app's mail password in the manifest; the platform's mailbox (D70).

### D98 — The "new app" skill, as a Claude Code plugin
- **Choice**: `plugin/skills/new-app/SKILL.md`, in a plugin this repo publishes as a marketplace (`/plugin marketplace add chamboug/bivouac`, `/plugin install bivouac@bivouac`, `/bivouac:new-app`), so someone without the monorepo, `gh` or the instance repo can use it. It names two roles, author and admin; what the server needs becomes a message to the admin unless the author is the admin. It recommends the admin's organization for the repo (the server pulls with the admin's GHCR token). It sets no deployment token. The app is built with the person trying it on `dev:local`, agreeing before any push.
- **Rejected**: the skill in the monorepo's `.claude/skills` only; copying it into `~/.claude/skills`; widening Claude's `gh` token.
- **Not verified**: adding the marketplace from the desktop app without a terminal.

### D99 — `bivy init` and `bivy configure`
- **Choice** (settled with the owner before any code):
  - **A new platform only**, from an empty Hetzner project; it never erases anything (a project with a server `bivouac` is for `bivy rebuild`), and refuses on a machine already reaching a platform.
  - **Steps**: questions that change nothing (location and server type with prices, DNS provider, SSH key, the empty private repo the owner creates at a pre-filled link, backups, alerts and mail now or later); the cost and a typed domain; the instance repo with generated secrets, the age key and restic password shown once until `stored`; Hetzner (snapshot as D65, protected Primary IPv4 and IPv6, firewall, server with a provisional host key, D91); the deploy key added by the owner; DNS after a second typed consent; `/setup` open for the owner's IPv4 only, checked to hold exactly one account before closing. An interrupted run carries on from `~/.config/bivouac/init.json` (no secret).
  - **No GitHub token at all**; the GHCR token waits for the first private app image.
  - The age key is made by `bivy` (X25519 and Bech32, checked against sops). Before writing DNS, `bivy` stops on a name pointing elsewhere, an `AAAA` or a CAA without Let's Encrypt, and never changes a record it did not create.
  - **`bivy configure backups|alerts|mail`** adds a missing part, checked against the real service. A part already set up is never changed by `bivy` (owner's choice).
- **Rejected**: reinstalling an existing server from `bivy init`; a temporary GitHub token for two clicks; flags for consents; the main Hetzner token for the snapshot tool.
- **Accepted**: typed consents rely on a terminal being detected (discipline, as rule 4).
- **Not verified**: no run against real infrastructure. A trial needs an empty Hetzner project, a test domain and a machine user with no `~/.config/bivouac` (about €0.02 an hour); it would also show how OVH returns TXT values, Pocket ID's `/setup` once allowed, and other S3 providers' regions. The owner's decision.

### D100 — Visual identity
- **Choice**: a tent with its light on (shelter, and someone always awake: "never silent"), in `canvas` orange, `glow` amber, `night` and `snow`; IBM Plex Sans and Mono; borders rather than shadows; states as a word and an icon, never a colour alone; text contrast at least 4.5:1. Files and rules in `docs/brand/`. `bivy` prints an ASCII tent in a terminal, without colour under `NO_COLOR`.
- **Rejected**: a font for the wordmark; box-drawing characters in the banner; orange for warnings.

### D101 — `bivy restore <app>`, guided
- **Choice**: `bivy restore [app]` asks the app, the nightly copy (14 latest; older with `--snapshot`) and the part (both, database or files); shows the server's plan from a dry run of `restore-app` (what goes back, what is kept, disk needed and free); warns when the app was deployed after the copy; asks for the app's name typed in a terminal (no flag, rule 5); runs it with one sentence per step; ends with the undo command. `--plan` only reads, and is all Claude runs. A lost connection does not stop the restore on the server (`restore-app` ignores SIGHUP and a closed output: tested end to end). The reconciler's dry run now reports disk needed and free, and a real run refuses when it is short (closes D94's gap).
- **Rejected**: running the restore detached and polling it; reading the image history from Git; listing every copy.

### D102 — A Pocket ID sign-in lasts 30 days
- **Context**: people had to use their passkey again on every app, about once a day. Each app's session lasts 24 hours from sign-in and is not extended (D79); past it, the app sends the browser to Pocket ID, whose own sign-in lasted 60 minutes (its default), so it asked for the passkey again. Deployments played no part: the app session key is derived and does not change.
- **Choice**: `SESSION_DURATION=43200` (30 days) on Pocket ID, from Git. An app still asks Pocket ID once a day, so group changes keep taking effect within a day; the round trip is silent while the Pocket ID sign-in is valid and the app was already authorized. Facts verified in v2.19.2's source: the sign-in is a signed token whose lifetime is that setting, not extended on use; every request reloads the account, so disabling someone takes effect at once at Pocket ID and within a day in apps; MCP clients keep requiring a fresh passkey (D85). Login Codes, device login and invitation sign-ups get the same 30 days.
- **Sign-out**: the oidc layer keeps the ID token in the session cookie and sends it to Pocket ID's end-session endpoint with the app's address; Pocket ID then ends its own session at once and sends the browser back. Without it, Pocket ID only offered a confirmation page, and closing it kept the 30-day sign-in. The token is left out when the session data would pass 2600 bytes (a cookie over 4 KB is dropped and the user could not sign in); sign-out then confirms at Pocket ID, as do sessions opened before this layer version. Signing out of an app does not disconnect Claude from it (D85). The token travels in the URL, so Pocket ID's request log, which admins see on the status page, holds it: accepted, it only proves a past sign-in and opens nothing.
- **Met on the way**: an app keeps its own copy of the template's tests, so app-layers v1.3.0 failed the sign-out test of every app (it checked the exact provider address). Fixed in each app to check only where sign-out goes. A layer change that alters what the template's tests assert needs the same fix in each app before its Renovate PR can pass. Renovate's hosted app took hours to reach some repos (one PR within the hour, one after two and a half hours, none after four and a half for two others): when a layer version gates a platform change, a by-hand PR with the same one-line change does the job.
- **Accepted**: a browser left signed in, or a copied Pocket ID cookie, opens the apps for up to 30 days instead of an hour, and the owner's own browser is an admin credential that long. Logging out only clears the cookie, and removing a passkey does not end the sessions it opened; disabling an account cuts them only while it stays disabled. The real cut is `pocket-id key-rotate --session-key` then a restart, which signs everyone out (runbook section 20).
- **Rejected**: extending the app session on use (groups would no longer be reread, and each app would still ask once); a longer app session alone (same reason).

### D103 — Apps installable on a phone, with a theme choice
- **Context**: apps are used mostly on phones, often added to the home screen, where they open without the browser's bar; each app had to rediscover the manifest, the icons and dark mode.
- **Choice**: the app template ships a web manifest (`display: standalone`), a placeholder `public/icon.svg` and `npm run icons`, which draws the PNGs (favicon, `apple-touch-icon` for iOS, 192 and 512 for Android, the 512 also maskable) with the Chromium the tests already use. Every app replaces the name and draws its own icon. Every app keeps a theme choice (automatic, light, dark: Nuxt UI's `UColorModeSelect`, kept on the device), and `theme-color` follows the chosen theme. The template's `CLAUDE.md` says what a screen needs without a browser bar (its own way back, no dead end, outside links in a new tab).
- **Verified**: iOS takes the home-screen icon from `apple-touch-icon` and supports only `standalone` (web.dev, *Learn PWA*); maskable icons through `purpose` (MDN). Nuxt UI 4.12 has `UColorModeSelect` and a French locale.
- **Rejected**: `@vite-pwa/nuxt` (a service worker and its cache for every app, when offline use is rare; an app that wants one writes it, as the inventory app did); the theme choice in the shared layers (layers are for the platform's contract, not the interface); an icon generator package (one more dependency for four images).
- **Not verified**: the safe-area advice for a bar fixed at the bottom, on a real iPhone.

### D104 — Claude works through `bivy`; a gap becomes a command
- **Context**: procedures in the runbook still hold long hand-typed SSH and `docker` lines, and Claude improvises others in sessions. What only lives in a conversation is lost (rule 7), and work done with Claude's access alone is work the owner could not do without Claude (D44: never requires remembering how things work).
- **Choice** (21 Nov. 2026, with the owner): `bivy` is how Claude acts on the platform. `bivy ssh` and `bivy exec` stay as the escape hatch, with two paces:
  - **reading to understand** (diagnosis, an incident never seen before): improvising is allowed, and Claude says in the session what was missing;
  - **changing something** on the server goes through a written command or Git; a missing one is written first, except an announced emergency fix (rule 4).
- **Each time Claude improvises**, it asks two questions: would this be worth a command (it came back a second time, it changes something, or it is a runbook step)? Would it have been easy without Claude's privileged access (its SSH key, its `gh` token, its knowledge of the internals)? When the answer to the second is no, the gap is noted and the command, or a way to do without the access, is proposed. A one-off check for a one-off incident stays improvised: every command is code to maintain (rule 9).
- **Rejected**: a platform MCP over SSH (D32): the same work behind a second door, one more component, invisible to the owner; "only written commands, ever": it would block diagnosing an unknown failure.

### D105 — `bivy status` and `bivy backup`
- **Context** (21 Nov. 2026): the first two gaps found by applying D104 to the runbook. Every session began with checks improvised over SSH (backups, restarts, `OOMKilled`, swap, versions), and the status page that shows the same is behind the owner's passkey. A backup before a change that can lose data (D89) meant stopping the reconciler, editing its state file with `jq` and starting it again: fragile (a reconciler left stopped deploys nothing, and alerts take a quarter of an hour), and impossible without knowing the internals.
- **Choice**: two commands of the reconciler, run beside it with `docker exec`, as `restore-app` is: `status` prints the status page's state (the last pass now also saved to disk); `backup-now [--restore-test]` writes a request file that the running reconciler picks up at its next pass, and follows it. The backup is the night's own job: same lock, healthchecks.io pings, alerts and record; the scheduler's state is never written from outside. `bivy status` adds the sentences "what is worth a look" (a late pass or backup, a failure, a stopped, unhealthy or memory-killed container, one restarted within the last day (Docker counts restarts since creation: older ones are history), an incident, a disk past 80%, no swap). Neither asks for consent: one only reads, the other only adds a copy (an app with `backup: { stop: true }` is stopped during it, as at night).
- **Guard**: an older reconciler would take an unknown command for its main loop and start a second reconciler beside the first; `bivy` checks the compiled code names the command before sending it, and the reconciler now refuses any command it does not know.
- **Accepted**: an extra ping to healthchecks.io between two nightly ones (harmless to a cron check, which waits for the next scheduled time, from memory); a request picked up within a minute, not at once.
- **Rejected**: a write on the internal API (the status page's token would then start backups, and D3 keeps sync as its only action); editing the scheduler's state from outside (it is written back on every pass); a separate process running the backup (two runs could overlap the night's).

### D106 — `bivy pin reconciler|status <commit>`
- **Context** (21 Nov. 2026, D104): moving the reconciler or the status page meant `docker buildx imagetools inspect` by hand, copying the index digest and writing a long line into `platform.yml` (D61); a typo, or another publisher's image, was caught late or not at all.
- **Choice**: `bivy pin` asks GHCR itself (D31): an anonymous pull token from `https://ghcr.io/token` (the packages are public), then the manifest of `sha-<7 characters>` with the index and manifest media types in `Accept`. The digest is the SHA-256 of the bytes received, refused if the registry's `Docker-Content-Digest` header says otherwise: the same digest `imagetools` prints (checked on a real version). The owner is the one already in `platform.yml`, the package is fixed by the part: another publisher's image cannot be written. Only the value on the block's `image:` line changes, as text (never re-serialized, D48); then the checks of `bivy validate` run, and a failure puts the file back. It prints the old and new values and commits nothing.
- **Verified**: OCI distribution spec (manifest by tag, `Accept`, digest header to verify if used); Docker token authentication spec (`token` or `access_token`); GitHub docs (public images pull anonymously); a missing tag answers 404, a missing or private package refuses the token.
- **Rejected**: running `docker buildx imagetools` or `crane` (a CLI, D31); reading the digest from the CI job summary (needs `gh`, and is not what the registry serves); committing and pushing from the command (the commit message is where the session says why, rule 7).

### D107 — `bivy login-link`: an admin's way back in
- **Context** (21 Nov. 2026): the third runbook step found by D104. An admin who lost every passkey had a `docker exec` line to type over SSH, read in Pocket ID's source and never tried; `bivy exec` only reaches app containers.
- **Choice**: `bivy login-link <username or email>` runs Pocket ID's own `one-time-access-token` beside it over SSH and shows the link. Verified in v2.19.2's source and by the end-to-end tests: one argument, looked up as username or email; the link (`/lc/` and 12 characters out of 56) works once, within one hour, and its session can add a passkey; an unknown user gets `user not found`; a disabled user gets a link that Pocket ID refuses when it is opened. The link is a credential: `bivy` refuses to run unless standard input and output are both a terminal, before reaching the server, so a script, a pipe or Claude's ordinary shell never receives it; it is never written to a file, and an error never repeats the command's output. The login is checked against Pocket ID's username characters (and `+` for an email) before it reaches a shell. Pocket ID's hidden admin behind `STATIC_API_KEY` (`static-api-user-…`) is refused: a passkey added there would be an admin sign-in nobody sees (rule 6 review). No consent asked: only an admin of the server can run it, and it changes nothing but adding one short-lived link.
- **Accepted**: anything that looks like a terminal passes the guard (`script`, tmux, an IDE's terminal, a terminal panel Claude can also type in and read): it stops accidents, not someone with the SSH key, who is root on the server anyway (D11), so the owner runs it in a terminal of its own and Claude never runs it. Pocket ID looks the argument up as `username = ? OR email = ?`, and a username may contain `@`: an email could match another user's username, hence "give the username". Opening the link records a sign-in in Pocket ID's audit log; making it records nothing. The link shows in the terminal's scrollback, worth nothing once used or after the hour.
- **Rejected**: Pocket ID's admin API with `STATIC_API_KEY` (a key that opens every account, carried to the Mac); a QR code (one more dependency, the owner opens the link on the machine at hand); checking the account is enabled first (a database read for a case Pocket ID already refuses plainly).

### D108 — `bivy secret set`: one platform secret changed
- **Context** (21 Nov. 2026, D104): changing a value of `secrets/platform.sops.yaml` (a new mailbox password, a new B2 key) was done by hand: decrypt, edit, encrypt in one pipe, compare hashes after decryption, delete the plain file. Fragile, and the one place where a secret could reach the screen. `bivy configure` adds a missing part but never changes one already set (D99, the owner's choice).
- **Choice**: `bivy secret set <path> [dir]` changes one value already set, from a fixed list: `mail.password`, `pocket_id.static_api_key`, `backup.b2_key_id`, `backup.b2_application_key`, `alerts.pushover_token`, `alerts.pushover_user`, `alerts.healthchecks.{heartbeat,backup,restore}`, `ghcr.username`, `ghcr.token`. The value is typed twice with hidden input by a person at a terminal, or read with `--from-file` from a file of mode 600, the owner's, with one name, not a link, outside the instance repo (compared as macOS stores the case), deleted once the change is checked (D93: a secret never has a flag). It refuses a checkout behind `origin/main` or with other uncommitted changes: an encrypted file cannot be merged, so a stale one pushed would undo another change. The file is decrypted and encrypted again by the pinned sops container (D31), for `.sops.yaml`'s single recipient, which must be the file's, through JSON, as the reconciler reads it (in YAML, sops writes text such as `<<` or `1_000` unquoted, which a YAML reader takes for something else); sops keeps the order of the keys. After writing, bivy decrypts what is on disk and compares every value by its SHA-256, never printing one; any difference puts the previous file back. It says what the change does once pushed (Pocket ID restarts for its two values, D68; the others serve from the next backup, alert, ping or pull), and commits nothing: the owner reads the diff and pushes.
- **Never changed by it**: `master_secret` (every derived secret comes from it, D14: a rotation of its own); `pocket_id.encryption_key` (a new one loses Pocket ID's signing keys, D57); `backup.restic_password` (the repository's own key must change first, or every backup fails). Derived secrets are not in the file.
- **Review** (rule 6, fresh agent, 21 Nov. 2026): no high or medium finding. Fixed: values YAML readers disagree on, the repo check fooled by a path's case, no checkout check, and hardening (inherited names such as `__proto__`, hard links, non-UTF-8 files, saying where the value file is left after a failure). Not taken, by the owner's choice: asking twice in the file recipe, since the value is pasted from the password manager; the recipe says how many characters it got and writes nothing for an empty paste.
- **Accepted**: each change re-encrypts the whole file, so every value's ciphertext changes in the diff (the plain values are compared instead); the decrypted values sit in bivy's memory for the run, as in `bivy configure`.
- **Rejected**: `sops set --value-stdin` in the container (it edits a file in place, so the instance repo would be mounted writable in the container; bivy's sops only reads standard input and writes standard output, as for `bivy init` and `bivy configure`); a flag carrying the value (it would sit in the shell history and the process list); adding missing values (that is `bivy configure`, checked against the real service).

### D109 — Base images updated once a month, by Renovate, on both repos
- **Context** (decided with the owner on 18 Nov. 2026, built on 21 Nov.): Caddy, Postgres, Pocket ID and restic are pinned in the monorepo (`packages/manifest/src/platform.ts`) and baked into the reconciler; moving the server took a monorepo commit and then a `bivy pin` in the instance repo, both done by Claude when it thought of it (Pocket ID v2.19.3 came out on 15 Nov.; the server was still on v2.19.2 on the 21st). Release pace seen on their release pages: Pocket ID two or three a month, Caddy about one a month, restic about two a year; `postgis/postgis:18-3.7` is rebuilt in place.
- **Choice** (the owner's): everything automatic, once a month, no session needed.
  - **Monorepo**: Renovate (`renovate.json`) watches `platform.ts` only, with a regex manager on `"<image>:<tag>@sha256:<digest>"`. On the 1st (Paris time), one PR, `renovate/base-images`, groups every update; Renovate merges it itself once CI is green (the miniature platform, now with a passkey sign-in into an app through Caddy and its OIDC exchange), on a weekday between 9:00 and 17:00, so the owner is awake if an alert follows. Majors get a PR of their own that waits for the owner; Postgres majors are never proposed (D29). The merge publishes a reconciler.
  - **Release tags**: CI tags the reconciler and the status page `v1.0.<run number of CI>` as well as `sha-<commit>`, the same number for both, so Renovate can order them (it cannot order `sha-` tags, D5, D50). The schema accepts `:v<x.y.z>` beside `:sha-<commit>`; the digest stays required. `bivy pin` writes the release tag of the same digest (found in GHCR's tag list, newest first); a version published before this has none and is written with its `sha-` tag, with a warning that Renovate cannot follow it.
  - **Instance repo**: `renovate.json` (also in `template/`) watches `reconciler.image` and `status.image` in `platform.yml` only, never app images (D5). From the 1st to the 10th, one grouped PR moves both to the newest `v1.0.<n>` with its digest; Renovate merges it when Validate is green, weekdays 9:00 to 17:00. A minor or major step (`v1.1.0`, `v2.0.0`) waits for the owner: the lever for a version that must not go out alone. The second step therefore follows the first the same day or the next (Mend runs about every 4 hours, verified in its docs).
  - **Rollback**: a reconciler version on trial (D61) whose first pass fails because a Caddy or Postgres container it created or recreated does not become healthy goes back by itself: it writes the previous version to `image.env`, itself and the reason to `refused.env`, and exits; the previous version starts, brings its own base images back and alerts until `platform.yml` changes. Not during a backup or a restore (the trial stays open; the next failed pass tries again). A pull error is not a health failure and does not roll back. **Not for Pocket ID** (rule 6 review): the older Pocket ID would refuse the database the newer one migrated, and a version only slow to migrate (more than 180 s) would be stopped; a Pocket ID that does not start is a failed pass and an alert.
  - **Never silent** (D44): the reconciler alerts when its own image was built more than 45 days ago: the monthly update stopped somewhere (a red PR, Renovate stopped, a refused version). The owner chose this over a Pushover message from GitHub on red tests, which needs the Pushover keys in two more places and misses Renovate itself stopping.
- **Verified**: in Renovate's source (21 Nov. 2026): a branch with no status check at all is "yellow" on GitHub and is not merged; an existing PR is still processed, and merged, outside `schedule` (`updateNotScheduled` defaults to true), within `automergeSchedule`; Docker versioning strips a leading `v`, ignores tags that are not versions (`sha-…`), and only compares tags of the same precision and suffix, so `18-3.7` only ever sees its own rebuilds (digest) or `19-3.7` (a major, disabled), never PostGIS 3.8; a repo with a config file is not onboarded. Renovate's docs: `schedule:monthly` is `* 0-3 1 * *` (hence a whole-day cron here), schedules are UTC unless `timezone`. A dry run (`--platform=local --dry-run=lookup`, Renovate 44.257.9) on the monorepo found exactly one group, `renovate/base-images`: Pocket ID v2.19.3, restic 0.20.0, and new digests for Caddy 2.11.9 and `18-3.7`. In Pocket ID v2.19.3's source: an older version refuses a database migrated by a newer one ("downgrades are not allowed" unless `ALLOW_DOWNGRADE`, which fetches down migrations from GitHub); a failed migration leaves the database "dirty" and Pocket ID refuses to start, so the pass fails and the alert goes out.
- **Accepted**: Mend's app can write to the instance repo, so it can drive the server (the owner, 21 Nov. 2026; already the case for the organization's app repos, D92). From the 1st to the 10th, whatever is on the monorepo's `main` reaches the server even if Claude did not pin it: a change that needs the owner's consent stays on a branch. A security fix in a base image can wait up to a month (Renovate cannot tell a Docker image's release is one; GitHub has no advisories for images) unless Claude sees it in a session. **Pocket ID cannot go back by itself** after a version that migrated its database: putting the old reconciler back is not enough, the database comes back from the night's copy, by hand with the owner, losing what changed in Pocket ID since the night (a passkey added that day). A restic image that breaks the backup is not rolled back (the backup is not a first pass): the backup alert reports it.
- **Learned** (incident, 21 Nov. 2026): the first `v1.0.124` written in `platform.yml` was refused by the reconciler then running (`sha-3d5b685`): it reads `reconciler.image` with its own schema, which knew only `sha-` tags, so the instance was "invalid" and no pass applied for 4 minutes (apps untouched, one alert, then "resolved"). Fixed by writing the same digest under `sha-44b60a1`, then `v1.0.124` once the new version ran. Rule: a change to what `platform.yml` may hold reaches the server in two steps, first a reconciler that reads it, then the file that uses it.
- **Review** (rule 6, fresh agent, 21 Nov. 2026): no high finding. Fixed: the rollback no longer covers Pocket ID (above); `bivy pin` sends GHCR's pull token to GHCR only, whatever a page of tags points to; error messages name the `v` tags. Accepted knowingly: whoever can push a tag to `ghcr.io/<owner>/bivouac-reconciler` or `-status` can now get it adopted by tagging it `v1.0.<huge number>` (today the monorepo's publish jobs on `main` only; the owner's tokens hold `read:packages`, D17, and must not get `write:packages`); such a number would also stop later updates, which the 45-day alert reports. A rerun of a publish job pushes the same `v1.0.<n>` again with a new digest (Renovate proposes that digest: same commit, harmless); renaming `ci.yml` restarts the numbering, which would stop Renovate silently until the 45-day alert.
- **Rejected**: one Renovate PR per image (spam, one session each); updates as soon as published (the owner's choice: monthly); `minimumReleaseAge` (Renovate then requires a release date, which GHCR does not give, so Pocket ID would never move); Renovate on the instance repo following app images (D5); `ALLOW_DOWNGRADE` for Pocket ID (SQL fetched from GitHub at start, not tried).
