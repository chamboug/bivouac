# Bivouac — project brief

**Bivouac** is a "zero config" self-hosting platform whose maintenance is rare, guided and never silent (D44). The CLI is called **`bivy`**. The `bivouac` prefix is used for repos, images and resources (`bivouac-platform`, `bivouac-app-template`, etc.).

> **Status: second version (5 November 2026).** The first draft summarized a brainstorming session between Gaëtan and Claude (1–2 November 2026). This version includes a Q&A session (3–5 November) that settled most open points. Each decision, with its context and the alternatives that were rejected, is recorded in [`docs/decisions.md`](docs/decisions.md) (references `D1`, `D2`…). The choices are still directions, not commitments: if a technology turns out to be a worse fit along the way, we change our minds, update this document and add an entry to the log.

You are Claude. Read this brief in full before proposing anything. Build on the directions chosen here, and explicitly flag any proposal that departs from them, explaining why.

## Language

- **This repo (public) is written entirely in English**: code, comments, docs, commit messages, and pull requests. PR descriptions are English only, in plain English (rule 3) (D41).
- **Always talk to Gaëtan in French, using "tu"**, in conversations.
- **The private instance repo `bivouac-platform` is in French**, including its operations log.

## How Gaëtan and Claude work together (follow strictly)

Bivouac is designed so that an application developer does not have to do infrastructure work (networking, security, operations): Gaëtan delegates operations to Claude and trusts it, which demands extreme rigor. These rules are not negotiable.

1. **Verify rather than assume.** Before using a tool, a version, an option or an API, check the current docs. In answers, explicitly separate what is "verified (source)" from what is "from memory, to be checked". Never bluff: if something is beyond what Claude can do reliably, say so.
2. **Two phases, two paces.**
   - **MVP phase** (as long as no real data and no real user are on the server): we move fast. Claude pushes directly to `main` and may deploy and test directly on the server, which is considered disposable. We can break and rebuild everything. Rules 5 (consent for sensitive actions) and 6 (security review before going public) still apply, and no secret may ever appear in plain text in Git.
   - **Prod phase** (from the day Gaëtan decides to put real data on it or invite someone, announced explicitly, and only once the conditions in "Before the prod phase" are met): every change goes through Git with green CI. **Low-risk** changes (new app, new app version, minor update, docs) may be merged by Claude alone or automatically when CI is green, with a summary afterwards. **Medium- or high-risk** changes go through a PR that Gaëtan approves.
3. **Every PR submitted to Gaëtan is explained in plain language**, so he can merge without understanding the infrastructure: what changes, why, the risk (low, medium, high), how to roll back. No unexplained jargon: an everyday image beats a technical term.
4. **SSH in prod is first and foremost for diagnosis, read-only.** Any action that changes something is announced beforehand, with its reason and its rollback. A hot fix is then carried over into Git in the same session. Accepted limitation: SSH keys log in as `core`, which has `sudo` and Docker; read-only relies on discipline, not on a technical barrier (D11).
5. **Irreversible or sensitive actions always require Gaëtan's explicit consent**, never autonomy: deleting data, destroying or recreating a server, touching DNS, opening a port, changing the firewall, rotating or replacing a key, changing the IdP domain, changing the list of authorized SSH keys.
6. **Double check for security.** Any change touching the firewall, auth, secrets, SSH keys or network exposure is reviewed by a second, independent pass (a fresh review agent, with a security checklist) before being proposed for merge.
7. **Memory lives in the repos, not in Claude.** Claude does not remember from one session to the next. We maintain:
   - in the **public monorepo `bivouac`**: this brief (`CLAUDE.md`) and the **decision log** (`docs/decisions.md`, one short entry per decision: context, choice, rejected alternatives);
   - in the **private instance repo `bivouac-platform`**: the **operations log** (what was done in prod, when, why) and a short `CLAUDE.md` that points to the monorepo.

   They are updated at the end of every work session (D4).
8. **Incidents are reported as they happened**: what happened, the cause, the impact, the fix, and what prevents it from happening again. Never downplayed.
9. **Simplicity by default.** We prefer well-known, well-documented tools, and refuse to add a component without a clear justification. Every component is something that can break. Corollary: we talk directly to official APIs rather than going through intermediate CLIs, and the little custom code we have is covered by end-to-end tests.
10. **Gaëtan's role is limited to** merging PRs after reading their summary, keeping safe (in a password manager) **the age master key, the restic password and his GitHub account's recovery codes**, and forwarding alerts to Claude. Everything else is Claude's responsibility.

Final safeguard: rigor reduces errors, it does not eliminate them. Nightly backups and one-command rebuild are also the safety net against Claude's mistakes.

## Context

Gaëtan regularly codes small applications with Claude (recipe site, library management, etc.). Some live happily as artifacts, others must be hosted on his infrastructure. He wants a lightweight platform to host them all, **first on a Hetzner VPS**, maybe later on a mini PC at home, for a small community of invited friends and family.

History to know:

- He used **CapRover**: decent, but no auth, no real backup mechanism, and not "as code".
- He wrote his own IdP, **Xenia** (github.com/xenia-sso): OIDC, MongoDB, invitation codes granting access to one or more apps at once (link or QR code), SSO for Node-RED and Grafana. Not 100% spec-compliant. Vue and Express plugins exist; future apps will be in Nuxt.
- Self-hosted **Supabase** was rejected: one instance per project, heavy (about 2 GB of RAM, 9 services).
- He has already hit OOMs building on the VPS.
- He has a **Home Assistant Green** (dedicated hardware), so no need for Proxmox for home automation.
- He already has a **Hetzner CX23** with the IPv4 `5.75.230.119`, which `xaet.fr` and `www.xaet.fr` point to. This server can be wiped (D24).
- An upcoming app that will need the `local` auth mode is written in **Next.js**; Gaëtan owns it and will adapt it to the platform contract.

