# Runbook: installing a Bivouac server by hand

This is the manual procedure for installing the base of a Bivouac server
(layer 2 of the build order). `bivy init` now automates sections 2 to 10 for
a new platform in an empty Hetzner project (section 19), and `bivy rebuild`
brings an existing one back (sections 15 and 16). The manual steps stay
here: they say what bivy does, and they are the way back when it cannot.
Every step that changes something outside the Mac is announced first.

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
- Run by the reconciler: Caddy, Postgres and Pocket ID, then nightly backups and alerts (section 12).

## 0. Prerequisites on the Mac

- Docker and Node LTS (see `.nvmrc`). Butane, SOPS and the image upload tool
  run in containers; nothing else is installed.
- This repo, built: `npm ci && npm run build`.
- Credentials in `~/.config/bivouac/`, one value per file, mode 600 (D93).
  **`bivy` asks for each one itself** the first time a command needs it, with
  hidden input, and writes the file; the next commands read it there. Delete
  the file to type a value again. A script (or Claude) is never asked: the
  command stops and says which file is missing. The age key stays in
  `~/.config/sops/age/keys.txt`, where SOPS reads it; on a computer without
  it, `bivy rebuild` lets the owner paste it and checks it is the instance's.
- Values only the manual steps below use (the OVH keys, until `bivy` asks for
  them; the temporary upload token of section 4) are typed the same way by
  hand, in a real terminal, so they never show on screen or in the history:

  ```bash
  mkdir -p ~/.config/bivouac && chmod 700 ~/.config/bivouac
  ```

  ```bash
  for n in ovh-application-key ovh-application-secret ovh-consumer-key; do read -rs "v?$n : "; echo; (umask 077; printf '%s' "$v" > ~/.config/bivouac/$n); done; unset v; ls -l ~/.config/bivouac
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
   it in `~/.config/bivouac/hetzner-token-upload` with the hidden-input command
   of section 0 (in a real terminal), and deletes it once the snapshot exists.

4. **Protect what exists (consent)**, so that a mistaken deletion fails:
   `hc /servers/<id>/actions/change_protection -X POST -d '{"delete": true, "rebuild": true}'`
   and `hc /primary_ips/<ipv4-id>/actions/change_protection -X POST -d '{"delete": true}'`.
   It does not stop a malicious tool, which could lift it first. Lift the
   server's protection again before a rebuild (section 7).

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
about 5.8 KB. It contains no secret: user-data can be read from the server
(D7); check it anyway (`grep -Ei 'PRIVATE KEY|AGE-SECRET-KEY'` must find
nothing). It starts the reconciler at the version and with the repo address
of `platform.yml` (D60), loads the metadata block before Docker (D62),
installs the hook that applies the SSH keys written by the reconciler (D63),
and configures the server's IPv6 (D66).

**IPv6**: Flatcar only configures DHCPv4 on Hetzner. The IPv6 is static
(metadata service, `network-config`: the `/64` with `::1`, gateway
`fe80::1`), so the instance's Butane writes a drop-in for Flatcar's default
network file, `/etc/systemd/network/zz-default.network.d/10-bivouac-ipv6.conf`.
The address is the server's Primary IPv6: create that IP (section 7) before
generating the Ignition, and change the Butane if the IP ever changes.

## 6. Firewall (consent)

Applied **before** the server is (re)installed, so Flatcar is never exposed
on anything else. Inbound 22/tcp, 80/tcp, 443/tcp and 443/udp from
everywhere, everything else blocked, ICMP included. Hetzner's firewall
filters before the server, so Docker's iptables rules cannot bypass it; it
is attached to the server, not its disk, and survives a rebuild (observed).

1. Write the current rules to the operations log first (the full JSON of
   `hc /firewalls/<id>`), so they can be put back.
2. Apply:

   ```bash
   RULES='[{"description":"SSH","direction":"in","protocol":"tcp","port":"22","source_ips":["0.0.0.0/0","::/0"]},{"description":"HTTP","direction":"in","protocol":"tcp","port":"80","source_ips":["0.0.0.0/0","::/0"]},{"description":"HTTPS","direction":"in","protocol":"tcp","port":"443","source_ips":["0.0.0.0/0","::/0"]},{"description":"HTTP/3","direction":"in","protocol":"udp","port":"443","source_ips":["0.0.0.0/0","::/0"]}]'
   ```

   - An existing firewall: `hc /firewalls/<id>/actions/set_rules -X POST -d "{\"rules\": $RULES}"`
     (replaces every rule), then `hc /firewalls/<id> -X PUT -d '{"name":"bivouac"}'`.
   - A new one: `hc /firewalls -X POST -d "{\"name\": \"bivouac\", \"rules\": $RULES, \"apply_to\": [{\"type\": \"server\", \"server\": {\"id\": <id>}}]}"`.
3. Wait for the `apply_firewall` action to be `success`, then check from the
   Mac that only those ports answer (`nc -z -G 4 <ip> <port>`).

## 7. Server

Check the Primary IPv4 has `auto_delete=false` **before** deleting or
rebuilding anything, otherwise the IP is lost with the server:
`hc /primary_ips/<ipv4-id> -X PUT -d '{"auto_delete": false}'`.

**A. Reinstalling an existing server in place (consent)**, as done on
8 November 2026: keeps the server, its type, location, price, IPs and
firewall, and **erases its disk**.

1. **Power off and add the IPv6 (consent)** if the server has none: a Primary
   IP can only be assigned to a server that is off (verified, API spec).
   `shutdown` (ACPI; `poweroff` only if it is not `off` after two minutes),
   then:

   ```bash
   hc /primary_ips -X POST -d '{"name": "bivouac-ipv6", "type": "ipv6", "assignee_type": "server", "assignee_id": <id>, "auto_delete": false}'
   hc /primary_ips/<ipv6-id>/actions/change_protection -X POST -d '{"delete": true}'
   hc /servers/<id> -X PUT -d '{"name": "bivouac"}'
   ```

   A Primary IPv6 is free (absent from `/pricing`). The server stays off.
2. **Generate the Ignition** (section 5) with this IPv6 in the Butane.
3. **Rebuild (consent)**. The image is given as a string (the snapshot ID);
   without `user_data`, the API reuses the server's previous one. The
   response holds a `root_password`: never print it. Lift the server's
   protection (`delete` and `rebuild` must have the same value), rebuild,
   and put the protection back **whatever the outcome**:

   ```bash
   hc /servers/<id>/actions/change_protection -X POST -d '{"delete": false, "rebuild": false}'
   AID=$(hc /servers/<id>/actions/rebuild -X POST -d "$(jq -n --arg ud "$(cat ignition.json)" '{image: "<snapshot-id>", user_data: $ud}')" | jq -r '.action.id // empty')
   # wait for: hc /servers/actions/$AID  ->  status success
   hc /servers/<id>/actions/change_protection -X POST -d '{"delete": true, "rebuild": true}'
   ```

   Observed: 25 to 35 s, the server comes back `running` on its own, SSH
   answers a few seconds later. Check through the API: same type, location
   and IPs, `image` is the snapshot, firewall applied, protection set.
   Until the keys of section 8 are placed, rebuilding again is the universal
   way back (a broken Ignition, no SSH access); each rebuild creates a new
   SSH host key.

**B. New server with an existing Primary IP (consent if an old server is
deleted)**: the IP must be unassigned (the old server deleted or the IP
unassigned while it is off) and in the same location as the new server.
Create the firewall and the Primary IPv6 first, and pass both:

```bash
hc /servers -X POST -d "$(jq -n --arg ud "$(cat ignition.json)" '{name: "bivouac", server_type: "<type>", location: "<location>", image: "<snapshot-id>", user_data: $ud, firewalls: [{firewall: <firewall-id>}], public_net: {enable_ipv4: true, enable_ipv6: true, ipv4: <ipv4-id>, ipv6: <ipv6-id>}}')"
```

(`jq` is included in recent macOS, as `/usr/bin/jq`.)

## 8. First login and keys on the server

SSH from the Mac always uses a known_hosts file of the platform's own,
never `~/.ssh/known_hosts`:

```bash
O=(-i ~/.ssh/bivouac-claude -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.config/bivouac/known_hosts -o BatchMode=yes)
ssh "${O[@]}" core@<ipv4> '<command>'
```

1. **Host key, never accepted blindly.** At boot, Flatcar writes the
   fingerprints of its host keys to the console's login prompt
   (`SSH host key: SHA256:… (ED25519)`, verified in Flatcar's `sshd_keygen`
   and `issuegen`). The owner opens the server's console in Hetzner's web
   console and reads the ED25519 line. On the Mac:
   `ssh-keyscan -t ed25519 <ipv4> > scan.txt; ssh-keygen -lf scan.txt`. Only
   if both fingerprints are identical, write **that same line** (not a second
   scan) to `~/.config/bivouac/known_hosts` (mode 600), with both addresses:
   `<ipv4>,<ipv6>::1 ssh-ed25519 AAAA…`.
2. **First-boot checks (read-only)**: `/etc/os-release`; `docker version`;
   `sudo sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|allowusers) '`
   (no, no, no, core); `systemctl --failed`; `sudo cat /etc/.ignition-result.json`
   (`userConfigProvided: true`); `timedatectl show -p NTPSynchronized`;
   `ip -br addr show eth0` and `ip -6 route show default` (the IPv6 and
   `fe80::1`); `sudo ss -tulpn` (only sshd on 22 before the base services);
   `sudo ls -la /etc/bivouac /var/lib/bivouac /opt/bivouac`;
   `sudo nft list table inet bivouac_metadata`;
   `systemctl list-dependencies docker.service | grep bivouac-metadata-block`;
   the metadata service answers on the host and is refused from a container
   (`docker run --rm alpine:3.24 wget -T3 -qO- http://169.254.169.254/hetzner/v1/userdata`
   must fail); `ls ~core/.ssh/authorized_keys.d/` (only `ignition` so far);
   `docker logs --tail 5 bivouac-reconciler` (each pass fails to clone:
   expected without a deploy key).
