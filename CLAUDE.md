# Bivouac — project brief

**Bivouac** is a "zero config" self-hosting platform whose maintenance is rare, guided and never silent (D44). The CLI is called **`bivy`**. The `bivouac` prefix is used for repos, images and resources (`bivouac-platform`, `bivouac-app-template`, etc.).

> **Status: second version (5 November 2026).** The first draft summarized a brainstorming session between the owner and Claude (1–2 November 2026). This version includes a Q&A session (3–5 November) that settled most open points. Each decision, with its context and the alternatives that were rejected, is recorded in [`docs/decisions.md`](docs/decisions.md) (references `D1`, `D2`…). The choices are still directions, not commitments: if a technology turns out to be a worse fit along the way, we change our minds, update this document and add an entry to the log.

You are Claude. Read this brief in full before proposing anything. Build on the directions chosen here, and explicitly flag any proposal that departs from them, explaining why.

## Language

- **This repo (public) is written entirely in English**: code, comments, docs, commit messages, and pull requests. PR descriptions are English only, in plain English (rule 3) (D41).
- **Conversations with the owner** follow the language set in `INSTANCE.md` of the private instance repo.
- **Personal and instance-specific details stay out of this repo** (D71). `bivouac-platform/INSTANCE.md` holds the real domain, IP and working preferences: read it at the start of every session. Here, `example.org` and `203.0.113.10` stand in for them. **This applies to everything written here, every time**: commit messages, the decision log, this brief, the runbook, tests, code comments and PR descriptions. Before each commit, reread the diff and the message for: the owner's name or personal situation, the real domain, IPs or server IDs, what was observed in production that identifies it, where credentials are kept, and remarks about the owner's skills or tastes. Write "the owner", use the stand-ins, and put the real details in the instance repo's operations log. Commits here use the GitHub `noreply` address.
- **The private instance repo `bivouac-platform` is in French**, including its operations log.

## How the owner and Claude work together (follow strictly)

Bivouac is designed so that an application developer does not have to do infrastructure work (networking, security, operations): the owner delegates operations to Claude and trusts it, which demands extreme rigor. These rules are not negotiable.

1. **Verify rather than assume.** Before using a tool, a version, an option or an API, check the current docs. In answers, explicitly separate what is "verified (source)" from what is "from memory, to be checked". Never bluff: if something is beyond what Claude can do reliably, say so.
2. **Two phases, two paces.**
   - **MVP phase** (as long as no real data and no real user are on the server): we move fast. Claude pushes directly to `main` and may deploy and test directly on the server, which is considered disposable. We can break and rebuild everything. Rules 5 (consent for sensitive actions) and 6 (security review before going public) still apply, and no secret may ever appear in plain text in Git.
   - **Interim phase, since 11 November 2026** (D89): real data the owner wants to keep is on the server (an ebook library, a household inventory, more to come), before the prod phase's conditions are met. **The server is no longer disposable.** Claude still pushes to `main` and deploys without a PR, but: anything that can lose data (rebuilding the server, recreating Postgres, touching a database, a volume, the backup repository or the keys that derive secrets) needs the owner's consent and a backup that succeeded after the last change of data; a change to the data path is announced with how the data would come back; experiments happen on the Mac or the miniature platform, never on the server; app data is never deleted without asking.
   - **Prod phase** (from the day the owner decides to put real data on it or invite someone, announced explicitly, and only once the conditions in "Before the prod phase" are met): every change goes through Git with green CI. **Low-risk** changes (new app, new app version, minor update, docs) may be merged by Claude alone or automatically when CI is green, with a summary afterwards. **Medium- or high-risk** changes go through a PR that the owner approves.
3. **Every PR submitted to the owner is explained in plain language**, so they can merge without understanding the infrastructure: what changes, why, the risk (low, medium, high), how to roll back. No unexplained jargon: an everyday image beats a technical term.
4. **SSH in prod is first and foremost for diagnosis, read-only.** Any action that changes something is announced beforehand, with its reason and its rollback. A hot fix is then carried over into Git in the same session. Accepted limitation: SSH keys log in as `core`, which has `sudo` and Docker; read-only relies on discipline, not on a technical barrier (D11).
5. **Irreversible or sensitive actions always require the owner's explicit consent**, never autonomy: deleting data, destroying or recreating a server, touching DNS, opening a port, changing the firewall, rotating or replacing a key, changing the IdP domain, changing the list of authorized SSH keys.
6. **Double check for security.** Any change touching the firewall, auth, secrets, SSH keys or network exposure is reviewed by a second, independent pass (a fresh review agent, with a security checklist) before being proposed for merge.
7. **Memory lives in the repos, not in Claude.** Claude does not remember from one session to the next. We maintain:
   - in the **public monorepo `bivouac`**: this brief (`CLAUDE.md`) and the **decision log** (`docs/decisions.md`, one short entry per decision: context, choice, rejected alternatives);
   - in the **private instance repo `bivouac-platform`**: the **operations log** (what was done in prod, when, why) and a short `CLAUDE.md` that points to the monorepo.

   They are updated at the end of every work session (D4).
8. **Incidents are reported as they happened**: what happened, the cause, the impact, the fix, and what prevents it from happening again. Never downplayed.
9. **Simplicity by default.** We prefer well-known, well-documented tools, and refuse to add a component without a clear justification. Every component is something that can break. Corollary: we talk directly to official APIs rather than going through intermediate CLIs, and the little custom code we have is covered by end-to-end tests.
10. **The owner's role is limited to** merging PRs after reading their summary, keeping safe (in a password manager) **the age master key, the restic password and their GitHub account's recovery codes**, and forwarding alerts to Claude. Everything else is Claude's responsibility.

Final safeguard: rigor reduces errors, it does not eliminate them. Nightly backups and one-command rebuild are also the safety net against Claude's mistakes.

## Context

The owner regularly codes small applications with Claude. Some live happily as artifacts, others must be hosted. Bivouac is a lightweight platform to host them all, **first on a Hetzner VPS**, maybe later on a mini PC at home, for a small community of invited friends and family. Earlier attempts with self-hosted PaaS tools and a home-made IdP shaped the choices below.

## Number-one criterion

**Zero config for the owner, and maintenance that is rare, guided and never silent** (D44). No platform connected to the internet runs for years untouched: security fixes, changes in third-party APIs, versions reaching end of life and expiring tokens or cards will require a few interventions a year. The goal is that each one is announced by an alert, takes one Claude session and one merged PR, and never requires remembering how things work. Small, frequent updates are preferred to big jumps after years of neglect. If the server is destroyed, it must be easy to bring back from backups. **One backup per night is enough**: losing at most one day is acceptable. Every added component must justify its place, because every component is something that can break.

