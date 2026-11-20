<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/bivouac-logo-night.svg">
  <img src="docs/brand/bivouac-logo.svg" alt="Bivouac" height="48">
</picture>

A self-hosting platform for small apps, run as code: one server, Git as the
source of truth, nightly off-site backups and one-command rebuilds. Its
maintenance is meant to be rare, guided and never silent.

How it works is in the [architecture](docs/architecture.md), the reason behind
each choice in the [decision log](docs/decisions.md), and the rules for working
on it in [`CLAUDE.md`](CLAUDE.md). Procedures on a real server are in the
[runbook](docs/runbook.md). The logo, colours and type are
in [`docs/brand`](docs/brand/README.md).

## Layout

- `packages/manifest`: schema of app and site manifests, and validation of an
  instance repo (shared by the CLI and the reconciler).
- `packages/bivy`: the `bivy` CLI: `init`, `configure`, `rebuild [--test]`,
  `restore`, `ssh`, `exec`, `validate`, `ignition`.
- `packages/reconciler`: the reconciler that runs on the server: it follows the
  instance repo, runs the base services and the apps, the nightly backups and
  the restore test. Published as `ghcr.io/chamboug/bivouac-reconciler:sha-<commit>`.
- `status-page/`: the platform's status page.
- `template/`: the instance repo template.
- `app-template/` and `app-layers/`: the app template and the shared sign-in
  and database code every app extends.
- `plugin/`: a Claude Code plugin with the `new-app` skill, which guides anyone
  from an idea to an app running on a Bivouac server.

## Creating an app with Claude Code

Install the plugin once, in a Claude Code session on your computer:

```
/plugin marketplace add chamboug/bivouac
/plugin install bivouac@bivouac
```

Then say "new app" (or run `/bivouac:new-app`). Updates: `/plugin marketplace
update bivouac`, or turn on automatic updates for it in `/plugin`, under
Marketplaces.

## Development

Requires Node 26 (LTS) and Docker (Butane runs in a container).

```bash
npm ci
npm run typecheck
npm test
```
