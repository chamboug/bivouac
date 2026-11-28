---
title: bivy configure
description: Add backups, alerts or mail to a platform that was set up without them.
---

`bivy configure` adds one part that was left for later during `bivy init`: backups, alerts or mail. It checks your answers against the real service, then commits and pushes the change to your instance repository.

## Usage

```sh
bivy configure backups|alerts|mail [dir] [options]
```

Run it on your computer, in a terminal, from the folder of your instance repository, or pass that folder as `dir`. It needs Docker running, and your age key, the key that decrypts your secrets, at `~/.config/sops/age/keys.txt`. On the computer where you ran `bivy init`, it is already there: `bivy init` put it there. On another computer, copy it there from your password manager.

Each question can also be answered with an option, the same ones `bivy init` takes:

| Option | What it answers |
|---|---|
| `--backup-provider b2\|s3` | Where backups go: Backblaze B2, or another S3-compatible storage. |
| `--backup-region <region>` | The storage's region, like `eu-central-003` for B2. |
| `--backup-endpoint <host>` | With `s3` only: the storage's HTTPS address, host name only. |
| `--backup-bucket <name>` | The bucket's name. |
| `--smtp-host <host>` | The mail server, like `smtp.example.org`. |
| `--smtp-user <login>` | The mail account's login. |
| `--smtp-from <address>` | The address mail is sent from. |

There is no option for passwords and keys: `bivy` asks for them hidden as you type, or reads them from `~/.config/bivouac/` (see below).

## When to use it

When you answered `later` to backups, alerts or mail during `bivy init`, and want that part now. Other commands send you here: `bivy backup` says <samp>backups are not configured</samp> until it is done.

- **Backups**: set them up before you keep any data you care about on the platform.
- **Alerts**: without them, nobody is told when a backup fails or the server goes silent.
- **Mail**: Pocket ID, the sign-in service, needs it to send invitations and notices.

`bivy configure` only adds a part. A part already set up is never changed by it: moving the backups or changing the mail server is done by hand. To change only a password or key a part uses, use [`bivy secret set`](../secret-set/).

## What it does

1. Checks your instance repository: it must be valid, exactly what is on GitHub, with no uncommitted change, and the part must not be set up yet.
2. Asks its questions, then checks the answers against the real service, as described below. Nothing is written yet.
3. Decrypts your secrets, in a Docker container. A wrong age key, or Docker not running, stops here.
4. For backups only, shows the backup password once, and waits until you type `stored` (see below).
5. Adds the part to `platform.yml` and to `secrets/platform.sops.yaml`, encrypted, then validates the repository. If it does not validate, both files are put back.
6. Commits the change as `bivy configure <part>` and pushes it to `main`. The server applies it within a minute.
7. Deletes the files in `~/.config/bivouac/` that held the keys and passwords of that part: they are now in your encrypted secrets.

### Backups

Any S3-compatible storage works. Before you start, make at the provider:

- a private, empty bucket;
- a key limited to that bucket, that can list, read and write. A key that cannot delete is safer, if the provider allows it.

`bivy` shows where to make them for Backblaze B2. It checks that the key can list the bucket and that the bucket is empty: a new platform starts its backups in a bucket of its own. It never writes or deletes anything there.

`bivy` then makes the backup password, which encrypts every backup. Keep it in your password manager: without it, the backups cannot be read. It is shown once only, so `bivy configure backups` always needs a terminal.

Backups run every night at 02:00 UTC. To make the first one now, and prove it works, run [`bivy backup`](../backup/).

### Alerts

Alerts reach your phone through Pushover. healthchecks.io notices when the server stops reporting, and alerts you through Pushover too. Before you start:

1. In Pushover (pushover.net): note your user key, then create an application and note its API token.
2. In healthchecks.io: create a project; in Integrations, add Pushover; in Settings, API Keys, create a read-write key.

