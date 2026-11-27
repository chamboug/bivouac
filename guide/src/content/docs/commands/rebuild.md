---
title: bivy rebuild
description: Bring the whole platform back from its backups, on a temporary server to prove it works, or on the real server when it is broken or lost.
---

`bivy rebuild` brings the whole platform back from its backups. With `--test`, it does so on a temporary server, checks the copy, then deletes it; without it, it erases the real server and rebuilds it on the same addresses.

## Usage

```sh
bivy rebuild --test [dir] [options]
bivy rebuild [dir] [--plan] [options]
```

Run it on your computer, in a terminal, from the folder of your instance repository, or pass that folder as `dir`. In a terminal, it asks for each choice the options below make.

It needs a Hetzner API token of your platform's project, with Read & Write access. It reads it from `~/.config/bivouac/hetzner-token`; if the file is missing, it asks for the token, hidden as you type, and keeps it there, readable by you only.

**With `--test`:**

| Option | What it does |
|---|---|
| `--yes` | Rent the test server without asking. |
| `--keep` | Leave the test server running after the checks, to look at it. Delete it afterwards with `--cleanup`. |
| `--cleanup` | Delete what a test created, and only that. |
| `--location <name>` | Where the test server goes, for example `fsn1`. Without it, `fsn1`, `nbg1` and `hel1` are tried in that order. |
| `--server-type <type>` | The test server's type. Default: `cx23`. |
| `--snapshot <id>` | Bring back this backup copy, by its ID, instead of the latest nightly one. |
| `--ssh-key <file>` | The SSH key used to reach the server. Without it, `bivy` uses the key you chose before, or the only key in `~/.ssh`. If there are several, it asks you to pick one, once, and remembers it. |
| `--age-key <file>` | The file holding your age key, which decrypts the secrets. Default: `~/.config/sops/age/keys.txt`. |
| `--hetzner-token <file>` | Where the Hetzner token is. Default: `~/.config/bivouac/hetzner-token`. |
| `--github-token <file>` | Where the temporary GitHub token is (see below). Default: `~/.config/bivouac/github-rebuild-token`. |

**Without `--test`, the real rebuild:**

| Option | What it does |
|---|---|
| `--plan` | Only read: show what the rebuild would do, and change nothing. |
| `--server-type <type>` | For a new server only, when no `cx23` can be ordered where your addresses are. |
| `--without-fresh-backup` | The old server no longer answers: accept losing what was written since its last nightly copy. |
| `--snapshot <id>` | Bring back this backup copy, by its ID, instead of a fresh one. |
| `--abandon` | Forget a rebuild that stopped before anything was erased. |
| `--ssh-key <file>` | As above. |
| `--age-key <file>` | As above. In a terminal, you can also paste the key when asked. |
| `--hetzner-token <file>` | As above. |

The real rebuild has no `--yes`: it is always confirmed by typing your platform's domain in a terminal.

## When to use it

- `bivy rebuild --test`: every three months, to prove the platform can come back from its backups. Your real server, its addresses and its backups are not touched. The platform reminds you when the next test is due.
- `bivy rebuild --plan`: to see what a real rebuild would do. It only reads.
- `bivy rebuild`: only when the server is broken beyond repair, or lost. It erases the server's disk, and cannot be undone.

The test has been run on a real platform, twice, in November 2026. The real rebuild has been tested against simulated Hetzner and GitHub services only: it has never been run on a real server. Run `bivy rebuild --test` first, and `bivy rebuild --plan` just before.

## What it does

### The test

1. It asks, before renting anything, for what it lacks: the temporary GitHub token, where the test server goes, which data comes back, then whether to rent the server now. It also finds your age key first, so a wrong key stops it before anything is rented.
2. It rents a server billed by the hour, about €0.01 for a test, with its own addresses and a firewall that lets in your computer only. Everything it creates is labelled `bivouac-rebuild-test`, so it can be found and deleted.
3. It installs the platform there and brings back the latest nightly copy: Pocket ID, every app's database and volumes.
4. It checks the copy: Pocket ID publishes the same signing keys as on the real server, and each app answers its health check.
5. It deletes everything it created, and checks nothing with its label is left.

