---
title: bivy status
description: See how the platform is doing, and anything on it that needs a look.
---

`bivy status` shows the state of your server in one screen, then lists what needs a look. It only reads: it changes nothing.

## Usage

```sh
bivy status [dir] [--json] [--ssh-key <file>]
```

Run it on your computer, from the folder of your instance repository, or pass that folder as `dir`.

| Option | What it does |
|---|---|
| `--json` | Print the server's answer as it is, as JSON, without the summary or the list of things to look at. It then exits with `0` whenever the server answered. |
| `--ssh-key <file>` | The SSH key used to reach the server. Without it, `bivy` uses the key you chose before, or the only key in `~/.ssh`. If there are several, it asks you to pick one, once, and remembers it. |

## When to use it

- Whenever you want to know whether everything is fine, for example after an alert, or before and after a change.
- After `bivy backup` was stopped with Ctrl-C or lost its connection: it shows how the backup ended.

## What it does

`bivy` connects to your server over SSH, reads its current state, and prints:

- **Reconciler**: the version the server runs, since when, and its last pass: when it ran, how it ended, and the commit of your instance repository it read. A pass ends `applied` when it changed something, `unchanged` when there was nothing to do, `invalid` when your instance repository did not pass its checks, `failed` when something went wrong.
- **Host**: when the server last started, its free disk space, free memory and swap.
- **Backups**: the date of the last backup that worked, and when the weekly restore test last passed.
- **Containers**: each app and each part of the platform, with `✓` when it runs and is healthy, `✗` otherwise; its health, since when it runs, its memory use, and how many times it restarted. An app's memory is shown against its limit of 1 GB.

Times are in your computer's time zone.

Then it checks this state and lists each problem in one sentence, or says there is nothing to look at. The command exits with `0` when there is nothing to look at, and `1` otherwise.

## Example

```text frame="terminal"
$ bivy status
Reconciler  v1.0.14, up since Mon 16 Nov, 10:12
            last pass Mon 23 Nov, 09:13: unchanged at 4f2c9e1
Host        booted Mon 16 Nov, 10:11 · disk 29.8 GB free of 37.5 GB · memory 2.2 GB free of 3.7 GB · swap 2.0 GB
Backups     last good Mon 23 Nov, 02:01 · restore test passed this week
Containers
  ✓ bivouac-app-recipes  healthy · since Mon 16 Nov, 10:13 · 182 MB of 1.0 GB
  ✓ bivouac-caddy        healthy · since Mon 16 Nov, 10:13 · 41 MB of 3.7 GB
  ✓ bivouac-pocket-id    healthy · since Mon 16 Nov, 10:13 · 48 MB of 3.7 GB
  ✓ bivouac-postgres     healthy · since Mon 16 Nov, 10:13 · 310 MB of 3.7 GB
  ✓ bivouac-reconciler   running · since Mon 16 Nov, 10:12 · 95 MB of 3.7 GB

✓ Nothing to look at.
```

When something needs a look, the last line becomes a list instead, for example:

```text frame="terminal"
✗ 2 things to look at:
  · The last backup failed: …
  · bivouac-app-recipes restarted 2 times, the last at Mon 23 Nov, 08:40.
```

## If something goes wrong

### Things to look at

When the platform needs a look, each line of the list starts as below. Only the beginning is shown here: the rest names the container, the date or the reason.

| The line starts with | What it means, and what to do |
|---|---|
| <samp>The reconciler has recorded no pass yet</samp> | No pass has finished yet, for example just after the server was set up. Run `bivy status` again in a minute. |
| <samp>No pass since</samp> | No pass for more than five minutes: changes you push are not applied. |
| <samp>The last pass found the instance repo invalid</samp> | Your latest commit did not pass its checks. Run `bivy validate`, fix what it says, and push. |
| <samp>The last pass failed</samp> | Something went wrong for the whole platform; the reason follows on the next line. |
| An app's name | That app could not be deployed, for the reason given. |
| <samp>The disk is</samp> | More than 80% of the server's disk is used. |
| <samp>No swap</samp> | The server runs without swap, the spare memory it falls back on. |
| <samp>No good backup since</samp> | No backup has worked for more than 26 hours. Run `bivy backup`. |
| <samp>No backup on record</samp> | No backup has run on this server yet. Run `bivy backup`. |
| <samp>The last backup failed</samp> | Run `bivy backup` once the reason is fixed. |
| <samp>The last restore test failed</samp> or <samp>The weekly restore test has not passed</samp> | The latest copy could not be read back. Make no change that could lose data until `bivy backup --restore-test` passes. |
| <samp>Cleaning up old backups failed</samp> | Old copies could not be removed, for the reason given. |
| A container's name, then <samp>is …</samp> | The container is not running, or fails its health check. <samp>starting</samp> means it has only just started: wait a minute. |
| A container's name, then <samp>was killed</samp> | It used more memory than allowed and was stopped. |
| A container's name, then <samp>restarted</samp> | It restarted within the last day. |
| <samp>Open incident</samp> | A problem the server already sent you an alert about, still not solved. |

Each line leaves the list once the problem is solved.

### When `bivy status` cannot run

Then it prints one of these messages instead of the state, and shows nothing about the platform.

| The message starts with | What it means, and what to do |
|---|---|
| <samp>No valid platform.yml in</samp> | You are not in your instance repository. Change to its folder, or pass it: `bivy status <dir>`. |
| <samp>No SSH key at</samp> | `bivy` found no key to use. Pass yours with `--ssh-key <file>`; the message lists the keys it found in `~/.ssh`, if any. |
| <samp>No known host key for the platform in</samp> | This computer has no record of your server's identity, so `bivy` cannot prove it is talking to your own server, and stops. |
| <samp>cannot find the server</samp> | The domain in `platform.yml` does not point to exactly one address. The message says what it found. |
| <samp>the server did not answer</samp> | The connection or the command on the server failed. The message ends with the last thing the server or SSH said. |
| <samp>the server's reconciler is older than this command</samp> | The server runs a version from before `bivy status` existed. Update the platform first. |

## See also

- [`bivy backup`](../backup/): make a backup now and follow it to its end.
- [Glossary](../../reference/glossary/): *reconciler*, *pass*.
