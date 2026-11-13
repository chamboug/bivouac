# Next session: the first real `bivy rebuild --test`, then the real `bivy rebuild` (layer 5, D91)

Prompt for a new Claude session, written at the end of the session of
13 November 2026. Talk to the owner in the language set by `INSTANCE.md`.

---

We continue layer 5 of Bivouac: **the first real `bivy rebuild --test` at
Hetzner, then the real `bivy rebuild`** (written and tested, never run). It
is the last urgent condition of D89: the only proof that the data comes back
if the server disappears. The server holds data the owner keeps (an ebook
library: database and about 5 GiB of books; a household food inventory): we
are in the interim phase of D89, **the server is no longer disposable**.

## Read first

- `CLAUDE.md` in full (rules 2, 5 and 6; "Host", "Backups", "Deployment" and
  the `bivy` part; "Before the prod phase"; "Progress").
- `docs/decisions.md`: D7, D30, D39, D65, D66, D75, D89, D90 and **D91 in
  full**, including its part on the server's host key.
- `docs/runbook.md`: sections 7, 8, 12, 14 and **15**.
- `packages/bivy/src/`: `rebuild.ts`, `hostkey.ts`, `hetzner.ts`,
  `github.ts`, `remote.ts`, `cli.ts`, `ignition.ts` and their tests;
  `packages/reconciler/src/rebuild.ts`.
- In the instance repo `../bivouac-platform`: `INSTANCE.md` (real domain, IP,
  where credentials are kept, how to talk to the owner) and the entries of
  13 November in `OPERATIONS.md`.

## Where we are (13 November 2026, evening)

- **D91 built and deployed**: reconciler `sha-d44cf3b` on the server since
  19:20 UTC on 13 November (without a marker it behaves as before).
- **New since then** (commits `fc79294`, `d555d08`, CI green):
  - `bivy rebuild --test` no longer stops for the owner to read the host key
    in Hetzner's console. `bivy` places a provisional ED25519 host key with
    the Ignition config. Over the first connection, verified against that
    key, the server makes its own key, and the Mac records it before
    anything else is sent.
  - The private-key guard on the user-data now decodes every `source` of
    the Ignition config. The old guard missed compressed contents.
  - `bivy`'s SSH ignores `~/.ssh/config` (`-F /dev/null`).
  - Rule 6 review done twice, and its fixes applied. The provisional key
    is a stated departure from D7, written in D91.
- **To observe during the test**: that Flatcar keeps the host key placed by
  Ignition on a fresh server. The sources say so (`ssh-keygen -A` only
  creates missing keys), but it has not been seen yet.
- **Set aside by the owner**: the price and duration guard (refuse a type
  above a price per hour, delete everything after a few hours). The owner
  doubts it is needed; to settle later.
- **Nothing has been created at Hetzner for the test yet.**
- Verified on 13 November: the CX23 can only be ordered in `hel1`
  (€0.01056/hour incl. VAT). A deploy key created with a GitHub token is
  deleted with that token: good for the test, a trap for a real rebuild,
  where the owner adds the key by hand. The token's "Administration"
  permission can delete the repository, so the token lasts one day.

## What I ask, in this order

Propose the plan in sub-steps, each with its risk and its way back, and have
it approved before acting.

1. **Check that last night's backup (02:00 UTC on 14 November) succeeded
   with `sha-d44cf3b`**, read-only. Look at `/var/lib/bivouac/backup/state.json`
   and the reconciler's log, and check that there is no lock and no
   `/etc/bivouac/rebuild.json`.
2. **Run the test for real.**
   - **Before creating anything at Hetzner**: get the owner's consent, with
     the cost announced.
   - **The owner's part**: they create the temporary GitHub token with the
     link the command prints, and type it into a real terminal. The SSH key
     given to `--ssh-key` must have no passphrase, or already be loaded in
     the agent.
   - **Record**: the duration of each step, memory and disk, and whether
     Flatcar kept the provisional host key.
   - **Compare with the real server**, read-only: row counts per table, and
     file counts and sizes per volume.
   - **Note everything that differed from the runbook.**
   - **At the end**: check through the API that nothing labelled
     `bivouac-rebuild-test` is left, and remind the owner to delete the token.
3. **The real `bivy rebuild`.**
   - Write it and test it against fake APIs.
   - Give it a dry-run plan that only reads the Hetzner project.
   - **Never run it** on the real server: running it one day is a separate
     decision, with the owner's explicit consent (rule 5). It reuses the
     provisional host key mechanism.
   - **Points to settle with the owner**, with a recommendation for each:
     1. reinstall in place or create a new server (recommended: in place if
        the server still exists);
     2. what to do if no CX23 can be ordered in the Primary IPs' location;
     3. the deploy key, added by the owner by hand (D91);
     4. when to remove the marker at the end.
4. Always separate "verified (source)" from "from memory, to check". Explain
   in plain language, and say clearly when you need the owner.
5. **At the end, update**:
   - `CLAUDE.md` ("Progress", "Before the prod phase");
   - `docs/decisions.md`;
   - the runbook (section 15);
   - the operations log, in the instance repo's language;
   - the next prompt in `prompts/`.

## Working rules for this session

- **Interim phase (D89).** Push to `main` in small commits with green CI.
  But nothing that can lose data without the owner's consent and a backup
  that succeeded just before, no destructive test on the server, and no app
  data deleted without asking. No Claude attribution in commits or PRs.
- **SSH to the real server.** Use the command line written in `INSTANCE.md`
  and runbook section 8, with the platform's own known_hosts file
  (`~/.config/bivouac/known_hosts`), never `~/.ssh/known_hosts`. In zsh, put
  the options in an array. Read-only by default. Announce any change
  beforehand, with its reason and its way back.
- **Secrets.** The owner never pastes a secret in the conversation: ask them
  to type it in a real terminal, then check the file without printing it.
  SOPS secrets are decrypted on the Mac with `ghcr.io/getsops/sops:v3.13.3`
  and the age key, in memory only.
- **Tools.**
  - `gh` reads CI (D78); it can neither push nor merge.
  - Node: add `/opt/homebrew/opt/node@24/bin` to `PATH`.
  - End-to-end tests take about 10 minutes on the Mac. If you stop a run,
    check that no vitest process and no `bivouac-*` container is left.
  - A stale copy under `.claude/worktrees/` makes a plain `npx vitest run`
    fail: run `npx vitest run packages`.

**Remind the owner during the session**: B2's spending cap needs a bank card.
They will set it later; it is a condition before the prod phase.

**Out of scope for this session**: new app features, Tinyauth, the mail
relay for apps (D70), the `AAAA` record (D67), `bivy init`, and the price
and duration guard unless the owner brings it back.