3. **Deploy key (consent), generated on the server** (D66): the private key
   never leaves it.

   ```bash
   ssh "${O[@]}" core@<ipv4> 'sudo ssh-keygen -q -t ed25519 -N "" -C bivouac-server -f /etc/bivouac/deploy_key && sudo cat /etc/bivouac/deploy_key.pub'
   ```

   The owner adds the public key in the instance repo: Settings → Deploy
   keys → Add deploy key, title `bivouac-server`, **"Allow write access"
   unchecked**, and confirms GitHub shows it "Read-only". (Through the API
   it would take a fine-grained PAT with "Administration: write" on the
   repo, verified.) Checks, from the reconciler's image with the GitHub host
   keys it pins:

   ```bash
   I=<reconciler image>; K=/app/packages/reconciler/github_known_hosts
   sudo docker run --rm --cap-drop NET_RAW --security-opt no-new-privileges -v /etc/bivouac/deploy_key:/k:ro --entrypoint git \
     -e GIT_SSH_COMMAND="ssh -i /k -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$K" \
     $I ls-remote <repository> refs/heads/main            # reads main
   sudo docker run --rm -i --cap-drop NET_RAW --security-opt no-new-privileges -v /etc/bivouac/deploy_key:/k:ro --entrypoint ssh \
     $I -i /k -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$K \
     git@github.com "git-receive-pack '<owner>/<repo>.git'" </dev/null
   ```

   The second command sends nothing; GitHub answers "The key you are
   authenticating with has been marked as read only". Reconciler versions
   before `sha-461e530` only look for the key at startup:
   `sudo systemctl restart bivouac-reconciler` for those.
4. **First SSH key sync**, with a second SSH session kept open as a safety
   net (a master connection: `ssh "${O[@]}" -M -S <short path> -o ControlPersist=2h -fN core@<ipv4>`;
   macOS limits socket paths to 104 bytes). The next pass writes the list;
   `bivouac-ssh-keys.path` applies it within a second: the `bivouac` set is
   added, `ignition` removed. Check `sudo cat /var/lib/bivouac/ssh-status/applied`
   (`applied <sha256>`), `ls ~core/.ssh/authorized_keys.d/` (only
   `bivouac`), and a **new** login without the master connection
   (`-o ControlPath=none`). The pass then stops at "the age key is missing":
   expected.
5. **age key (consent)**, through standard input, never on a command line
   or the screen; then compare hashes without printing them:

   ```bash
   ssh "${O[@]}" core@<ipv4> 'sudo test -e /etc/bivouac/age.key && exit 1; sudo sh -c "umask 077; cat > /etc/bivouac/age.key.tmp && mv /etc/bivouac/age.key.tmp /etc/bivouac/age.key"' < ~/.config/sops/age/keys.txt
   L=$(shasum -a 256 < ~/.config/sops/age/keys.txt | cut -d' ' -f1); R=$(ssh "${O[@]}" core@<ipv4> 'sudo sha256sum /etc/bivouac/age.key' | cut -d' ' -f1)
   [ -n "$L" ] && [ "$L" = "$R" ] && echo identical || echo DIFFERENT; unset L R
   ```

   If different, delete the file on the server. The next pass starts the
   networks, Postgres, Pocket ID and Caddy (about 1.5 minutes, three
   containers `healthy`, about 730 MB of memory).
6. **Checks with the base running**: from the Mac, over IPv4 and IPv6, only
   22, 80 and 443 answer (2019, 5432, 1411 closed); `http://<ipv4>/` answers
   308 to HTTPS; the generated Caddyfile (`/var/lib/bivouac/caddy/Caddyfile`)
   refuses `/setup` and `/api/signup/setup` before the proxy; Pocket ID is
   unreachable from the `bivouac` network; the metadata service is refused
   from the `bivouac` network too. Without DNS, Caddy cannot get a
   certificate: observed, two failures at Let's Encrypt's production
   endpoint (limit: 5 per name per hour), then retries against its staging
   endpoint, 60 s, 120 s and further apart (documented: at most one day
   apart). Restart Caddy once DNS exists rather than waiting.
7. **Restarts (consent)**: `sudo systemctl restart docker`, then
   `sudo systemctl reboot`; after each, the same checks plus the SSH key
   sync at boot. Observed: SSH back 18 s after a reboot, the base about a
   minute later; Pocket ID fails for about a minute first (D68).
8. **Reconciler self-update** (D61), checked on a real version: change
   `reconciler.image` in `platform.yml`; within a pass, the reconciler logs
   "moving to a new reconciler version", writes
   `/var/lib/bivouac/reconciler/image.env`, exits and comes back on the new
   image.

   **Moving to a new version**: once CI on the monorepo's `main` is green for
   the commit (it publishes `sha-<commit>` and `v1.0.<n>`), run `bivy pin
   reconciler <commit>` in the instance repo (D106). It finds the digest of
   the index on GHCR and the release tag with the same digest, writes
   `ghcr.io/<owner>/bivouac-reconciler:v1.0.<n>@sha256:<digest>` in
   `reconciler.image` (that line only; Renovate follows that tag, D109; a
   version from before 21 Nov. 2026 has only its `sha-` tag, written with a
   warning), runs the checks of `bivy validate`,
   and prints the old and new values; then commit and push. The way back is
   the old value, written back the same way. The new version is **on trial**
   (`reconciler/trial.env`) until its first pass; `journalctl -u
   bivouac-reconciler` shows "on trial: start n of 3" from
   `/opt/bivouac/reconciler-trial`. If it fails three starts, the fourth goes
   back to the previous version, which logs "failed its trial: rolled back"
   and alerts until `platform.yml` names another version (`refused.env`).
   A version whose first pass leaves a Caddy or Postgres it recreated
   unhealthy goes back the same way by itself, with the reason in
   `refused.env` (D109). Not for Pocket ID: an older one refuses the
   database a newer one migrated.
   **By hand** (never delete `image.env`: the unit's own version can be
   months old): `sudo sh -c 'umask 077; echo BIVOUAC_RECONCILER_IMAGE=<image>
   > /var/lib/bivouac/reconciler/image.env; rm -f
   /var/lib/bivouac/reconciler/trial.env'`, then `sudo systemctl restart
   bivouac-reconciler`.

   **A server installed before D61's fallback** (14 November 2026) gets the
   script and the drop-in by hand, as the Butane writes them: `/opt/bivouac/reconciler-trial`
   (root, 0700) and
   `/etc/systemd/system/bivouac-reconciler.service.d/20-bivouac-trial.conf`,
   then `sudo systemctl daemon-reload` (no restart needed: it applies at the
   next start). Way back: remove both, `daemon-reload`.

