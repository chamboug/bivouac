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
   generated randomly, in `secrets/platform.sops.yaml` (layout: D57). Generate
   and encrypt in one pipe, so no value is ever shown or written in plain
   text:

   ```bash
   R=$(grep -o 'age1[0-9a-z]*' .sops.yaml)
   { printf 'master_secret: %s\n' "$(openssl rand -hex 32)"
     printf 'pocket_id:\n  encryption_key: %s\n' "$(openssl rand -base64 32)"
     printf '  static_api_key: %s\n' "$(openssl rand -hex 32)"; } |
     docker run --rm -i ghcr.io/getsops/sops:v3.13.3 encrypt --input-type yaml \
       --output-type yaml --age "$R" /dev/stdin > secrets/platform.sops.yaml
   ```
3. `bivy validate` checks the file is encrypted for exactly the keys in
   `.sops.yaml`, without decrypting it (D35).

## 4. Flatcar snapshot

There is no official Flatcar image at Hetzner. `hcloud-upload-image`
(v1.5.0, read at its tag; D65) creates a temporary SSH key and server, both
named `hcloud-upload-image-<random>` and labelled
`apricote.de/created-by=hcloud-upload-image`, boots the server into the rescue
system, erases its disk, writes the image, takes a snapshot, then deletes the
server and the key. It costs a few cents. Verified (Hetzner FAQ): a snapshot is
not bound to a location; the server it later goes to must have the same
architecture.

1. **Pick the version** (stable channel, an exact version):

   ```bash
   curl -fsSL https://stable.release.flatcar-linux.net/amd64-usr/current/version.txt | grep FLATCAR_VERSION=
   ```

2. **Download and verify the image on the Mac**, in a new empty folder
   (`V=<version>`). Flatcar signs the list of checksums with its image signing
   key (primary key `F88CFEDEFF29A5B4D9523864E25D9AED0593B34A`, ID
   `E25D9AED0593B34A`, published at `https://www.flatcar.org/security/image-signing-key/`).
   The check runs in a throwaway container:

   ```bash
   B=https://stable.release.flatcar-linux.net/amd64-usr/$V/flatcar_production_hetzner_image.bin.bz2
   curl -fsSL -o image.bin.bz2 "$B" && curl -fsSL -o image.DIGESTS.asc "$B.DIGESTS.asc" &&
     curl -fsSL -o flatcar.asc https://www.flatcar.org/security/image-signing-key/Flatcar_Image_Signing_Key.asc
   docker run --rm -v "$PWD:/w:ro" alpine:3.24 sh -euc '
     apk add -q gnupg >/dev/null; export GNUPGHOME=$(mktemp -d); gpg -q --import /w/flatcar.asc
     gpg --status-fd 1 -o /tmp/d --decrypt /w/image.DIGESTS.asc 2>/dev/null |
       grep -q "VALIDSIG .* F88CFEDEFF29A5B4D9523864E25D9AED0593B34A$" && echo signature OK
     [ "$(awk "/SHA512/{getline; print \$1}" /tmp/d)" = "$(sha512sum /w/image.bin.bz2 | cut -d" " -f1)" ] && echo sha512 OK'
   ```

   Both lines must print OK. The tool itself checks nothing: it writes
   whatever it is given, which is why the verified file is sent rather than a
   URL (`--image-url` would make the temporary server download it unchecked).

3. **A temporary token.** The tool receives a token that can do anything in
   the project (Hetzner tokens cannot be narrowed). The owner creates a
   dedicated Read & Write token in the console (Security → API tokens), stores
   it in `~/.config/bivouac/hetzner-token-upload` with the `read -s` command of
   section 0 (in a real terminal), and deletes it once the snapshot exists.

4. **Protect what exists (consent)**, so that a mistaken deletion fails:
   `hc /servers/<id>/actions/change_protection -X POST -d '{"delete": true, "rebuild": true}'`
   and `hc /primary_ips/<ipv4-id>/actions/change_protection -X POST -d '{"delete": true}'`.
   It does not stop a malicious tool, which could lift it first. Lift the
   server's protection again before a rebuild (section 6).

5. **Run the tool (consent)**, pinned by digest (the image is not signed, and a
   tag can be pushed again). `--server-type` sets the architecture; pick an
   x86 type available in the chosen location with a disk no larger than the
   final server's (from memory: a snapshot only goes to a disk at least as
   large as its own). The default `cx23` was available nowhere on
   7 November 2026.

   ```bash
   HCLOUD_TOKEN="$(cat ~/.config/bivouac/hetzner-token-upload)" docker run --rm --read-only \
     --cap-drop ALL --security-opt no-new-privileges -e HCLOUD_TOKEN \
     -v "$PWD/image.bin.bz2:/image.bz2:ro" \
     ghcr.io/apricote/hcloud-upload-image@sha256:1cd09ab0e26662a8c244e76a52c1d2f436de27681ca4d56d99d9cc6de1175078 \
     upload --image-path /image.bz2 --compression bz2 --server-type cpx12 --location fsn1 \
     --description flatcar-stable-$V --labels os=flatcar,flatcar-channel=stable,flatcar-version=$V
   ```

   Never pass `-v`. If the run is interrupted (Ctrl-C, sleep), the tool does
   not clean up: run the same image with `cleanup`, which deletes every server
   and SSH key carrying its label, and never images.

