import { connect } from "node:net";

/**
 * Checks, from inside the reconciler's container, that the provider's
 * metadata service is out of reach (D7). Ignition loads a block for every
 * container at boot; nothing would notice if it were later removed (a
 * flushed ruleset, for example), so each pass tries the real path, as any
 * container would. With the block, the connection is refused at once.
 */

/** Where the metadata service listens, as `host:port`. */
export const METADATA_ADDRESS = "169.254.169.254:80";

export function parseAddress(address: string): { host: string; port: number } {
  const index = address.lastIndexOf(":");
  const port = Number(address.slice(index + 1));
  if (index <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`'${address}' is not a host:port address`);
  }
  return { host: address.slice(0, index), port };
}

/** Whether a TCP connection to `address` succeeds within `timeoutMs`. */
export function isReachable(address: string, timeoutMs = 3000): Promise<boolean> {
  const { host, port } = parseAddress(address);
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
