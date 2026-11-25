---
title: bivy exec
description: Run a command inside one of your apps on the server, or open a shell there.
---

`bivy exec` runs a command inside one of your apps on the server, or opens a shell there.

:::caution
This goes through the server with full rights: `bivy exec` logs in as `core`, which can use `sudo` and Docker. Use it to look, or to run a script your app provides for this. Anything changed by hand inside an app's container is lost when the app is deployed again; only its database and its declared volumes are kept.
:::

## Usage

```sh
bivy exec [app] [--instance <dir>] [--ssh-key <file>] [-- command...]
```

Run it on your computer, from the folder of your instance repository, or pass that folder with `--instance`.

| Argument or option | What it does |
|---|---|
| `app` | The app, by the name in its manifest. Without it, `bivy` shows the list of your apps to choose from. |
| `-- command...` | The command to run in the app. Everything after `--` goes to the app as it is, options included. Without it, you get a shell (`sh`) in the app. |
| `--instance <dir>` | The folder of your instance repository (default: the current folder). |
| `--ssh-key <file>` | The SSH key used to reach the server. Without it, `bivy` uses the key you chose before, or the only key in `~/.ssh`. If there are several, it asks you to pick one, once, and remembers it. |

Options of `bivy` itself go before the `--`.

## When to use it

- To run a script your app ships for an admin task, such as creating an invitation.
- To look inside a running app: its files, its environment, what it sees on the network.

To read an app's logs, use [`bivy ssh`](../ssh/) instead: the logs are kept by the server, outside the app.

## What it does

`bivy` reaches the server as [`bivy ssh`](../ssh/) does, then runs the command in the app's container. At a terminal, the command is interactive: you can type into it, and Ctrl-C reaches it. From a script, it gets no terminal and `bivy` asks nothing.

The command's words reach the app exactly as you typed them: nothing is read by the server's shell on the way. So a pipe or `&&` meant for the app goes inside `sh -c '…'`:

```sh
bivy exec notes -- sh -c 'ls /data | wc -l'
```

`bivy exec` ends with the command's exit code.

## Example

For an app named `notes` that ships an admin script `scripts/invite.mjs`:

```sh
bivy exec notes -- node scripts/invite.mjs --uses 1
```

`bivy` prints nothing of its own: what appears is the command's output. With no command, `bivy exec notes` opens a shell in the app; type `exit` to leave. With no app, `bivy exec` first asks which one.

## If something goes wrong

| The message says | What it means, and what to do |
|---|---|
| <samp>Which app? bivy exec &lt;app&gt; -- &lt;command&gt;. Apps: …</samp> | No app was given, and there is no terminal to choose from a list. Name the app. |
| <samp>No app '…' in this instance. Apps: …</samp> | No manifest in your instance repository has that name. The message lists the ones that do. |
| <samp>No known host key for the platform in …</samp> | This computer has no list of known server keys, so nothing proves the server is yours. See [`bivy ssh`](../ssh/#if-something-goes-wrong). |
| <samp>Cannot find the server: …</samp> | The address of the server could not be found from your domain. See [`bivy ssh`](../ssh/#if-something-goes-wrong). |
| <samp>No SSH key at …</samp> | `bivy` found no key to use. Pass yours with `--ssh-key <file>`; the message lists the keys it found in `~/.ssh`, if any. |
| <samp>No valid platform.yml in …</samp> | You are not in your instance repository. Change to its folder, or pass it: `bivy exec --instance <dir>`. |

Other messages come from the server: if the app is not running, Docker says so. `bivy status` shows the state of each app.

## See also

- [`bivy ssh`](../ssh/): a shell on the server itself.
- [`bivy backup`](../backup/): back up first, before any change that could lose data.
