# Bivouac — project brief

**Bivouac** is a "zero config" self-hosting platform whose maintenance is rare, guided and never silent (D44). The CLI is called **`bivy`**. The `bivouac` prefix is used for repos, images and resources (`bivouac-platform`, `bivouac-app-template`, etc.).

You are Claude. Read this brief in full before proposing anything. Build on the directions chosen here, and explicitly flag any proposal that departs from them, explaining why. The choices are directions, not commitments: if a technology turns out to be a worse fit, we change our minds, update this brief and add an entry to the log.

**Where things are written** (rule 7):
- this brief: the rules, the principles, a map of the platform, what is open;
- [`docs/architecture.md`](docs/architecture.md): how each part works today. **Read the relevant section before changing a part**;
- [`docs/decisions.md`](docs/decisions.md): why, one entry per decision (`D1`, `D2`…), with an index at the top. Read the entries a change touches; do not read the whole file;
- [`docs/runbook.md`](docs/runbook.md): procedures on the real server; [`docs/adapters.md`](docs/adapters.md): `bivy`'s adapter contracts;
- the private instance repo `bivouac-platform`: `INSTANCE.md` (real values, working preferences) and the operations log (what was done in prod, when, why).

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
   - **Interim phase, since 11 November 2026** (D89): real data the owner wants to keep is on the server (an ebook library, a household inventory, more to come), before the prod phase's conditions are met. **The server is no longer disposable.** Claude still pushes to `main` and deploys without a PR, but: anything that can lose data (rebuilding the server, recreating Postgres, touching a database, a volume, the backup repository or the keys that derive secrets) needs the owner's consent and a backup that succeeded after the last change of data; a change to the data path is announced with how the data would come back; experiments happen on the Mac or the miniature platform, never on the server; app data is never deleted without asking. Kept on 17 November 2026, by the owner's choice, with every prod condition met (D95).
   - **Prod phase** (from the day the owner decides to put real data on it or invite someone, announced explicitly, and only once the conditions listed under "Before the prod phase" below are met): every change goes through Git with green CI. **Low-risk** changes (new app, new app version, minor update, docs) may be merged by Claude alone or automatically when CI is green, with a summary afterwards. **Medium- or high-risk** changes go through a PR that the owner approves.
3. **Every PR submitted to the owner is explained in plain language**, so they can merge without understanding the infrastructure: what changes, why, the risk (low, medium, high), how to roll back. No unexplained jargon: an everyday image beats a technical term.
4. **SSH in prod is first and foremost for diagnosis, read-only.** Any action that changes something is announced beforehand, with its reason and its rollback. A hot fix is then carried over into Git in the same session. Accepted limitation: SSH keys log in as `core`, which has `sudo` and Docker; read-only relies on discipline, not on a technical barrier (D11).
5. **Irreversible or sensitive actions always require the owner's explicit consent**, never autonomy: deleting data, destroying or recreating a server, touching DNS, opening a port, changing the firewall, rotating or replacing a key, changing the IdP domain, changing the list of authorized SSH keys.
6. **Double check for security.** Any change touching the firewall, auth, secrets, SSH keys or network exposure is reviewed by a second, independent pass (a fresh review agent, with a security checklist) before being proposed for merge.
7. **Memory lives in the repos, not in Claude.** Claude does not remember from one session to the next. We maintain:
   - in the **public monorepo `bivouac`**: this brief (`CLAUDE.md`), the architecture (`docs/architecture.md`) and the **decision log** (`docs/decisions.md`, one short entry per decision: context, choice, rejected alternatives);
   - in the **private instance repo `bivouac-platform`**: the **operations log** (what was done in prod, when, why) and a short `CLAUDE.md` that points to the monorepo.

   They are updated at the end of every work session (D4). Each fact lives in one place: the reason in the log, how it works in the architecture, the procedure in the runbook, what happened in prod in the operations log. This brief keeps only what every session needs.
8. **Incidents are reported as they happened**: what happened, the cause, the impact, the fix, and what prevents it from happening again. Never downplayed.
9. **Simplicity by default.** We prefer well-known, well-documented tools, and refuse to add a component without a clear justification. Every component is something that can break. Corollary: we talk directly to official APIs rather than going through intermediate CLIs, and the little custom code we have is covered by end-to-end tests.
10. **The owner's role is limited to** merging PRs after reading their summary, keeping safe (in a password manager) **the age master key, the restic password and their GitHub account's recovery codes**, and forwarding alerts to Claude. Everything else is Claude's responsibility.