## Number-one criterion

**Zero config for Gaëtan, and maintenance that is rare, guided and never silent** (D44). No platform connected to the internet runs for years untouched: security fixes, changes in third-party APIs, versions reaching end of life and expiring tokens or cards will require a few interventions a year. The goal is that each one is announced by an alert, takes one Claude session and one merged PR, and never requires remembering how things work. Small, frequent updates are preferred to big jumps after years of neglect. If the server is destroyed, it must be easy to bring back from backups. **One backup per night is enough**: losing at most one day is acceptable. Every added component must justify its place, because every component is something that can break.

## Architecture principles

1. **Everything on the server is either in Git, backed up off-site every night, or recomputable.** Config and encrypted secrets are in Git. Data (databases and files) is stored locally and replicated every night. Secrets generated by the platform are derived from a master secret, so they are recomputed identically (D14). We prefer rebuilding over repairing.
2. **Git is the source of truth for configuration.** No interface changes config directly on the machine.
3. **Apps are disposable.** Data lives in the shared Postgres and in declared volumes, all backed up every night.
4. **Claude has SSH access to the server to diagnose and debug**, which reassures Gaëtan. Rule: a hot fix made over SSH must then be carried over into Git, otherwise the next reconciler pass overwrites it. Deployments go through Git; depending on the risk level, they are merged automatically, by Claude, or approved by Gaëtan (rule 2). *Revised: the first draft said every deployment went through a PR merged by Gaëtan, which contradicted rule 2 (D5).*
5. **No building on the server, at least at first** (the VPS lacks RAM). Images are built in GitHub Actions. Local builds may come back later, for example on a mini PC with more RAM.
6. **Convention over configuration.** The minimum of parameters to provide; the rest follows from conventions.
7. **The platform does not know the apps' framework.** It runs any image that follows a simple contract (port, health endpoint, environment variables). Nuxt, Next, Node-RED or Grafana all go through the same path (D19).

## Repos

- **Monorepo `bivouac`, public** (this folder): `bivy` CLI, reconciler, manifest schema (shared by the CLI and the reconciler), instance repo template, app template, `CLAUDE.md`, decision log. Images published to GHCR. It is written as a product: it contains nothing personal and nothing about Gaëtan's production (D1, D4).
- **Instance repo `bivouac-platform`, private**, created from the template by `bivy init`: app and site manifests, Butane, SOPS secrets, list of authorized SSH keys, operations log.
- **App repos**, private: one per app, each with its own GitHub Actions workflow.

## Stack

### Host

- **Flatcar Container Linux, official image, stable channel.** Immutable OS with automatic A/B updates and rollback. Docker is included. There is no Node, no Ansible and no package manager on the host: everything runs in containers.
- **No custom Flatcar image**: it would mean losing official updates. Customization goes through a **minimal Ignition file** (Butane format) that **contains no secrets**: public SSH keys, sshd configuration, and a systemd unit that starts the reconciler container (D7).
- **Ignition runs only on first boot.** Anything that must change later (authorized SSH keys, etc.) is managed by the reconciler from Git, not by Ignition.
- Updates: `update_engine` downloads them, `locksmithd` reboots in a night window. One minute of downtime is accepted, and all containers use `restart: unless-stopped`.
- **Hetzner** (verified, Flatcar docs, Nov. 2026): there is no official Flatcar image at Hetzner. We build a snapshot once with `hcloud-upload-image` (community tool, v1.5.0, run from its container; `flatcar_production_hetzner_image.bin.bz2`, pinned to a stable version), then create or reinstall (`rebuild`) the server from that snapshot with the Ignition (transpiled JSON, not Butane) as user-data, limited to 32 KiB (verified, Hetzner API). Known limitations: no automatic mounting of Hetzner volumes, and no root password (SSH key required, which suits us). The tool's temporary server defaults to `cx23` in `fsn1`, where that type can no longer be ordered: pass `--location`. The manual procedure is in [`docs/runbook.md`](docs/runbook.md).
- **Server**: the existing **CX23** (x86, 2 vCPU, 4 GB) in `fsn1`, the location of the IP `5.75.230.119`, **reinstalled in place** with Hetzner's `rebuild` action: the CX23 can no longer be ordered in `fsn1` (verified, 6 Nov. 2026), and the existing server keeps an older, lower price (D24). x86 rather than Arm, so we don't have to build every image for multiple architectures (D25).
- **IP**: `5.75.230.119` is the platform's **Primary IP**, already with `auto_delete=false` so it survives deletion of the server (D24). Verified (Hetzner API): €0.50/month excl. VAT, same location required, assigning it to an existing server requires the server to be powered off; for a new server it is passed at creation (`public_net.ipv4`), and must then be unassigned.
- **IPv4 required** (verified on 4 Nov. 2026 by DNS lookup): `github.com`, `api.github.com`, `ghcr.io` and `smtp-relay.brevo.com` have no IPv6 address. Without IPv4, the server could neither read Git, nor pull images, nor send email. The server also gets a free IPv6 (D26).
- **Later, mini PC**: Flatcar directly on the hardware, with the same Ignition.