## Architecture principles

1. **Everything on the server is either in Git, backed up off-site every night, or recomputable.** Config and encrypted secrets are in Git. Data (databases and files) is stored locally and replicated every night. Secrets generated by the platform are derived from a master secret, so they are recomputed identically (D14). We prefer rebuilding over repairing.
2. **Git is the source of truth for configuration.** No interface changes config directly on the machine.
3. **Apps are disposable.** Data lives in the shared Postgres and in declared volumes, all backed up every night.
4. **Claude has SSH access to the server to diagnose and debug**, which reassures the owner. Rule: a hot fix made over SSH must then be carried over into Git, otherwise the next reconciler pass overwrites it. Deployments go through Git; depending on the risk level, they are merged automatically, by Claude, or approved by the owner (rule 2). *Revised: the first draft said every deployment went through a PR merged by the owner, which contradicted rule 2 (D5).*
5. **No building on the server, at least at first** (the VPS lacks RAM). Images are built in GitHub Actions. Local builds may come back later, for example on a mini PC with more RAM.
6. **Convention over configuration.** The minimum of parameters to provide; the rest follows from conventions.
7. **The platform does not know the apps' framework.** It runs any image that follows a simple contract (port, health endpoint, environment variables). Nuxt, Next, Node-RED or Grafana all go through the same path (D19).

## Repos

- **Monorepo `bivouac`, public** (this folder): `bivy` CLI, reconciler, manifest schema (shared by the CLI and the reconciler), instance repo template, app template, `CLAUDE.md`, decision log. Images published to GHCR. It is written as a product: it contains nothing personal and nothing about the owner's production (D1, D4).
- **Instance repo `bivouac-platform`, private**, created from the template by `bivy init`: app and site manifests, Butane, SOPS secrets, list of authorized SSH keys, operations log.
- **App repos**, private: one per app, each with its own GitHub Actions workflow.

## Stack

### Host

- **Flatcar Container Linux, official image, stable channel.** Immutable OS with automatic A/B updates and rollback. Docker is included. There is no Node, no Ansible and no package manager on the host: everything runs in containers.
- **No custom Flatcar image**: it would mean losing official updates. Customization goes through a **minimal Ignition file** (Butane format) that **contains no secrets**: public SSH keys, sshd configuration, and a systemd unit that starts the reconciler container (D7).
- **Ignition runs only on first boot.** Anything that must change later (authorized SSH keys, etc.) is managed by the reconciler from Git, not by Ignition.
- Updates: `update_engine` downloads them, `locksmithd` reboots in a night window. One minute of downtime is accepted, and all containers use `restart: unless-stopped`.
- **Hetzner** (verified, Flatcar docs, Nov. 2026): there is no official Flatcar image at Hetzner. We build a snapshot once with `hcloud-upload-image` (community tool, v1.5.0, run from its container; `flatcar_production_hetzner_image.bin.bz2`, pinned to a stable version), then create or reinstall (`rebuild`) the server from that snapshot with the Ignition (transpiled JSON, not Butane) as user-data, limited to 32 KiB (verified, Hetzner API). Known limitations: no automatic mounting of Hetzner volumes, and no root password (SSH key required, which suits us). The image is checked on the Mac (Flatcar GPG signature, SHA-512) and sent as a file; the tool runs pinned by digest with a temporary token, after delete protection is set on the server and its IP (D65). Its default `cx23` could be ordered nowhere on 7 Nov. 2026: pass `--server-type`. A snapshot is not bound to a location (verified, Hetzner FAQ). The manual procedure is in [`docs/runbook.md`](docs/runbook.md).
- **Server**: the existing **CX23** (x86, 2 vCPU, 4 GB) in `fsn1`, the location of the IP `203.0.113.10`, **reinstalled in place** with Hetzner's `rebuild` action: the CX23 can no longer be ordered in `fsn1` (verified, 6 Nov. 2026), and the existing server keeps an older, lower price (D24). x86 rather than Arm, so we don't have to build every image for multiple architectures (D25).
- **IP**: `203.0.113.10` is the platform's **Primary IP**, already with `auto_delete=false` so it survives deletion of the server (D24). Verified (Hetzner API): €0.50/month excl. VAT, same location required, assigning it to an existing server requires the server to be powered off; for a new server it is passed at creation (`public_net.ipv4`), and must then be unassigned.
- **IPv4 required** (verified on 4 Nov. 2026 by DNS lookup): `github.com`, `api.github.com`, `ghcr.io` and `smtp-relay.brevo.com` have no IPv6 address. Without IPv4, the server could neither read Git, nor pull images, nor send email. The server also gets a free IPv6 (D26), configured statically by the instance's Butane: Flatcar only configures DHCPv4 at Hetzner (D67). No `AAAA` record until Caddy sees real client addresses over IPv6 (D67).
- **Later, mini PC**: Flatcar directly on the hardware, with the same Ignition.

### Host security (applied automatically by `bivy init`)

- **SSH**: key-only login, with Flatcar's `core` user. An sshd config file placed by Ignition explicitly sets `PermitRootLogin no`, `PasswordAuthentication no` and `KbdInteractiveAuthentication no`. The port stays 22: with keys only, changing the port only reduces log noise.
- **SSH keys**: **one key per machine and per use**, never a private key copied from one machine to another. On the owner's Mac: their own key and a dedicated `bivouac-claude` key, used by Claude Code, revocable on its own. Authorized public keys are listed in `bivouac-platform` (`ssh-keys.yml`, the only list): the reconciler writes them to its state directory, and a host script started by a systemd path unit applies them with `update-ssh-keys`, then removes every other set of keys (D63). Any change is a high-risk PR (D11, D12). Claude sessions in the cloud have no SSH access.
- **age master key and deploy key** placed over SSH by `bivy init` / `bivy rebuild` (`/etc/bivouac/`, mode 600), never through user-data. Verified: Hetzner user-data can be read from the server at `http://169.254.169.254/hetzner/v1/userdata`, so potentially from any container (D7).
- **Access to the metadata service blocked** from containers: a small nftables table of our own, loaded before Docker (which requires it), rejects forwarded traffic to `169.254.169.254`; the reconciler checks on each pass that it is still out of reach (D7, D62). No container uses host networking.
- **Hetzner Cloud firewall** (outside the machine, free, IPv4 and IPv6, verified), created through the API by the CLI: inbound allowed on 22/tcp, 80/tcp, 443/tcp and 443/udp (HTTP/3), everything else blocked. Since it filters before the server, Docker's iptables rules cannot bypass it.
- **No container port published**, except Caddy's. Postgres, Pocket ID, Tinyauth, the reconciler and the apps stay on internal Docker networks. Enforced by the reconciler and validated in CI.
- **Two Docker networks with fixed subnets** (D56): `bivouac` (apps, Caddy, Postgres, reconciler) and `bivouac-internal` (Pocket ID, Caddy, Postgres, reconciler). No app can reach Pocket ID except through Caddy. Every container drops `NET_RAW` and runs with `no-new-privileges`.
- **The Docker socket is mounted only in the reconciler**, which is not publicly exposed. The status page and the MCP go through the reconciler's internal API (D8).
- **Updates**: OS and Docker via Flatcar, third-party images via Renovate.
- **Least privilege**: one Postgres role per app, OVH keys limited to DNS zones, a dedicated Hetzner token, GitHub tokens limited to the strict minimum (see "GitHub tokens").
- **Login attempt limits**: handled by Pocket ID and by the auth library of `local` apps. Verified (Pocket ID docs): `TRUST_PROXY` is not a boolean but a list of IPs or CIDRs; we set it to **only Caddy's fixed address on the internal network**, otherwise all users share the same limit (D27, D56).
- Options rejected by default, can be added later: CrowdSec and fail2ban (pointless with SSH keys only and a surface reduced to Caddy).

