# Adapters: where `bivy` meets the outside world

`bivy` is built for one stack (Hetzner, OVH, Backblaze B2, Pushover,
healthchecks.io), and is generic only where it costs almost nothing (D93).
Three places are written against a contract, so another provider can be
added without touching the rest:

| Contract | Where | Available |
| --- | --- | --- |
| Server provider | `packages/bivy/src/server-provider.ts` | Hetzner |
| DNS provider | `packages/bivy/src/dns.ts` | OVHcloud (`ovh.ts`), manual |
| Backup destination | `packages/bivy/src/s3.ts` | any S3-compatible storage (Backblaze B2 is a preset) |

Pocket ID's mail goes through any SMTP server on port 587 with STARTTLS
(`smtp.ts`): no adapter is needed. Pushover and healthchecks.io are fixed
choices.

## How a new adapter arrives

By pull request into this monorepo, with its tests against a fake of the
provider's API (see `adapters.test.ts`), and an independent security review
when it handles a token (rule 6). Never as a module loaded at run time from
npm: it would run unreviewed code next to the Hetzner, DNS and GitHub
credentials (D93).

Each adapter speaks to the provider's official API directly (D31), keeps
its credentials in files of mode 600 under `~/.config/bivouac/` (asked with
hidden input, `credentials.ts`), and never puts a credential on a command
line, in a URL, a log or an error message.

## Server provider

What `bivy init` needs from wherever the server runs (`ServerProvider`):

- `projectProblems()`: why this project cannot receive a new platform.
  `bivy init` never replaces or erases anything; a project that already
  holds one is for `bivy rebuild`.
- `offers()`: where an x86 machine of at least 4 GB can be ordered now,
  with its hourly price, cheapest first (an arrow-key list).
- `flatcarImage(location, disk)`: the Flatcar image to boot, made when
  missing (verified against Flatcar's signature first).
- `addresses(location)`: a fixed IPv4 and IPv6 that outlive the server, so a
  rebuild keeps the DNS; protected against deletion.
- `firewall()`: outside the machine, letting in 22/tcp, 80/tcp, 443/tcp and
  443/udp only, so Docker's own rules cannot bypass it.
- `server(request)`: boots Flatcar with the Ignition config as user-data,
  with the addresses and the firewall; protected against deletion.

Every call is safe to repeat: it finds what an interrupted run created (by
name, `bivouac`, `bivouac-ipv4`, `bivouac-ipv6`) instead of creating a
second one. `bivy rebuild` relies on the same names.

## DNS provider

`bivy init` needs two records: the wildcard `*.<platform domain>` → the
fixed IPv4 (never an `AAAA`, D67), and, when the zone has none, a DMARC
record `p=none`. A provider (`DnsProvider`):

- `check(zone)`: proves it can act on the zone, changing nothing;
- `existing(zone, name, type)`: the records the provider holds for a name,
  or `undefined` when it cannot read them (bivy then reads public DNS);
- `apply(zone, records)`: makes the records exist, never deleting or
  changing one it did not create. A provider that cannot write (manual)
  tells the person what to create and returns.

Before writing, bivy stops on a name of the platform already pointing
elsewhere, an `AAAA`, or a CAA record that does not allow Let's Encrypt; it
writes only after the owner's typed consent (rule 5), then waits until
public resolvers (1.1.1.1, 8.8.8.8) answer.

The manual provider is the second implementation that keeps the contract
honest, and covers every registrar.

## Backup destination

Any S3-compatible storage that restic can use (D16): an HTTPS endpoint, a
bucket, a region and an access key. bivy only checks that the key can list
the bucket and that the bucket is empty (a new platform starts a new restic
repository), with a request signed by AWS Signature Version 4 (`signV4`,
checked against AWS's own example). A provider is a preset (`PRESETS`):
where to create the bucket and key, and how to build the endpoint from a
region. The secret names in `secrets/platform.sops.yaml` still say
`b2_key_id` and `b2_application_key`, for history; they hold any S3 key.

## Not adapters

`bivy configure backups|alerts|mail` adds a part a platform does not have
yet, with the same code `bivy init` uses. It never changes a part already
set up: moving the backups or replacing an account is done by hand
(runbook sections 10 and 12), so bivy cannot lose a backup repository or
silence alerts by mistake.
