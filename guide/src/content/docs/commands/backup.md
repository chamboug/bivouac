---
title: bivy backup
description: Back up the platform now instead of waiting for the night, and follow the backup to its end.
---

`bivy backup` makes the same backup the server makes every night, right away, and shows it step by step until it ends.

## Usage

```sh
bivy backup [dir] [--restore-test] [--ssh-key <file>]
```

Run it on your computer, from the folder of your instance repository, or pass that folder as `dir`.

| Option | What it does |
|---|---|
| `--restore-test` | After the backup, also run the restore test (see below). |
| `--ssh-key <file>` | The SSH key used to reach the server. Without it, `bivy` uses the key you chose before, or the only key in `~/.ssh`. If there are several, it asks you to pick one, once, and remembers it. |

## When to use it

Before any change that could lose data, so the latest copy is minutes old rather than hours:

- deploying an app version that changes how it stores its data;
- removing an app: once its manifest is gone, its database and volumes are no longer part of the backups;
- any work on the server's databases or volumes.

You do not need it otherwise: the server backs up every night at 02:00 UTC on its own.

## What it does

The backup copies, to your backup storage:

- the database of each app, and the database of Pocket ID (the sign-in service);
- every volume an app declares in its manifest.

Apps keep running during the backup, except an app whose manifest says `backup: { stop: true }`: it is stopped while its files are copied, as it is every night.

The server starts the backup at the reconciler's next pass, within a minute. On a small platform the whole run takes about a minute. If a backup is already waiting or running, `bivy backup` follows that one instead of starting a second.

With `--restore-test`, the server then checks the backup storage and loads the latest copy of every database into a temporary database, to prove the copy can be read back. It does this on its own once a week.

## Example

```text frame="terminal"
$ bivy backup
· Backup asked for: it starts at the reconciler's next pass, within a minute
· Backing up the databases and volumes to the backup repository
· Backup done
```

With `--restore-test`, the first line ends with `, with a restore test` and the last one reads `Backup done, and the restore test passed`.

The command exits with `0` when the backup is done, and `1` otherwise.

## If something goes wrong

Pressing Ctrl-C, or losing the connection, stops only the display. The backup carries on on the server: run `bivy status` to see how it ended.

A failed backup counts as a failed nightly one: `bivy status` lists it and, if alerts are set up, the server sends you one a few minutes later. The next backup that works clears it.

| The message starts with | What it means, and what to do |
|---|---|
| <samp>Still waiting</samp> | The backup has not started after three minutes; the reason follows. The server runs one backup or restore at a time, so it starts when the other one ends. `bivy backup` keeps following it. |
| <samp>The backup failed: backups are not configured</samp> | Backup storage was skipped during `bivy init`. Set it up with `bivy configure backups`. |
| <samp>The backup failed: it was interrupted by a restart</samp> | The reconciler restarted during the backup, for example after an update. Nothing is retried on its own: run `bivy backup` again. |
| <samp>The restore test failed</samp> | The backup worked, but the latest copy could not be read back; the reason follows. Make no change that could lose data until a restore test passes. |
| <samp>No SSH key at</samp> | `bivy` found no key to use. Pass yours with `--ssh-key <file>`; the message lists the keys it found in `~/.ssh`, if any. |
| <samp>No valid platform.yml in</samp> | You are not in your instance repository. Change to its folder, or pass it: `bivy backup <dir>`. |
| <samp>The server's reconciler is older than this command</samp> | The server runs a version from before `bivy backup` existed. Update the platform first. |

## See also

- `bivy status`: the date of the last good backup, and anything that needs a look.
- `bivy restore`: bring an app back to a backup copy.
- [Glossary](../../reference/glossary/): *reconciler*, *pass*.