`bivy` checks the Pushover token and user key with Pushover. The user key must have at least one device with the Pushover app. In a terminal, `bivy configure` then offers to send a test alert to your phone, and asks whether it arrived. (`bivy init` does not: the server sends one once it runs.) You can skip it. If it did not arrive, `bivy` stops: check that the Pushover app on your phone is signed in with that user key and allowed to notify, then run it again.

`bivy` creates three checks in that project, named after your platform's domain: `apps.example.org heartbeat`, `apps.example.org backup` and `apps.example.org restore`. Each one sends to every integration of the project. Run again, it finds the same checks by name instead of making new ones.

If the project has no Pushover integration, `bivy` warns that the alerts go to the other integrations only.

### Mail

Pocket ID sends mail through an SMTP account of yours, on port 587 with STARTTLS. `bivy` takes no other port: the server's provider blocks ports 25 and 465. `bivy` logs in to the account to check the login and password, over an encrypted connection, and sends no mail. If the login is an email address, it is offered as the address mail is sent from.

### Keys and passwords

Each key or password is asked for hidden as you type, then kept in its own file in `~/.config/bivouac/`, readable by you only. If a run fails, the files stay, so the next run does not ask again; delete a file to type its value again. Once the part is pushed, they are deleted.

| Part | Files |
|---|---|
| Backups | `backup-key-id`, `backup-secret-key` |
| Alerts | `pushover-token`, `pushover-user`, `healthchecks-api-key` |
| Mail | `smtp-password` |

To run `bivy configure alerts` or `mail` without a terminal, for example from a script or an AI assistant, write these files first (mode 600, the value on one line), and pass the other answers as options.

## Example

Adding backups to Backblaze B2, in a terminal:

```text frame="terminal"
$ bivy configure backups
│
◇  Where do the nightly backups go? Any S3-compatible storage works.
│  Backblaze B2
In Backblaze (the region is chosen at sign-up, for the whole account, and cannot be changed):
  1. Buckets → Create a Bucket: private, a unique name; Lifecycle Settings → keep prior versions 30 days.
  2. Application Keys → Add a New Application Key: only this bucket, Read and Write.
     (A key that cannot delete is safer: runbook section 12 makes one with B2's own API.)
  3. Note the bucket's Endpoint (s3.<region>.backblazeb2.com), the keyID and the applicationKey.
│
◇  The bucket's region, as in its endpoint (like eu-central-003):
│  eu-central-003
│
◇  The bucket's name (empty, private):
│  my-platform-backups
│
◇  The storage's access key ID (hidden as you type, or paste it):
│  ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪
Kept in /Users/you/.config/bivouac/backup-key-id (readable by you only). Delete that file to type it again.
│
◇  The storage's secret key (hidden as you type, or paste it):
│  ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪
Kept in /Users/you/.config/bivouac/backup-secret-key (readable by you only). Delete that file to type it again.
  ✓ the key can list my-platform-backups, which is empty

Keep these in your password manager NOW. bivy shows them this once; without them, a lost machine means a lost platform.

  The restic password (without it, the backups cannot be read):
    -dzKIPYJbWM0609HoyIUs-FgGSMDnp1JyafG0OImWBU

│
◇  Type 'stored' once they are in your password manager:
│  stored
  Also keep your GitHub account's recovery codes there (D38). You may clear this terminal's scrollback now.
✓ Pushed: backups to s3:https://s3.eu-central-003.backblazeb2.com/my-platform-backups, every night at 02:00 UTC. The reconciler applies it within a minute.
```

The other parts end the same way: <samp>✓ Pushed: alerts through Pushover, and healthchecks.io's three checks</samp>, or <samp>✓ Pushed: Pocket ID's mail through …</samp>. They show nothing once.

The command exits with `0` when the part is pushed, and `1` otherwise.

## If something goes wrong

Every error before the push leaves your instance repository as it was. The keys and passwords already typed stay in `~/.config/bivouac/`, so the next run does not ask for them again.