Final safeguard: rigor reduces errors, it does not eliminate them. Nightly backups and one-command rebuild are also the safety net against Claude's mistakes.

## Context and number-one criterion

The owner regularly codes small applications with Claude. Some live happily as artifacts, others must be hosted. Bivouac hosts them on a Hetzner VPS (maybe later a mini PC at home), for a small community of invited friends and family.

**Zero config for the owner, and maintenance that is rare, guided and never silent** (D44). Security fixes, third-party API changes, end-of-life versions and expiring tokens or cards will require a few interventions a year: each one is announced by an alert, takes one Claude session and one merged PR, and never requires remembering how things work. Small, frequent updates beat big jumps after years of neglect. If the server is destroyed, it must be easy to bring back from backups (`bivy rebuild`, D91). **One backup per night is enough**: losing at most a day is acceptable.

## Architecture principles

1. **Everything on the server is either in Git, backed up off-site every night, or recomputable.** Platform-generated secrets are derived from a master secret (D14). We prefer rebuilding over repairing.
2. **Git is the source of truth for configuration.** No interface changes config on the machine.
3. **Apps are disposable.** Data lives in the shared Postgres and in declared volumes, backed up every night.
4. **SSH is for diagnosis.** A hot fix made over SSH must be carried over into Git, or the next reconciler pass overwrites it. Deployments go through Git (D5).
5. **No building on the server** (not enough RAM). Images are built in GitHub Actions.
6. **Convention over configuration.** The minimum of parameters; the rest follows from conventions.
7. **The platform does not know the apps' framework.** It runs any image that follows the contract: port, health endpoint, environment variables (D19).

## Repos

- **Monorepo `bivouac`, public** (this folder): `bivy` CLI (`packages/bivy`), reconciler (`packages/reconciler`), manifest schema shared by both (`packages/manifest`), instance repo template (`template/`), app template (`app-template/`) and shared app layers (`app-layers/`), status page (`status-page/`), the "new app" plugin (`plugin/`), docs. Images on GHCR. Written as a product: nothing personal, nothing about the owner's production (D1, D4).
- **Instance repo `bivouac-platform`, private**, created from the template by `bivy init`: app and site manifests, `platform.yml`, Butane, SOPS secrets, `ssh-keys.yml`, operations log.
- **App repos**, private: one per app, each with its own GitHub Actions workflows.

## Map of the platform

Details and verified facts per part: [`docs/architecture.md`](docs/architecture.md).

| Part | In one line | Decisions |
|---|---|---|
| Host | Flatcar stable, official image, minimal Ignition with no secret; CX23 in `fsn1`, x86 | D7, D24, D25, D65 |
| IPs | Primary IPv4 (required: GitHub has no IPv6) and IPv6; no `AAAA` record | D26, D67 |
| Host security | SSH keys only as `core`; Hetzner firewall 22/80/443; metadata service blocked from containers | D11, D12, D62, D63 |
| Networks | Two Docker networks with fixed subnets; no published port but Caddy's; no `NET_RAW` | D56, D94 |
| Domains | `*.apps.example.org`; `auth.` (Pocket ID, final), `gate.` (Tinyauth), `status.` | D13, D40, D34 |
| Proxy | Caddy, automatic HTTPS, Caddyfile generated by the reconciler | D53 |
| Database | One Postgres 18 with PostGIS, one database and role per app | D51, D56, D29 |
| Files | Declared volumes; apps use the storage module (S3-ready) | D72 |
| Secrets | SOPS + age in the instance repo; derived secrets; an app's own secrets | D14, D35, D57, D97 |
| Backups | restic to B2 EU Central nightly; the server's key cannot delete; weekly restore test; one app or Pocket ID back to a copy | D73, D74, D75, D101, D110 |
| Identity | Pocket ID, passkeys only, no email code, a sign-in lasts 30 days; mail through the OVH mailbox | D37, D52, D70, D102 |
| Auth modes | `oidc`, `public`, `local` (Better Auth) built; `forward` (Tinyauth) not | D10, D79, D97 |
| Reconciler | Polls Git every minute; bases, databases, OIDC clients, Caddy, containers; self-update by digest, on trial | D2, D50–D61, D109 |
| Deployment | App CI builds, `propose.yml` opens a PR, merged by itself if the layers did not change | D5, D64, D86, D92 |
| Apps | Nuxt template with shared layers by commit, installable on a phone, theme choice; Renovate for the layers only | D79, D80, D81, D103 |
| Base updates | Renovate once a month: monorepo base images, then the instance's reconciler (`v1.0.<n>`); rollback on a broken Caddy or Postgres; alert after 45 days | D109 |
| App MCPs | `mcp: true` opens `/mcp`, signed in through Pocket ID | D85 |
| Alerts | Pushover from the server, healthchecks.io as dead man's switch, normal priority | D45, D76, D82 |
| Status page | `status.apps.example.org`, through the reconciler's internal API | D8, D96 |
| CLI | `bivy init`, `configure`, `rebuild [--test]`, `restore [app\|pocket-id]`, `status`, `backup`, `secret set`, `login-link`, `ssh`, `exec`, `validate`, `pin` | D31, D91, D93, D99, D101, D104, D105, D106, D107, D108, D110 |
| Rebuild | `bivy rebuild --test` every 3 months, the only proof the platform comes back | D39, D91 |

