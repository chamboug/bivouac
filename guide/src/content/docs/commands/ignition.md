---
title: bivy ignition
description: Print the configuration a new server reads the first time it starts, built from your instance repository.
---

`bivy ignition` builds the configuration a new server reads the first time it starts, and prints it as JSON.

## Usage

```sh
bivy ignition [dir] [-o file] [--ipv6 <address/64>]
```

Run it on your computer, from the folder of your instance repository, or pass that folder as `dir`. It needs Docker running: the configuration is built in a container, downloaded the first time. It does not connect to your server and never decrypts your secrets.

| Option | What it does |
|---|---|
| `-o <file>` | Write the configuration to that file instead of printing it. |
| `--ipv6 <address/64>` | The server's IPv6 address, with its `/64`, for example `2001:db8::1/64`. Needed when `butane/server.bu` sets up the server's IPv6, as the one `bivy init` writes does. |

## When to use it

Rarely. `bivy init` and `bivy rebuild` build this configuration themselves when they create a server, and `bivy validate` checks it before every push.

Use it to see exactly what a new server would start with, or when you create a server by hand rather than with `bivy`.

## What it does

It reads `butane/server.bu`, the server's start configuration in your instance repository, and:

- fills in the repository address and the reconciler's version from `platform.yml`;
- fills in the IPv6 address given with `--ipv6`;
- adds the SSH keys listed in `ssh-keys.yml`, so that they can log in to the new server;
- converts the result into Ignition, the JSON format the server's system reads at its first start.

It refuses a result that holds a private key: a server's start configuration can be read from the server itself, so it must hold no secret. It also refuses a result above 32 KiB, the most Hetzner accepts.

When `bivy init` or `bivy rebuild` create a server, they add one thing to this configuration: a temporary identity for the server, replaced at the first connection. `bivy ignition` leaves it out.

It changes nothing.

## Example

```text frame="terminal"
$ bivy ignition --ipv6 2001:db8::1/64 -o ignition.json
```

With `-o`, it prints nothing when it works. Without it, the JSON is printed on one line.

The command exits with `0` when the configuration is built, and `1` otherwise.

## If something goes wrong

| The message says | What it means, and what to do |
|---|---|
| <samp>platform.yml or ssh-keys.yml is invalid: run 'bivy validate' for details.</samp> | You are not in your instance repository, or one of these two files has a mistake. Change to the repository's folder, or pass it as `dir`; if you are there already, run `bivy validate` to see the problem. |
| <samp>butane/server.bu configures the server's IPv6 (…): give its address</samp> | Your `butane/server.bu` has a place for the address (`@@IPV6_ADDRESS@@`). Add `--ipv6` with the server's IPv6 address and its `/64`. |
| <samp>'…' is not an IPv6 address with its /64 (like 2a01:db8:1:2::1/64)</samp> | The address given with `--ipv6` is not in the expected form: lower-case letters, with `::` and `/64`, for example `2001:db8::1/64`. |
| <samp>butane/server.bu must configure the IPv6 with @@IPV6_ADDRESS@@, not a fixed address</samp> | You gave `--ipv6`, but `butane/server.bu` has no place for it. Leave out `--ipv6`, or write `@@IPV6_ADDRESS@@` where the address goes. |
| <samp>butane/server.bu is missing</samp> | The server's start configuration is not in the repository. Put it back from the repository's history. |
| <samp>could not run Docker (is it installed and started?): …</samp> | Start Docker, then run `bivy ignition` again. |
| <samp>Butane refused the config:</samp> | `butane/server.bu` has a mistake; the reason follows. A warning counts as a mistake. |
| <samp>butane/server.bu writes a private key (…): the user-data must hold no secret (D7)</samp> | The start configuration would put a private key on the server, where anyone on it could read it. Remove that key from `butane/server.bu`. |
| <samp>the Ignition config is … bytes, above Hetzner's user-data limit of …</samp> | The configuration is too large for Hetzner. Make `butane/server.bu` smaller. |

## See also

- [`bivy validate`](../validate/): checks this configuration, with everything else in the repository.
- [Glossary](../../reference/glossary/): *reconciler*.
