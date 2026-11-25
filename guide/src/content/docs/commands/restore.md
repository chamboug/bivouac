---
title: bivy restore
description: Bring one app's data, or the sign-in's, back to a nightly backup copy, on the running server.
---

`bivy restore` puts one app's database and files back as they were in a nightly backup copy, without touching the other apps. `bivy restore pocket-id` does the same for Pocket ID, the sign-in service.

## Usage

```sh
bivy restore [app|pocket-id] [--plan] [--snapshot <id> | --before <date>] [--only database|files]
```

Run it on your computer, from the folder of your instance repository, or pass that folder with `--instance`. In a terminal, it asks for what you leave out: the app, the copy and the part to restore.

| Option | What it does |
|---|---|
| `--plan` | Only read: show what the restore would do, and change nothing. |
| `--snapshot <id>` | Restore this copy, by its ID (eight characters or more, as `bivy restore` shows them). |
| `--before <date>` | Restore the latest nightly copy taken at or before this date, in UTC: `2026-11-12` means the end of that day, `2026-11-12T08:00Z` a precise time. |
| `--only database\|files` | Restore only the database, or only the files. Without it, both. Not for `pocket-id`, which has only a database. |
| `--instance <dir>` | Your instance repository, if you are not in its folder. |
| `--ssh-key <file>` | The SSH key used to reach the server. Without it, `bivy` uses the key you chose before, or the only key in `~/.ssh`. If there are several, it asks you to pick one, once, and remembers it. |

There is no option to skip the confirmation: a restore always asks you to type the app's name in a terminal.

## When to use it

- Data was deleted or changed by mistake: restore the last copy taken before the mistake.
- An update of an app damaged its data: first put the previous version back in `apps/<app>.yml` and wait for it to be deployed, then restore the database from the last copy taken before the update. Otherwise the damaging version runs again on the restored data.
- An app's volume was lost: restore its files from the latest copy.
- An update of Pocket ID broke the sign-in: `bivy restore pocket-id`, once a version with the previous Pocket ID runs on the server.

Run it with `--plan` first: it shows what would change, and changes nothing.

## What it does

The server keeps the nightly copies of every app. The menu offers the 14 latest, in your computer's time; `--before` reaches older ones.

**What is overwritten.** The app's database is replaced by the one in the copy. Its files are put back as they were: files added since the copy are removed, changed ones are put back. With `--only`, the other part is left as it is.

**What leaves the app.** Everything written in the app since the copy was taken: new entries, changes, uploaded files. It is not deleted:

- before changing anything, the server sends a *safety copy* of the app's current data to your backup storage. The command that puts it back is printed at the end;
- the replaced database is also kept on the server, under a new name. It is not backed up, and it takes room on the disk until it is removed.

Safety copies are never removed by the clean-up of old backups.

**While it runs**, the app is stopped: usually under a minute, longer for a large volume. The other apps keep running. Once begun, a restore cannot be stopped: it carries on on the server to its end, even if you press Ctrl-C or lose the connection.

Before it starts, `bivy` shows the plan the server computed: the copy and when it was taken, what goes back, and the disk space needed and free. It warns you if the app was deployed again after the copy. Then it asks you to type the app's name.

**For Pocket ID**, the plan also shows whether Pocket ID works right now, its version and its number of accounts. Accounts, passkeys, invitations and sign-ins made since the copy are no longer there: whoever joined or added a passkey since does it again, and everyone signs in again. Sign-in is down for a minute or two; apps keep running for people already signed in. If Pocket ID works when you run it, `bivy` reminds you to restore it only to undo a mistake.

## Example

Restoring an app called `recipes`, in a terminal:

```text frame="terminal"
$ bivy restore recipes
│
◇  Which nightly copy? (your computer's time; older ones: --snapshot <id>)
│  Thu 19 Nov, 03:02
│
◇  What should go back to that copy?
│  The database and the files

Restoring recipes to the copy 3f9a1c2e, taken Thu 19 Nov, 03:02:
  · the database goes back to that copy; today's is kept aside, as bivouac_r261120091502_recipes
  · the files (bivouac-app-recipes_photos) go back to that copy: files added since are removed, the others put back as they were
  · what was written in recipes since Thu 19 Nov, 03:02 will no longer be in the app. It is not lost: a safety copy
    of today's data is sent first, so this restore can be undone
  · recipes is stopped meanwhile: usually under a minute, longer for a large volume
  · disk: about 1.0 GB needed, 31.4 GB free

│
◇  To replace recipes's data with the copy of Thu 19 Nov, 03:02, type the app's name (recipes):
│  recipes

A restore cannot be stopped halfway: once begun, it carries on on the server to its end.
✓  Stopping recipes
✓  Sending a safety copy of recipes's current data (8 s)
✓  Bringing the database back
✓  Bringing the files back
✓  Starting recipes and waiting for its health check (6 s)

✓ recipes is back to the copy of Thu 19 Nov, 03:02.
  To undo it: bivy restore recipes --snapshot 7c41d0b9
  The replaced database is kept as bivouac_r261120091502_recipes: not backed up, it takes room on the disk until you ask to drop it.
```

With `--plan`, it stops after the plan with `Nothing was changed (--plan). To restore: bivy restore recipes --snapshot 3f9a1c2e, in a terminal.`

The command exits with `0` when the restore is done, or after `--plan`, and `1` otherwise.

## If something goes wrong

If a step fails before the app's data was touched, nothing was changed and the app runs again. If it fails after, the app stays stopped, so it never runs on half-restored data, and `bivy status` lists it until a restore of all its data completes.

| The message says | What it means, and what to do |
|---|---|
| <samp>… The app stays stopped: run the restore again, or restore the safety copy.</samp> | The restore failed halfway. The next line gives the safety copy and the command that puts it back, as it was before this restore. Run the same restore again, or that command. For Pocket ID, the message says `Pocket ID stays stopped`. |
| <samp>… the connection to the server was lost</samp> | The restore may still be running on the server. Wait a few minutes, then run `bivy restore <app> --plan`: it says whether a restore is still running, or was interrupted. |
| <samp>the data is restored, but the app is not healthy: …</samp> | The data is back, but the app does not start properly on it. If an update of the app is the cause, put its previous version back first, then restore again. To return to where you were, use the safety copy the message names. |
| <samp>Stopped: nothing was changed.</samp> | You pressed Ctrl-C or Escape during a question, or chose to stop after a warning. |
| <samp>not confirmed: nothing was changed.</samp> | The name typed did not match. Run the command again. |
| <samp>a restore replaces live data: it is confirmed by typing in a terminal, and there is none here. Nothing was changed.</samp> | `bivy restore` was run from a script or another program. Run it in a terminal, or use `--plan` to only read. |
| <samp>a … is running on the server: try again once it is over. Nothing was changed.</samp> | A backup or another restore is running. The server runs one at a time. Try again in a few minutes. |
| <samp>not enough free disk on the server for this restore. Nothing was changed.</samp> | A restore needs room for about three times the database's size, plus 1 GB. The plan shows how much is needed and free. |
| <samp>an earlier restore of … was interrupted: only a restore of all its data (without --only) starts it again. Nothing was changed.</samp> | An earlier restore stopped halfway. Run the restore again without `--only`. |
| <samp>copy … does not hold …: choose a later one</samp> | The app's volume did not exist yet when that copy was taken. Choose a later copy. |
| <samp>no nightly copy at or before that date</samp> | No nightly copy was taken at or before the date given to `--before`. Remember that the date is in UTC. |
| <samp>the server has no nightly copy yet</samp> | The first nightly backup has not run yet. There is nothing to restore from. |
| <samp>backups are not configured on this platform</samp> | Backup storage was skipped during `bivy init`, so there are no copies. Set it up with `bivy configure backups`. |
| <samp>no app '…' in this instance. Apps with data: …</samp> | The name is not one of your apps. The message lists the apps that have data to restore. |
| <samp>the server's reconciler is too old for bivy restore: let it move to the latest version first</samp> | The server runs a version from before `bivy restore` existed. Update the platform first. |
| <samp>No SSH key at …</samp> | `bivy` found no key to use. Pass yours with `--ssh-key <file>`; the message lists the keys it found in `~/.ssh`, if any. |
| <samp>No valid platform.yml in …</samp> | You are not in your instance repository. Change to its folder, or pass it with `--instance <dir>`. |

## See also

- [`bivy backup`](../backup/): make a fresh copy before a risky change.
- `bivy status`: whether an app is stopped after an interrupted restore.
- [Glossary](../../reference/glossary/): *reconciler*.