### Domain names

- **Domain**: `example.org`, at OVH (OVH DNS, OVH mail).
- **One subdomain dedicated to the platform and one sub-subdomain per app**: `recettes.apps.example.org`, `biblio.apps.example.org` (D13).
- **A wildcard DNS record** `*.apps.example.org` pointing to the Primary IP: adding an app requires no DNS action.
- **Pocket ID on `auth.apps.example.org`. This name is final**: it shows in users' passkey dialog, and changing it invalidates every passkey (D40).
- **Tinyauth on `gate.apps.example.org`**: invisible to users (redirects), can be changed safely. Its session cookie is set on `.apps.example.org`.
- **Reserved names**, rejected by CI as app names: `auth`, `gate`, `status` (D34).
- `example.org` and `www.example.org` already point to this IP: they serve a simple static page, declared as a site (see "Static sites") with a custom domain (D24).
- A custom domain per app remains possible as an option in the manifest.
- **SPF**: `example.org` already has an SPF record (`v=spf1 include:mx.ovh.com ~all`), which covers sending through OVH (D70). Only one can exist: anything that needs to change it modifies the existing one instead of adding a second.

### Network and access

- **Caddy** as reverse proxy: automatic HTTPS (one certificate per subdomain, obtained automatically, so no wildcard certificate and no DNS plugin), minimal config. The **Caddyfile is generated by the reconciler** (the same code runs in `bivy validate`, followed by `caddy validate`) and Caddy has no access to the Docker socket (D53).
- **VPS**: admin access over **SSH** (keys only). No admin interface publicly exposed.
- **Mini PC (later)**: Tailscale for admin access. For public exposure, one of: port forwarding on the home router, Cloudflare Tunnel, or a relay VPS. Never `*.ts.net` (Tailscale Funnel), because passkeys would be bound to that domain.

### Data

- **A single shared Postgres** (18, image `postgis/postgis:18-3.7`), with one database and one role per app and `REVOKE CONNECT ... FROM PUBLIC`. The image ships PostGIS; pgvector will need an image of our own, built the day an app needs it (D51). Extensions are enabled per database according to the manifest, from an allowlist (D56). Accepted trade-off: all apps share the same major version.
- **Postgres major upgrades**: Renovate never proposes them (exclusion rule). They follow a documented procedure (dump then restore, the same path as `rebuild`) and are high-risk changes, approved by the owner (D29).
- **Files stored locally**, in volumes declared per app (`name → mount path`), included in backups. No paid S3.
- **S3-ready apps, no S3 server** (D72): apps use one storage module, on the declared volume by default and on S3 when `S3_BUCKET` is set, so an app can leave the platform without a rewrite. Garage runs in the template's CI only, until a trigger listed in D72 appears.
- No BaaS layer: Nuxt server routes and Drizzle are enough.
- **Database migrations**: run at app startup, and **additive only** (add, never drop or rename in the same deployment). A destructive migration takes two deployments. This is what makes rolling back to the previous image safe (D21).

### Secrets

- **Secrets encrypted with SOPS + age in the instance repo.** They include: Hetzner, OVH and B2 tokens, the mail account's password, the GHCR PAT, the `bivouac-deploy` PAT, Pocket ID's `ENCRYPTION_KEY` and `STATIC_API_KEY`, the restic repository password, the Pushover application token and user key, the healthchecks.io ping URLs, and the platform's **master secret**.
- **age master key**: present in three places only: the server, the owner's password manager, and their Mac (`~/.config/sops/age/keys.txt`, needed so the "new app" skill can read the `bivouac-deploy` token). Never in a repo, never in GitHub Actions (D35, D36). Someone in control of the Mac would have SSH access anyway; the key being there does not really increase the risk.
- **Derived secrets**: secrets generated by the platform (Postgres role passwords, OIDC client secrets, etc.) are stored nowhere. They are computed: `HMAC(master secret, "db:recettes")`, `HMAC(master secret, "oidc:recettes")`, etc. After a rebuild, everything is recomputed identically; rotating a secret means changing a version suffix in the manifest. Reason: per-database `pg_dump` does not back up roles, and Pocket ID lets you choose an OIDC client's secret (verified, Pocket ID v2.19.2) (D14).
- **Pocket ID's `ENCRYPTION_KEY`**: it encrypts, among other things, the token signing keys (verified). What happens if it is lost is not documented, but according to the code there is no recovery. It is in SOPS. Caution: with `ENCRYPTION_KEY_FILE`, a trailing newline becomes part of the key.

### Backups

- **Every night**: one `pg_dump` per database plus the file volumes, sent with **restic** (encrypted, deduplicated, retention for example 7 days, 4 weeks and 6 months). **The reconciler triggers them**, running restic in an ephemeral container: no extra component (D33).
- **Apps that store their data in files** (SQLite, Node-RED): a `backup: { stop: true }` manifest option stops the container for a few seconds during the backup to avoid an inconsistent copy. Off by default (D20).
- **Off-site destination: Backblaze B2, through the S3-compatible API**, in EU Central, chosen at sign-up (D73; the first sign-up did not offer it, a second one did, and the backups moved there on 13 Nov. 2026). The server's key cannot delete, and the bucket keeps hidden files 30 days (D73). Verified (restic docs): restic recommends the S3 API over its native B2 backend, because of error-handling issues. Still no rclone (D16). The region is chosen at sign-up, for the whole account, and cannot be changed afterwards.
- **B2 pricing** (verified, Nov. 2026): 10 GB free, then $6.95/TB/month; egress free up to 3 times the stored volume; no minimum storage duration. *Revised: the first draft said $0.005/GB.*
- **Automatic restore test, every week**: `restic check`, then the latest dump restored into a temporary Postgres, with a minimal check (the tables exist). The result is reported to the dead man's switch (D9). *Revised: the first draft listed this test as "not a priority".*
- Alternative rejected for now: Koofr (European, 10 GB free), more of a consumer Drive-like service, with no published SLA and reachable only through rclone. Later, the mini PC can serve as a second destination.

