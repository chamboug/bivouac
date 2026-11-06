# Runbook: installing a Bivouac server by hand

This is the manual procedure for installing the base of a Bivouac server
(layer 2 of the build order). `bivy init` and `bivy rebuild` will automate it
later (layer 5); until then, it is followed step by step, and every step
that changes something outside the Mac is announced first.

Steps marked **(consent)** are irreversible or sensitive (rule 5 of the brief):
they are only run after the platform owner's explicit agreement, given at the
moment of the step.

Steps marked **(not built yet)** describe a piece that does not exist yet in
this repo; the step is completed when that piece lands.

Instance-specific values (server ID, IPs, zone) are not written here: they go
in the instance repo's operations log.

## What it produces

- A Flatcar server whose Ignition config sets up SSH and starts the reconciler.
- A Hetzner Cloud firewall allowing only 22/tcp, 80/tcp, 443/tcp and 443/udp.
- A Primary IPv4 (`auto_delete=false`) and a Primary IPv6.
- A wildcard DNS record `*.<domain>` pointing to the server.
- On the server: the age key and the read-only deploy key in `/etc/bivouac/`.
- Run by the reconciler: Caddy, Postgres and Pocket ID.

## 0. Prerequisites on the Mac

- Docker and Node LTS (see `.nvmrc`). Butane, SOPS and the image upload tool
  run in containers; nothing else is installed.
- This repo, built: `npm ci && npm run build`.
- Credentials in `~/.config/bivouac/`, one value per file, mode 600, typed by
  the owner with `read -s` so they never show on screen or in the shell
  history:

  ```bash
  mkdir -p ~/.config/bivouac && chmod 700 ~/.config/bivouac
  ```

  ```bash
  for n in hetzner-token ovh-application-key ovh-application-secret ovh-consumer-key; do read -rs "v?$n : "; echo; (umask 077; printf '%s' "$v" > ~/.config/bivouac/$n); done; unset v; ls -l ~/.config/bivouac
  ```

  (`read -rs "v?prompt"` is zsh syntax, the default shell on macOS.)
  Commands below read these files and never print them.
- The Hetzner token is a Read & Write token of the server's project. The OVH
  keys are limited to the platform's zone (D49).
- One SSH key per machine and per use (D11, D12). For the agent:

  ```bash
  ssh-keygen -t ed25519 -f ~/.ssh/bivouac-claude -C bivouac-claude
  ```

A helper for the Hetzner API, used below (zsh). The token is read from its
file for each call:

```bash
hc() { curl -fsS -H "Authorization: Bearer $(cat ~/.config/bivouac/hetzner-token)" -H 'Content-Type: application/json' "https://api.hetzner.cloud/v1$1" "${@:2}"; }
```

## 1. Read-only inventory

Before changing anything, read the current state (GET only):

- `hc /servers`, `hc /primary_ips`, `hc /firewalls`, `hc /images?type=snapshot`.
- Server type availability: `hc '/server_types?name=cx23'`. Each entry of
  `locations` has `available` (an indicator, not a guarantee) and
  `deprecation`. A Primary IP can only be used by a server in its own
  location, so check the type is available in the IP's location.
