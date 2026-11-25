---
title: bivy pin
description: Move the server's reconciler or status page to the version published for one commit of Bivouac.
---

`bivy pin` changes the version of the reconciler, or of the status page, that your server runs: it writes the exact version published for one commit of Bivouac into `platform.yml`, checks the result, and leaves the commit to you.

## Usage

```sh
bivy pin reconciler <commit> [--instance <dir>]
bivy pin status <commit> [--instance <dir>]
```

Run it on your computer, from the folder of your instance repository, or pass that folder with `--instance`. It needs an internet connection and Docker running (for the checks of `bivy validate`). It does not connect to your server.

| Argument or option | What it does |
|---|---|
| `reconciler` or `status` | Which one to move: the reconciler, or the status page. |
| `<commit>` | A commit of the `main` branch of the Bivouac repository (the one `bivy` comes from), whose checks are green. Its hash, at least 7 characters, as `git log` or GitHub shows it. |
| `--instance <dir>` | Your instance repository, if you are not in its folder. |

## When to use it

Rarely. If Renovate is installed on your instance repository, it moves the reconciler and the status page to the newest version once a month on its own, and you never need `bivy pin`.

Use it when you cannot wait for that monthly update:

- a fix you need has just been published, for example a security fix;
- the server warns that the reconciler has not been updated for weeks, because a version written by hand stopped Renovate (see `! … has no release tag` below);
- you have just added a `status` block to `platform.yml`, to turn on the status page, and want it on the latest version.

## What it does

1. It finds the version published for the commit, and the exact fingerprint (digest) of that version, so that the server runs those exact files and nothing else.
2. It replaces one line of `platform.yml`, the `image:` line of the `reconciler` or `status` block. The rest of the file, comments included, is left as it is.
3. It runs the checks of `bivy validate`. If they fail, `platform.yml` is put back as it was.
4. It prints the old and the new value.

It does not commit or push. The server moves within a minute once you commit and push the change to your instance repository.

## Example

```text frame="terminal"
$ bivy pin reconciler 839b39b
✓ Instance is valid: 2 app(s), 0 site(s), 1 SSH key(s).

✓ reconciler.image in platform.yml:
  was  ghcr.io/example/bivouac-reconciler:v1.0.124@sha256:a23a4dea0123ccd5a7d41e2ce1684b376894e6c6c06f8b4005f81477048af358
  now  ghcr.io/example/bivouac-reconciler:v1.0.140@sha256:35ff1edf4de10de71730ee923e5279ded11ea0fc41629cde30b706966f129c57

Nothing is committed or pushed: the server moves once this change is on main.
The way back: write the "was" value back in reconciler.image, then commit and push.
```

Then commit and push `platform.yml`:

```sh
git commit platform.yml -m "Reconciler: version of 839b39b"
git push
```

If the version is already the one in `platform.yml`, `bivy pin` says `nothing to change` and changes nothing.

The command exits with `0` when `platform.yml` holds the version asked for, and `1` otherwise.

## If something goes wrong

To go back to the previous version, write the `was` value back in place of the new one, then commit and push.

| The message says | What it means, and what to do |
|---|---|
| <samp>'…' is not a commit: give its hash (at least 7 characters), as in git log.</samp> | Give the commit's hash, not a branch name or a version number. |
| <samp>No sha-… for ghcr.io/…: CI has not published that commit (yet), or it is not a commit of main.</samp> | Versions are published a few minutes after a commit reaches `main`, once its checks pass. Wait for the green check on GitHub, or pick a commit of `main`. |
| <samp>! sha-… has no release tag (v&lt;x.y.z&gt;, published from D109 on): Renovate cannot follow</samp> | A warning, not an error: the change is written. The commit is older than the monthly updates, so Renovate cannot update from it, and the monthly update stops until you pin a newer commit. |
| <samp>With the new version the instance is not valid (above): platform.yml is back as it was.</samp> | The checks of `bivy validate` failed with the new line; their message is just above. Nothing was changed. If the problem is not in the new line, fix it first, then run `bivy pin` again. |
| <samp>platform.yml has no status block: …</samp> | The status page is not turned on in this instance: there is nothing to move. |
| <samp>GHCR could not be reached (…): nothing was changed.</samp> | GHCR is GitHub's registry, where the versions are published. Check your internet connection and try again. |
| <samp>No platform.yml in …: run bivy from the instance repo, or pass --instance &lt;dir&gt;.</samp> | You are not in your instance repository. Change to its folder, or pass it: `bivy pin reconciler <commit> --instance <dir>`. |

## See also

- [`bivy validate`](../validate/): the checks `bivy pin` runs.
- `bivy status`: which version of the reconciler the server runs.
- [Glossary](../../reference/glossary/): *reconciler*.
