<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/bivouac-logo-night.svg">
  <img src="docs/brand/bivouac-logo.svg" alt="Bivouac" height="48">
</picture>

A self-hosting platform for small apps, run as code: one server, Git as the
source of truth, nightly off-site backups and one-command rebuilds. Its
maintenance is meant to be rare, guided and never silent.

The design, and the reason behind each choice, are in [`CLAUDE.md`](CLAUDE.md)
and the [decision log](docs/decisions.md). Installing a server by hand is
described in the [runbook](docs/runbook.md). The logo, colours and type are
in [`docs/brand`](docs/brand/README.md).

## Layout

- `packages/manifest`: schema of app and site manifests, and validation of an
  instance repo (shared by the CLI and the reconciler).
- `packages/bivy`: the `bivy` CLI. For now: `bivy validate` and `bivy ignition`.
- `packages/reconciler`: the reconciler that runs on the server. For now: it
  follows the instance repo and writes the Caddyfile. Published as
  `ghcr.io/chamboug/bivouac-reconciler:sha-<commit>`.
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