- Prices: `hc /pricing` (net and gross, with the project's VAT rate). An
  existing server may be billed at an older price than a new one.
- DNS: list the zone's records through the OVH API
  (`GET /domain/zone/<zone>/record`, then each record by ID), including the
  existing SPF record. Note: with rights on `/domain/zone/<zone>/*`, reading
  `/domain/zone/<zone>` itself is refused; records and refresh are covered.

Record the result in the operations log.

## 2. Instance repo

1. The owner creates an empty **private** repo `bivouac-platform` on GitHub
   (one click; whether a fine-grained PAT can do it is still to check).
2. Copy `template/` into it, set `platform.yml` (`domain`) and add the public
   keys to `ssh-keys.yml` (the owner's key and `bivouac-claude`).
3. `node packages/bivy/dist/cli.js validate <instance-dir>`, then push. The
   instance repo's `Validate` workflow must be green.

## 3. age key and secrets

1. Generate the age master key. The owner runs this and stores the output in
   the password manager; the agent never sees it. Until `bivy` generates it
   itself (layer 5), `age-keygen` comes from Alpine's `age` package:

   ```bash
   (umask 077; docker run --rm alpine:3.24 sh -c 'apk add -q age >/dev/null && age-keygen' > ~/.config/sops/age/keys.txt)
   ```

   (create `~/.config/sops/age` with mode 700 first). The public key (the
   `# public key: age1…` line) goes into the instance repo's `.sops.yaml`.
2. Create the secrets file and encrypt it with SOPS in its container
   (`ghcr.io/getsops/sops:v3.13.3-alpine`). For layer 2 it holds the master
   secret (D14), Pocket ID's `ENCRYPTION_KEY` and `STATIC_API_KEY`, each
   generated randomly. **(not built yet)**: the exact file layout is set by
   the reconciler.
3. `bivy validate` checks the file is encrypted for exactly the keys in
   `.sops.yaml`, without decrypting it (D35).

## 4. Flatcar snapshot

There is no official Flatcar image at Hetzner. `hcloud-upload-image` creates
a temporary server, writes the image to its disk, takes a snapshot and deletes
the server. It costs a few cents. Pin both the tool and the Flatcar version
(current stable: check `https://stable.release.flatcar-linux.net/amd64-usr/current/version.txt`).

The tool's temporary server defaults to `cx23` in `fsn1`: pass a location
where that type is available (`--location`), or another x86 type
(`--server-type`).

```bash
HCLOUD_TOKEN="$(cat ~/.config/bivouac/hetzner-token)" docker run --rm -e HCLOUD_TOKEN \
  ghcr.io/apricote/hcloud-upload-image:v1.5.0 upload \
  --image-url https://stable.release.flatcar-linux.net/amd64-usr/<version>/flatcar_production_hetzner_image.bin.bz2 \
  --architecture x86 --compression bz2 --location nbg1 \
  --description flatcar-stable-<version> \
  --labels os=flatcar,flatcar-channel=stable,flatcar-version=<version>
```

The snapshot ID is printed at the end; `hc '/images?type=snapshot&label_selector=os=flatcar'`
lists them. From memory, to check: a snapshot can be used in any location.

## 5. Ignition

```bash
node packages/bivy/dist/cli.js ignition <instance-dir> -o ignition.json
```

The result must stay under 32 KiB (Hetzner's `user_data` limit). It contains
no secret: user-data can be read from the server (D7).

**(not built yet)**: the Butane gains the reconciler at an exact version, the
instance repo's address, the block on the metadata service from Docker
networks (D7), and the hook that applies SSH keys written by the reconciler.

## 6. Server

Two cases. Either way, check the Primary IPv4 has `auto_delete=false`
**before** deleting or rebuilding anything, otherwise the IP is lost with the
server:

```bash
hc /primary_ips/<ipv4-id> -X PUT -d '{"auto_delete": false}'
```

**A. Reinstalling an existing server in place (consent)**: keeps the server,
its type, location, price and IPs, and **erases its disk**. `rebuild` takes
the snapshot and the Ignition as `user_data`; the server is powered off
automatically first.

```bash
hc /servers/<id>/actions/rebuild -X POST -d "$(jq -n --arg ud "$(cat ignition.json)" '{image: <snapshot-id>, user_data: $ud}')"
```

**B. New server with an existing Primary IP (consent if an old server is
deleted)**: the IP must be unassigned (the old server deleted or the IP
unassigned while it is off) and in the same location as the new server.

```bash
hc /servers -X POST -d "$(jq -n --arg ud "$(cat ignition.json)" '{name: "bivouac", server_type: "cx23", location: "<location>", image: "<snapshot-id>", user_data: $ud, firewalls: [{firewall: <firewall-id>}], public_net: {enable_ipv4: true, enable_ipv6: true, ipv4: <ipv4-id>}}')"
```

(`jq` is included in recent macOS, as `/usr/bin/jq`.)

Then, in both cases:

- Name the server: `hc /servers/<id> -X PUT -d '{"name": "bivouac"}'`.
- IPv6 (D26), if the server has none: create a Primary IPv6 assigned to it,
  while it is powered off (`shutdown`, wait for `off`):
  `hc /primary_ips -X POST -d '{"name": "bivouac-ipv6", "type": "ipv6", "assignee_type": "server", "assignee_id": <id>, "auto_delete": false}'`,
  then `poweron`.

## 7. Firewall (consent)

Inbound 22/tcp, 80/tcp, 443/tcp and 443/udp from everywhere, everything else
blocked. Hetzner's firewall filters before the server, so Docker's iptables
rules cannot bypass it.

```bash
RULES='[{"description":"SSH","direction":"in","protocol":"tcp","port":"22","source_ips":["0.0.0.0/0","::/0"]},{"description":"HTTP","direction":"in","protocol":"tcp","port":"80","source_ips":["0.0.0.0/0","::/0"]},{"description":"HTTPS","direction":"in","protocol":"tcp","port":"443","source_ips":["0.0.0.0/0","::/0"]},{"description":"HTTP/3","direction":"in","protocol":"udp","port":"443","source_ips":["0.0.0.0/0","::/0"]}]'
```

- An existing firewall: `hc /firewalls/<id>/actions/set_rules -X POST -d "{\"rules\": $RULES}"`
  (replaces every rule).
- A new one: `hc /firewalls -X POST -d "{\"name\": \"bivouac\", \"rules\": $RULES, \"apply_to\": [{\"type\": \"server\", \"server\": {\"id\": <id>}}]}"`.

ICMP (ping) is not allowed: it is not needed, and its absence only makes
diagnosis from outside a little harder.

## 8. First login and keys on the server

1. `ssh -i ~/.ssh/bivouac-claude core@<ipv4>`: the host key is new, check it
   against the server's console output if in doubt.
2. Check: Flatcar version (`cat /etc/os-release`), Docker version, sshd
   settings (`sudo sshd -T | grep -Ei 'permitrootlogin|passwordauth|kbdinteractive'`).
3. Deploy key: generate a key pair on the Mac in a temporary folder, add the
   public key to the instance repo as a **read-only** deploy key (repo
   settings), copy the private key to the server, then delete the local copy.
   `bivy` will do this through the GitHub API (D30).
4. Copy the age key and the deploy key, never through user-data (D7):

   ```bash
   ssh core@<ipv4> 'sudo install -m 600 /dev/stdin /etc/bivouac/age.key' < ~/.config/sops/age/keys.txt
   ```

   ```bash
   ssh core@<ipv4> 'sudo install -m 600 /dev/stdin /etc/bivouac/deploy_key' < <temporary-folder>/deploy_key
   ```

5. Check the metadata service is blocked from containers
   **(not built yet)**: `docker run --rm alpine:3.24 wget -qO- -T 3 http://169.254.169.254/hetzner/v1/metadata`
   must fail, while `curl -s http://169.254.169.254/hetzner/v1/metadata` on
   the host works.

## 9. DNS (consent)

Through the OVH API: `POST /domain/zone/<zone>/record` with
`{"fieldType": "A", "subDomain": "*.<sub>", "target": "<ipv4>", "ttl": 3600}`,
the same with `AAAA` for the IPv6, then `POST /domain/zone/<zone>/refresh`.
Requests are signed (`X-Ovh-Application`, `X-Ovh-Consumer`, `X-Ovh-Timestamp`,
`X-Ovh-Signature`). Read the zone first; never add a second SPF record: modify
the existing one (Brevo, later in this layer).

Check from the Mac: `dig +short anything.<domain> A`.

## 10. Base services and first admin

**(not built yet)**: the reconciler starts Caddy, Postgres and Pocket ID.
Then:

1. Caddy allows `/setup` on `auth.<domain>` only from the owner's IP (D15).
2. The owner opens `https://auth.<domain>/setup`, creates the admin account
   and registers at least two passkeys.
3. The `/setup` route is removed from the Caddyfile.

Record everything done in the instance repo's operations log.