## Conventions for Claude

- **Claude acts on the server through `bivy`** (D104). A session starts with `bivy status` and the open Renovate PRs of both repos (runbook section 21, D109); the backup D89 asks for before a change that can lose data is `bivy backup` (D105). Improvising over `bivy ssh`/`exec` is for reading; a change goes through a written command or Git. Each improvisation asks: worth a command? Easy without Claude's privileged access? If not, say so in the session and propose the command.
- **App contract** (any framework): an image that listens on `port`, answers on the health endpoint, reads the standard variables the platform provides, and applies additive migrations at startup (D19, D21).
- **User files** (D72): never `fs` directly, only the storage module. The database stores keys (`photos/123.jpg`), never paths or URLs. Files are served through an app route that checks access (`/api/files/...`).
- **App work happens on the Mac** with `npm run dev:local`: light, dark and phone width checked before pushing, never on the real server (D83). The miniature platform (`npm run platform:up`) is for the platform itself (D59).
- **App template**: Nuxt only (D23); a Next app follows the contract by hand. Its `.mcp.json` has the official Nuxt UI MCP (`https://ui.nuxt.com/mcp`); references at `https://ui.nuxt.com/llms.txt`.
- **New apps**: the `new-app` skill, shipped as a plugin (`/plugin marketplace add chamboug/bivouac`, `/plugin install bivouac@bivouac`, then `/bivouac:new-app`) (D98). When the first app of a repo starts using Renovate, install it with "Only select repositories" on that repo only, except in the owner's organization (D81, D92).
- **`gh` on the owner's Mac is for Claude's own work** (D78): reading CI and logs on the monorepo and the instance repo (`gh run list`, `gh run watch`, `gh run view --log-failed`), opening and commenting on PRs. It cannot push, merge, rerun or set secrets; pushes go through Git over SSH. If `gh` answers 401, the token has expired: ask the owner for a new one. `bivy` never depends on it (D31).
- **Security reviews** (rule 6) use a fresh agent and a checklist; findings are checked again on the code or the server before being presented; the owner chooses what to fix and what to accept knowingly, with the risk stated.
- **Never run against the real server without the owner's decision**: `bivy rebuild` (only `--plan`), `bivy restore` (only `--plan`), `bivy init` on real infrastructure (proven once on a throwaway project, D99).
- **Pitfalls already met**: macOS has no `timeout` command; a YAML 1.2 parser reads `mode: 0600` as decimal, so the Butane file is never re-serialized (D48); in Caddy's image `localhost` is `::1` (D55); Pocket ID's `PUT` on a client replaces it whole (D52); changing a healthchecks.io schedule so a check is already overdue marks it down without notifying (D82); a deploy key added with a PAT disappears with that PAT (D91); `npm run build` while `dev:local` runs breaks the dev server (D83).

## Where things stand (22 November 2026)

- **Built and running**: layers 1 to 5 of D44 (foundations, base on the VPS, safety net, first real apps, rebuilding without memory), plus the status page (D96), `local` apps (D97), app MCPs (D85), `bivy init`/`configure` (D99), `bivy restore` (D101), and the commands D104 asked for: `bivy status`, `bivy backup` (D105, used for real on 21 Nov. 2026), `bivy pin` (D106), `bivy login-link` (D107), `bivy secret set` (D108), `bivy restore pocket-id` (D110, tried on the miniature platform only), and a Pocket ID sign-in lasting 30 days (D102, since 21 Nov. 2026). Apps hold data the owner keeps since 11 Nov. 2026. Interim phase (D89, D95).
- **Proven**: `bivy init` on a throwaway project (22 Nov. 2026, D99); `bivy rebuild --test` (14 and 19 Nov. 2026, D91); `restore-app` rehearsed on the server (D90); every alert received on the owner's phone (D82).

## Open items

