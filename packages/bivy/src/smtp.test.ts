import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket, createSecureContext } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSmtp, parseReply } from "./smtp.js";

describe("SMTP replies", () => {
  it("waits for the last line of a multi-line reply", () => {
    expect(parseReply("250-hello\r\n250-PIPELINING\r\n")).toBeUndefined();
    expect(parseReply("250-hello\r\n250 STARTTLS\r\nrest")).toEqual({ code: 250, rest: "rest" });
  });
});

/** A tiny SMTP server on localhost, with a certificate made for the test. */
describe("checkSmtp", () => {
  let dir: string;
  let key: string;
  let cert: string;
  let server: Server;
  let port: number;
  let seen: string[] = [];
  let tlsUsedForAuth = false;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "bivy-smtp-"));
    const made = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", join(dir, "k"), "-out", join(dir, "c")], { encoding: "utf8" });
    if (made.status !== 0) throw new Error(made.stderr);
    key = readFileSync(join(dir, "k"), "utf8");
    cert = readFileSync(join(dir, "c"), "utf8");
    server = createServer((socket: Socket) => {
      let channel: Socket | TLSSocket = socket;
      let buffer = "";
      const onLine = (line: string) => {
        seen.push(line.startsWith("AUTH") ? "AUTH ***" : line);
        if (line.startsWith("EHLO")) channel.write("250-localhost\r\n250 STARTTLS\r\n");
        else if (line === "STARTTLS") {
          channel.write("220 go ahead\r\n");
          socket.removeAllListeners("data");
          const secure = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext({ key, cert }) });
          channel = secure;
          secure.on("data", onData);
        } else if (line.startsWith("AUTH PLAIN ")) {
          tlsUsedForAuth = channel instanceof TLSSocket;
          const [, user, password] = Buffer.from(line.slice(11), "base64").toString().split("\u0000");
          channel.write(user === "me@example.org" && password === "right" ? "235 ok\r\n" : "535 no\r\n");
        } else if (line === "QUIT") channel.end("221 bye\r\n");
      };
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        let at: number;
        while ((at = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          onLine(line);
        }
      };
      socket.on("data", onData);
      socket.on("error", () => undefined);
      socket.write("220 localhost ready\r\n");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("logs in over TLS only", async () => {
    seen = [];
    await checkSmtp({ host: "localhost", port, user: "me@example.org", password: "right" }, { ca: cert });
    expect(seen).toEqual(["EHLO bivy", "STARTTLS", "EHLO bivy", "AUTH ***", "QUIT"]);
    expect(tlsUsedForAuth).toBe(true);
  });

  it("says when the password is refused", async () => {
    await expect(checkSmtp({ host: "localhost", port, user: "me@example.org", password: "wrong" }, { ca: cert })).rejects.toThrow(/refused/);
  });

  it("refuses a certificate it cannot trust", async () => {
    await expect(checkSmtp({ host: "localhost", port, user: "me@example.org", password: "right" })).rejects.toThrow(/TLS/);
  });
});
