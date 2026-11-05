# Bivouac

A self-hosting platform for small apps, run as code: one server, Git as the
source of truth, nightly off-site backups and one-command rebuilds. Its
maintenance is meant to be rare, guided and never silent.

The design, and the reason behind each choice, are in [`CLAUDE.md`](CLAUDE.md)
and the [decision log](docs/decisions.md).

## Layout

- `packages/manifest`: schema of app and site manifests, and validation of an
  instance repo (shared by the CLI and the reconciler).
- `packages/bivy`: the `bivy` CLI. For now: `bivy validate` and `bivy ignition`.
- `template/`: the instance repo template.

## Development

Requires Node 26 (LTS) and Docker (Butane runs in a container).

```bash
npm ci
npm run typecheck
npm test
```