### Host security (applied automatically by `bivy init`)

- **SSH**: key-only login, with Flatcar's `core` user. An sshd config file placed by Ignition explicitly sets `PermitRootLogin no`, `PasswordAuthentication no` and `KbdInteractiveAuthentication no`. The port stays 22: with keys only, changing the port only reduces log noise.
- **SSH keys**: **one key per machine and per use**, never a private key copied from one machine to another. On Gaëtan's Mac: his own key and a dedicated `bivouac-claude` key, used by Claude Code, revocable on its own. Authorized public keys are listed in `bivouac-platform` and synced by the reconciler into `authorized_keys.d`; any change is a high-risk PR (D11, D12). Claude sessions in the cloud have no SSH access.
- **age master key and deploy key** placed over SSH by `bivy init` / `bivy rebuild` (`/etc/bivouac/`, mode 600), never through user-data. Verified: Hetzner user-data can be read from the server at `http://169.254.169.254/hetzner/v1/userdata`, so potentially from any container (D7).
- **Access to the metadata service blocked** from Docker networks (`DOCKER-USER` rule towards `169.254.169.254`), as defense in depth (D7).
- **Hetzner Cloud firewall** (outside the machine, free, IPv4 and IPv6, verified), created through the API by the CLI: inbound allowed on 22/tcp, 80/tcp, 443/tcp and 443/udp (HTTP/3), everything else blocked. Since it filters before the server, Docker's iptables rules cannot bypass it.
- **No container port published**, except Caddy's. Postgres, Pocket ID, Tinyauth, the reconciler and the apps stay on the internal Docker network. Enforced by the reconciler and validated in CI.
- **The Docker socket is mounted only in the reconciler**, which is not publicly exposed. The status page and the MCP go through the reconciler's internal API (D8).
- **Updates**: OS and Docker via Flatcar, third-party images via Renovate.
- **Least privilege**: one Postgres role per app, OVH keys limited to DNS zones, a dedicated Hetzner token, GitHub tokens limited to the strict minimum (see "GitHub tokens").
- **Login attempt limits**: handled by Pocket ID and by the auth library of `local` apps. Verified (Pocket ID docs): `TRUST_PROXY` is not a boolean but a list of IPs or CIDRs; we set it to **only Caddy's Docker subnet**, otherwise all users share the same limit (D27).
- Options rejected by default, can be added later: CrowdSec and fail2ban (pointless with SSH keys only and a surface reduced to Caddy).

### Domain names

- **Domain**: `xaet.fr`, at OVH (OVH DNS, OVH mail).
- **One subdomain dedicated to the platform and one sub-subdomain per app**: `recettes.apps.xaet.fr`, `biblio.apps.xaet.fr` (D13).
- **A wildcard DNS record** `*.apps.xaet.fr` pointing to the Primary IP: adding an app requires no DNS action.
- **Pocket ID on `auth.apps.xaet.fr`. This name is final**: it shows in users' passkey dialog, and changing it invalidates every passkey (D40).
- **Tinyauth on `gate.apps.xaet.fr`**: invisible to users (redirects), can be changed safely. Its session cookie is set on `.apps.xaet.fr`.
- **Reserved names**, rejected by CI as app names: `auth`, `gate`, `status` (D34).
- `xaet.fr` and `www.xaet.fr` already point to this IP: they serve a simple static page, declared as a site (see "Static sites") with a custom domain (D24).
- A custom domain per app remains possible as an option in the manifest.
- **SPF**: `xaet.fr` already has an SPF record (`v=spf1 include:mx.ovh.com ~all`). Only one can exist: the CLI modifies the existing one instead of adding a second.

### Network and access

- **Caddy** as reverse proxy: automatic HTTPS (one certificate per subdomain, obtained automatically, so no wildcard certificate and no DNS plugin), minimal config. The **Caddyfile is generated by the reconciler** (the same code runs in `bivy validate`, followed by `caddy validate`) and Caddy has no access to the Docker socket (D53).
- **VPS**: admin access over **SSH** (keys only). No admin interface publicly exposed.
- **Mini PC (later)**: Tailscale for admin access. For public exposure, one of: port forwarding on the home router, Cloudflare Tunnel, or a relay VPS. Never `*.ts.net` (Tailscale Funnel), because passkeys would be bound to that domain.

### Data

- **A single shared Postgres** (18, image `postgis/postgis:18-3.7`), with one database and one role per app and `REVOKE CONNECT ... FROM PUBLIC`. The image ships PostGIS; pgvector will need an image of our own, built the day an app needs it (D51). Extensions are enabled per database according to the manifest. Accepted trade-off: all apps share the same major version.
- **Postgres major upgrades**: Renovate never proposes them (exclusion rule). They follow a documented procedure (dump then restore, the same path as `rebuild`) and are high-risk changes, approved by Gaëtan (D29).
- **Files stored locally**, in volumes declared per app (`name → mount path`), included in backups. No paid S3.
- No BaaS layer: Nuxt server routes and Drizzle are enough.
- **Database migrations**: run at app startup, and **additive only** (add, never drop or rename in the same deployment). A destructive migration takes two deployments. This is what makes rolling back to the previous image safe (D21).

### Secrets

