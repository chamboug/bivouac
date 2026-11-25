---
title: bivy validate
description: "Check your instance repository before you push it: manifests, SSH keys, secrets, the server's start configuration and the web routes."
---

`bivy validate` checks your instance repository and lists every problem it finds, so that a mistake is caught on your computer rather than on the server.

## Usage

```sh
bivy validate [dir]
```

Run it on your computer, from the folder of your instance repository, or pass that folder as `dir`. It needs Docker running: two of the checks run in containers, downloaded the first time. It does not connect to your server and never decrypts your secrets.

## When to use it

Before you commit and push a change to your instance repository: a new app, a new SSH key, a secret.

Your instance repository runs the same checks on GitHub for every pull request and every push to `main` (the *Validate* check), so a mistake is caught there too, but only after the push.

## What it does

It reads the repository and checks:

- `platform.yml`, `ssh-keys.yml` and each app's manifest in `apps/`: required fields, allowed values, a file name that matches the app's `name`, no address used twice;
- the secrets: every file in `secrets/` is encrypted, with no value left in plain text, for exactly the keys listed in `.sops.yaml`; an app's own secrets belong to an app that exists;
- that no private key appears anywhere in the repository;
- the server's start configuration (`butane/server.bu`), built with your SSH keys, as it would be for a new server;
- once everything else passes, the web routes the server would serve, checked by Caddy, the web server the platform uses.

It changes nothing.

## Example

```text frame="terminal"
$ bivy validate
✓ Instance is valid: 2 app(s), 0 site(s), 1 SSH key(s).
```

When something is wrong, it lists every problem, one per line, each starting with the file it is in:

```text frame="terminal"
$ bivy validate
✗ 1 problem found:

  ssh-keys.yml: 'keys' must list at least one key, otherwise nobody can log in to the server
```

The command exits with `0` when the repository is valid, and `1` otherwise.

## If something goes wrong

Most messages say what to change. These are the ones that need more.

| The message says | What it means, and what to do |
|---|---|
| <samp>No platform.yml in …: run bivy from the instance repo, or pass it (bivy validate &lt;dir&gt;).</samp> | You are not in your instance repository, or the folder does not exist. Change to its folder, or pass it: `bivy validate <dir>`. |
| <samp>butane/server.bu: butane/server.bu is missing</samp> | The server's start configuration is not in the repository. Put it back from the repository's history. |
| <samp>butane/server.bu: could not run Docker (is it installed and started?): …</samp> | Start Docker, then run `bivy validate` again. |
| <samp>…: is not encrypted with SOPS (no 'sops' section): encrypt it before committing</samp> | A file in `secrets/` was saved without encryption. Do not commit it: encrypt it with `sops` first. |
| <samp>…: has a value in plain text at '…'</samp> | A value was added to an encrypted file without going through `sops`. Do not commit it. Values are added with `sops edit <file>`, which encrypts them on save. |
| <samp>…: is not encrypted for exactly the age keys listed in .sops.yaml: re-encrypt it (sops updatekeys)</samp> | The list of keys in `.sops.yaml` changed after the file was encrypted. Run `sops updatekeys <file>`. |
| <samp>…: contains a PRIVATE key: remove it from the repo and treat it as leaked</samp> | A private key (an SSH or age key, for example) was found in that file. Remove it. If it was ever committed, it stays in the repository's history: replace that key with a new one. |
| <samp>platform.yml: reconciler.image must be pinned by digest (…)</samp> | The reconciler's version in `platform.yml` was written by hand without its digest. Write it with [`bivy pin`](../pin/). The same goes for `status.image`. |
| <samp>(generated Caddyfile): Caddy refused the generated Caddyfile: …</samp> | The web routes built from your manifests were refused; Caddy's reason follows. |

## See also

- [`bivy pin`](../pin/): change the reconciler's version, then run these checks.
- [Glossary](../../reference/glossary/): *reconciler*.
