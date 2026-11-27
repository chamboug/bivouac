---
title: bivy init
description: Make a new platform from an empty Hetzner project and a domain, with its configuration in a private GitHub repository.
---

`bivy init` makes a new platform: it asks its questions, writes your instance repository and pushes it to GitHub, creates the server at Hetzner, writes the DNS records, and opens the sign-in service for your first account.

## Usage

```sh
bivy init [options]
```

Run it on your computer, in a terminal, from any folder. It asks a question for each choice; each question also has a flag, so a choice given as a flag is not asked.

| Option | What it does |
|---|---|
| `--dir <folder>` | Where to write your instance repository: a new or empty folder. Asked with `bivouac-platform` filled in. |
| `--zone <domain>` | Your domain, as bought from a registrar: `example.org`. |
| `--domain <name>` | The platform's own part of it: `apps.example.org`. Each app gets `<app>.apps.example.org`. |
| `--location <id>` | The Hetzner location of the server, such as `fsn1`. |
| `--server-type <type>` | The Hetzner server type, such as `cx23`. |
| `--dns ovh\|manual` | Who serves your domain's DNS (see below). |
| `--ssh-key <file>` | The SSH key this computer logs in to the server with. |
| `--repository <address>` | The SSH address of the empty GitHub repository: `git@github.com:you/bivouac-platform.git`. |
| `--backups now\|later` | Set up nightly backups now, or later with `bivy configure backups`. |
| `--alerts now\|later` | The same, for alerts on your phone. |
| `--mail now\|later` | The same, for the mail the sign-in service sends. |

The questions of backups and mail have flags too (`--backup-provider b2|s3`, `--backup-region`, `--backup-endpoint`, `--backup-bucket`, `--smtp-host`, `--smtp-user`, `--smtp-from`): they are the questions of `bivy configure`.

Three moments have no flag and always need you at a terminal: confirming the cost, keeping the keys shown once, and allowing the DNS records.

Passwords, tokens and keys are never given as flags. `bivy` asks for each one with hidden input and keeps it in `~/.config/bivouac/`, readable by you only, so a second run does not ask again.

## When to use it

Once, to make your platform. `bivy init` never replaces or erases a platform: a Hetzner project that already has one is refused.

You need:

- **A Hetzner project made for the platform, empty**, and an API token of it (Read & Write): Hetzner Console → New project → Security → API tokens.
- **A domain of your own.** If its DNS is at OVHcloud, `bivy` writes the records itself with keys limited to that domain; it gives you the link to create them. Anywhere else, choose `manual`: `bivy` shows the records and you create them.
- **A GitHub account** whose SSH key is on this computer, and **git** with your name and address set (`git config --global user.name` and `user.email`).
- **Docker**, running: `bivy` encrypts the secrets and checks the server's system image in containers.
- **About 35 minutes**, at the computer: you are asked to do three things in GitHub and in your browser along the way.

The server is billed by Hetzner by the hour from the moment it exists. `bivy` shows the price before creating anything.

Backups, alerts and mail can each be set up now or later. To set them up now, have their accounts ready: an empty, private bucket on S3-compatible storage with its key (Backblaze B2 or another), Pushover and healthchecks.io, a mailbox that sends mail over SMTP. Without backups, keep no real data on the platform.

A computer holds one platform per user: `bivy init` refuses on a computer that already reaches one.

## What it does

**First the questions, which change nothing.** In order: the folder, the domain, the platform's domain, the Hetzner token, where the server goes and which one (cheapest first, with the price per hour), who serves the DNS, the SSH key, the GitHub repository, then backups, alerts and mail.

- The sign-in page lives at `auth.<platform domain>` for good: passkeys are bound to that name.
- For the SSH key, `bivy` offers a new key for this computer, `~/.ssh/bivouac` (it asks you for its passphrase), or the keys already in `~/.ssh`.
- For the repository, `bivy` gives you a link that opens GitHub's new-repository page, filled in. Create it **private and empty**: no README, no licence. Another name than `bivouac-platform` is fine. Then paste its SSH address (Code → SSH). `bivy` checks that your git can read it and that it is empty.

**Then the cost.** `bivy` lists what it is about to create at Hetzner and asks you to type the platform's domain to go ahead. Nothing billed exists before that.

**Then the steps**, each one shown as it starts:

1. **The instance repository.** `bivy` writes your platform's configuration in the folder, generates its secrets and encrypts them with a new *age key*, added to `~/.config/sops/age/keys.txt`.
2. **The keys shown once.** The age master key, and the restic password if you set up backups. Put them in your password manager, then type `stored`. Without them, a lost computer means a lost platform. Keep your GitHub account's recovery codes there too.
3. **The push** to your GitHub repository.
4. **The system image**, made once per Hetzner project: `bivy` downloads Flatcar (about 500 MB) and checks its signature. It then asks for a **second Hetzner token**, used only by the tool that copies the image to Hetzner, for about five minutes, on a temporary server (a few cents). Delete that token afterwards, as `bivy` reminds you: your first token keeps working.
5. **At Hetzner:** a fixed IPv4 and IPv6, kept even if the server goes, a firewall that lets in SSH and the web only, and the server.
6. **The server's checks:** `bivy` waits for the server to answer, gives it its own SSH host key, and checks its first boot.
7. **The deploy key.** `bivy` shows a key and a link to your repository's settings. Add it on GitHub with "Allow write access" **unchecked**: the server reads your configuration and can never change it. `bivy` waits for it, then checks GitHub refuses it any write. It then gives the server the age key, so it can read the secrets.
8. **The DNS.** `bivy` shows the records it will add: `*.<platform domain>` pointing to the server, and a `_dmarc` record if your domain has none. Type the platform's domain again to allow them. Nothing else in your DNS is changed or removed. `bivy` then waits until the public DNS answers (up to an hour) and the sign-in page has a valid certificate.
9. **Your account.** `bivy` opens the sign-in service's first-admin page to your computer's public IPv4 only, and asks you to open it in your browser. Create your account, then add a second passkey on another device. `bivy` shows the account created: if it is yours, type `done`. It then closes the page and checks there is exactly one account.
10. **A test alert**, if you set up alerts: a message arrives on your phone.

Before writing the DNS, `bivy` stops if the platform's names already point elsewhere, have an IPv6 (`AAAA`) record, or have a CAA record that does not allow Let's Encrypt.

**If it stops**, for an error, Ctrl-C or a closed terminal, run `bivy init` again: it carries on where it stopped, with the answers already given, and asks nothing twice. The answers and the steps done are kept in `~/.config/bivouac/init.json`, which holds no secret. An answer already given wins over a flag: a flag that differs is ignored, with a line saying so. To start over from the questions, delete that file.

**What stays on your computer:** the instance repository in its folder, the age key, the SSH key, and `~/.config/bivouac/`: the Hetzner token and DNS keys, the server's host key, and the SSH key to use, so the next commands need no `--ssh-key`. The passwords and keys of backups, alerts and mail leave it once pushed: they are then only in the encrypted file.

## Example

The cost confirmation, after the questions:

```text frame="terminal"
bivy is about to create, in your Hetzner project:
  - a server cx23 in fsn1: €0.01056/hour incl. VAT, about €7.6 for a 30-day month;
  - a fixed IPv4 and IPv6 (the IPv4 about €0.50/month excl. VAT, the IPv6 free), kept even if the server goes;
  - a firewall letting in SSH and the web only, and the Flatcar image if missing (a few cents).
Then it pushes the configuration to git@github.com:you/bivouac-platform.git, and asks again before touching the DNS of example.org.
Parts left for later: backups, alerts, mail.
│
◇  Type the platform domain (apps.example.org) to go ahead:
│  apps.example.org
· instance repo written
```

The end of a run, from the DNS:

```text frame="terminal"
· DNS

The DNS of example.org gets:
  *.apps.example.org A 203.0.113.10
  _dmarc.example.org TXT v=DMARC1; p=none
Nothing else is changed or removed. From then on, the sign-in page is public: its first-admin page stays refused until the next step (D15, D69).
│
◇  Type the platform domain (apps.example.org) to write these records:
│  apps.example.org
  public DNS answers with the server's address
  auth.apps.example.org answers with a valid certificate
· first admin
  opening the first-admin page to your address: the server picks the change up within a minute or two…

  ▶ Open https://auth.apps.example.org/setup in your browser (from this machine's network, over IPv4),
    create your admin account, then add a second passkey that does not live in the same place
    (phone and computer, or a synced passkey). Waiting for the account (up to an hour)…
  account created: alex, alex@example.org
│
◇  If that account is yours, type 'done' once your passkeys are registered (two are safer: one on each device):
│  done
  closing the first-admin page again: the server picks the change up within a minute or two…
  one admin account, and the first-admin page is closed again

✓ The platform runs on 203.0.113.10: https://auth.apps.example.org, configuration in /Users/you/bivouac-platform (you/bivouac-platform).
  Left for later: bivy configure backups, bivy configure alerts, bivy configure mail. Without backups, keep no real data on it.
  Reach the server with: bivy ssh /Users/you/bivouac-platform (with /Users/you/.ssh/bivouac, remembered for the next commands).
```