- **Secrets encrypted with SOPS + age in the instance repo.** They include: Hetzner, OVH, B2 and Brevo tokens, the GHCR PAT, the `bivouac-deploy` PAT, Pocket ID's `ENCRYPTION_KEY` and `STATIC_API_KEY`, the restic repository password, the Pushover application token and user key, the healthchecks.io ping URLs, and the platform's **master secret**.
- **age master key**: present in three places only: the server, Gaëtan's password manager, and his Mac (`~/.config/sops/age/keys.txt`, needed so the "new app" skill can read the `bivouac-deploy` token). Never in a repo, never in GitHub Actions (D35, D36). Someone in control of the Mac would have SSH access anyway; the key being there does not really increase the risk.
- **Derived secrets**: secrets generated by the platform (Postgres role passwords, OIDC client secrets, etc.) are stored nowhere. They are computed: `HMAC(master secret, "db:recettes")`, `HMAC(master secret, "oidc:recettes")`, etc. After a rebuild, everything is recomputed identically; rotating a secret means changing a version suffix in the manifest. Reason: per-database `pg_dump` does not back up roles, and Pocket ID lets you choose an OIDC client's secret (verified, Pocket ID v2.19.2) (D14).
- **Pocket ID's `ENCRYPTION_KEY`**: it encrypts, among other things, the token signing keys (verified). What happens if it is lost is not documented, but according to the code there is no recovery. It is in SOPS. Caution: with `ENCRYPTION_KEY_FILE`, a trailing newline becomes part of the key.

### Backups

- **Every night**: one `pg_dump` per database plus the file volumes, sent with **restic** (encrypted, deduplicated, retention for example 7 days, 4 weeks and 6 months). **The reconciler triggers them**, running restic in an ephemeral container: no extra component (D33).
- **Apps that store their data in files** (SQLite, Node-RED): a `backup: { stop: true }` manifest option stops the container for a few seconds during the backup to avoid an inconsistent copy. Off by default (D20).
- **Off-site destination: Backblaze B2, EU Central region (Amsterdam), through the S3-compatible API.** Verified (restic docs): restic recommends the S3 API over its native B2 backend, because of error-handling issues. Still no rclone (D16). The region is chosen at sign-up, for the whole account, and cannot be changed afterwards.
- **B2 pricing** (verified, Nov. 2026): 10 GB free, then $6.95/TB/month; egress free up to 3 times the stored volume; no minimum storage duration. *Revised: the first draft said $0.005/GB.*
- **Automatic restore test, every week**: `restic check`, then the latest dump restored into a temporary Postgres, with a minimal check (the tables exist). The result is reported to the dead man's switch (D9). *Revised: the first draft listed this test as "not a priority".*
- Alternative rejected for now: Koofr (European, 10 GB free), more of a consumer Drive-like service, with no published SLA and reachable only through rclone. Later, the mini PC can serve as a second destination.

### Authentication

- **Pocket ID** as the IdP (Go, a single container, BSD-2, stored in the shared Postgres). Xenia is abandoned, but its model was validated. Facts verified on Pocket ID v2.19.2:
  - **Signup tokens**: lifetime of at most 31 days, 1 to 100 uses, attached to groups (new accounts join those groups).
  - **Groups that restrict access to each OIDC client** (`allowed-user-groups`), sent in the ID token with the `groups` scope. Each app maps them to roles (Grafana with `role_attribute_path`, for example).
  - **API** (`X-API-KEY`): creating OIDC clients with a chosen ID, redirect URLs, group restriction; the chosen secret is set through a separate call, `POST /api/oidc/clients/{id}/secrets` (D52).
  - **`STATIC_API_KEY`** (at least 16 characters): admin API key provided through an environment variable, which lets the reconciler create clients without going through the UI. It is in SOPS.
  - **Database**: Postgres is selected by the `DB_CONNECTION_STRING` prefix (`postgres://`).
  - **Several passkeys per account**, from "My Account".
