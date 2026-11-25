import type { CommandOutput } from "./remote.js";
import { failed } from "./say.js";

/**
 * `bivy login-link <username or email>` (D107): a one-time sign-in link for
 * an admin who lost every passkey, from Pocket ID's own command, run beside
 * it with `docker exec`.
 *
 * Verified in Pocket ID v2.19.2's source (backend/internal/cmds/
 * one_time_access_token.go, onetimeaccess/): `one-time-access-token` takes
 * exactly one argument, looked up as `username = ? OR email = ?`; it prints
 * two lines, the second `Use the following URL to sign in once:
 * <APP_URL>/lc/<token>`, the token being 12 characters out of 56. The link
 * works once and for one hour. An unknown user: `Error: user not found` on
 * standard error, exit 1. A disabled user: the link is made all the same,
 * and Pocket ID refuses it when it is opened.
 */

const POCKET_ID = "bivouac-pocket-id";
const LINK_LINE = /^Use the following URL to sign in once: (https:\/\/[^\s/]+\/lc\/[A-Za-z0-9]+)$/m;

export class LoginLinkError extends Error {}

/**
 * Pocket ID's usernames (dto/validations.go: letters, digits, `_.@-`, a
 * letter or digit at each end) and ordinary email addresses. Anything else is
 * refused before it reaches a shell on the server.
 */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9_.@+-]{0,252}[A-Za-z0-9])?$/;

export function checkLogin(login: string): string {
  if (!LOGIN.test(login)) {
    throw new LoginLinkError(`'${login}' is neither a Pocket ID username nor an email address bivy accepts (letters, digits and . _ @ + -). Give the username.`);
  }
  // Pocket ID's hidden admin behind STATIC_API_KEY (apikey/service.go): a
  // passkey added there would be an admin sign-in nobody sees.
  if (/^static-api-user-/i.test(login)) throw new LoginLinkError(`'${login}' is Pocket ID's hidden account for the platform's API key: no sign-in link for it.`);
  return login;
}

/** The command run on the server, over SSH. The login is checked above, then quoted all the same. */
export function loginLinkCommand(login: string): string {
  return `docker exec ${POCKET_ID} /app/pocket-id one-time-access-token '${checkLogin(login)}'`;
}

/**
 * The link out of the command's answer, or why there is none. An error never
 * repeats the command's standard output: it may hold the link.
 */
export function readLink(result: CommandOutput, domain: string): string {
  const said = result.stderr.split("\n").map((line) => line.trim()).filter((line) => line && !line.includes("/lc/")).at(-1) ?? "";
  if (result.status === 255) throw new LoginLinkError(`the server could not be reached${said ? ` (${said})` : ""}`);
  if (result.status !== 0) {
    if (/user not found/.test(result.stderr)) throw new LoginLinkError("Pocket ID has no user with that username or email.");
    if (/No such container/.test(result.stderr)) throw new LoginLinkError(`no ${POCKET_ID} container on the server: bivy status says what runs.`);
    throw new LoginLinkError(`Pocket ID made no link${said ? `: ${said}` : ""}`);
  }
  const link = LINK_LINE.exec(result.stdout)?.[1];
  if (!link) throw new LoginLinkError("Pocket ID answered, but not with a sign-in link: its command may have changed with its version.");
  const expected = `https://auth.${domain}/lc/`;
  if (!link.startsWith(expected)) throw new LoginLinkError(`the link is not on ${expected.slice(0, -4)}: Pocket ID's APP_URL is not the one platform.yml gives.`);
  return link;
}

/** What a person reads around the link. */
export function linkMessage(login: string, link: string): string {
  return [
    `Sign-in link for ${login}:`,
    "",
    `  ${link}`,
    "",
    "This link is a key: whoever opens it first is signed in as that user. Share it",
    "with no one. It works once, within the hour; after that it is worth nothing.",
    "Open it yourself, in the browser you will keep using, then add a passkey at",
    "once (your account page, Add Passkey). A disabled account is refused.",
  ].join("\n");
}

export interface LoginLinkDeps {
  /** A person at a terminal: standard input and output both a TTY. */
  interactive: boolean;
  /** The server, reached over SSH; undefined after saying why it cannot be. */
  server: () => Promise<{ run: (command: string) => CommandOutput; domain: string } | undefined>;
  show: (text: string) => void;
  error: (text: string) => void;
}

/**
 * The link is a credential, so it is shown to a person at a terminal only. A
 * script, a pipe or Claude gets a refusal before anything runs on the server,
 * and the link is never written to a file.
 */
export async function loginLink(login: string | undefined, deps: LoginLinkDeps): Promise<number> {
  if (!login) {
    deps.error("Whose link? bivy login-link <username or email>.");
    return 1;
  }
  if (!deps.interactive) {
    deps.error("✗ bivy login-link shows a sign-in link, which is a credential: it runs only for a person at a terminal, never in a script, a pipe or for Claude. Run it yourself in a terminal.");
    return 1;
  }
  try {
    checkLogin(login);
    const target = await deps.server();
    if (!target) return 1;
    deps.show(linkMessage(login, readLink(target.run(loginLinkCommand(login)), target.domain)));
    return 0;
  } catch (error) {
    if (!(error instanceof LoginLinkError)) throw error;
    deps.error(failed(error.message));
    return 1;
  }
}
