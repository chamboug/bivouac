import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { isReachable, parseAddress } from "./metadata-check.js";

describe("metadata check", () => {
  it("reads host:port addresses", () => {
    expect(parseAddress("169.254.169.254:80")).toEqual({ host: "169.254.169.254", port: 80 });
    expect(() => parseAddress("169.254.169.254")).toThrow(/host:port/);
    expect(() => parseAddress(":80")).toThrow(/host:port/);
  });

  it("tells a listening address from a refused one", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    expect(await isReachable(`127.0.0.1:${port}`)).toBe(true);
    await new Promise((resolve) => server.close(resolve));
    expect(await isReachable(`127.0.0.1:${port}`)).toBe(false);
  });
});