- **First admin**: the `/setup` page creates the first account and works **for whoever gets there first** (verified). During `bivy init`, Caddy only allows `/setup` from Gaëtan's IP, then the route is removed (D15).
- **Passkeys only**: Pocket ID does not handle passwords. Guidance for users: at least two passkeys (phone + computer) or one synced passkey. Troubleshooting: one-time links generated by the admin.
- **Email login code: to be decided before the prod phase** (D37). Pocket ID has two settings, both off by default: `EMAIL_ONE_TIME_ACCESS_AS_ADMIN_ENABLED` (the admin sends a code) and `EMAIL_ONE_TIME_ACCESS_AS_UNAUTHENTICATED_ENABLED` (users request one themselves; the account's security then becomes that of their mailbox). In the meantime, neither is enabled.
- **Email through Brevo** (free plan: 300 emails per day, verified). A local mail server is not viable: Hetzner blocks outbound ports 25 and 465 by default (verified), and deliverability from a VPS IP is poor. Sending over SMTP on port 587, with an SMTP key (not an API key). Things to know (verified): Brevo must **approve the account** before the first send; domain authentication requires a Brevo verification TXT, DKIM and a DMARC record (SPF reportedly no longer required: unconfirmed). Sender: `no-reply@apps.xaet.fr`.
- **Four auth modes**, declared in the manifest (D10). `oidc` and `public` are built first; `forward` and `local` when the first app needs them (D44):
  - `oidc` (default): a Nuxt layer that speaks standard OIDC, with an encrypted-cookie session. The app knows the user and their groups.
  - `forward`: Caddy `forward_auth` to **Tinyauth** (repo `tinyauthapp/tinyauth`, v5.2.0 verified), connected to Pocket ID (official Tinyauth guide). For things without their own auth: static sites, third-party UIs like Node-RED. Per-group access through `TINYAUTH_APPS_<APP>_OAUTH_GROUPS` (no Docker labels), and **`ACLS_POLICY=deny`**: otherwise any Pocket ID user would get in everywhere. Caddy must overwrite `X-Forwarded-Host`, and `TRUSTEDPROXIES` is limited to Caddy. A single login for all apps thanks to the cookie on `.apps.xaet.fr`.
  - `public`: no protection.
  - `local` (for sites open to the general public): the app manages its own accounts with an embedded auth library, **Better Auth** (to be checked: current status, Nuxt and Next integration, generic OAuth plugin). Email + password, email verification and reset through the Brevo SMTP provided by the platform. A "Sign in with Pocket ID" button (generic OAuth) can coexist for the community. Pocket ID stays reserved for the invited community. If several public sites ever had to share the same accounts, we would reconsider an IdP with passwords.

### Deployment

- **App repos**: Nuxt (+ Nuxt UI) with a Dockerfile, or any framework that follows the contract. GitHub Actions builds and pushes to **GHCR**. App images are **private** (D17).
- **New app version**: after the build, the app repo's workflow opens a PR on `bivouac-platform` that changes the image tag in the manifest. That PR is merged automatically if the platform CI is green (low risk). Typical delay: a few minutes. The workflow template lives in the public monorepo, with nothing personal; only the instance repo name is a parameter (D5). Rejected: Renovate for app images (one run every 4 hours on Mend's free plan, verified, and `sha-…` tags it cannot order).
- **App manifest** (D19):
  ```yaml
  # apps/recettes.yml
  image: ghcr.io/<user>/recettes:sha-abc123
  name: recettes            # → recettes.apps.xaet.fr
  port: 3000                # internal port, 3000 by default
  health: /api/health       # default; optional for third-party apps
  database: { extensions: [postgis] }   # optional
  auth: oidc                # oidc | forward | public | local
  groups: [famille]         # allowed Pocket ID groups
  volumes: { uploads: /app/uploads }    # name → mount path
  backup: { stop: false }   # true for SQLite, Node-RED, etc.
  env:                      # renaming of values provided by the platform
    GF_AUTH_GENERIC_OAUTH_CLIENT_ID: ${oidc.clientId}
  ```
  The platform injects standard variables according to the manifest: `DATABASE_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SMTP_*`. The `env` block is for third-party apps that expect other names. *Revised: the first draft wrote `volumes: [uploads]`, without a mount path.*