Three groups, sorted with the owner on 21 Nov. 2026. Only the first is work to plan (empty since 23 Nov. 2026); the second waits for its trigger and costs nothing until then.

### To do

Nothing at the moment.

### When a need comes

Nothing to do until the trigger in bold.

- **Before Tinyauth (`forward`)**: apps reach each other without Caddy; isolate them first (D94), then build `forward` (D10).
- **Before the first app with a Postgres extension**: extensions must not be recreated as superuser in the app's own schema (D94).
- **Before any app sends mail**: choose a send-only relay (D70); this is also the last prod condition.
- **Before removing an app**: its database and volumes leave the nightly copies at once (the backup lists current manifests only), and older copies age out of retention in about six months; until archiving exists (D18), take a final copy by hand, with the owner's consent.
- **When a failed deployment is a real nuisance**: automatic rollback to the previous image (D21); today the app is stopped, with an alert.
- **When the owner wants the domain's home page back**: static sites (D22).
- **When a new machine needs SSH access**: `bivy machine add` (D38); meanwhile runbook section 20.
- **When someone else installs Bivouac, or for the guide**: backups, alerts and mail set up for real, during `bivy init` and through `bivy configure` (`bivy init` itself was proven on 22 Nov. 2026, D99), in one throwaway run with every answer given by flag; a prompt is ready in the instance repo. The friction points a newcomer hits are in its operations log of 22 Nov. 2026, for the guide (D111).
- **On the owner's wish**: resource history (D42), Web Push module (D84), an overview with diagrams (D93), the status page in another language.
- **When the owner opens the session for it**: a user guide for `bivy`, in a session of its own: Starlight on GitHub Pages, with an `llms.txt` (D111). Tone chosen on 23 Nov. 2026 (D111): a plain, concise reference in English, with steps and expected output only where needed, no internal names unless on screen, very little humour. Install: `npm install -g @bivouacjs/cli`, with `@bivouacjs/core` (today's `packages/manifest`), not published yet; the npm organization is created at the first publication (D111). To settle then: the reader (someone installing Bivouac from scratch, the owner's first choice on 22 Nov. 2026), and the friction points noted during the real `bivy init` trial (operations log, 22 Nov. 2026).

### Appointments and the owner's decisions

- **First automatic base update** (D109): 1 December 2026 on the monorepo, then the instance; check both went through and the server moved.
- **Next `bivy rebuild --test`**: February 2027, with the app check of runbook section 13; warn the users of apps with their own scheduled jobs (a duplicate push summary, D91).
- **To observe**: zram swap after the next reboot (D94); mail deliverability with a real invitation (D70); `update-ssh-keys` with `sk-*` keys; HTTP/3 from outside; whether a connector added on claude.ai shows in the phone app (D85).
- **Never run yet, the owner's decision each**: the real `bivy rebuild` (D91); `bivy restore` on a real app (D101); `bivy login-link` and `bivy secret set` on the real platform, when needed (D107, D108); announcing the prod phase (D95).
- **Unknown**: what Pocket ID does if its `ENCRYPTION_KEY` is lost (undocumented; the key is in SOPS).
- **Accepted risks to revisit**: the deployment token's holders are root (D64, D92), if more people get write access; no email login code (D37), when an app opens to the general public or the community outgrows help by hand; GitHub Free cannot block a red PR (D95).

## Before the prod phase

Every condition is met or accepted by the owner (D95), except one: choose a send-only mail relay before any app sends mail through the platform (D70). The prod phase starts only when the owner announces it.

## Rejected components and options

Each has its entry in the log.

- **Supabase** (one heavy instance per project); **Coolify / Dokploy** (UI-centered, exposed admin panel); **CapRover** (not as code, no backups); **Kamal** (no shared database or OIDC); **Komodo / doco-cd** (D28).
- **Ansible** (pointless with Ignition); **a custom Flatcar image** (breaks official updates); **Proxmox** (single-purpose host).
- **Traefik / caddy-docker-proxy** (label discovery not needed, and they need the Docker socket).
- **WAL archiving** (one backup a night is enough); **paid S3** and **an S3 server** (D72); **a local mail server** (ports blocked, poor deliverability).
- **Tailscale Funnel**, **Pangolin** (off topic on a VPS).
- **A webhook for the reconciler** (D2); **secrets in user-data** (D7); **the age key in GitHub** (D35, D36); **IPv6 only** (D26); **Arm** (D25).
- **Renovate for app versions** (D5); **a platform MCP** (D32, D104); **`gh`, `hcloud` or `sops` in the CLI** (D31).
- **Prometheus + Grafana** (D42); **a permanent dev or staging instance** (D43).