A test takes five to ten minutes. Each step is recorded on your computer: if the test stops, running `bivy rebuild --test` again offers to carry on from where it stopped, or to delete what it created.

**The temporary GitHub token.** The test server needs read access to your instance repository. `bivy` asks for a token that lets it add that access, and prints a link to GitHub's form, already filled in: it expires after one day, and you choose your instance repository only. At the end, delete the token on GitHub; `bivy` deletes its own copy.

**While the test server runs**, it holds a full copy of your data and secrets, reachable from your computer only. It makes no backup, sends no alert and no mail, and uses certificates of its own. Apps on it sign in through your real Pocket ID. An app that does things on its own schedule, such as sending a daily notification, does it on the test server too: its users may get it twice. Warn them before a test.

**What the test does not prove**: signing in with a passkey in a browser (a passkey belongs to the real address), getting real certificates, and moving your real addresses to a new server.

### The real rebuild

1. **The plan.** It reads your Hetzner project, your server and your backups, and shows what it would do. If the server `bivouac` still exists, it is rebuilt in place; otherwise a new server is created on your addresses, which Hetzner keeps apart from the server (*Primary IPs*). Your DNS is never changed. Anything odd stops it here, and nothing is changed. `--plan` stops here in every case.
2. **The questions.** In a terminal, it asks what the plan leaves open: another server type, if no `cx23` can be ordered; whether to go on without a fresh backup, if the old server no longer answers; and which data comes back. It finds your age key, so a wrong one stops it now and not halfway.
3. **The confirmation.** You type your platform's domain.
4. **A fresh backup** on the old server, so nothing written today is lost. If it fails, nothing is erased.
5. **The erase.** It notes Pocket ID's signing keys, then erases the server and installs it again (or creates the new one). The server's protection against deletion is lifted for that moment only, and put back whatever happens.
6. **The deploy key.** It prints a key and a link to GitHub: add it there, with "Allow write access" unchecked. This key gives the server read access to your instance repository. `bivy` waits up to an hour, then checks that GitHub refuses the key any write.
7. **The data.** It brings back the copy, starts Pocket ID and the apps, then checks them on their real addresses, with real certificates: Pocket ID must publish the same signing keys as before, and each app must answer its health check.

Your instance repository must be exactly what is on GitHub, with nothing uncommitted: the server is rebuilt from it. Your backup storage must also let you download the whole copy that day.

If it stops, run `bivy rebuild` again. Before the erase, it asks whether to start over, with a new plan, confirmation and backup, or to forget it. After the erase, it carries on from where it stopped, and never erases twice. `bivy rebuild --plan` says which case you are in.

At the end, remove the old deploy key on GitHub, keeping only the new one, and check the next morning that the night's backup ran.

## Example