## 9. DNS (consent)

Through the OVH API: `POST /domain/zone/<zone>/record` with
`{"fieldType": "A", "subDomain": "*.<sub>", "target": "<ipv4>", "ttl": 3600}`,
then `POST /domain/zone/<zone>/refresh`. No `AAAA` record (D67, IPv4 only for
visitors, accepted): over IPv6, Caddy would not see the visitor's address.
Requests are signed (`X-Ovh-Application`, `X-Ovh-Consumer`, `X-Ovh-Timestamp`,
`X-Ovh-Signature`). Read the zone first; never add a second SPF record: modify
the existing one (Brevo, later in this layer).

The signature is `$1$` + the SHA-1 of
`<application secret>+<consumer key>+<METHOD>+<full URL>+<body>+<timestamp>`,
with the timestamp from `GET /auth/time` (verified, `python-ovh`). Node's
`fetch` on `eu.api.ovh.com` can fail TLS (D69); `curl` works.

**Before the write**, because a certificate exposes Pocket ID before it has an
admin (D69): list the zone into the operations log; check there is no CAA
record on the name or its parents, and no DS record unless DNSSEC is meant to
be on; have the first-admin paths reviewed (rule 6).

Check from the Mac, on the zone's name servers and on a public resolver:
`dig +short anything.<domain> A @<server>`, and that `AAAA` is empty. Observed:
published within 10 seconds of the refresh.