### Authentication

- **Pocket ID** as the IdP (Go, a single container, BSD-2, stored in the shared Postgres). Facts verified on Pocket ID v2.19.2:
  - **Signup tokens**: lifetime of at most 31 days, 1 to 100 uses, attached to groups (new accounts join those groups).
  - **Groups that restrict access to each OIDC client** (`allowed-user-groups`), sent in the ID token with the `groups` scope. Each app maps them to roles (Grafana with `role_attribute_path`, for example).
  - **API** (`X-API-KEY`): creating OIDC clients with a chosen ID, redirect URLs, group restriction; the chosen secret is set through a separate call, `POST /api/oidc/clients/{id}/secrets` (D52).
  - **`STATIC_API_KEY`** (at least 16 characters): admin API key provided through an environment variable, which lets the reconciler create clients without going through the UI. It is in SOPS.
  - **Database**: Postgres is selected by the `DB_CONNECTION_STRING` prefix (`postgres://`).
  - **Several passkeys per account**, from "My Account".
- **First admin**: the `/setup` page creates the first account and works **for whoever gets there first** (verified). During `bivy init`, Caddy only allows `/setup` from the owner's IP, then the exception is removed; the route itself stays refused for good (D15, done 8 Nov. 2026).
- **Passkeys only**: Pocket ID does not handle passwords. Guidance for users: at least two passkeys (phone + computer) or one synced passkey. Troubleshooting: one-time links generated by the admin.
- **Email login code: to be decided before the prod phase** (D37). Pocket ID has two settings, both off by default: `EMAIL_ONE_TIME_ACCESS_AS_ADMIN_ENABLED` (the admin sends a code) and `EMAIL_ONE_TIME_ACCESS_AS_UNAUTHENTICATED_ENABLED` (users request one themselves; the account's security then becomes that of their mailbox). In the meantime, neither is enabled.
- **Email through an OVH MX Plan mailbox, for Pocket ID only** (D70). A local mail server is not viable: Hetzner blocks outbound ports 25 and 465 by default (verified), and deliverability from a VPS IP is poor. Pocket ID sends through `smtp.mail.ovh.net:587`, always STARTTLS, as `contact@example.org`, named in `platform.yml` (`mail`), with the password in SOPS and given to Pocket ID as a file. Its settings come from Git (`UI_CONFIG_DISABLED=true`). SPF and DKIM pass (verified on a real message); `_dmarc.example.org` is `p=none`. **That password opens the whole mailbox: apps never receive it.** Apps needing mail will get a send-only relay, to choose when the first one needs it. *Revised: the first draft planned Brevo.*
- **Four auth modes**, declared in the manifest (D10). `oidc` and `public` are built first; `forward` and `local` when the first app needs them (D44):
  - `oidc` (default): a Nuxt layer that speaks standard OIDC, with an encrypted-cookie session. The app knows the user and their groups.
  - `forward`: Caddy `forward_auth` to **Tinyauth** (repo `tinyauthapp/tinyauth`, v5.2.0 verified), connected to Pocket ID (official Tinyauth guide). For things without their own auth: static sites, third-party UIs like Node-RED. Per-group access through `TINYAUTH_APPS_<APP>_OAUTH_GROUPS` (no Docker labels), and **`ACLS_POLICY=deny`**: otherwise any Pocket ID user would get in everywhere. Caddy must overwrite `X-Forwarded-Host`, and `TRUSTEDPROXIES` is limited to Caddy. A single login for all apps thanks to the cookie on `.apps.example.org`.
  - `public`: no protection.
  - `local` (for sites open to the general public): the app manages its own accounts with an embedded auth library, **Better Auth** (to be checked: current status, Nuxt and Next integration, generic OAuth plugin). Email + password, email verification and reset through the send-only relay still to be chosen (D70). A "Sign in with Pocket ID" button (generic OAuth) can coexist for the community. Pocket ID stays reserved for the invited community. If several public sites ever had to share the same accounts, we would reconsider an IdP with passwords.

### Deployment

- **App repos**: Nuxt (+ Nuxt UI) with a Dockerfile, or any framework that follows the contract. GitHub Actions builds and pushes to **GHCR**. App images are **private** (D17).
- **New app version**: after the build, the app repo's workflow opens a PR on `bivouac-platform` that changes the image tag in the manifest. That PR is merged automatically if the platform CI is green (low risk), by a workflow of the instance repo, since GitHub Free has no auto-merge on a private repo; a change of the shared layers still waits for the owner (D86). Typical delay: a few minutes. The workflow template lives in the public monorepo, with nothing personal; only the instance repo name is a parameter (D5). Rejected: Renovate for app images (one run every 4 hours on Mend's free plan, verified, and `sha-…` tags it cannot order).
- **App manifest** (D19):
  ```yaml
  # apps/recettes.yml
  image: ghcr.io/<user>/recettes:sha-abc123
  name: recettes            # → recettes.apps.example.org
  port: 3000                # internal port, 3000 by default
  health: /api/health       # default; optional for third-party apps
  database: { extensions: [postgis] }   # optional
  auth: oidc                # oidc | forward | public | local
  groups: [famille]         # allowed Pocket ID groups
  volumes: { uploads: /app/uploads }    # name → mount path
  backup: { stop: false }   # true for SQLite, Node-RED, etc.
  env:                      # renaming of values provided by the platform
    GF_AUTH_GENERIC_OAUTH_CLIENT_ID: ${oidc.clientId}
  mcp: false                # true: Claude may connect to the app's /mcp (D85)
  ```
  The platform injects standard variables according to the manifest: `DATABASE_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SMTP_*`. The `env` block is for third-party apps that expect other names. *Revised: the first draft wrote `volumes: [uploads]`, without a mount path.*
