---
title: bivy secret set
description: Change one value of the platform's encrypted secrets, such as a mailbox password or a backup storage key, without ever showing it.
---

`bivy secret set` changes one value of your platform's secrets file, `secrets/platform.sops.yaml`, and checks that every other value stayed the same.

## Usage

```sh
bivy secret set <path> [dir] [--from-file <file>] [--age-key <file>]
```

Run it on your computer, in a terminal, from the folder of your instance repository, or pass that folder as `dir`. `<path>` names the value to change, for example `mail.password`.

| Option | What it does |
|---|---|
| `--from-file <file>` | Read the new value from a file instead of asking for it (see below). |
| `--age-key <file>` | The file holding your age key, which decrypts the secrets. Without it, `bivy` uses `~/.config/sops/age/keys.txt`. |

The new value is never given on the command line: it would stay in your shell history.

## When to use it

When a password, key or token the platform uses has changed at its provider, or may be known to someone else. First make the new value where it lives (a new key in your backup storage account, a new mailbox password), then give it to the platform with `bivy secret set`.

`bivy secret set` only changes a value that is already set. To add a part you skipped during `bivy init`, such as backups or alerts, use `bivy configure`.

## The values it changes

| Path | What it is | Once pushed |
|---|---|---|
| `mail.password` | The password of the mailbox Pocket ID sends mail from. | Pocket ID restarts: signing in pauses for up to about a minute. Then send a test mail from Pocket ID's email settings. |
| `pocket_id.static_api_key` | The key the platform uses to talk to Pocket ID. At least 16 characters. | Pocket ID restarts: signing in pauses for up to about a minute. |
| `backup.b2_key_id` | The ID of the key to your backup storage. | Nothing restarts: the next backup uses it. |
| `backup.b2_application_key` | The secret part of that key. | Nothing restarts: the next backup uses it. |
| `alerts.pushover_token` | The token of your Pushover application. | Nothing restarts: the next alert uses it. |
| `alerts.pushover_user` | Your Pushover user key. | Nothing restarts: the next alert uses it. |
| `alerts.healthchecks.heartbeat` | The ping address of a healthchecks.io check. Starts with `https://`. | Nothing restarts: the next ping goes there. |
| `alerts.healthchecks.backup` | The same, for the backup check. | Nothing restarts: the next ping goes there. |
| `alerts.healthchecks.restore` | The same, for the restore test check. | Nothing restarts: the next ping goes there. |
| `ghcr.username` | The GitHub account the server uses to pull images from GitHub's container registry. | Nothing restarts: the next pull of a private image uses it. |
| `ghcr.token` | That account's token. | Nothing restarts: the next pull of a private image uses it. |

If the key to your backup storage changed, change `backup.b2_key_id` and `backup.b2_application_key` one after the other, push once, then run `bivy backup` to prove the new key works.

Three values are never changed by `bivy secret set`:

- `master_secret`: every password the platform makes for itself comes from it. Changing it is a larger operation of its own.
- `pocket_id.encryption_key`: Pocket ID's signing keys are encrypted with it, and a new one loses them.
- `backup.restic_password`: your backups are encrypted with it. The backup storage's own key must change first, or every backup fails.

## What it does

1. Checks your instance repository: it must be exactly what is on GitHub, with no other uncommitted change. `secrets/platform.sops.yaml` may already differ, so you can change two values in a row and push them together.
2. Decrypts the secrets file with your age key. A wrong key stops here, before you type anything.
3. Asks for the new value twice, hidden as you type or paste. A typo is caught before anything is written.
4. Encrypts the file again, decrypts what it wrote, and compares every value with the one before. If anything differs, it puts the previous file back.

No value is ever shown on screen. The decrypting and encrypting run in a Docker container, so Docker must be running.

Nothing is committed or pushed. Commit and push the change from your instance repository yourself; the server applies it within a minute. In the diff, every encrypted value looks changed, since the whole file is encrypted again. The names stay readable.