The last lines depend on the parts set up: with backups, the first one runs that night at 02:00 UTC; with mail, `bivy` asks you to send a test mail from the sign-in service's settings.

The command exits with `0` when the platform runs, and `1` otherwise.

## If something goes wrong

Every error below can be fixed, then `bivy init` run again: it carries on from where it stopped, and says so with <samp>Run the same command again to carry on: answers given and steps done are kept.</samp> An error before you confirm the cost has created nothing billed.

| The message starts with | What it means, and what to do |
|---|---|
| <samp>Git has no … on this machine</samp> | Set your name and address in git with the two commands the message shows, then run again. GitHub's private address works too. |
| <samp>This machine already reaches a platform</samp> | This computer user already has a platform. Run `bivy init` as another user, or move `~/.config/bivouac` aside first. |
| <samp>This Hetzner project cannot receive a new platform</samp> | The project already has a platform's server or fixed IP in use. Use a new, empty project. |
| <samp>… exists and is not empty</samp> | The folder you named already holds files. Name a new folder. |
| <samp>Your git cannot read …</samp> | The repository does not exist yet, or your SSH key is not on your GitHub account. Create the repository with the link shown, or add your key on GitHub. |
| <samp>… is not empty: bivy init needs a new, empty repo</samp> | The repository already has commits, often a README. Create a new one, empty. |
| <samp>The OVH keys cannot read the zone …</samp> | The OVH keys were made for another domain, or have expired. Delete the three `ovh-*` files in `~/.config/bivouac/`, create new keys with the link shown, and run again. |
| <samp>No x86 server with at least … GB can be ordered anywhere right now</samp> | Hetzner has no server of that size available. Try again later. |
| <samp>Hetzner …</samp> | Hetzner refused a request; its reason follows. A refused token is fixed by deleting `~/.config/bivouac/hetzner-token` and running again: `bivy` asks for a new one. |
| <samp>The downloaded image does not carry Flatcar's valid signature: nothing was sent to Hetzner</samp> | The download was damaged or tampered with. Run again; if it happens again, stop and find out why. |
| <samp>The snapshot tool left …</samp> | The tool that copies the image left a server or key behind, which Hetzner bills. Delete them in the Hetzner Console, as the message lists them, then run again. |
| <samp>The snapshot tool failed</samp> | The image could not be copied, and nothing was left behind. Run again. |
| <samp>The server does not present the host key placed with its Ignition config: nothing was sent</samp> | Something other than your new server answered at its address. Do not carry on: find out why first. |
| <samp>The deploy key '…' can write to the repo</samp> | "Allow write access" was checked. Delete the key on GitHub, add it again with the box unchecked, and run again. |
| <samp>The DNS step stops here, nothing was written</samp> | A record already covers the platform's names, or a CAA record does not allow Let's Encrypt; each reason follows. Remove or change that record at your DNS provider, or start over with another platform domain. |
| <samp>…: still not there after … minutes</samp> | Something `bivy` waits for did not happen in time: the deploy key, the public DNS, the certificate or your account. Do what it waited for, then run again. |
| <samp>This machine's address … is not a public IPv4</samp> | The first-admin page is opened to one public IPv4 only, and this computer has none. Run `bivy init` from another network. |
| <samp>Not confirmed as yours: /setup is still open to your address</samp> | You did not type `done`. Look at the account in the sign-in service's admin screen, then run again: it closes the page. |
| <samp>Pocket ID has … accounts, not one</samp> | Someone else may have created an account on the first-admin page. Look in the sign-in service's admin screen before anything else. |
| <samp>These answers differ from the ones you confirmed</samp> | Something an answer depends on changed after you confirmed the cost, such as the SSH key's file. Put it back as it was, or delete `~/.config/bivouac/init.json` to start over. |
| <samp>Another bivy init is running</samp> | Only one runs at a time. If none is running, delete the `.lock` file the message names. |
| <samp>Cancelled: nothing more was done</samp> | You pressed Ctrl-C or Escape at a question. Run again to carry on. |
| <samp>This needs a person at a terminal (no flag can answer it)</samp> | `bivy init` was started by a script or another program, and reached a moment only you can answer. Run the same command in a terminal. |
| <samp>Could not run Docker (is it installed and started?)</samp> | Start Docker, then run again. |

## See also

- [`bivy status`](../status/): check the new platform.
- [`bivy ssh`](../ssh/): reach the server.
- [`bivy backup`](../backup/): once backups are set up, make a first copy.