- **Static sites** (HTML artifacts, the `xaet.fr` home page): files in `bivouac-platform/sites/<name>/`, with a `sites/<name>.yml` manifest (`auth`, `groups`, optional domain). Caddy serves them directly (`file_server`) from the repo checkout, read-only. No container (D22).
- **The reconciler, in TypeScript on Node LTS** (`packages/reconciler`, image `ghcr.io/chamboug/bivouac-reconciler:sha-<commit>`, D50, D54), is the only significant custom code: a few hundred lines, shipped as a container. It polls Git **every minute** (`git fetch` with a read-only deploy key); no webhook, so as not to expose a public endpoint. A `POST /sync` call on its internal API (status page button, MCP tool) triggers an immediate pass, at most once every 10 s (D2, D3). On each pass, it compares the desired state (Git) with the actual state and corrects:

  1. authorized SSH keys (`core`'s `authorized_keys.d`);
  2. for each app: database, role and extensions;
  3. OIDC client created or updated through the Pocket ID API (`STATIC_API_KEY`), with a derived secret;
  4. Caddyfile regenerated (apps, sites, Tinyauth) and Caddy reloaded;
  5. container with the right image (pull and restart).

  It also triggers the nightly backups and the weekly restore test, and serves the read-only internal API (state, versions, health, latest logs, latest backup) and the MCP.

  Required properties:
  - **Idempotent**: the same code handles installation, updates and rebuilds.
  - **Never deletes data**: when an app is removed, it takes a final `pg_dump` sent to restic with the `archive` tag, then **renames** the database and the volume (`archived_recettes_20261103`). Actual deletion only happens through an explicit action by Gaëtan (D18).
  - **Monitored deployment**: it waits for the app's health check and rolls back to the previous image on failure. The failed image is **marked** and not retried until the manifest changes; the failure shows on the status page and triggers an alert (D21).

  Rejected: Komodo and doco-cd. The container part fits in about a hundred lines with the Docker API, and they would add a component with its own UI and its own state (D28).

- **GitHub tokens** (D17, D31, D36). Verified: GHCR only accepts *classic* PATs, and on GitHub Free organization secrets are not available to private repos.
  - **Classic `read:packages` PAT**, no expiration, in SOPS: the server uses it to pull private app images. It grants read access to all of Gaëtan's GHCR packages, and nothing else.
  - **Fine-grained `bivouac-deploy` PAT**, no expiration, limited to `bivouac-platform` (write access to contents and PRs), in SOPS: set as a secret in each app repo by the "new app" skill, to open the deployment PRs.
  - **Read-only deploy key** on `bivouac-platform`: created by `bivy init` / `bivy rebuild` through the GitHub API and placed over SSH. During a rebuild, the new one is created first and the old one revoked only at the end, if everything worked (D30).
  - **Temporary fine-grained PAT** (7 days): requested by `bivy init`, `rebuild` and `machine add`, through a pre-filled creation link. It is never stored.
  - Rotating any of these tokens requires Gaëtan's consent (rule 5).

- **`bivy` CLI, in TypeScript on Node LTS, used as a black box** (even by Gaëtan). This is a priority: the whole server lifecycle must fit in a few commands. It **depends on neither `gh`, `hcloud` nor `sops`**: it talks directly to the official APIs, and everything else runs in containers (D31). Distribution: `npx` (the monorepo is public) or a Docker image.
  - **`bivy init`**:
    1. Asks for the few required inputs: Hetzner API token, domain, B2 keys, Brevo SMTP credentials, OVH keys (link `https://api.eu.ovhcloud.com/createToken/` shown with GET, POST and PUT pre-filled on `/domain/zone/<zone>/*`, D49), temporary GitHub PAT, GHCR PAT and `bivouac-deploy` PAT (pre-filled links).
    2. Generates the age master key and shows it **only once**. It **does not continue** until Gaëtan has confirmed, by typing a word (not just Enter), that it is stored in his password manager. At the same moment it reminds him to store the restic password and the GitHub recovery codes (D38). It places the age key on the Mac.
    3. Creates the instance repo from the template.
    4. Prepares the Flatcar snapshot if needed and generates the Ignition.
    5. Checks that `5.75.230.119` is indeed a Primary IP and sets `auto_delete=false`.
    6. Asks for **explicit confirmation** before destroying the existing server, then creates the new one with the Primary IP (rule 5).
    7. Places the age key and the deploy key over SSH, creates the firewall and the DNS records (wildcard, Brevo, modification of the existing SPF), with Gaëtan's consent for DNS.
    8. Once the base is up (Caddy, Postgres, Pocket ID, Tinyauth, backups), opens `/setup` for Gaëtan's IP only and shows the link to create the admin account.
  - **`bivy rebuild`** (same logic): new server with the same Primary IP, latest restic backup restored, and we're back. It works from any machine and asks for the age key and the restic password (from the password manager) and a temporary GitHub PAT. All other tokens are in SOPS.
  - **`bivy rebuild --test`**: creates a temporary server billed by the hour (from memory, to be checked: a few cents per test), restores, checks, then destroys everything. It never touches the real IP or DNS (D39).
  - **`bivy machine add`**: on a new machine, generates an SSH key and opens a PR adding it to the list of authorized keys (and removing a lost machine's key if needed). It asks for the age key from the password manager rather than copying it from one machine to another (D38).
  - **DNS through the OVH API**: wildcard `*.apps.xaet.fr`, Brevo records (verification TXT, DKIM, DMARC) and modification of the existing SPF. Touching DNS requires Gaëtan's consent (rule 5).
- **Portability: we build for Gaëtan's stack only**, without trying to support other cases. We simply keep clean extension points:

  - the CLI goes through three interfaces: server provider (Hetzner), DNS provider (OVH), backup destination (restic, so already very open);
  - a "manual" DNS provider that just prints the records to create: it covers every registrar for almost nothing;
  - the base runs entirely in containers, so it would work on any Docker host (Ubuntu, etc.). Only the Ignition bootstrap is Flatcar-specific.

  No "existing server" mode, other providers or multi-OS test matrix until someone needs them.

- **Renovate** (Mend's free plan, verified: private repos included, one run every 4 hours) on the instance repo, for third-party images (Caddy, Postgres, Pocket ID, Tinyauth, Node-RED…): minor updates merged automatically if CI is green, PRs for majors, never a Postgres major version.

### Admin interface

- **No interface for editing config**: it goes through Git, often via PRs from Claude.
- Managing users, invitations and groups: **Pocket ID's interface**.
- **A status page**: a small Nuxt app on the platform (`status.apps.xaet.fr`), behind Pocket ID, restricted to the admin group. It shows the apps, their versions, their health, the latest logs, the latest backup and pending Renovate PRs, by querying the reconciler's internal API; it never has the Docker socket (D8). Its only action is a "Sync now" button. A good first project to break in the conventions.
- **Resource usage** (D42): the status page shows CPU, RAM and disk for the host and for each container, current values and **30 days of history**. The reconciler takes one sample per minute and stores it in a small table in the shared Postgres. No Prometheus or Grafana.
- **Platform MCP server**, served by the reconciler **over stdio through SSH**: in `.mcp.json`, a command like `ssh core@<server> docker exec bivouac-reconciler mcp`. No public exposure, and the SSH key serves as authentication. Claude can read state and logs, and trigger a sync (D32). *Revised: the first draft exposed the MCP through the status page via `@nuxtjs/mcp-toolkit`, which would have required OAuth authentication of MCP clients against Pocket ID.*

### Tests

1. **Instance repo CI, on every PR**: manifest schema validation (including reserved names), Butane to Ignition compilation, `caddy validate` on the generated Caddyfile, and **a check that every secrets file is properly encrypted** and well-formed, without decrypting it: the age key never goes to GitHub. Actual decryption is checked by the reconciler on every pass and by the restore test (D35). Blocks merging and gates automatic merges. *Revised: the first draft planned to decrypt secrets in CI.*
2. **End-to-end tests of the reconciler, in the monorepo CI**: a miniature platform (Postgres, Pocket ID, Caddy, Tinyauth, test app). We check creation of the database and extensions, of the OIDC client and of the route, idempotence, archiving on removal, and rollback with a failed image being marked. SSO login testable with Playwright and Chrome's virtual WebAuthn authenticator.
3. **In prod**: mandatory health check per app, with automatic rollback to the previous image.
4. **Restore**: automatic test every week on the server, a full `bivy rebuild --test` before moving to prod, then **every 3 months** (D9, D39, D44): it is the only proof that rebuilding from scratch still works once everyone has forgotten how.
5. **Alerts** (D45), built with the backups, before any real data:
   - **Channel: Pushover**, on Gaëtan's phone (he already has an account). The reconciler calls the Pushover API directly, with no extra component.
   - **What the server reports itself**: failed deployment or rollback (D21), disk above 80% (a full disk stops Postgres, D42), backup or restore test failure, secrets that fail to decrypt.
   - **What only an outside service can report** (a dead server sends nothing): **healthchecks.io** as a dead man's switch, with three checks: nightly backup, weekly restore test, and a reconciler heartbeat. When a ping is missing, healthchecks.io notifies Pushover through its native integration.
   - **One alert per incident, not one per pass**: the reconciler runs every minute, so it alerts when a state changes (and once again when it is resolved), with at most one reminder a day while it lasts. Otherwise a single stuck problem would use up the Pushover quota in a week.
   - **Quarterly reminder**: the reconciler sends a Pushover reminder every 3 months to run `bivy rebuild --test` (D44).
   - HTTP availability monitoring (UptimeRobot) is not added for now: the heartbeat and the per-app health checks cover the essentials.

### Environments

No permanent dev or staging instance: it would be a second server to pay for and maintain, with its own Pocket ID accounts (D43). Instead, three levels, none of them permanent:

1. **Developing an app**: locally on the Mac, against the miniature platform used by the end-to-end tests (Postgres, Pocket ID, Caddy), started with one command.
2. **Trying an app on the real server before users see it**: declare a second app, for example `recettes-preview`, with its own database and another image. To the platform it is just one more app; remove it afterwards.
3. **Testing a platform change**: the end-to-end tests in CI, plus `bivy rebuild --test` on a temporary server billed by the hour.

Until the prod phase, the server itself is the dev environment.

### Conventions for Claude

- **App contract** (any framework): an image that listens on `port`, answers on the health endpoint, reads the standard variables provided by the platform, and applies additive migrations at startup.
- **App template repo, Nuxt only**: shared layer (OIDC auth, database connection, health endpoint), a second `local` layer (Better Auth) exclusive with the first, Dockerfile, GitHub workflow (build, push to GHCR, deployment PR), Vitest and a minimal Playwright test, and a `CLAUDE.md` describing these conventions. No Next template for now: Gaëtan's Next app follows the contract by hand, and we will create a template if a second Next app comes along (D23).
- `.mcp.json` in the template with the **official Nuxt UI MCP** (`https://ui.nuxt.com/mcp`; in Claude Code: `claude mcp add --transport http nuxt-ui https://ui.nuxt.com/mcp`), plus the **official Nuxt UI skill**. Additional references: `https://ui.nuxt.com/llms.txt` and `/llms-full.txt`.
- **A "new app" skill**: create the repo from the template, set the `bivouac-deploy` secret on it (read from SOPS with the Mac's age key), code the app, push, then open a PR on the instance repo adding the manifest.

## Rejected components and options, and why

- **Supabase**: one heavy instance per project.
- **Coolify / Dokploy**: UI-centered, not as code, heavier at rest, and an exposed admin panel.
- **CapRover**: not as code, no backups.
- **Kamal**: handles neither the shared database nor OIDC.
- **Komodo / doco-cd**: the reconciler's container part is small; one more component with its own UI and its own state (D28).
- **Ansible**: pointless with Ignition and an immutable OS.
- **Custom Flatcar image**: breaks official updates.
- **Proxmox**: pointless (Home Assistant runs on dedicated hardware).
- **Traefik / caddy-docker-proxy**: label-based discovery is pointless here, and they need the Docker socket.
- **Continuous WAL archiving (WAL-G, pgBackRest)**: pointless, one backup per night is enough.
- **Paid S3**: local storage, and backups sent to a free service.
- **Local mail server**: ports blocked at Hetzner, poor deliverability.
- **Tailscale Funnel**, **Pangolin**: off topic while we are on a VPS.
- **Webhook for the reconciler**: one more public endpoint, to gain at best one minute (D2).
- **Secrets in Ignition / user-data**: readable from the server through the metadata service (D7).
- **age key in GitHub (repo or CI)**: a single leak would expose every secret (D35, D36).
- **IPv6-only server**: GitHub and Brevo are not reachable over IPv6 (D26).
- **Renovate for app versions**: up to 4 hours of delay, tags it cannot order (D5).
- **Publicly exposed MCP**: would require OAuth authentication of MCP clients; stdio over SSH exposes nothing (D32).
- **Depending on `gh`, `hcloud` or `sops` in the CLI**: extra intermediaries between the CLI and the official APIs (D31).
- **Arm (CAX)**: every image would have to be built for multiple architectures (D25).
- **Prometheus + Grafana**: two more components and several hundred MB of RAM on a 4 GB server; a lightweight history in the status page is enough (D42).
- **Permanent dev or staging instance**: a second server to pay for and maintain (D43).

## Before the prod phase

Moving to the prod phase (rule 2) requires having:

- completed a full **`bivy rebuild --test`** (D39);
- decided on the **email login code** (D37);
- **alerts** in place and tested: each case of D45 received at least once on Gaëtan's phone, including a simulated missing backup (D45);
- done the rule 6 security review of the whole base.

## Points to check at implementation time

- **Better Auth**: current status, Nuxt and Next integration, generic OAuth plugin for Pocket ID.
- **Fine-grained PAT**: can it create a repo on a personal account? If not, `bivy` asks Gaëtan to create the empty repo in one click. Also check the format of pre-filled creation links.
- **`authorized_keys.d`** on Flatcar: partly verified (Flatcar docs, 5 Nov. 2026): keys go in files under `~core/.ssh/authorized_keys.d/`, and `update-ssh-keys` regenerates `~core/.ssh/authorized_keys` from them. Hetzner's metadata keys land in `authorized_keys.d/coreos-metadata`. Planned (not built): the reconciler writes `authorized_keys.d/bivouac` through a mount, and a systemd `.path` unit placed by Ignition runs `update-ssh-keys` on the host, so the container needs no extra privilege.
- ~~Visibility of the public monorepo's GHCR packages~~: the reconciler image could be pulled anonymously right after its first publication (6 Nov. 2026), although the GitHub docs say new packages are private by default (D50).
- ~~Current Node LTS version~~: Node 26 (verified 5 Nov. 2026, D47).
- **Hetzner hourly billing** (actual cost of a `rebuild --test`): a CX23 is €0.01056/hour incl. VAT (verified, API); a snapshot is €0.0143/GB/month excl. VAT.
- **CX23 availability** at rebuild time: no longer orderable in `fsn1` (verified, 6 Nov. 2026). The fallback for a real `bivy rebuild` is still to decide (D24).
- ~~Assigning the Primary IP at server creation~~: verified (Hetzner API): `public_net.ipv4` takes the ID of an unassigned Primary IP in the same location.
- **On the server, at first boot**: whether a snapshot can be used in another location than the one it was made in (from memory: yes); Docker's version on Flatcar; whether the `DOCKER-USER` rule blocking the metadata service survives Docker restarts; whether Caddy sees the client's real IP over IPv4 and IPv6 (D53); whether sshd reads `authorized_keys.d` directly or only through `update-ssh-keys`.
- **Brevo**: whether SPF is still required for domain authentication.
- **Pocket ID**: exact behavior if the `ENCRYPTION_KEY` is lost (undocumented).
- **healthchecks.io**: that the Pushover integration is available on the free plan (inferred from the docs, not stated).

## Suggested build order

Built in layers (D44): each layer is useful on its own, so if the project stalls halfway, what exists keeps running and stays backed up.

1. **Foundations**: manifest schema, instance repo template, minimal Butane, SOPS + age, validation CI.
2. **Base on the VPS**: Flatcar, Caddy, Postgres, Pocket ID (+ Brevo SMTP), wildcard DNS, Primary IP. They are run by a first, minimal reconciler (database and role per app, OIDC client, Caddyfile, containers) with its end-to-end tests. It never deletes anything: archiving on removal comes in step 6. In the MVP phase, the server may be installed by hand from a written runbook, which the CLI automates in step 5.
3. **Safety net**: nightly backups (restic to B2), weekly restore test and alerts (Pushover, healthchecks.io), before putting real data on it.
4. **First real app**: Nuxt template repo (OIDC layer, health, Dockerfile, workflow, `.mcp.json`) and the first app Gaëtan actually wants hosted. From here on, the platform is useful.
5. **Rebuilding without memory**: `bivy init` / `bivy rebuild` automating the runbook, then `bivy rebuild --test`.
6. **The rest of the reconciler**: authorized SSH keys, static sites, archiving on removal, rollback with marked images, internal API.
7. **On demand, when a real need appears**: forward auth with Tinyauth, the `local` layer (when the Next app arrives), status page and resource history, platform MCP, "new app" skill, `bivy machine add`.
8. The decisions in "Before the prod phase".

### Progress

- **Layer 1 (foundations)**: done.
- **Layer 2 (base on the VPS)**, as of 6 November 2026. Plan agreed with Gaëtan, in order:
  1. ~~Read-only inventory of Hetzner and OVH~~ (done; results in the instance repo's operations log).
  2. ~~Written runbook~~ (`docs/runbook.md`).
  3. ~~Instance repo `bivouac-platform`~~ (created; age key generated by Gaëtan; validation CI green).
  4. ~~Caddyfile generator, `caddy validate` in `bivy validate`, reconciler skeleton and its image~~.
  5. **Next**: miniature platform (Postgres, Pocket ID v2.19.2, Caddy, test app) and end-to-end tests in CI, adding one capability at a time: database, role and extensions per app; OIDC client with derived secret and groups; containers (pull, run, wait for health) and route; idempotence. Archiving and rollback stay in layer 6.
  6. Butane: reconciler at an exact version and self-update (D50), metadata block (D7), SSH key hook.
  7. Flatcar snapshot (temporary server outside `fsn1`).
  8. In-place reinstall of the server, then firewall rules, IPv6, name, keys over SSH (each with Gaëtan's consent).
  9. Wildcard DNS (consent).
  10. Pocket ID online and first admin; then Brevo and its DNS records (consent).
- Credentials on Gaëtan's Mac, one per file, mode 600, never printed: `~/.config/bivouac/` (`hetzner-token`, `ovh-application-key`, `ovh-application-secret`, `ovh-consumer-key`) and the age key in `~/.config/sops/age/keys.txt`. SSH keys: `~/.ssh/id_ed25519` (Gaëtan) and `~/.ssh/bivouac-claude`.