If the new value is the same as the old one, `bivy` says so and changes nothing.

## Example

```text frame="terminal"
$ bivy secret set mail.password
│
◇  The new value of mail.password (hidden as you type, or paste it):
│  ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪
│
◇  The same value again, to check it:
│  ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪
✓ mail.password changed in secrets/platform.sops.yaml; every other value checked unchanged.
  Nothing is committed: commit and push it from the instance repo.
  Once pushed: Pocket ID restarts with it: signing in pauses for up to about a minute (D68). Then send a test mail from Pocket ID's email settings (runbook section 10).
```

The last line depends on the value, as in the table above. The command exits with `0` when the value is changed or already held that value, and `1` otherwise.

## With `--from-file`

Use it when `bivy` cannot ask you, for example when it is started by a script or an AI assistant. The file must:

- be outside your instance repository, where it could be committed (`~/.config/bivouac/` is a good place);
- be readable by you only (mode 600);
- hold the value on one line.

To write it without the value showing on screen or staying in your shell history, run this in your own terminal and paste the value when asked:

```sh
(umask 077; printf 'Paste the value, then Enter: '; read -rs v; echo; if [ -n "$v" ]; then printf '%s' "$v" > ~/.config/bivouac/new-secret && echo "Written: ${#v} characters."; else echo "Nothing pasted: nothing written."; fi; unset v)
```

Then:

```sh
bivy secret set mail.password --from-file ~/.config/bivouac/new-secret
```

`bivy` deletes the file once the change is checked. If anything fails, the file is kept so you can run the same command again; delete it yourself if you give up.

Never paste a secret value into a chat, an issue, or any file other than this one.

## If something goes wrong

Every error below leaves the secrets file as it was.

| The message says | What it means, and what to do |
|---|---|
| <samp>… is never changed by bivy: …</samp> | The value is one of the three above. The message says why. |
| <samp>'…' is not a value bivy can change. It can change: …</samp> | The path is misspelled, or not in the table above. |
| <samp>… has no … yet</samp> | The value was never set, usually because that part was skipped during `bivy init`. Add it with `bivy configure`. |
| <samp>the new value is typed by a person at a terminal …</samp> | `bivy` was not started from a terminal, so it cannot ask you. Run it in a terminal, or use `--from-file`. |
| <samp>the instance checkout should not be changed now: …</samp> | Your instance repository has other uncommitted changes, or is not exactly what is on GitHub. Commit or undo those changes, or pull, then run it again. The encrypted file cannot be merged, so changing an old copy would undo someone else's change once pushed. |
| <samp>the two values differ: nothing was changed</samp> | The two values you typed are not the same. Run it again. |
| <samp>the new value of … cannot be used: …</samp> | The value is empty, holds a line break, starts or ends with a space, is longer than 4 KiB, or does not match what the table says (`https://`, at least 16 characters). The message says which. |
| <samp>no age key at …</samp> | Your age key is not at the default place. Pass it with `--age-key <file>`. |
| <samp>the age key file holds no key for the recipients of .sops.yaml …</samp> | The key file does not hold the key this instance repository is encrypted for. Pass the right one with `--age-key <file>`. |
| <samp>could not run Docker (is it installed and started?): …</samp> | Start Docker, then run it again. |
| <samp>… is inside the instance repo, where it could be committed: …</samp> | With `--from-file`: move the file outside your instance repository. |
| <samp>… can be read by others: it must be mode 600 …</samp> | With `--from-file`: run `chmod 600` on the file, or write it again with the command above. Other messages about the file say what is wrong with it. |
| <samp>The value is still in …: run this again once fixed, or delete it.</samp> | Shown after an error with `--from-file`: the value is still in that file. |
| <samp>… the previous file was put back, nothing was changed</samp> | The file `bivy` wrote did not decrypt to the expected values, so it put the old one back. |

## See also

- [`bivy backup`](../backup/): prove a new backup storage key works.
- [Glossary](../../reference/glossary/): *reconciler*, *pass*.