A test, in a terminal, the first time (the server's own report while the data comes back, one line per database and volume, is left out):

```text frame="terminal"
$ bivy rebuild --test
This builds a temporary copy of your platform from its backups, on a server rented by the hour (about €0.01),
checks it against the real one, then deletes it. Your real server is not touched.
A temporary GitHub token is needed, to give the test server read access to the instance repo. Create it here (the form is filled in):
  https://github.com/settings/personal-access-tokens/new?name=bivouac-rebuild-test&description=Deploy+key+of+a+rebuild+test&expires_in=1&administration=write
Under "Repository access", choose "Only select repositories" → you/my-platform, nothing else. It expires tomorrow; you delete it at the end.
│
◇  The temporary GitHub token (hidden as you type, or paste it):
│  ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪
Kept in /Users/you/.config/bivouac/github-rebuild-token (readable by you only). Delete that file to type it again.
│
◇  Where should the test server go?
│  cx23 in fsn1 (Falkenstein), €0.0081/hour (recommended)
│
◇  Which data should come back?
│  The latest nightly copy (recommended)
│
◇  Rent a cx23 in fsn1 now, at €0.0081/hour? The test takes about ten minutes, and the household's apps may send their notifications twice (D91).
│  Yes
Test 202611270915-3fa2: cx23 in fsn1 (€0.0081/hour incl. VAT), Flatcar 4459.2.1.
✓  Putting up a firewall that lets in this computer only
✓  Reserving a temporary IPv6 address
✓  Renting the test server (34 s)
✓  Waiting for the server to start (a minute or two) (51 s)
  the server replaced its provisional host key
✓  The server makes its own identity key
✓  Checking the server's first boot (SSH settings, metadata block)
✓  Telling the server it is a test copy
✓  Giving the server read access to the instance repo
✓  Handing over the age key, so the server can read its secrets
✓  Starting Postgres, alone for now (1 min)
  copy 3f9a1c2e taken 2026-11-27T02:00:12.483920117Z, 4.87 GiB
✓  Bringing the data back from the backup (a minute or more) (2 min)
✓  Starting Pocket ID and the apps (1 min)
  Pocket ID publishes the same signing keys as the real server
  recipes: /api/health answers 200 through Caddy
✓  Comparing the copy with the real platform

✓ Your platform came back on the test server in 6 min: Pocket ID has the real signing keys, and recipes answers.
  Steps (seconds): {"firewall, open to this Mac only":1,"temporary IPv6":1,"server":34,"SSH answers":51,"host key replaced":3,"first-boot checks":1,"rebuild marker (test mode)":1,"deploy key":2,"age key":1,"Postgres, alone":62,"restore the latest nightly copy":97,"Pocket ID and the apps":58,"checks against the real platform":2}
· deleting server bivouac-rebuild-test-202611270915-3fa2
· deleting Primary IP 2001:db8:4f8::/64
· deleting firewall bivouac-rebuild-test-202611270915-3fa2
· removing deploy key bivouac-rebuild-test-202611270915-3fa2
✓  Everything the test created is deleted (14 s)

What is left for you:
  1. Delete the temporary GitHub token 'bivouac-rebuild-test': https://github.com/settings/personal-access-tokens
     (bivy already deleted its copy on this computer.)
  2. Run the next test in three months, around 2027-02-27 (the platform reminds you, D44).
```

Each test asks for a new token: `bivy` deletes its copy at the end. With `--keep`, it stops after the checks with `The test server is still running at …, billed €…/hour, with a copy of the data. Delete it with: bivy rebuild --test --cleanup`.

The plan of a real rebuild:

```text frame="terminal"
$ bivy rebuild --plan
Looking at your server, its addresses and its backups…
Rebuild IN PLACE of server 12345678 (cx23, fsn1): its disk is ERASED, then the platform comes back from the backups.
  IPs kept: 203.0.113.10 and 2001:db8:42::/64; DNS of apps.example.org unchanged.
  Firewall: bivouac. Image: Flatcar 4459.2.1 (snapshot 987654321).
  Last backup of the old server: 2026-11-27T02:03:11.482Z. A fresh one is made first; nothing is erased if it fails.
  Afterwards: you add the new server's read-only deploy key on GitHub when asked, and remove the old one at the end.
```

If something would stop the rebuild, the plan ends with `Stops here:` and one line per problem (see below).

The command exits with `0` when the test or the rebuild is done, after `--plan` with no problem, after `--cleanup` or `--abandon`, and `1` otherwise.

## If something goes wrong

Pressing Ctrl-C stops `bivy` at once. Each step done is recorded on your computer, and the message says what to do: for a test, run `bivy rebuild --test` again to carry on or delete what it created, since the test server may still be running, billed; for the real rebuild, run `bivy rebuild` again.

### The test

Every error below leaves your real server as it was. Unless the message says nothing was rented, the test server may still be running: run `bivy rebuild --test` again, or `bivy rebuild --test --cleanup`.

| The message says | What it means, and what to do |
|---|---|
| <samp>Not confirmed: nothing was rented</samp> | You answered no to renting the server. |
| <samp>… cannot be ordered in …; choose --server-type and --location among:</samp> | That server type is sold out where it was looked for. The message lists what can be ordered: pass one with `--server-type` and `--location`. |
| <samp>No server type of … GB or more can be ordered in …</samp> | Nothing large enough can be ordered in those places right now. Try again later, or in another place with `--location`. |
| <samp>No Flatcar snapshot is available in the Hetzner project</samp> | The image of the server's system, made in your Hetzner project during `bivy init`, is gone. |
| <samp>The server does not present the host key placed with its Ignition config: nothing was sent</samp> | Something other than the new server answered at its address. Nothing was sent to it. Delete the test with `--cleanup`, then run it again. |
| <samp>The server does not answer with the host key recorded for it: nothing more was sent. Do not run again: find out why first</samp> | The server's identity changed during the test. Do not run the test again until you know why. Delete it with `--cleanup`. |
| <samp>restore-platform failed: …</samp> | The data could not be brought back from the copy; the reason follows. Your backups are not changed. |
| <samp>Pocket ID on the test server does not publish the real signing keys: its data or ENCRYPTION_KEY did not come back</samp> | The sign-in service came back without its data, and a real rebuild would do the same. Look into it before relying on the backups. |
| <samp>… answers … on …</samp> | An app does not answer its health check on the copy. Look at it with `--keep`, then delete the test with `--cleanup`. |
| <samp>…: still not there after … minutes</samp> | A step took too long. Run the test again to carry on, or delete it with `--cleanup`. |
| <samp>Clean-up incomplete:</samp> | Something the test created could not be deleted; the lines after it say what. Run `bivy rebuild --test --cleanup` again. A server or address that is not a test's is always left alone. |
| <samp>This test already started with …: carry on without --snapshot, or --cleanup first</samp> | An unfinished test brings back another copy. Carry it on without `--snapshot`, or delete it first. |
| <samp>An older copy was asked for, and nobody is at a terminal to choose it</samp> | Run it in a terminal, or name the copy with `--snapshot <id>`. |
| <samp>--plan, --without-fresh-backup and --abandon are for the real 'bivy rebuild' only.</samp> | Those options do not go with `--test`. |
| <samp>api.ipify.org answered HTTP …: cannot tell this Mac's IPv4</samp> | `bivy` asks that service for your computer's address, to open the firewall to it alone. Try again in a moment. |

### The real rebuild

When a plan finds problems, it lists them after <samp>Stops here:</samp>, then says <samp>The plan has problems: nothing was changed</samp>. Each problem starts with its own `✗`.

| The message says | What it means, and what to do |
|---|---|
| <samp>Not confirmed: nothing was changed</samp> | The domain you typed did not match. |
| <samp>A rebuild is confirmed by typing in a terminal: none here</samp> | `bivy rebuild` was run from a script or another program. Run it in a terminal, or use `--plan` to only read. |
| <samp>Stopped: nothing was changed</samp> | You chose to stop, before anything was erased. |
| <samp>Stopped: run 'bivy rebuild' again to carry on</samp> | You chose to stop a rebuild whose server was already erased. Run it again to finish it: the platform is down until then. |
| <samp>… is not exactly origin/main: pull first</samp> | Your instance repository is behind GitHub, or ahead of it. Pull, or push. |
| <samp>… has uncommitted changes: …</samp> | Commit or undo those changes first: the server is rebuilt from what is on GitHub. |
| <samp>… does not resolve: …</samp> or <samp>… points to …, not to the Primary IPv4 …</samp> | Your sign-in address does not lead to your server's address. A rebuild never changes the DNS: fix it first. |
| <samp>No firewall '…': create it first</samp> | The firewall of the platform is missing from your Hetzner project. |
| <samp>The firewall '…' is not applied to server …</samp> | The server is not behind the platform's firewall. Look at the server before going on. |
| <samp>Server … has no delete protection: something is off, look first</samp> | The server's protection was lifted, which the platform never leaves that way. Find out why before going on. |
| <samp>The Primary IPv4 … has auto_delete: set it to false first</samp> | That address would be deleted with the server. Turn that setting off in Hetzner's console, on the address. The same holds for the IPv6. |
| <samp>No server '…', and not exactly one unassigned Primary IPv4 and IPv6</samp> | With no server left, `bivy` cannot tell which addresses are the platform's. |
| <samp>… cannot be ordered in …. Choose with --server-type, keeping the IPs and the DNS</samp> | No `cx23` can be ordered where your addresses are. Pass one of the types listed with `--server-type`, or answer the question in a terminal. Another place would mean new addresses and a DNS change, which `bivy` does not do. |
| <samp>A backup or a restore holds the lock on the old server: wait for it</samp> | A backup or a restore is running. Plan again once it is over. |
| <samp>The old server already has a rebuild marker: look first</samp> | The server looks like it is in the middle of a rebuild already. Find out why before going on. |
| <samp>The old server has never made a backup</samp> | There is no copy to come back from. |
| <samp>… still answers while SSH does not</samp> | The platform works, but `bivy` cannot reach the server over SSH, probably because of your computer's key. Fix that rather than erasing a working server. |
| <samp>The old server cannot make a fresh backup (…): run again with --without-fresh-backup</samp> | The old server does not answer. If Pocket ID is only restarting, about a minute, wait and plan again. Otherwise, going on loses what was written since the last nightly copy. |
| <samp>Another bivy rebuild is running (…); if none is, remove that file</samp> | Two rebuilds never run at once. If no other terminal runs one, remove the file the message names. |
| <samp>The instance checkout cannot be trusted: …</samp> | Your instance repository changed during the rebuild. Make it exactly what is on GitHub again, then run `bivy rebuild` again. |
| <samp>The fresh backup failed on the old server: …. Nothing was erased</samp> | Nothing was erased; the reason follows. Fix it, or go on with `--without-fresh-backup` if the old server cannot back up any more. |
| <samp>Pocket ID answers …, so its signing keys cannot be recorded: nothing was erased, run again in a minute</samp> | Pocket ID was restarting. Run it again in a minute. |
| <samp>The rebuild was never carried out by Hetzner: nothing was erased.</samp> | The request was lost on its way. Run it again: it starts over with a new plan, confirmation and backup. |
| <samp>The deploy key '…' can write to the repo</samp> | The key was added with "Allow write access" checked. Delete it on GitHub, add it again unchecked, then run `bivy rebuild` again. |
| <samp>Pocket ID does not publish the signing keys it had before the rebuild: its data or ENCRYPTION_KEY did not come back</samp> | The server is rebuilt, but the sign-in service came back without its data: passkeys may no longer work. Your backups are not changed. Look into it before going further; running `bivy rebuild` again only repeats this check. |
| <samp>This rebuild already started with another copy: carry on without --snapshot</samp> | Carry the rebuild on as it started. |
| <samp>No rebuild under way: nothing to abandon</samp> | There is nothing for `--abandon` to forget. |
| <samp>The server may already have been sent for rebuilding: run without --abandon</samp> | The erase may have happened. Run `bivy rebuild`: it finds out, and carries on or says nothing was erased. |
| <samp>--keep, --cleanup, --yes, --location and --github-token are for 'bivy rebuild --test' only.</samp> | Those options do not go with the real rebuild. |

### Both

| The message says | What it means, and what to do |
|---|---|
| <samp>The Hetzner token is missing (…), and nobody is at a terminal to type it: run the command in a terminal.</samp> | Run it in a terminal once: `bivy` asks for the token and keeps it. The same holds for the temporary GitHub token. |
| <samp>… can be read by others: chmod 600 it</samp> | A token file must be readable by you only. |
| <samp>The instance repo is invalid: run 'bivy validate …' first</samp> | Fix what [`bivy validate`](../validate/) reports, then run it again. |
| <samp>platform.yml names no backup: there is nothing to rebuild from</samp> | Backup storage was skipped during `bivy init`. Set it up with `bivy configure backups`, and wait for a first nightly copy. |
| <samp>No age key in …: pass --age-key &lt;file&gt;, or run in a terminal to paste it</samp> | Your age key is not at the default place. Pass it, or run in a terminal and paste it from your password manager. |
| <samp>The age key file holds no key for the recipients of .sops.yaml</samp> | The key given is not the one your instance repository is encrypted for. |
| <samp>'…' is not a backup copy ID</samp> | A copy ID is 8 to 64 characters, `0`–`9` and `a`–`f`. In a terminal, choose "An older copy" instead: `bivy` lists them. |
| <samp>No SSH key at …</samp> | `bivy` found no key to use. Pass yours with `--ssh-key <file>`; the message lists the keys it found in `~/.ssh`, if any. |

## See also

- [`bivy backup`](../backup/): back up now, before a change that could lose data.
- [`bivy restore`](../restore/): bring one app back to a copy, without rebuilding anything.
- [`bivy status`](../status/): the date of the last good backup.
- [Glossary](../../reference/glossary/).