6. **Check for leftovers** (GET only): no server, SSH key or Primary IP
   labelled `apricote.de/created-by`, besides the snapshot itself
   (`hc '/images?type=snapshot&label_selector=os=flatcar'`: status
   `available`, architecture `x86`, the expected labels). The existing server
   and IPs are unchanged. Then the owner deletes the temporary token (console,
   then `rm ~/.config/bivouac/hetzner-token-upload`), and the local image
   files are deleted.

Observed (7 November 2026, 4757.2.3): the run took about 5 minutes; the
snapshot has `disk_size` 40 (the temporary server's disk) and is stored as
0.55 GB, about €0.01 a month. Hetzner labels it `os_flavor: ubuntu`, inherited
from the temporary server's unused image; from memory, to check at first
boot: it changes nothing, since Flatcar reads its Ignition from the metadata
service itself.

## 5. Ignition

```bash
node packages/bivy/dist/cli.js ignition <instance-dir> -o ignition.json
```

`bivy` refuses a result above 32 KiB (Hetzner's `user_data` limit); it is
about 5.6 KB. It contains no secret: user-data can be read from the server
(D7). It starts the reconciler at the version and with the repo address of
`platform.yml` (D60), loads the metadata block before Docker (D62), and
installs the hook that applies the SSH keys written by the reconciler (D63).

Checks after the first boot (over SSH, read-only except the Docker restart
and the reboot, which are announced first):

```bash
# The metadata service: refused from a container, answered on the host.
docker run --rm alpine:3.24 wget -T3 -qO- http://169.254.169.254/hetzner/v1/userdata   # must fail
curl -s http://169.254.169.254/hetzner/v1/userdata | head -c 40; echo                  # must answer
sudo nft list table inet bivouac_metadata                                               # counter > 0
systemctl list-dependencies docker.service | grep bivouac-metadata-block
# SSH keys: applied, only the `bivouac` fragment left, still able to log in.
sudo cat /var/lib/bivouac/ssh-status/applied
ls ~core/.ssh/authorized_keys.d/
# The reconciler: its version and its last passes.
systemctl show bivouac-reconciler -p Environment; docker logs --tail 20 bivouac-reconciler
```

Repeat the metadata checks after `sudo systemctl restart docker` and after a
reboot.

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
automatically first. If the server is protected (section 4), lift its
protection first (`{"delete": false, "rebuild": false}`: the API requires
both to have the same value, verified) and set it again afterwards.

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

## 11. Rescue: no SSH key works any more (consent)

For when nobody can log in as `core` (a wrong `ssh-keys.yml`, a lost
machine, a broken key sync). Hetzner's rescue system boots a small Debian
from the network; the server's disk is untouched and can be mounted. Tried
on 8 November 2026 (D63). About 3 minutes of downtime, free.

1. **Fix Git first.** The reconciler writes `ssh-keys.yml` to the server on
   every pass: a key repaired by hand comes back wrong if the list in the
   instance repo is wrong. Correct and merge it, if possible.
2. **A temporary Hetzner SSH key** holding a public key that still exists on a
   machine at hand (Hetzner only injects keys it knows into the rescue
   system):
   `hc /ssh_keys -X POST -d "$(jq -n --arg k "$(cat ~/.ssh/<key>.pub)" '{name:"bivouac-rescue-temp", public_key:$k}')"`.
3. **Limit SSH to the owner's IP** for the duration: the rescue system's sshd
   accepts passwords (observed: `passwordauthentication yes`), and its
   password is returned by the API. Replace the SSH rule's `source_ips` with
   the Mac's IPv4 `/32` and IPv6 `/64` (`set_rules`, section 7).
4. **Boot into rescue**: `enable_rescue` with `{"type":"linux64","ssh_keys":[<key-id>]}`
   (never print the response: it holds `root_password`; filter it with
   `jq`), then `shutdown`, wait for `off`, `poweron`. Delete or rebuild
   protection does not need to be lifted.
5. **Log in as `root`** with a separate known_hosts file: the rescue system
   has its own host keys, which must never go into the platform's
   known_hosts. Nothing secret is sent to it.
6. **Mount Flatcar's root partition**: `mount /dev/disk/by-partlabel/ROOT /mnt`
   (read-only, `-o ro`, to look first). Keys are in
   `/mnt/home/core/.ssh/`: sshd reads only `authorized_keys`, which
   `update-ssh-keys` regenerates from the fragments in `authorized_keys.d/`
   (`bivouac` is the reconciler's). To repair: remount read-write, put the
   right public keys in both `authorized_keys.d/bivouac` and
   `authorized_keys` (owner `500:500`, `core` on Flatcar, mode 644), then
   `umount`.
7. **Back to Flatcar**: `reboot` from the rescue system (rescue mode turns
   itself off at the first boot into it; observed: `reboot` printed a D-Bus
   error and still rebooted). Wait for Flatcar's own host key (the one in
   the platform's known_hosts), then log in as `core`.
8. **Put everything back** and check through the API: the SSH rule open to
   everyone again, the temporary key deleted, `rescue_enabled` false.

Anyone holding a Hetzner token of the project can do the same and read the
whole disk, the age key included: the Hetzner account is as sensitive as
the server itself.