A new backup password is made on each run of `bivy configure backups`. If a run fails after showing one, keep only the one from the run that ends with <samp>✓ Pushed</samp>.

Without a terminal, a missing answer stops `bivy` with the question, and the option that answers it.

| The message starts with | What it means, and what to do |
|---|---|
| <samp>Which part? bivy configure …</samp> | The part is missing or misspelled. |
| <samp>… is already set up. bivy only adds a part; changing one is done by hand</samp> | That part exists already. To change only a key or a password, use `bivy secret set`. |
| <samp>The instance repo is invalid: run 'bivy validate …' first</samp> | Your instance repository has a problem. `bivy validate` lists it. |
| <samp>The instance checkout cannot be pushed as is: …</samp> | Your instance repository has uncommitted changes, or is not exactly what is on GitHub. Commit or undo those changes, or pull, then run it again. |
| <samp>The storage refused: …</samp> | The storage did not accept the key: the reason follows (unknown key, wrong secret, no such bucket, wrong region, a key that may not list the bucket). Fix it at the provider, or delete the two key files to type them again. |
| <samp>The bucket … is not empty</samp> | The bucket already holds files, maybe an old platform's backups. Use a new, empty bucket. |
| <samp>Could not reach …</samp> | The storage's address is wrong, your computer is offline, or Pushover or healthchecks.io is down. What could not be reached follows. |
| <samp>Pushover refused: …</samp> | Pushover did not accept the token or the user key: its reason follows. Fix it, or delete `~/.config/bivouac/pushover-token` and `~/.config/bivouac/pushover-user` to type them again. |
| <samp>The test alert did not arrive</samp> | You answered that the test alert did not reach your phone. Check the Pushover app on your phone, then run it again. |
| <samp>The healthchecks.io project has no integration</samp> | Add Pushover to the project in healthchecks.io (Integrations), then run it again. Without one, a silent server would alert nobody. |
| <samp>healthchecks.io … the API key is wrong or read-only</samp> | Create a read-write key in the project's settings, delete `~/.config/bivouac/healthchecks-api-key`, then run it again. |
| <samp>…:587 refused: …</samp> | The mail server refused the connection, the encryption or the login: the reason follows. Fix it, or delete `~/.config/bivouac/smtp-password` to type the password again. |
| <samp>… is missing (…), and nobody is at a terminal to type it</samp> | `bivy` was not started from a terminal, and a key file is missing. Run it in a terminal, or write the file first. |
| <samp>bivy is about to show secrets to keep in your password manager: run the same command in a terminal</samp> | `bivy configure backups` shows the backup password once, which needs a person at a terminal. |
| <samp>No age key at …</samp> | Your age key is not at `~/.config/sops/age/keys.txt`. Put it there from your password manager, then run it again. |
| <samp>The age key file holds no key for the recipients of .sops.yaml</samp> | The key file does not hold the key this instance repository is encrypted for. |
| <samp>Could not run Docker (is it installed and started?)</samp> | Start Docker, then run it again. |
| <samp>sops could not decrypt: …</samp> | The secrets file could not be decrypted: the reason follows. If Docker is not running, start it. |
| <samp>The result does not validate, nothing was committed</samp> | The part's answers make the repository invalid; both files were put back. The message says what failed. |
| <samp>git … failed: … The change is in …: push it by hand.</samp> | The commit or the push failed, for example without access to GitHub. The change is in your instance repository: commit and push it yourself. Do not run `bivy configure` again: the part now looks set up. |
| <samp>Cancelled: nothing more was done</samp> | You pressed Ctrl-C or Escape during a question. |

## See also

- [`bivy backup`](../backup/): make the first backup now, once backups are set up.
- [`bivy secret set`](../secret-set/): change one key or password of a part already set up.
- [`bivy validate`](../validate/): check your instance repository.
- [Glossary](../../reference/glossary/): *reconciler*.
