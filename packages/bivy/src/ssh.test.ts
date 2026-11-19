import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SshError, execCommand, serverAddress, shellQuote, splitAtDoubleDash, sshArguments } from "./ssh.js";

describe("shellQuote", () => {
  it("leaves plain words alone and quotes the rest", () => {
    expect(shellQuote("scripts/create-invitation.mjs")).toBe("scripts/create-invitation.mjs");
    expect(shellQuote("--uses")).toBe("--uses");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("")).toBe("''");
  });

  it("gives back exactly what was written, through a real shell", () => {
    const tricky = ["it's", "$(touch /tmp/x)", "`id`", "a;b", "\"q\"", "new\nline", "*", "~", "\\"];
    for (const argument of tricky) {
      const echoed = spawnSync("sh", ["-c", `printf '%s' ${shellQuote(argument)}`], { encoding: "utf8" });
      expect(echoed.stdout).toBe(argument);
    }
  });
});

describe("execCommand", () => {
  it("runs the command in the app's container", () => {
    expect(execCommand("recettes", ["node", "scripts/create-invitation.mjs", "--admin", "--uses", "1"], true)).toBe(
      "docker exec -it bivouac-app-recettes node scripts/create-invitation.mjs --admin --uses 1",
    );
  });

  it("opens a shell when no command is given", () => {
    expect(execCommand("biblio", [], true)).toBe("docker exec -it bivouac-app-biblio sh");
  });

  it("asks for no terminal when nobody is at one", () => {
    expect(execCommand("biblio", ["ls"], false)).toBe("docker exec -i bivouac-app-biblio ls");
  });

  it("cannot be turned into a second command on the server", () => {
    expect(execCommand("biblio", ["echo", "x; reboot"], false)).toBe("docker exec -i bivouac-app-biblio echo 'x; reboot'");
  });
});

describe("sshArguments", () => {
  it("checks the host key strictly against the platform's own file", () => {
    const args = sshArguments("203.0.113.10", "/k", "/kh", { tty: false, remote: "uptime" });
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("UserKnownHostsFile=/kh");
    expect(args).toContain("BatchMode=yes");
    expect(args.slice(-3)).toEqual(["-T", "core@203.0.113.10", "uptime"]);
  });

  it("lets a person at a terminal type their key's passphrase", () => {
    const args = sshArguments("203.0.113.10", "/k", "/kh", { tty: true });
    expect(args).not.toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args.slice(-2)).toEqual(["-t", "core@203.0.113.10"]);
  });
});

describe("serverAddress", () => {
  it("is the address of auth.<domain>", async () => {
    let asked = "";
    const address = await serverAddress("example.org", async (name) => {
      asked = name;
      return ["203.0.113.10"];
    });
    expect(asked).toBe("auth.example.org");
    expect(address).toBe("203.0.113.10");
  });

  it("refuses to guess between several addresses, or none", async () => {
    await expect(serverAddress("example.org", async () => ["203.0.113.10", "203.0.113.11"])).rejects.toThrow(SshError);
    await expect(serverAddress("example.org", async () => { throw new Error("ENOTFOUND"); })).rejects.toThrow(/does not resolve/);
  });
});

describe("splitAtDoubleDash", () => {
  it("keeps what follows -- for the container, even options of bivy's own", () => {
    expect(splitAtDoubleDash(["exec", "recettes", "--", "node", "x.mjs", "--ssh-key", "--"])).toEqual({
      own: ["exec", "recettes"],
      command: ["node", "x.mjs", "--ssh-key", "--"],
    });
    expect(splitAtDoubleDash(["ssh"])).toEqual({ own: ["ssh"], command: [] });
  });
});