- **Static sites** (HTML artifacts, the `example.org` home page): files in `bivouac-platform/sites/<name>/`, with a `sites/<name>.yml` manifest (`auth`, `groups`, optional domain). Caddy serves them directly (`file_server`) from the repo checkout, read-only. No container (D22).
- **The reconciler, in TypeScript on Node LTS** (`packages/reconciler`, image `ghcr.io/chamboug/bivouac-reconciler:sha-<commit>`, D50, D54), is the only significant custom code: a few hundred lines, shipped as a container. It polls Git **every minute** (`git fetch` with a read-only deploy key); no webhook, so as not to expose a public endpoint. A `POST /sync` call on its internal API (status page button, MCP tool) triggers an immediate pass, at most once every 10 s (D2, D3). On each pass, it compares the desired state (Git) with the actual state and corrects:

  1. authorized SSH keys (`core`'s `authorized_keys.d`);
  2. for each app: database, role and extensions;
  3. OIDC client created or updated through the Pocket ID API (`STATIC_API_KEY`), with a derived secret;
  4. Caddyfile regenerated (apps, sites, Tinyauth) and Caddy reloaded;
  5. container with the right image (pull and restart).

  It **moves itself to the version named in `platform.yml`** (`reconciler.image`): it reads that field before validating the rest, pulls the image, runs its self-test, writes `/var/lib/bivouac/reconciler/image.env` and exits; systemd restarts it on that version. A version that fails its self-test, or another publisher's image, is refused (D50, D61).

  It also triggers the nightly backups and the weekly restore test, and serves the read-only internal API (state, versions, health, latest logs, latest backup) and the MCP.

  Required properties:
  - **Idempotent**: the same code handles installation, updates and rebuilds.
  - **Never deletes data**: when an app is removed, it takes a final `pg_dump` sent to restic with the `archive` tag, then **renames** the database and the volume (`archived_recettes_20261103`). Actual deletion only happens through an explicit action by the owner (D18).
  - **Monitored deployment**: it waits for the app's health check and rolls back to the previous image on failure. The failed image is **marked** and not retried until the manifest changes; the failure shows on the status page and triggers an alert (D21).

  Rejected: Komodo and doco-cd. The container part fits in about a hundred lines with the Docker API, and they would add a component with its own UI and its own state (D28).

- **GitHub tokens** (D17, D31, D36). Verified: GHCR only accepts *classic* PATs, and on GitHub Free organization secrets are not available to private repos.
  - **Classic `read:packages` PAT**, no expiration, in SOPS: the server uses it to pull private app images. It grants read access to all of the owner's GHCR packages, and nothing else.
  - **Fine-grained `bivouac-deploy` PAT**, no expiration, limited to `bivouac-platform` (write access to contents and PRs), in SOPS: set as a secret in each app repo by the "new app" skill, to open the deployment PRs.
  - **Read-only deploy key** on `bivouac-platform`: created by `bivy init` / `bivy rebuild` through the GitHub API and placed over SSH. During a rebuild, the new one is created first and the old one revoked only at the end, if everything worked (D30).
  - **Temporary fine-grained PAT** (7 days): requested by `bivy init`, `rebuild` and `machine add`, through a pre-filled creation link. It is never stored.
  - Rotating any of these tokens requires the owner's consent (rule 5).

- **`bivy` CLI, in TypeScript on Node LTS, used as a black box** (even by the owner). This is a priority: the whole server lifecycle must fit in a few commands. It **depends on neither `gh`, `hcloud` nor `sops`**: it talks directly to the official APIs, and everything else runs in containers (D31). Distribution: `npx` (the monorepo is public) or a Docker image.
  - **`bivy init`**:
    1. Asks for the few required inputs: Hetzner API token, domain, B2 keys, the mail account (D70), OVH keys (link `https://api.eu.ovhcloud.com/createToken/` shown with GET, POST and PUT pre-filled on `/domain/zone/<zone>/*`, D49), temporary GitHub PAT, GHCR PAT and `bivouac-deploy` PAT (pre-filled links).
    2. Generates the age master key and shows it **only once**. It **does not continue** until the owner has confirmed, by typing a word (not just Enter), that it is stored in their password manager. At the same moment it reminds the owner to store the restic password and the GitHub recovery codes (D38). It places the age key on the Mac.
    3. Creates the instance repo from the template.
    4. Prepares the Flatcar snapshot if needed and generates the Ignition.
    5. Checks that `203.0.113.10` is indeed a Primary IP and sets `auto_delete=false`.
    6. Asks for **explicit confirmation** before destroying the existing server, then creates the new one with the Primary IP (rule 5).
    7. Places the age key and the deploy key over SSH, creates the firewall and the DNS records (wildcard, DMARC), with the owner's consent for DNS.
    8. Once the base is up (Caddy, Postgres, Pocket ID, Tinyauth, backups), opens `/setup` for the owner's IP only and shows the link to create the admin account.
  - **`bivy rebuild`** (same logic): new server with the same Primary IP, latest restic backup restored, and we're back. It works from any machine and asks for the age key and the restic password (from the password manager) and a temporary GitHub PAT. All other tokens are in SOPS.
  - **`bivy rebuild --test`**: creates a temporary server billed by the hour (from memory, to be checked: a few cents per test), restores, checks, then destroys everything. It never touches the real IP or DNS (D39).
  - **`bivy machine add`**: on a new machine, generates an SSH key and opens a PR adding it to the list of authorized keys (and removing a lost machine's key if needed). It asks for the age key from the password manager rather than copying it from one machine to another (D38).
  - **DNS through the OVH API**: wildcard `*.apps.example.org` and DMARC. Touching DNS requires the owner's consent (rule 5).
- **Portability: we build for the owner's stack only**, without trying to support other cases. We simply keep clean extension points:

  - the CLI goes through three interfaces: server provider (Hetzner), DNS provider (OVH), backup destination (restic, so already very open);
  - a "manual" DNS provider that just prints the records to create: it covers every registrar for almost nothing;
  - the base runs entirely in containers, so it would work on any Docker host (Ubuntu, etc.). Only the Ignition bootstrap is Flatcar-specific.

  No "existing server" mode, other providers or multi-OS test matrix until someone needs them.

- **Renovate** (Mend's free plan, verified: private repos included, one run every 4 hours) on the instance repo, for third-party images (Caddy, Postgres, Pocket ID, Tinyauth, Node-RED…): minor updates merged automatically if CI is green, PRs for majors, never a Postgres major version.

### Admin interface

- **No interface for editing config**: it goes through Git, often via PRs from Claude.
- Managing users, invitations and groups: **Pocket ID's interface**.
- **A status page**: a small Nuxt app on the platform (`status.apps.example.org`), behind Pocket ID, restricted to the admin group. It shows the apps, their versions, their health, the latest logs, the latest backup and pending Renovate PRs, by querying the reconciler's internal API; it never has the Docker socket (D8). Its only action is a "Sync now" button. A good first project to break in the conventions.
- **Resource usage** (D42): the status page shows CPU, RAM and disk for the host and for each container, current values and **30 days of history**. The reconciler takes one sample per minute and stores it in a small table in the shared Postgres. No Prometheus or Grafana.
- **App MCP servers** (D85): an `oidc` app with `mcp: true` serves its own tools at `/mcp`. Claude (claude.ai, phone, Claude Code) signs in through Pocket ID with a public client `<app>-mcp` the reconciler creates, restricted to the app's groups; the shared layer accepts only access tokens issued for that address, never the cookie. Each person reaches only their own data, as in the app's pages.
- **Platform MCP server**, served by the reconciler **over stdio through SSH**: in `.mcp.json`, a command like `ssh core@<server> docker exec bivouac-reconciler mcp`. No public exposure, and the SSH key serves as authentication. Claude can read state and logs, and trigger a sync (D32). *Revised: the first draft exposed the MCP through the status page via `@nuxtjs/mcp-toolkit`, which would have required OAuth authentication of MCP clients against Pocket ID.*

### Tests

1. **Instance repo CI, on every PR**: manifest schema validation (including reserved names), Butane to Ignition compilation, `caddy validate` on the generated Caddyfile, and **a check that every secrets file is properly encrypted** and well-formed, without decrypting it: the age key never goes to GitHub. Actual decryption is checked by the reconciler on every pass and by the restore test (D35). Blocks merging and gates automatic merges. *Revised: the first draft planned to decrypt secrets in CI.*
2. **End-to-end tests of the reconciler, in the monorepo CI**: a miniature platform (Postgres, Pocket ID, Caddy, Tinyauth, test app). We check creation of the database and extensions, of the OIDC client and of the route, idempotence, archiving on removal, and rollback with a failed image being marked. SSO login testable with Playwright and Chrome's virtual WebAuthn authenticator.
3. **In prod**: mandatory health check per app, with automatic rollback to the previous image.
4. **Restore**: automatic test every week on the server, a full `bivy rebuild --test` before moving to prod, then **every 3 months** (D9, D39, D44): it is the only proof that rebuilding from scratch still works once everyone has forgotten how. The same session checks the apps for serious flaws (D81, runbook section 13).
5. **Alerts** (D45), built with the backups, before any real data:
   - **Channel: Pushover**, on the owner's phone (already has an account), every message at normal priority (D82). The reconciler calls the Pushover API directly, with no extra component.
   - **What the server reports itself**: failed deployment or rollback (D21), disk above 80% (a full disk stops Postgres, D42), backup or restore test failure, secrets that fail to decrypt.
   - **What only an outside service can report** (a dead server sends nothing): **healthchecks.io** as a dead man's switch, with three checks: nightly backup, weekly restore test, and a reconciler heartbeat. When a ping is missing, healthchecks.io notifies Pushover through its native integration.
   - **One alert per incident, not one per pass**: the reconciler runs every minute, so it alerts when a state changes (and once again when it is resolved), with at most one reminder a day while it lasts. Otherwise a single stuck problem would use up the Pushover quota in a week.
   - **Quarterly reminder**: the reconciler sends a Pushover reminder every 3 months to run `bivy rebuild --test` (D44).
   - HTTP availability monitoring (UptimeRobot) is not added for now: the heartbeat and the per-app health checks cover the essentials.

### Environments

No permanent dev or staging instance: it would be a second server to pay for and maintain, with its own Pocket ID accounts (D43). Instead, three levels, none of them permanent:

1. **Developing an app**: locally on the Mac with `npm run dev:local` (in the app template): a Postgres in Docker, the tests' fake identity provider and hot reload. Every interface change is checked there (light, dark, phone width) before pushing, never on the real server (D83). The miniature platform (`npm run platform:up`) is for the platform itself.
2. **Trying an app on the real server before users see it**: declare a second app, for example `recettes-preview`, with its own database and another image. To the platform it is just one more app; remove it afterwards.
3. **Testing a platform change**: the end-to-end tests in CI, plus `bivy rebuild --test` on a temporary server billed by the hour.

Until the prod phase, the server itself is the platform's dev environment; apps are still checked on the Mac first.

### Conventions for Claude

- **App contract** (any framework): an image that listens on `port`, answers on the health endpoint, reads the standard variables provided by the platform, and applies additive migrations at startup.
- **User files** (D72), in any framework: never use `fs` directly, only the storage module. The database stores keys (`photos/123.jpg`), never paths or full URLs. Files are served through an app route that checks access (`/api/files/...`). The disk mode refuses keys that leave the app's directory. The module has no framework dependency, so a non-Nuxt app can copy it.
- **App template repo, Nuxt only**: shared layer (OIDC auth, database connection, health endpoint), a second `local` layer (Better Auth) exclusive with the first, Dockerfile, GitHub workflow (build, push to GHCR, deployment PR), Vitest and a minimal Playwright test, and a `CLAUDE.md` describing these conventions. No Next template for now: the owner's Next app follows the contract by hand, and we will create a template if a second Next app comes along (D23).
- `.mcp.json` in the template with the **official Nuxt UI MCP** (`https://ui.nuxt.com/mcp`; in Claude Code: `claude mcp add --transport http nuxt-ui https://ui.nuxt.com/mcp`), plus the **official Nuxt UI skill**. Additional references: `https://ui.nuxt.com/llms.txt` and `/llms-full.txt`.
- **A "new app" skill**: create the repo from the template, set the `bivouac-deploy` secret on it (read from SOPS with the Mac's age key), code the app, push, then open a PR on the instance repo adding the manifest.
- **`gh` on the owner's Mac is for Claude's own work** (D78): reading CI and its logs on the monorepo and the instance repo (`gh run list`, `gh run watch`, `gh run view --log-failed`), and opening or commenting on PRs. Its token is limited to those two repos and cannot push, merge or rerun a workflow; pushes keep going through Git over SSH. `bivy` still never depends on it (D31). If `gh` answers 401, the token has expired (366 days): ask the owner for a new one. macOS has no `timeout` command.

## Rejected components and options, and why

- **Supabase**: one heavy instance per project.
- **Coolify / Dokploy**: UI-centered, not as code, heavier at rest, and an exposed admin panel.
- **CapRover**: not as code, no backups.
- **Kamal**: handles neither the shared database nor OIDC.
- **Komodo / doco-cd**: the reconciler's container part is small; one more component with its own UI and its own state (D28).
- **Ansible**: pointless with Ignition and an immutable OS.
- **Custom Flatcar image**: breaks official updates.
- **Proxmox**: pointless for a single-purpose host.
- **Traefik / caddy-docker-proxy**: label-based discovery is pointless here, and they need the Docker socket.
- **Continuous WAL archiving (WAL-G, pgBackRest)**: pointless, one backup per night is enough.
- **Paid S3**: local storage, and backups sent to a free service.
- **Local mail server**: ports blocked at Hetzner, poor deliverability.
- **Tailscale Funnel**, **Pangolin**: off topic while we are on a VPS.
- **Webhook for the reconciler**: one more public endpoint, to gain at best one minute (D2).
- **Secrets in Ignition / user-data**: readable from the server through the metadata service (D7).
- **age key in GitHub (repo or CI)**: a single leak would expose every secret (D35, D36).
- **IPv6-only server**: GitHub is not reachable over IPv6 (D26).
- **Renovate for app versions**: up to 4 hours of delay, tags it cannot order (D5).
- **Publicly exposed platform MCP**: it holds the Docker socket's power; stdio over SSH exposes nothing (D32). App MCPs are public, behind Pocket ID (D85).
- **Depending on `gh`, `hcloud` or `sops` in the CLI**: extra intermediaries between the CLI and the official APIs (D31).
- **Arm (CAX)**: every image would have to be built for multiple architectures (D25).
- **Prometheus + Grafana**: two more components and several hundred MB of RAM on a 4 GB server; a lightweight history in the status page is enough (D42).
- **Permanent dev or staging instance**: a second server to pay for and maintain (D43).

## Before the prod phase

Moving to the prod phase (rule 2) requires having:

**Urgent since real data arrived (D89)**: ~~the full `bivy rebuild --test`~~ (done 14 Nov. 2026: the platform came back on a temporary server in about six minutes, data identical, D91); B2's download caps and a card, so a real rebuild is not stuck for a day (D91). ~~Restoring one app's database and volume without touching the others~~ (done 13 Nov. 2026: deployed and rehearsed on the server with a test app, D90, runbook section 14). ~~The backup region~~ (done 13 Nov. 2026: EU Central, D73).

- ~~completed a full **`bivy rebuild --test`** (D39)~~ (done 14 Nov. 2026, D91; then every 3 months);
- decided on the **email login code** (D37);
- ~~**alerts** in place and tested: each case of D45 received at least once on the owner's phone, including a simulated missing backup (D45)~~ (done 9 Nov. 2026, D82);
- done the rule 6 security review of the whole base;
- for backups (D73): an independent monthly check from outside the server with a separate read-only key, and a spending cap and download caps at B2 (a card on file; a real rebuild downloads the whole copy in one day, D91) (~~the backup region~~, done 13 Nov. 2026);
- restricted who can write to the instance repo's `main` (D64), pinned the reconciler by digest and added its automatic fallback (D61), ~~written and tried the lockout rescue procedure (D63)~~ (done 8 Nov. 2026, runbook section 11); settled how Caddy sees client IPv6 addresses before any `AAAA` record (D67); looked at Pocket ID's minute of failure after each restart (D68); chosen a send-only relay before any app sends mail (D70).

## Points to check at implementation time

- **Better Auth**: current status, Nuxt and Next integration, generic OAuth plugin for Pocket ID.
- **Fine-grained PAT**: can it create a repo on a personal account? If not, `bivy` asks the owner to create the empty repo in one click. Also check the format of pre-filled creation links.
- ~~**`authorized_keys.d`** on Flatcar~~: verified (Flatcar source, 7 Nov. 2026): Flatcar's sshd config does not change `AuthorizedKeysFile`, so sshd reads only `~core/.ssh/authorized_keys`, which `update-ssh-keys` (`/usr/bin`) regenerates from the fragments in `authorized_keys.d/`; Ignition writes `authorized_keys.d/ignition`. Built (D63); first-boot checks below.
- ~~Visibility of the public monorepo's GHCR packages~~: the reconciler image could be pulled anonymously right after its first publication (6 Nov. 2026), although the GitHub docs say new packages are private by default (D50).
- ~~Current Node LTS version~~: Node 26 (verified 5 Nov. 2026, D47).
- **Hetzner hourly billing** (actual cost of a `rebuild --test`): a CX23 is €0.01056/hour incl. VAT (verified, API); a snapshot is €0.0143/GB/month excl. VAT on its stored size (0.55 GB for Flatcar); a `cpx12` is €0.02208/hour incl. VAT (D65).
- **CX23 availability** at rebuild time: no longer orderable in `fsn1` (verified, 6 Nov. 2026), then in no location at all (7 Nov. 2026), then shown available again in `fsn1`, `nbg1` and `hel1` (API, 8 Nov. 2026: an indicator, not a guarantee). The fallback for a real `bivy rebuild` is still to decide (D24).
- ~~Assigning the Primary IP at server creation~~: verified (Hetzner API): `public_net.ipv4` takes the ID of an unassigned Primary IP in the same location.
- **On the server, at first boot** (checked 8 Nov. 2026, operations log of the instance repo):
  - verified: the metadata block (D62) — refused from containers on the default bridge and on `bivouac`, answered on the host, still so after `systemctl restart docker` and a reboot; `docker.service` requires `bivouac-metadata-block.service`; SSH keys (D63) — `bivouac-ssh-keys.path` fires within a second of the list being written, only the `bivouac` fragment is left, `ssh-status/applied` says `applied`, fresh logins with `bivouac-claude` and the owner's key work; `/opt/bivouac` written by Ignition; the reconciler's self-update on a real version change (`sha-49b0479` → `sha-461e530`, D61); the firewall survives a rebuild; Ignition is read from user-data despite the snapshot's `os_flavor: ubuntu`;
  - verified once DNS answered (8 Nov. 2026, D69): Caddy passes the client's real IPv4 to Pocket ID (D53); over IPv6 Pocket ID sees a Docker gateway, as D67 expected; a container on the `bivouac` network reaches the public issuer URL through the server's public IP (D56), seen as `10.209.0.1`; a 50 KB reply over IPv6 without ICMP arrived intact from one network path;
  - not yet checkable: pulling a private app image with the GHCR token (D17; no app, and the token is not wired in yet); `update-ssh-keys` with `sk-*` keys (none in the list); HTTP/3 from outside.
- **Mail deliverability** (D70): the first test message went to Gmail's spam although SPF and DKIM passed; check again with a real invitation.
- **Pocket ID**: exact behavior if the `ENCRYPTION_KEY` is lost (undocumented).
- ~~**healthchecks.io**: Pushover integration on the free plan~~: available (confirmed by the owner in their account, 8 Nov. 2026, D76).

## Suggested build order

Built in layers (D44): each layer is useful on its own, so if the project stalls halfway, what exists keeps running and stays backed up.

1. **Foundations**: manifest schema, instance repo template, minimal Butane, SOPS + age, validation CI.
2. **Base on the VPS**: Flatcar, Caddy, Postgres, Pocket ID (+ mail), wildcard DNS, Primary IP. They are run by a first, minimal reconciler (database and role per app, OIDC client, Caddyfile, containers) with its end-to-end tests. It never deletes anything: archiving on removal comes in step 6. In the MVP phase, the server may be installed by hand from a written runbook, which the CLI automates in step 5.
3. **Safety net**: nightly backups (restic to B2), weekly restore test and alerts (Pushover, healthchecks.io), before putting real data on it.
4. **First real app**: Nuxt template repo (OIDC layer, health, Dockerfile, workflow, `.mcp.json`) and the first app the owner actually wants hosted. From here on, the platform is useful.
5. **Rebuilding without memory**: `bivy init` / `bivy rebuild` automating the runbook, then `bivy rebuild --test`.
6. **The rest of the reconciler**: authorized SSH keys, static sites, archiving on removal, rollback with marked images, internal API.
7. **On demand, when a real need appears**: forward auth with Tinyauth, the `local` layer (when the Next app arrives), status page and resource history, platform MCP, "new app" skill, `bivy machine add`.
8. The decisions in "Before the prod phase".

### Progress

- **Layer 1 (foundations)**: done.
- **Layer 2 (base on the VPS)**, as of 6 November 2026. Plan agreed with the owner, in order:
  1. ~~Read-only inventory of Hetzner and OVH~~ (done; results in the instance repo's operations log).
  2. ~~Written runbook~~ (`docs/runbook.md`).
  3. ~~Instance repo `bivouac-platform`~~ (created; age key generated by the owner; validation CI green).
  4. ~~Caddyfile generator, `caddy validate` in `bivy validate`, reconciler skeleton and its image~~.
  5. ~~Miniature platform and end-to-end tests~~ (D55–D59): the reconciler runs the base services, databases, OIDC clients and app containers; 34 end-to-end tests in CI; `npm run platform:up` locally. Archiving and rollback stay in layer 6.
  6. ~~Butane and platform secrets~~ (D60–D64): reconciler at an exact version named in `platform.yml`, self-update, metadata block, SSH key sync; `secrets/platform.sops.yaml` created in the instance repo (values never shown). 41 end-to-end tests. The compiled Ignition is 5.6 KB (limit 32 KiB).
  7. ~~Flatcar snapshot~~ (D65): Flatcar stable 4757.2.3, checked against Flatcar's signature, made with a temporary `cpx12` in `fsn1`; no leftovers (checked through the API); the server and its IP are delete-protected until the rebuild. Snapshot ID in the operations log.
  8. ~~In-place reinstall~~ (8 Nov. 2026; D66–D68): firewall limited to 22/80/443 before the rebuild, Primary IPv6 (static in the Butane), server `bivouac` reinstalled with Flatcar and re-protected, host key checked against Hetzner's console, read-only deploy key generated on the server, age key placed over SSH; the reconciler runs Postgres, Pocket ID and Caddy; restarts, self-update and the rescue system tried. Two security reviews (plan and real state).
  9. ~~Wildcard DNS~~ (8 Nov. 2026; D69): `*.apps.example.org`, `A` only; Let's Encrypt production certificate for `auth.apps.example.org`; the first-admin paths refused over HTTPS. Security review done before the write. **Pocket ID is public and has no admin yet**: do not change its version until step 10 is done.
  10. ~~First admin and mail~~ (8 Nov. 2026; D70): one admin with two passkeys, `/setup` closed again; Pocket ID sends through the OVH mailbox, and a real message passed SPF and DKIM. Rule 6 review done. **Layer 2 is done; next is layer 3 (backups and alerts).**
- **Layer 3 (safety net)**, as of 8 November 2026 (D73-D77). A, secrets and bucket: done. B, alerts and heartbeat: built. C, nightly backup: built, real copies at B2. D, weekly retention: built, ran on B2. E, weekly restore test: built, ran from B2. F, rule 6 review of code and real server: done, its fixes deployed. G, each case of D45 received on the owner's phone: done 9 November (D82). **Layer 3 is done.**
- **Layer 4 (first real app)**, as of 9 November 2026 (D79). Nuxt template: built in `app-template/`, shared layers in `app-layers/` (D80), rule 6 reviews done and their fixes applied. **To remind the owner when the first real app starts**: first a tag ruleset on `app-layers-v*` (Restrict updates and deletions, not creations), then install https://github.com/apps/renovate with "Only select repositories" and only the app's repo, never "All repositories" (other repos could get onboarding PRs); one click per new app afterwards (D81). Deployment PRs merge by themselves when they only change an app's image and its shared layers did not change (D86, 11 Nov. 2026).
- **Real data since 11 November 2026** (D89): two apps hold data the owner keeps. Interim phase (rule 2): the server is no longer disposable.
- **Restoring one app** (D90, 12 November 2026): `restore-app` in the reconciler, runbook section 14, 12 end-to-end tests, rule 6 review done and its fixes applied. Deployed on 13 November and rehearsed on the server with a throwaway test app: a deleted book came back, and the undo removed it again; the test app was then removed by hand.
- **Backup region** (D73, 13 November 2026): the backups moved to B2 EU Central, with the same bucket rule, key capabilities and restic password; first copy and restore test passed. The old account was deleted the same day, by the owner's choice (history before the move given up). The spending cap waits: B2 needs a card on file for it.
- **Layer 5 (rebuilding without memory)**, as of 14 November 2026 (D91). The reconciler's rebuild marker, test mode and `restore-platform` deployed (`sha-d44cf3b`). **`bivy rebuild --test` ran for real on 14 November**: a CX23 in `hel1`, the provisional host key kept by Flatcar and swapped (no console), the latest nightly copy restored in 66 s, Pocket ID with the real signing keys, both apps healthy, row counts and files identical to the real server, about six minutes of work, about €0.01, nothing left behind. **The real `bivy rebuild`** is written (in place, or a new server on the same IPs; `--plan` only reads; typed confirmation; a fresh backup first; the deploy key added by the owner; the marker removed at the end), tested against fake APIs, two rule 6 reviews done and fixed; `--plan` ran against the real project. **Never run against the real server**: that is a decision of its own (rule 5). Open: B2's daily download caps (a warning arrived the day of the test), the price and duration guard for `--test` (set aside by the owner).
- **Before the prod phase, from step 6's security reviews** (D64): anyone who can push to the instance repo's `main` is root on the server (the `bivouac-deploy` PAT sits in every app repo): restrict it (branch protection or rulesets if available on the plan, otherwise another deployment path); pin the reconciler image by digest; ~~a rescue procedure for a lockout~~ (done 8 Nov. 2026); an automatic fallback when a new reconciler version crashes after its self-test (D61).