Then **(consent)** `docker restart bivouac-caddy`, and follow
`docker logs bivouac-caddy` until "certificate obtained successfully"
(observed: 6 s, Let's Encrypt production). Check, over HTTPS: a valid
certificate; `/setup` and `/api/signup/setup` in 403, with variants (case,
`%73`, `//`, dot segments with `curl --path-as-is`); no `signup/setup` line in
Pocket ID's logs. Pocket ID's logs (`ip=`) show the address it sees for each
request.

**Emergency stop** until the first admin exists: close 80/tcp, 443/tcp and
443/udp at the firewall (section 6). Removing the record closes nothing, and
the reconciler restarts a stopped Caddy.

## 10. Base services, first admin and mail

The reconciler already runs Caddy, Postgres and Pocket ID (section 8).
Once DNS answers, restart Caddy so it asks for its certificate at once,
then:

1. **(consent)** Allow `/setup` on `auth.<domain>` only from the owner's IP
   (D15): `auth.setupFrom` in `platform.yml`, a **public IPv4** read right before
   (`curl -4 https://api.ipify.org`); private addresses are refused (D67).
   Check the generated Caddyfile and a 403 from another address. The owner
   opens the page over IPv4 (no `AAAA` record). Some providers share one IPv4
   between subscribers (from memory): keep the window short.
2. The owner opens `https://auth.<domain>/setup`, creates the admin account
   and registers at least two passkeys that do not depend on the same vault.
   For a phone: in the admin's user list, **Login Code** gives a one-time link
   or QR code; open it on the phone, then **Add Passkey** in the account page.
   The same **Login Code** link is how anyone who lost their passkeys gets
   back in: the admin sends it through any messaging app; there is no email
   login code (D37). **If the admin lost every passkey**: the owner runs
   `bivy login-link <username or email>` in a terminal, from the instance
   repo (D107). It prints a sign-in link that works once, within one hour.
   It is a credential: `bivy` refuses to show it to a script or a pipe, Claude's
   ordinary shell included. Run it in a terminal app of its own, not in a
   terminal panel shared with Claude, which Claude can read; Claude never
   runs it. Give the username rather than the email (see D107). The owner opens the link, then
   adds a passkey at once (account page, **Add Passkey**). A disabled account
   is refused; an unknown one gets "no user with that username or email".
3. **(consent)** Remove `setupFrom`. Check 403 for everyone, the owner included,
   and exactly one user (`users` in database `bivouac_pocket_id`).
4. Mail (D70). `bivy configure mail` adds `mail` to `platform.yml` (`host`,
   `from`, `user`) and `mail.password` to the secrets, after logging in to the
   SMTP server with the password typed with hidden input (D99). A new `mail`
   block needs a reconciler version that knows it; it moves to it before
   validating. **Changing the password later** (the mailbox's was changed, or
   it may be known): `bivy secret set mail.password`, section 12, "Changing one
   secret" (D108).
5. **(consent, Pocket ID restarts, about a minute: D68)** Push (`bivy
   configure` pushes by itself: the consent comes before it runs). The owner clicks
   **Send test email** in Pocket ID's email settings. Read the message's
   `Authentication-Results`: SPF and DKIM must pass. Check the zone has one SPF
   record and a `p=none` DMARC.

Record everything done in the instance repo's operations log.

## 11. Rescue: no SSH key works any more (consent)

For when nobody can log in as `core` (a wrong `ssh-keys.yml`, a lost
machine, a broken key sync). A lost machine alone usually needs only a new
key pushed to Git (section 20); this is for when that does not work. Hetzner's rescue system boots a small Debian
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
   the Mac's IPv4 `/32` and IPv6 `/64` (`set_rules`, section 6).
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

## 12. Backups and alerts (consent)

Built in layer 3 (D73-D76). All of it is run by the reconciler; this section is
how to set it up, and how to act on it by hand.

**Accounts, by the owner**: a B2 account (the region is chosen at sign-up and
cannot be changed), with its master key at hand; a Pushover application and its
user key; a healthchecks.io account with three checks, connected to Pushover:
`heartbeat` (simple, period 5 minutes, grace 10), `backup` (cron `0 2 * * *`,
UTC, grace 3 h), `restore` (cron `0 2 * * 0`, UTC, grace 6 h). Don't ping them
by hand: a check starts counting at its first ping.

**Bucket and key, through B2's native API** (`/b2api/v3`), with the master key
typed in a real terminal: `b2_authorize_account` gives the S3 endpoint;
`b2_create_bucket` with `bucketType: allPrivate` and the lifecycle rule
`{"daysFromHidingToDeleting": 30, "daysFromUploadingToHiding": null, "fileNamePrefix": ""}`;
`b2_create_key` limited to that bucket with `listBuckets`, `listAllBucketNames`,
`readBuckets`, `listFiles`, `readFiles`, `writeFiles`. Then the owner generates
a new master key, which voids the one typed.

In API v4 the key's bucket restriction is `bucketIds`, a list; check the
capabilities and the bucket in the response. A new account may answer
`Account ineligible for bucket creation` until its email address is verified:
the interface asks for it when a bucket is created there.

**Moving the backups to another account or region** (done once, D73): new
bucket and key as above; `restic init` from the Mac on the new repository with
the **same** restic password (the reconciler never creates a repository once a
backup has succeeded, D74); force a last backup to the old one; replace
`backup.b2_key_id` and `backup.b2_application_key` with `bivy secret set`
(below, "Changing one secret") and `backup.repository` in one commit; force a backup and a restore test
(`.day=0 | del(.restoreWeek)`) and check the copy with `restore-app <app> --list`.
Keeping the old account readable for a while is the owner's call: it holds the only history from before the move. Way back, while it exists: revert that commit.

**Secrets**, added by `bivy configure backups` and `bivy configure alerts`
(D99): `backup.{restic_password, b2_key_id, b2_application_key}` and
`alerts.{pushover_token, pushover_user, healthchecks.{heartbeat, backup, restore}}`.
The restic password also goes in the owner's password manager. In
`platform.yml`: `backup.repository: s3:<endpoint>/<bucket>`.

**Changing one secret** (D108), from the instance repo on the Mac, with the
age key in `~/.config/sops/age/keys.txt`. First make the new value where it
lives (a new key at B2, a new Pushover token, the mailbox's new password),
then:

```bash
bivy secret set mail.password
```

The value is pasted (or typed) twice with hidden input, in a real terminal
(never the chat's `!`); an empty value is refused. bivy decrypts the file, changes that value only, encrypts it
again for `.sops.yaml`'s key, decrypts what it wrote and compares every value
by its hash, never printing one; if anything differs, the previous file is
put back. It commits nothing: commit and push (the diff shows names only),
and the reconciler applies it within a minute. When Claude drives it, the
owner pastes the value from the password manager into a file, in a real
terminal; the line says how many characters it got, never the value, and
writes nothing for an empty paste. bivy deletes that file once the change is
checked (kept if it fails, so the command can be run again):

```bash
(umask 077; printf 'Paste the value, then Enter: '; read -rs v; echo; if [ -n "$v" ]; then printf '%s' "$v" > ~/.config/bivouac/new-secret && echo "Written: ${#v} characters."; else echo "Nothing pasted: nothing written."; fi; unset v)
```

```bash
bivy secret set mail.password --from-file ~/.config/bivouac/new-secret
```

What each change does once pushed: `mail.password` and
`pocket_id.static_api_key` restart Pocket ID (signing in pauses up to about a
minute, D68; send a test mail after a mail change); `backup.b2_key_id` and
`backup.b2_application_key` restart nothing and serve from the next backup
(change both together for a new key, push once, then `bivy backup`);
`alerts.*` restart nothing (try the channel, below); `ghcr.*` serve from the
next pull. bivy changes only a value already set (a missing part is `bivy
configure`) and never `master_secret` (every derived secret comes from it,
D14), `pocket_id.encryption_key` (a new one loses Pocket ID's signing keys,
D57) or `backup.restic_password` (the repository's own key must change first).

**A backup now**, instead of waiting for 02:00 UTC, from the instance repo on
the Mac (D105):

```bash
bivy backup                  # the night's job, followed to its end (a few minutes)
bivy backup --restore-test   # and the weekly restore test right after
```

Before any change that can lose data (D89). It starts at the reconciler's next
pass, within a minute, or after a restore of an app that holds the lock.
Ctrl-C or a lost connection leaves the backup running: `bivy status` shows how
it ended. An app with `backup: { stop: true }` is stopped during it, as at
night.

**By hand**, for the clean-up or a server whose reconciler predates
`bivy backup`: the state is read when the
reconciler starts, and the alert state is written back on every pass. So stop
the reconciler, change the file, then start it again
(`sudo systemctl stop bivouac-reconciler`, edit, `start`):

```bash
sudo sh -c 'umask 077; f=/var/lib/bivouac/backup/state.json; jq -c ".day=0 | del(.restoreWeek)" $f > $f.new && mv $f.new $f'
```

`.day=0` makes the backup due, `del(.restoreWeek)` the restore test,
`del(.maintenanceWeek)` the clean-up. Follow `docker logs bivouac-reconciler`
(`backup done`, `old backups cleaned up`, `restore test passed`). On a new
server, the first backup otherwise waits for the next night, on purpose (D74).

**Reading the repository from the Mac**: decrypt the values into environment
variables, never on a command line, and use `restic --no-lock`, pinned by the
digest in `packages/manifest/src/platform.ts`. Never write a decrypted dump to
a shared directory: it holds the data.

**Testing the channel**: `docker exec bivouac-reconciler node packages/reconciler/dist/main.js alert-test`
sends one message.

**Rehearsing the alerts** (D82), one at a time, each with its way back. A
reconciler alert comes after 3 passes, its end after 3 clean ones:

- quarterly reminder: `.rebuildReminder` moved back more than 90 days in
  `/var/lib/bivouac/alerts/state.json`;
- disk: `sudo fallocate -l <size> /var/tmp/<file>` to pass 80%, then remove it;
- secrets: rename `/etc/bivouac/age.key` in its directory, rename it back, and
  compare its hash without printing it;
- silent server: stop the reconciler for about 15 minutes, with a
  `systemd-run --on-active` restart as a safety net;
- failed backup: a missing bucket in `backup.repository`, `.day=0`, and the good
  address back within the hour, before the one automatic retry;
- failed deployment: an app whose image exits at once, with no database; remove
  the manifest, then the stopped container by hand (until layer 6);
- failed restore test: force a backup and a restore test (`.day=0`,
  `del(.restoreWeek)`), and `docker kill bivouac-restore-test` as soon as it
  appears; force them again for the end of the incident;
- missed backup ping: from healthchecks.io's side only. Send a success, then set
  a short schedule whose next time is still ahead. Setting a schedule that is
  already overdue marks the check down **without any alert**, on purpose. Put
  `0 2 * * *` and its 3 hours back afterwards.

**Recovering a hidden file** (from memory, not tried yet): deleting a file's
hide marker with `b2_delete_file_version` and a key holding `deleteFiles`
makes the previous version visible again, within 30 days. Left untried by
the owner's choice (D73, 16 November 2026).

## 13. App check, at each `bivy rebuild --test` (every 3 months)

Done by Claude in the session of the quarterly reminder (D44, D81). Apps are left alone between two checks: a finished app that stays on its versions is normal. Read only; a fix is proposed to the owner afterwards.

1. List the apps from `apps/*.yml` in the instance repo, and clone each app repo over SSH (the `gh` token only covers the two Bivouac repos).
2. In each app, compare `layersCommit` in `nuxt.config.ts` with the latest `app-layers-v*` tag. An app behind means Renovate is not reaching it, or its PR is stuck on red tests: find out why.
3. Run `npm audit --package-lock-only --json` and keep only **high and critical** advisories. An app created from the template starts with low and moderate ones (16 on 9 Nov. 2026): they are not to be chased.
4. An advisory counts only if all three hold:
   - the package runs in the image: the image holds `.output` and the migrations only, so look for it in `.output/server/node_modules` of a build, not in the lockfile;
   - it can be triggered from outside: by anyone on the internet, or only by invited users;
   - it affects how the app uses the package.
5. Look harder at apps in `public` or `local` mode: they are open to strangers.
6. Report to the owner in plain language, one line per app: nothing to do, or what to fix, why, and the risk. Fix only what is left after step 4.


## 14. Restoring one app's data (consent)

Built with D90. Brings **one** app's database and volumes back to a nightly
copy, without touching the other apps, Pocket ID or the reconciler's passes.

**The usual way, from the Mac** (D101), in the instance repo:

```bash
bivy restore            # asks the app, the copy and the part, shows the plan, then asks to type the app's name
bivy restore biblio --plan                   # only reads: what it would do, the disk needed and free
bivy restore biblio --list                   # only reads: every copy with its ID, older and safety copies included
bivy restore biblio --snapshot <id> --only database
```

It does everything below (the plan first, then the exact copy of the plan,
the disk check) and ends with the command that undoes it. The confirmation
is typed in a terminal: Claude only runs `--plan`.

**By hand on the server**, run by the reconciler itself through
`docker exec` (the `restore-app` command of `main.js`):

```bash
r=(docker exec bivouac-reconciler node packages/reconciler/dist/main.js restore-app)
"${r[@]}" <app> --list                                # the copies (UTC times)
"${r[@]}" <app>                                       # what it would do; changes nothing
"${r[@]}" <app> --before 2026-11-11 --yes             # latest nightly copy at or before that day (UTC)
"${r[@]}" <app> --snapshot <id> --yes                 # a copy named by --list
"${r[@]}" <app> --only database --yes                 # or --only files
```

Without `--yes`, nothing is changed. It is a data operation: the owner's
consent first, saying which copy and what will be lost. The plan (without
`--yes`) gives the disk needed and free, and a run with `--yes` refuses when
it is short (D101): about three times the database's size (safety dump,
restored dump, the new database beside the live one) plus 1 GiB. Volumes
are not counted: bringing back an emptied volume needs up to its size again,
so check `df -h /` for a large one. The replaced database is kept for good. After an interrupted
restore, only a restore of **all** the app's data (no `--only`) starts it
again (D94). Run it without `--yes`
first, then with `--yes` **and `--snapshot <id>`** of the copy it named: a
nightly copy finishing in between would otherwise change the choice. Do not
interrupt it (no `-t`, no Ctrl-C): if it is cut short anyway, restart the
reconciler (`sudo systemctl restart bivouac-reconciler`), which releases its
lock and marks the app as interrupted (below).

**What it does, in order** (each step only if the previous one worked):

1. Takes the lock shared with the nightly backup: one of them at a time. It
   refuses while a backup runs, and the backup waits for it.
2. Stops the app. Passes leave it alone while the lock names it.
3. **Safety copy**: the app's current dump and volumes are sent to restic,
   tagged `pre-restore` and `app:<app>`. If it fails, nothing was changed.
4. Database: the dump is loaded into `bivouac_restoring_<db>` **as the app's
   own role** (never as superuser: D75), then swapped with the live one in one
   transaction. The replaced one is kept as `bivouac_r<YYMMDDhhmmss>_<db>` (UTC).
   Right before the swap, and before each volume, it checks the app is still
   stopped (a deployment landing in the same minute could have started it).
5. Volumes: brought back in place (`restic restore --delete`, limited to that
   volume): files the copy does not have are removed, others rewritten only
   where they differ, owners kept.
6. Starts the app again and waits for its health check. The log ends with
   `restore done` and the command that undoes it.

**Data written since the copy** is no longer in the app, but is not lost: it
is in the safety copy and in the kept database. To put a few of those rows or
files back by hand, read them from there. To undo the whole restore:
`restore-app <app> --snapshot <safety copy> --yes`.

**Real cases:**

- **Things deleted by mistake yesterday**: `--before` the day before, or the
  copy from `--list` taken before the mistake. What was added since is no
  longer in the app (see above).
- **An update damaged the database**: first put the previous image back in
  `apps/<app>.yml` and wait for its deployment, otherwise the damaging
  version starts again on the restored data. Then `--only database`, with the
  last copy taken before the update. Migrations being additive (D21), the old
  image runs on the old database.
- **The volume disappeared**: the reconciler recreates it empty on its next
  pass. Then `--only files` with the latest copy, or both parts from the same
  copy if the database must match the files exactly.

**If it stops halfway** (error past step 3, or the reconciler restarted
during it): the app stays stopped and is reported as failed, with "a restore
of its data was interrupted", until a restore of it completes, which then
starts it. Run the same command again, or restore the safety copy named in
the error. Each app has its own mark (`backup/restore-interrupted-<app>.json`).

**Afterwards**: the kept database (`bivouac_r…`) is not backed up and stays
until the owner asks to drop it (`DROP DATABASE`, consent). `pre-restore`
copies are never removed by the weekly clean-up (only `nightly` and
`incomplete` ones are); remove them by hand when no longer wanted, with
consent. The kept database holds the database's size on disk until then.

**Rehearsing it** (done 13 November 2026, D90): with a throwaway app
`<app>-preview` (a real app's image, one group, its own volume), never with a
real app. Its user uploads a few files, force a backup (section 12), they
delete one, then restore without `--yes`, with `--yes --snapshot`, and undo
with the safety copy. Removing it afterwards, until layer 6: remove the
manifest (only its route goes), then by hand and with consent
`docker rm -f`, `docker volume rm`, `DROP DATABASE` of its database and of
its kept `bivouac_r…` ones, `DROP ROLE`, its OIDC client
(`DELETE /api/oidc/clients/<app>` with the static API key, decrypted in
memory), and `restic forget` of its `pre-restore` copies (from the Mac, with
the secrets in environment variables).

## 15. Rebuilding from the backups: `bivy rebuild --test` (D91)

A temporary copy of the platform, rebuilt from the latest `nightly` copy on a
server billed by the hour, checked against the real one, then deleted. Done
before the prod phase, then every 3 months with the app check of section 13.
It never touches the real server, its IPs, the DNS, or the backup repository
other than to read. Cost: a CX23 is about €0.01 an hour, plus a temporary IPv4.

**Before**: a nightly copy that succeeded (section 12). `bivy` asks, at the
start and before renting anything, for what it lacks: the Hetzner token, and a
**temporary GitHub token** (it prints the pre-filled creation link: one day,
"Administration: write", only the instance repo, kept in
`~/.config/bivouac/github-rebuild-token`). That permission can also delete the
repo: the end summary says to delete the token on GitHub, and `bivy` deletes
its own copy. The test's deploy key is deleted with it (GitHub docs).

**Apps that act on their own** run on the test server too, on a copy of
02:00 (D91's note of 15 November 2026). Before a test, look in each app for
timers or scheduled jobs that send something (notifications, mail, calls to
outside services). A test server cannot turn them off (D91, accepted): warn
the people they reach before the test. The instance's operations log lists the
known ones.

```bash
bivy rebuild --test <instance-dir>
```

`--ssh-key ~/.ssh/<key>` only for another key than the one `bivy` remembers
(D112).

**In a terminal, it asks** (D93), each question with the arrow keys, the
recommended answer first: what to do with an unfinished test (carry on,
delete what it created, quit); where the test server goes (a CX23 where one
can be ordered first, with the hourly price); which data comes back (the
latest nightly copy, or an older one chosen from the list once the server can
read the backups); then whether to rent the server now. The age key is found
before that. Each step is then one sentence with a spinner, and the end says
what is left to do. **Without a terminal** (a script, Claude), nothing is
asked: `--location`, `--server-type`, `--snapshot <id>` and `--yes` answer,
and the defaults are the CX23 where it can be ordered and the latest copy; an
unfinished test is carried on, or deleted with `--cleanup`.

`bivy`'s SSH reads neither `~/.ssh/config` nor the system's files, and never
asks for anything (`BatchMode`): a key with a passphrase must already be in
the agent (`ssh-add --apple-use-keychain <key>` on macOS).

1. It creates, all labelled `bivouac-rebuild-test=<run>`: a firewall open to
   the Mac's IPv4 only, a Primary IPv6, and a server from the Flatcar snapshot
   (CX23 where one can be ordered), whose Ignition carries that IPv6 and a
   **provisional SSH host key** made on the Mac (D91).
2. It checks the server presents that key, then, over the first connection
   (verified against it): the server makes its own host key, the Mac records
   it, the server puts it in place, and the Mac connects again with only that
   key known. Nothing else is sent before. No console to read.
3. It goes on, each step once (an interruption is resumed by running the same
   command): first-boot checks; the rebuild marker `{"mode":"test"}` in
   `/etc/bivouac/rebuild.json`; the deploy key generated on the server and
   added read-only; the age key (standard input, compared by hash); Postgres
   alone; `restore-platform` (below); Pocket ID, Caddy and the apps; then the
   checks: Pocket ID publishes the **same signing keys** as the real server,
   and each app answers its health check through Caddy.
4. Without `--keep`, it deletes everything it created and checks nothing with
   its label is left. `bivy rebuild --test --cleanup` does the same after an
   interruption; it only ever deletes what carries the label, never anything
   protected. Then delete the GitHub token.

**On a test server** (`"mode": "test"`), for its whole life: no backup,
clean-up or restore test, no alert, no healthchecks.io ping, no mail settings
for Pocket ID, and Caddy's own certificate authority (`local_certs`). Its
known_hosts file is `~/.config/bivouac/known_hosts-rebuild-test`.

**`restore-platform`**, run by `bivy` on a server waiting for its data
(`docker exec bivouac-reconciler node packages/reconciler/dist/main.js restore-platform [--list] [--snapshot <id>] [--yes]`):
without `--yes` it only says which copy and what it holds. With it: the dumps
come back from restic (`--no-lock`: nothing is written to the repository);
Pocket ID's database, then each app's, is created empty with its role and
derived password, and the dump loaded **as that role** in one transaction
(D75); the volumes are restored into volumes that do not exist yet. It
refuses on a server that is not waiting for its data, and never loads into a
database or volume it did not create. Run again after an interruption, it
carries on from where it stopped. Once done, it writes
`/var/lib/bivouac/rebuild/restored.json`, and the next pass starts Pocket ID,
the apps and Caddy.

**What it proves, and what it does not**: see D91. A real passkey login is
not tried: passkeys are bound to `auth.<domain>`, which points to the real
server.

**First run** (14 November 2026, D91): about six minutes from creation to a
checked platform, for about 5 GB of data; one started hour of a CX23. Leave
`--keep` on to compare row counts and files with the real server (read-only on
both), then `--cleanup`. Where a CX23 can be ordered changes by the minute.

## 16. The real rebuild: `bivy rebuild` (consent, rule 5)

Written and tested against fake APIs; **never run against the real server**.
Running it erases the server's disk: a decision of its own, with the owner's
explicit consent, never a way to try something. Claude only ever runs
`--plan`.

**Before**: the instance checkout is exactly `origin/main`, with nothing
uncommitted; the age key at hand; the Hetzner token in
`~/.config/bivouac/hetzner-token`; the backup provider able to serve the whole
copy that day (B2: check the download caps, D91); a terminal where the owner
can type.

```bash
bivy rebuild --plan <instance-dir>   # only reads
bivy rebuild <instance-dir>
```

`--ssh-key ~/.ssh/<key>` only for another key than the one `bivy` remembers
(D112).

In a terminal, every choice below is a question with the arrow keys (D93);
the flag in brackets answers it without one. The typed confirmation has no
flag: only a person at a terminal can give it.

1. The plan: in place if the server `bivouac` exists, otherwise a new server
   on the unassigned Primary IPs. If no CX23 can be ordered there, it asks
   which type among those that can (`--server-type`); another location means
   new IPs and a DNS change, by hand. It stops on anything odd: DNS not
   pointing to the Primary IPv4, an IP with `auto_delete`, no firewall, a lock
   or a marker on the old server. Questions are only asked when nothing else
   stops it.
2. If the old server does not answer, no fresh backup can be made: it asks
   whether to stop (recommended) or accept losing what was written since its
   last nightly copy (`--without-fresh-backup`; refused while the platform
   still answers).
3. Which data comes back: the copy made just before erasing, or an older one
   chosen from the list once the server can read the backups (`--snapshot
   <id>`); everything written since an older copy is lost.
4. The age key: from `~/.config/sops/age/keys.txt` (or `--age-key`), or
   pasted from the password manager, checked against `.sops.yaml` and kept
   only if the owner says so. Found **before** anything is erased.
5. The owner types the platform's domain.
6. A fresh backup on the old server; nothing is erased if it fails.
7. Pocket ID's signing keys recorded; protection lifted, Hetzner's `rebuild`
   (or a new server), protection put back; the platform's `known_hosts` is
   backed up next to it (`known_hosts.before-rebuild-<run>`).
8. Host key swap, marker `{"mode":"rebuild"}`, then **the owner adds the
   deploy key** it prints, at the link it gives, "Allow write access"
   unchecked; it waits, then checks GitHub refuses any write.
9. age key, `restore-platform`, Pocket ID and the apps; checks on the real
   names with real certificates (same signing keys as before, each app
   healthy); the marker removed.
10. The end summary says what is left: remove the **old** deploy key on
    GitHub (D30); check the next night's backup (the first one waits for it,
    D74).

Interrupted: run the same command again. Before the erase, it asks whether
to start over with a new plan, confirmation and backup, or forget it
(`--abandon`, which also puts the server's protection back if a kill left it
lifted); after, it carries on and never sends the rebuild twice.

## 17. The status page (D96)

From the Mac, without a browser or a passkey: `bivy status` shows the same
state through SSH, then lists what is worth a look (D105). It only reads;
`--json` gives the server's answer as it is.

`status.<domain>`, for the admins only: what runs, versions, health, memory,
restarts, the last pass, the last backup and restore test, open incidents, the
host's disk and memory, the latest logs of a container (not Postgres's), and a
"Sync now" button. It reads the reconciler's internal API; it has no Docker
socket and no database.

**Turning it on** (no DNS change: the wildcard covers the name):

1. CI on the monorepo's `main` publishes both images for the commit; each
   job's summary gives the digest.
2. Move the reconciler first (`bivy pin reconciler <commit>`, section 8),
   and check that it passed: the API comes with it, and nothing else changes
   for the apps.
3. Then add to `platform.yml` (any published version), and run
   `bivy pin status <commit>`, which writes its real digest:

   ```yaml
   status:
     image: ghcr.io/<owner>/bivouac-status:sha-<commit>@sha256:<digest>
     groups: [admins]
   ```

   The next pass creates the `admins` group and the `status` client in
   Pocket ID, starts the page on the internal network and routes it. Caddy
   asks for its certificate on the first visit.
4. **The owner adds themself to `admins`** in Pocket ID's admin screen
   (Users → their account → groups). Nobody else.

**Checks**: the page answers 200 on `/api/health` through Caddy; a member of
another group is refused by Pocket ID; from an app container, the reconciler's
port 8080 closes the connection.

**A new version**: `bivy pin status <commit>`, then commit and push.

**Turning it off**: remove the `status` block. The next pass drops its
route; the container keeps running, unreachable, until removed by hand
(`docker rm -f bivouac-app-status`), like a removed app (D18). Its Pocket ID
client stays, harmless without the page.

## 18. An app's own secrets (D97)

For a value only one app needs and the platform cannot derive: a token for an
outside service, the password of a mail account the app sends through. It
becomes one of the app's environment variables. Never a value the platform
already gives (`DATABASE_URL`, `SESSION_SECRET`, `OIDC_*`, `SMTP_*`…): CI and
the reconciler refuse those names.

**Adding or changing one**, on the owner's Mac, at the root of the instance
repo (the age key is in `~/.config/sops/age/keys.txt`):

1. The value goes from the password manager or the service's page straight
   into the encrypted file, never into the chat or a plain file in the repo:

   ```bash
   sops edit secrets/apps/<app>.sops.yaml
   ```

   One line per variable, upper case, value in quotes:
   `MAIL_SMTP_PASSWORD: "…"`. `sops` encrypts on save.
2. Check: `bivy validate` (or the instance CI) must be green. It reads the names, never
   the values.
3. Commit and push. The next pass recreates the app with the new value; the
   change list says "container bivouac-app-<app> recreated".

**If the file cannot be decrypted** (wrong key, damaged file), the app keeps
its running version and its route, the pass reports
"could not decrypt secrets/apps/<app>.sops.yaml", and the owner gets an alert.
Fix the file; nothing else changes meanwhile.

**Removing the app**: remove its secrets file in the same commit, or CI
refuses the orphan.

The values sit in the container's environment, like `DATABASE_URL`: visible to
whoever runs `docker inspect` on the server (root already), never shown by the
status page (D96) or in the reconciler's logs.

## 19. A new platform: `bivy init` (D99)

From an empty Hetzner project and a domain to a running platform, in one
command run in a terminal. It never erases anything: if the project already
has a server `bivouac`, it stops and points to `bivy rebuild`. It refuses to
run on a machine that already reaches a platform
(`~/.config/bivouac/known_hosts`): bivy keeps one platform's credentials per
machine user.

**Before**: Docker running; an empty Hetzner project and a Read & Write
token for it; a domain whose DNS you can change (OVH, or any provider by
hand); a GitHub account whose SSH key works with `git` on this machine; for
the parts set up now, the accounts of section 12 (backups, alerts) and the
SMTP account (section 10).

```bash
bivy init
```

1. **Questions** (nothing is created): the folder, the domain and the
   platform's part of it (`auth.<that>` is final, D40), the Hetzner token,
   the location and server type (arrow-key lists, with prices), the DNS
   provider, the SSH key (a new one for this machine by default), the empty
   private repo to create at the link shown, then backups, alerts and mail,
   now or later. Each answer is checked against the real service (the S3
   bucket is listed, the SMTP account logs in, the healthchecks.io checks
   are created). Every question also has a flag (`bivy init --help`).
2. **Cost, typed confirmation** (the platform domain).
3. **The configuration**: written from `template/`, secrets generated and
   encrypted for a new age key, appended to `~/.config/sops/age/keys.txt`.
   The age key and the restic password are shown **once**; type `stored`
   once they are in the password manager. Then pushed with your git; the
   credential files of the parts are deleted (the values now live in the
   encrypted file only).
4. **Hetzner**: the Flatcar snapshot if missing (section 4; a temporary
   token, to delete right after), the Primary IPv4 and IPv6
   (`bivouac-ipv4`, `bivouac-ipv6`, `auto_delete=false`, protected), the
   firewall `bivouac` (section 6), the server `bivouac` (protected), with a
   provisional host key replaced at the first connection (D91, no console).
5. **The server**: first-boot checks; the deploy key it makes, which you add
   at the link shown, "Allow write access" unchecked (bivy checks GitHub
   refuses it any write); the age key; Postgres, Pocket ID and Caddy.
6. **DNS, typed consent** (section 9): the wildcard, and a DMARC `p=none`
   when the zone has none. It stops first on a name already pointing
   elsewhere, an `AAAA`, or a CAA record without Let's Encrypt. Manual DNS:
   create the records it prints; it waits for public DNS.
7. **First admin** (section 10): `/setup` opened for this machine's public
   IPv4 only (pushed in `platform.yml`), you create the account and two
   passkeys, then it is closed again and bivy checks there is exactly one
   account. Interrupted while open: run again, it closes it.
8. If alerts were set up, a test message.

**Interrupted**: run the same command again. Answers and steps done are in
`~/.config/bivouac/init.json` (no secret); delete it to start over (what was
already created at Hetzner stays, and is found again by name).

**Later parts**: `bivy configure backups`, `bivy configure alerts`,
`bivy configure mail`, from the instance repo, exactly `origin/main`. Each
adds a part the platform does not have yet; a part already set up is
changed by hand (sections 10 and 12).

**Typed confirmations**: a mistyped domain, at the cost or the DNS
confirmation, asks again; Ctrl-C stops with nothing created (or the DNS
untouched), and the next run resumes at that question. Anything but `done`
after the first admin is created stops the run with `/setup` still open to
your address. After `done`, the first-admin page closes when the server next
reads Git (a minute or two).

**Git identity**: bivy stops before any question if git has no `user.name`
or `user.email`, since it commits to the instance repo in the owner's name.

**Trying it without touching a platform you have**: run it with an empty
home, so bivy sees none of your credentials or host keys, and give that
home a git identity first (bivy stops without one):

```bash
mkdir -p ~/bivy-trial && cd ~/bivy-trial && HOME=$PWD git config --global user.email you@users.noreply.github.com && HOME=$PWD git config --global user.name "Your Name"
```

```bash
cd ~/bivy-trial && HOME=$PWD node <monorepo>/packages/bivy/dist/cli.js init
```

`git push` still uses your own SSH key (OpenSSH reads the account's real
home, not `HOME`). Give the OVH keys a one-day validity. Afterwards, delete
in this order: lift the delete protection of the server and both Primary
IPs, delete the server, the IPs, the firewall and the Flatcar snapshot,
check the project lists nothing, then delete the tokens, the project, the
repo and the DNS records (a record left on a deleted IP could be taken over
by whoever gets that IP next).

**Proven** (22 November 2026): a first real run, end to end, as above (D99).

## 20. A lost or broken Mac (consent)

`bivy machine add` is not built (D38); until it is, by hand. Two cases:
**broken** (the disk is gone or unreadable) or **lost or stolen** (someone
else may hold it). On the Mac live the two SSH keys allowed on the server,
the age key, the Hetzner token, the OVH keys, the `gh` token and a GitHub SSH
key. The server keeps running alone meanwhile: nothing here is urgent for
it.

**Lost or stolen: cut access first**, from any browser, before anything
else. These give direct control, without decrypting anything:

1. GitHub: delete the Mac's SSH key and its `gh` token, sign out the other
   sessions. Whoever can write to the instance repo can add an SSH key to
   the server (D12).
2. Hetzner: delete the project's Read & Write token (Security → API tokens).
3. OVH: revoke the platform's API keys (D49).
4. Pocket ID, only if the Mac was taken unlocked: a sign-in lasts 30 days
   and the owner's is admin (D102). On the server, with consent:
   `docker exec -it bivouac-pocket-id /app/pocket-id key-rotate --session-key`
   (it asks to confirm), then `docker restart bivouac-pocket-id`; everyone
   signs in again. Then, in Pocket ID, remove passkeys and API keys nobody
   recognises.
5. Then the server's SSH keys, as in step 4 below, from the new machine.

**Then, on the new machine** (both cases):

1. **GitHub**: a new SSH key for `git`, added to the owner's account; clone
   this repo and the instance repo; section 0 (Docker, Node, build).
2. **age key** from the password manager into
   `~/.config/sops/age/keys.txt` (mode 600, directory 700), typed by the owner
   in a real terminal.
3. **New SSH keys**: the owner's (`ssh-keygen -t ed25519 -C <machine>`) and
   Claude's (section 0), each named after the new machine.
4. **`ssh-keys.yml`** (consent, high risk): add the two new public keys,
   remove the old machine's, `bivy validate`, push. The reconciler writes the
   list within a minute; the host script applies it and refuses an empty or
   malformed list, which raises an alert and leaves the old list in place
   (D63). Nothing pushed yet (no git on the new machine)? The file can be
   edited on github.com.
5. **Host key**: rebuild `~/.config/bivouac/known_hosts` from the Hetzner
   console, never by accepting the key blindly (section 8, step 1). Then log
   in and check `~core/.ssh/authorized_keys` holds the new keys only. If no
   key gets in, section 11.
6. **Tokens**: a new Hetzner token and new OVH keys with the same rights
   (section 0, D49); delete the old ones if not done. `bivy` asks for each
   credential file the first time it needs it.

**Lost or stolen: the secrets behind the age key** (decision of the owner).
With the age key and a clone of the instance repo, a holder of the Mac can
read every SOPS file: the master secret (and so every derived secret, D14),
Pocket ID's keys, the restic password, the mail password, the GHCR token,
the apps' own secrets. But with FileVault on and the Mac off or locked, its
disk cannot be read without the session password, and on Apple silicon that
password cannot be guessed at speed. **By default, accept**: the access cut
above is enough. Rotate only if the Mac was taken unlocked, or the session
password may be known. Rotation starts with what can be reached from
outside: the mail password, the bucket key and the GHCR token are each made
anew at their provider, then changed with `bivy secret set` (section 12,
"Changing one secret", D108), the old one revoked once the new one works;
an app's own secrets, section 18. The restic password, the master secret
(and with it the apps' session secrets) and Pocket ID's encryption key are not
one-value changes: there is no tested procedure for them yet, and a Claude
session plans it with consent at each step.

Record what was done in the operations log.

## 21. Monthly base updates (D109)

Nothing to do when it works. On the 1st (Paris time), Renovate opens
`renovate/base-images` on the monorepo (Caddy, Postgres digests, Pocket ID,
restic) and merges it once CI is green, on a weekday between 9:00 and 17:00.
CI publishes `v1.0.<n>`; between the 1st and the 10th, Renovate moves
`reconciler.image` and `status.image` in the instance repo and merges once
Validate is green. The server moves within a minute; Pocket ID restarts
(about a minute of failed sign-ins, D68).

**At the start of every session**: `bivy status`, then the open Renovate
PRs and the Dependency Dashboard issue of both repos (`gh pr list --author
app/renovate`, `gh issue list --search Dashboard`, with the right `GH_TOKEN`).
A PR still open means a red check, a major, or a minor step of the
platform: read why before anything else.

**Alerts and what they mean**:
- "The new reconciler version … was refused: … did not become healthy, and
  the server went back to …": a new Caddy or Postgres image did not start;
  the previous version is back with its own images. Read the image's
  release notes and the container's logs (`bivy status`, then the status
  page's logs), fix in the monorepo, and the next version moves on its own.
- "A reconciler pass failed: bivouac-pocket-id … not healthy" after an
  update: the new Pocket ID does not start, and nothing goes back by itself
  (the previous one refuses a database the new one migrated: "downgrades
  are not allowed"). Look at its logs first: a slow migration may just need
  time. If it is broken: section 22 (the previous Pocket ID as a new version,
  then `bivy restore pocket-id` with the owner's consent); what changed in
  Pocket ID since the night is lost.
- "The reconciler running here was built N days ago": nothing moved for 45
  days. Look at the PRs above, at Mend's status for the repos, and whether
  the instance's `platform.yml` still has a `v1.0.<n>` tag (a `sha-` tag
  written by hand stops Renovate: `bivy pin` again).
- A backup that fails after an update: restic changed; it is not rolled
  back. Pin the previous reconciler (`bivy pin reconciler <commit>`) until
  fixed.

**What Renovate sees**: Mend's page of each repo
(`https://developer.mend.io/github/<owner>/<repo>`, the owner's sign-in)
lists the detected dependencies, the updates "Awaiting Schedule" and the
last jobs. The monorepo must show the four base images in
`packages/manifest/src/platform.ts` only; the instance repo, the reconciler
and the status page in `platform.yml` only.

**An urgent security fix** (seen in a session, before the 1st): on Mend's
page of the monorepo, tick the "base images" update and press
"Create/Rebase" (the checkbox bypasses `schedule`, verified in Renovate's
source; the merge still waits for green CI and the weekday hours), then the
same on the instance repo once CI has published. Or by hand: update the
image in `packages/manifest/src/platform.ts` (tag and digest, `docker
buildx imagetools inspect`), push to `main` once CI is green, then `bivy pin
reconciler <commit>` and `bivy pin status <commit>` in the instance repo.

**A new kind of value in `platform.yml`** (a tag format, a field): the
running reconciler reads it with its own schema. Move the server first to a
version that understands it, written the old way (the same digest under its
`sha-` tag), then write the new value (D109: four minutes of "invalid
instance" on 21 Nov. 2026).

**A version that must not go out alone**: keep it on a branch, or have the
instance's PR wait by stepping the minor (`v1.1.0` in `ci.yml`): only
`v1.0.<n>` steps merge by themselves.

## 22. Bringing Pocket ID back after an update that broke it (consent)

Built with D110. Pocket ID migrates its database when a new version starts;
an older version then refuses that database ("downgrades are not allowed",
D109). So when an update of Pocket ID breaks it, going back takes two
things, in this order: the previous Pocket ID, then its database from the
night before the update. Sign-in is down until both are done; the apps keep
running, and people already signed in keep using them.

**1. Read before acting.** The alert says "A reconciler pass failed:
bivouac-pocket-id … not healthy". `bivy status`, then Pocket ID's logs (the
status page's logs, or `bivy ssh -- docker logs --tail 100 bivouac-pocket-id`). A
migration that is only slow passes on its own within a few minutes: wait for
the next passes. A "dirty" database, or a crash at every start, is broken.

**2. The previous Pocket ID, as a new version** (no consent needed: it is the
ordinary way a version reaches the server, D109). In the monorepo, put the
previous Pocket ID line back in `packages/manifest/src/platform.ts` (its tag
and digest, from Git history), and add to `renovate.json` a package rule
keeping Renovate on the working line until a fixed version comes out (a
regex: Docker versioning has no ranges, so `<2.20.0` is not supported,
verified in Renovate's docs; `v?` because the docs do not say whether the
`v` is stripped before matching):

```json
{ "matchPackageNames": ["ghcr.io/pocket-id/pocket-id"], "allowedVersions": "/^v?2\\.19\\./" }
```

Push to `main`; once CI is green, `bivy pin reconciler <commit>` in the
instance repo, commit and push. Always forward: an older `v1.0.<n>` pinned by
hand would be moved again by Renovate between the 1st and the 10th. Within a
minute the server runs the previous Pocket ID, which refuses today's
database: Pocket ID keeps failing until step 3, as expected.

**3. The database back** (consent: what changed in Pocket ID since the copy
is no longer there). From the Mac, in the instance repo:

```bash
bivy restore pocket-id --plan                 # what it would do: the copy, Pocket ID now, its accounts
bivy restore pocket-id                        # asks the copy, shows the plan, then asks to type pocket-id
```

Choose the last nightly copy taken **before** the update (the plan says when
Pocket ID's container was created). Claude only runs `--plan`; the owner
types the confirmation. It is the reconciler's `restore-pocket-id`, the same
steps as `restore-app` (section 14) for one database: the lock shared with the
backup; Pocket ID stopped, and passes stopping after Postgres while it runs
(apps and Caddy left as they are); a safety copy tagged `pre-restore` and
`platform:pocket-id`; the copy's dump loaded as Pocket ID's own role into
`bivouac_restoring_bivouac_pocket_id`, its `users` checked to be a plain table,
then swapped in one transaction; the replaced database kept as
`bivouac_r<YYMMDDhhmmss>_bivouac_pocket_id`; Pocket ID started and its health
checked (a container still on another image than the reconciler names is
removed instead, and the next pass creates it). While it runs, alerts about
the pass and the apps stay open rather than resolved. By hand on the server:
`docker exec bivouac-reconciler node packages/reconciler/dist/main.js restore-pocket-id [--list] [--snapshot <id> | --before <date>] [--yes]`.

**What is lost**, and is in the safety copy and the kept database: accounts,
passkeys, invitations and groups changed since the copy, and every sign-in
since (people sign in again). Someone who joined or added a passkey that day
does it again (a new invitation, or `bivy login-link` for an admin, D107).
OIDC clients of apps deployed since the copy come back at the next pass.

**If Pocket ID is still not healthy afterwards**: the version running is not
the previous one (step 2 not done, or not yet on the server). Do step 2, then
run the restore again: it takes a new safety copy and starts from the same
nightly copy.

**If it stops halfway** (an error after the swap began, or the reconciler
restarted during it): Pocket ID stays stopped and every pass reports "a
restore of Pocket ID's database was interrupted" until a restore completes
(`backup/restore-interrupted-bivouac-pocket-id.json`). Run it again, or
restore the safety copy the error names.

**Afterwards**: once a fixed Pocket ID is out, remove the package rule; the
next monthly update moves it. The kept `bivouac_r…` database is not backed up
and stays until the owner asks to drop it (`DROP DATABASE`, consent).
