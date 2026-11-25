---
title: bivy ssh
description: Open a shell on your server, to look around, without knowing its address or how to log in.
---

`bivy ssh` opens a shell on your server, logged in as `core`.

:::caution
This shell has full rights on the server: `core` can use `sudo` and Docker. Use it to look, not to change things. Every minute, the server makes itself match your instance repository again: a change made by hand to what it manages is undone, at once or at the next deployment. Make changes through the instance repository instead.
:::

## Usage

```sh
bivy ssh [dir] [--ssh-key <file>] [-- <command>...]
```

Run it on your computer, from the folder of your instance repository, or pass that folder as `dir` (or `--instance <dir>`).

| Option | What it does |
|---|---|
| `--ssh-key <file>` | The SSH key used to reach the server. Without it, `bivy` uses the key you chose before, or the only key in `~/.ssh`. If there are several, it asks you to pick one, once, and remembers it. |

With `--` followed by a command, `bivy ssh` runs that command on the server instead of opening a shell, prints what it prints, and exits with its exit code. To run a command inside an app, use [`bivy exec`](../exec/).

## When to use it

To understand something `bivy status` does not explain: read a container's logs, look at the disk, see what Docker runs. For example, once logged in:

```sh
docker ps
docker logs --tail 100 bivouac-app-notes
```

Or, for one command, without opening a shell:

```sh
bivy ssh -- docker logs --tail 100 bivouac-pocket-id
```

Each app runs in a container named `bivouac-app-` followed by the app's name.

Do not stop an app's container by hand: the server takes a stopped app for a deployment that failed, and leaves it stopped until the app's manifest changes.

## What it does

`bivy` finds the server by looking up `auth.` followed by your domain (the address of the sign-in page, which is always on the server), then runs your computer's `ssh` with:

- the user `core`;
- your SSH key, and no other;
- the platform's own list of known server keys, `~/.config/bivouac/known_hosts`: `ssh` refuses to connect if the server's key does not match it, and never adds a new key by itself;
- nothing from your `~/.ssh/config`, and no agent forwarded to the server.

`bivy` prints nothing of its own once connected: what you see is the server's shell. Type `exit` to leave.

If your key has a passphrase, `ssh` asks for it. Without a terminal (in a script), it never asks anything and fails instead.

## If something goes wrong

If `ssh` itself refuses to connect because the server's key does not match the known one, stop there: either the server was rebuilt by hand, or you are not talking to your server.

| The message says | What it means, and what to do |
|---|---|
| <samp>No known host key for the platform in …</samp> | This computer has no list of known server keys, so nothing proves the server is yours. `bivy init` writes it when it creates the server, and `bivy rebuild` when it rebuilds one. On another computer, there is no command to set it up yet. |
| <samp>Cannot find the server: auth.… does not resolve (…)</samp> | Your domain's `auth.` name has no address. Check your DNS, and that you are online. |
| <samp>Cannot find the server: auth.… has … addresses (…), one expected</samp> | The `auth.` name points to several addresses, so `bivy` cannot tell which is the server. It needs exactly one. |
| <samp>Could not start ssh: …</samp> | `ssh` is not installed on this computer, or cannot be started. |
| <samp>No SSH key at …</samp> | `bivy` found no key to use. Pass yours with `--ssh-key <file>`; the message lists the keys it found in `~/.ssh`, if any. |
| <samp>No SSH key chosen: nothing was done.</samp> | You cancelled the list of keys. Run the command again and pick one, or pass it with `--ssh-key <file>`. |
| <samp>No valid platform.yml in …</samp> | You are not in your instance repository. Change to its folder, or pass it: `bivy ssh <dir>`. |

## See also

- [`bivy exec`](../exec/): run a command in an app's container.
- [`bivy backup`](../backup/): back up first, before any change that could lose data.
