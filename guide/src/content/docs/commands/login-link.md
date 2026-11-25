---
title: bivy login-link
description: Get a one-time sign-in link for a Pocket ID account, when its admin has lost every passkey.
---

`bivy login-link` asks Pocket ID, the platform's sign-in service, for a link that signs a user in once, without a passkey.

## Usage

```sh
bivy login-link <user> [dir] [--ssh-key <file>]
```

Run it on your computer, in a terminal window of your own, from the folder of your instance repository, or pass that folder as `dir`. `<user>` is the Pocket ID username or email address of the account. Give the username when you can: Pocket ID looks the name up as a username or an email, and a username may look like someone else's email.

| Option | What it does |
|---|---|
| `--ssh-key <file>` | The SSH key used to reach the server. Without it, `bivy` uses the key you chose before, or the only key in `~/.ssh`. If there are several, it asks you to pick one, once, and remembers it. |

## When to use it

When the admin of Pocket ID has lost every passkey (a lost phone, a reset password manager) and so cannot sign in to anything on the platform.

For anyone else who lost their passkeys, the admin can make a one-time link in Pocket ID itself (**Login Code** in the user list) and send it to them.

## What it does

`bivy` reaches your server over SSH, runs Pocket ID's own command for one-time links, and shows the link. It changes nothing else.

The link:

- works **once**, and only **within one hour**; after that it is worth nothing;
- signs in whoever opens it first, as that user;
- is refused when opened if the account is disabled.

Because the link is a key to the account:

- `bivy login-link` runs only when it is started by a person at a terminal. Started by a script, through a pipe, or by an AI assistant's shell, it stops before reaching the server.
- The link is shown on screen only, never written to a file.
- Never paste it into a chat, an email or a file. If an AI assistant can read your terminal, run the command in another window.

Once signed in, add a passkey at once, from your account page in Pocket ID (**Add Passkey**).

## Example

```text frame="terminal"
$ bivy login-link admin
Sign-in link for admin:

  https://auth.apps.example.org/lc/k3Xh9QmT2bWz

This link is a key: whoever opens it first is signed in as that user. Share it
with no one. It works once, within the hour; after that it is worth nothing.
Open it yourself, in the browser you will keep using, then add a passkey at
once (your account page, Add Passkey). A disabled account is refused.
```

The command exits with `0` when it shows a link, and `1` otherwise.

The link stays in your terminal's scrollback. It is worth nothing once used or after the hour.

## If something goes wrong

| The message says | What it means, and what to do |
|---|---|
| <samp>bivy login-link shows a sign-in link, which is a credential: …</samp> | `bivy` was not started by a person at a terminal. Run it yourself, in a terminal window. |
| <samp>Whose link? bivy login-link &lt;username or email&gt;.</samp> | The username is missing. |
| <samp>Pocket ID has no user with that username or email.</samp> | Check the spelling. The username is the one shown in Pocket ID's user list. |
| <samp>'…' is neither a Pocket ID username nor an email address bivy accepts …</samp> | The name holds characters a Pocket ID username cannot have. Only letters, digits and `. _ @ + -` are accepted. |
| <samp>No bivouac-pocket-id container on the server: …</samp> | Pocket ID is not running. Run `bivy status` to see what is. |
| <samp>The server could not be reached …</samp> | The SSH connection failed. The message says why. |
| <samp>Pocket ID made no link: …</samp> | Pocket ID's command failed. The message gives its last words. |
| <samp>Pocket ID answered, but not with a sign-in link: …</samp> | Pocket ID printed something `bivy` does not recognise, probably after a Pocket ID update that changed the command. No link is shown. |
| <samp>The link is not on https://auth.…: …</samp> | Pocket ID made a link for another address than the one in your `platform.yml`. No link is shown. |
| <samp>No SSH key at …</samp> | `bivy` found no key to use. Pass yours with `--ssh-key <file>`; the message lists the keys it found in `~/.ssh`, if any. |
| <samp>No valid platform.yml in …</samp> | You are not in your instance repository. Change to its folder, or pass it: `bivy login-link <user> <dir>`. |

## See also

- `bivy status`: whether Pocket ID is running.
