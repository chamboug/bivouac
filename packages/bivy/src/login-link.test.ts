import { describe, expect, it } from "vitest";
import { LoginLinkError, checkLogin, linkMessage, loginLink, loginLinkCommand, readLink } from "./login-link.js";

const DOMAIN = "apps.example.org";
const LINK = "https://auth.apps.example.org/lc/aB3dE5fG7hJ9";
/** Pocket ID v2.19.2's answer, as its source prints it. */
const answer = (login: string, link = LINK) =>
  `A one-time access token valid for 1 hour has been created for "${login}".\nUse the following URL to sign in once: ${link}\n`;

describe("bivy login-link", () => {
  it("runs Pocket ID's own command beside it, with the login quoted", () => {
    expect(loginLinkCommand("owner")).toBe("docker exec bivouac-pocket-id /app/pocket-id one-time-access-token 'owner'");
    expect(loginLinkCommand("first.last+admin@example.org")).toContain("one-time-access-token 'first.last+admin@example.org'");
  });

  it.each(["owner'; rm -rf /; '", "$(id)", "a b", "`id`", "-flag", "owner\n", "", "a".repeat(300), "owner.", "é", "static-api-user-yP1L75", "Static-API-User-abc123"])(
    "refuses %j before it reaches a shell on the server",
    (login) => {
      expect(() => checkLogin(login)).toThrow(LoginLinkError);
      expect(() => loginLinkCommand(login)).toThrow(LoginLinkError);
    },
  );

  it.each(["a", "owner", "first_last", "first-last.2", "someone@example.org"])("accepts %j", (login) => {
    expect(checkLogin(login)).toBe(login);
  });

  it("finds the link in Pocket ID's answer, among its log lines", () => {
    const stdout = `{"level":"INFO","msg":"connected"}\n${answer("owner")}`;
    expect(readLink({ status: 0, stdout, stderr: "" }, DOMAIN)).toBe(LINK);
  });

  it("says plainly when no user has that username or email", () => {
    expect(() => readLink({ status: 1, stdout: "", stderr: "Error: user not found\n" }, DOMAIN)).toThrow("Pocket ID has no user with that username or email.");
  });

  it("says when Pocket ID is not there, or the server cannot be reached", () => {
    expect(() => readLink({ status: 1, stdout: "", stderr: "Error response from daemon: No such container: bivouac-pocket-id\n" }, DOMAIN)).toThrow(/no bivouac-pocket-id container/);
    expect(() => readLink({ status: 255, stdout: "", stderr: "ssh: connect to host 203.0.113.10 port 22: Connection refused\n" }, DOMAIN)).toThrow(/could not be reached \(ssh: connect/);
  });

  it("never repeats the command's output in an error: it may hold the link", () => {
    const leaks = [
      { status: 0, stdout: `Use the following URL to sign in once: ${LINK} (changed format)\n`, stderr: "" },
      { status: 2, stdout: answer("owner"), stderr: `half done: ${LINK}\n` },
      { status: 0, stdout: answer("owner", "https://auth.elsewhere.example/lc/aB3dE5fG7hJ9"), stderr: "" },
    ];
    for (const result of leaks) {
      let message = "";
      try {
        readLink(result, DOMAIN);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("aB3dE5fG7hJ9");
    }
  });

  it("refuses a link on another domain than platform.yml's", () => {
    expect(() => readLink({ status: 0, stdout: answer("owner", "https://auth.elsewhere.example/lc/aB3dE5fG7hJ9"), stderr: "" }, DOMAIN)).toThrow(/not on https:\/\/auth\.apps\.example\.org/);
  });

  it("says what the link is worth and what to do next", () => {
    const message = linkMessage("owner", LINK);
    expect(message).toContain(LINK);
    expect(message).toMatch(/key/);
    expect(message).toMatch(/once, within the hour/);
    expect(message).toMatch(/add a passkey/);
  });

  it("refuses to run without a terminal, before reaching the server", async () => {
    let reached = false;
    const errors: string[] = [];
    const shown: string[] = [];
    const deps = {
      interactive: false,
      server: async () => {
        reached = true;
        return { domain: DOMAIN, run: () => ({ status: 0, stdout: answer("owner"), stderr: "" }) };
      },
      show: (text: string) => shown.push(text),
      error: (text: string) => errors.push(text),
    };
    expect(await loginLink("owner", deps)).toBe(1);
    expect(reached).toBe(false);
    expect(shown).toEqual([]);
    expect(errors.join("\n")).toContain("only for a person at a terminal");
  });

  it("shows the link to a person at a terminal, and only then", async () => {
    const commands: string[] = [];
    const shown: string[] = [];
    const code = await loginLink("owner", {
      interactive: true,
      server: async () => ({ domain: DOMAIN, run: (command) => (commands.push(command), { status: 0, stdout: answer("owner"), stderr: "" }) }),
      show: (text) => shown.push(text),
      error: () => {},
    });
    expect(code).toBe(0);
    expect(commands).toEqual([loginLinkCommand("owner")]);
    expect(shown.join("\n")).toContain(LINK);
  });

  it("checks the login before reaching the server", async () => {
    let reached = false;
    const errors: string[] = [];
    const code = await loginLink("$(id)", { interactive: true, server: async () => ((reached = true), undefined), show: () => {}, error: (text) => errors.push(text) });
    expect(code).toBe(1);
    expect(reached).toBe(false);
    expect(errors[0]).toMatch(/neither a Pocket ID username/);
  });
});
