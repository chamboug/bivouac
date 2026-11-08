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

## 9. DNS (consent)

Through the OVH API: `POST /domain/zone/<zone>/record` with
`{"fieldType": "A", "subDomain": "*.<sub>", "target": "<ipv4>", "ttl": 3600}`,
then `POST /domain/zone/<zone>/refresh`. No `AAAA` record yet (D67): over
IPv6, Caddy would not see the visitor's address.
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
3. **(consent)** Remove `setupFrom`. Check 403 for everyone, the owner included,
   and exactly one user (`users` in database `bivouac_pocket_id`).
4. Mail (D70). Add `mail` to `platform.yml` (`host`, `from`, `user`). Have the
   owner type the mailbox password in a real terminal into a file of mode 600,
   test it against the SMTP server with its output filtered to the status codes
   (a verbose log contains the credentials), add `mail.password` to the secrets
   file in one pipe (decrypt, append, encrypt), compare it after decryption
   without printing it, and delete the file. A new `mail` block needs a
   reconciler version that knows it; it moves to it before validating.
5. **(consent, Pocket ID restarts, about a minute: D68)** Push. The owner clicks
   **Send test email** in Pocket ID's email settings. Read the message's
   `Authentication-Results`: SPF and DKIM must pass. Check the zone has one SPF
   record and a `p=none` DMARC.

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
