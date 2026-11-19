import { connect as tcp, type Socket } from "node:net";
import { connect as tls, type TLSSocket } from "node:tls";

/**
 * Checks an SMTP account the way Pocket ID will use it (D70): port 587,
 * STARTTLS always, a certificate valid for the host, then AUTH PLAIN.
 * Sends no mail. The password only ever goes over the encrypted
 * connection, and no exchange is logged (a log would hold it, base64 is no
 * protection).
 */

export class SmtpError extends Error {}

/** Reads one reply, multi-line included (`250-…` lines until `250 …`). */
export function parseReply(buffer: string): { code: number; rest: string } | undefined {
  const lines = buffer.split("\r\n");
  for (let index = 0; index < lines.length - 1; index++) {
    const match = /^(\d{3})([ -])/.exec(lines[index] as string);
    if (!match) throw new SmtpError(`odd SMTP reply: '${(lines[index] as string).slice(0, 60)}'`);
    if (match[2] === " ") return { code: Number(match[1]), rest: lines.slice(index + 1).join("\r\n") };
  }
  return undefined;
}

class Conversation {
  private buffer = "";
  private waiting: ((reply: number) => void) | undefined;
  private failed: ((error: Error) => void) | undefined;

  constructor(private socket: Socket | TLSSocket) {
    this.listen(socket);
  }

  listen(socket: Socket | TLSSocket): void {
    this.socket = socket;
    // Nothing read before TLS may count as a reply after it.
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      const reply = parseReply(this.buffer);
      if (reply && this.waiting) {
        this.buffer = reply.rest;
        const done = this.waiting;
        this.waiting = undefined;
        done(reply.code);
      }
    });
    socket.on("error", (error) => this.failed?.(error));
  }

  reply(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.waiting = resolve;
      this.failed = reject;
    });
  }

  async send(line: string, expected: number, what: string): Promise<void> {
    const answer = this.reply();
    this.socket.write(`${line}\r\n`);
    const code = await answer;
    if (code !== expected) throw new SmtpError(`${what}: the server answered ${code}`);
  }
}

export async function checkSmtp(account: { host: string; port: number; user: string; password: string }, options: { timeoutMs?: number; ca?: string } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const plain = tcp({ host: account.host, port: account.port });
  const timer = setTimeout(() => plain.destroy(new SmtpError(`no answer from ${account.host}:${account.port} within ${timeoutMs / 1000} s`)), timeoutMs);
  try {
    const talk = new Conversation(plain);
    if ((await talk.reply()) !== 220) throw new SmtpError("the server did not greet");
    await talk.send("EHLO bivy", 250, "EHLO");
    await talk.send("STARTTLS", 220, "STARTTLS (required: the password never goes in clear)");
    plain.removeAllListeners("data");
    // The system's certificate authorities (a test passes its own).
    const secure = tls({ socket: plain, servername: account.host, ...(options.ca ? { ca: options.ca } : {}) });
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", resolve);
      secure.once("error", (error) => reject(new SmtpError(`TLS with ${account.host}: ${error.message}`)));
    });
    talk.listen(secure);
    await talk.send("EHLO bivy", 250, "EHLO over TLS");
    const token = Buffer.from(`\u0000${account.user}\u0000${account.password}`).toString("base64");
    await talk.send(`AUTH PLAIN ${token}`, 235, "logging in (user or password refused)");
    await talk.send("QUIT", 221, "QUIT").catch(() => undefined);
    secure.end();
  } finally {
    clearTimeout(timer);
    plain.destroy();
  }
}
