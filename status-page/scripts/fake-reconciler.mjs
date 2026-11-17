// A stand-in for the reconciler's internal API, for `npm run dev:local`:
// fixed sample data, the same shape as packages/reconciler/src/api.ts.
import { createServer } from "node:http";

const TOKEN = process.env.BIVOUAC_API_TOKEN;
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const MiB = 1024 ** 2;
const container = (name, image, extra = {}) => ({
  name, kind: name.startsWith("bivouac-app-") && name !== "bivouac-app-status" ? "app" : "platform", image, state: "running", health: null, startedAt: iso(26 * 3600_000), restarts: 0, oomKilled: false,
  memory: { usedBytes: 55 * MiB, limitBytes: 1024 * MiB }, ...extra,
});

const state = () => ({
  generatedAt: new Date().toISOString(),
  reconciler: { image: "ghcr.io/example/bivouac-reconciler:sha-df59c98@sha256:47e2", startedAt: iso(2 * 86400_000) },
  lastPass: { at: iso(40_000), status: "unchanged", commit: "7c1fd9c", changes: [], failures: [] },
  containers: [
    container("bivouac-app-library", "ghcr.io/example/library:sha-3aff14a"),
    container("bivouac-app-pantry", "ghcr.io/example/pantry:sha-cbcfc16", { restarts: 1 }),
    container("bivouac-caddy", "caddy:2.11.9@sha256:0c22", { health: "healthy", memory: { usedBytes: 30 * MiB, limitBytes: 3900 * MiB } }),
    container("bivouac-pocket-id", "ghcr.io/pocket-id/pocket-id:v2.19.2@sha256:3ee2", { health: "healthy", restarts: 10, memory: { usedBytes: 40 * MiB, limitBytes: 3900 * MiB } }),
    container("bivouac-postgres", "postgis/postgis:18-3.7@sha256:440b", { health: "healthy", memory: { usedBytes: 180 * MiB, limitBytes: 3900 * MiB } }),
    container("bivouac-app-status", "ghcr.io/example/bivouac-status:sha-df59c98", { memory: { usedBytes: 45 * MiB, limitBytes: 1024 * MiB } }),
    container("bivouac-reconciler", "ghcr.io/example/bivouac-reconciler:sha-df59c98", { memory: { usedBytes: 70 * MiB, limitBytes: 3900 * MiB } }),
  ],
  backup: { lastSuccessAt: iso(16 * 3600_000), lastAttemptAt: iso(16 * 3600_000), lastError: null, restoreTestWeekPassed: 2968, restoreError: null, maintenanceError: null },
  incidents: process.env.FAKE_INCIDENT ? [{ key: "disk:host", message: "The disk is 85% full", since: iso(3600_000) }] : [],
  host: {
    disk: { totalBytes: 31 * 1024 ** 3, availableBytes: 22 * 1024 ** 3 },
    memory: { totalBytes: 3900 * MiB, availableBytes: 2800 * MiB },
    swap: { totalBytes: 2048 * MiB, freeBytes: 2047 * MiB },
  },
});

createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${TOKEN}`) return response.writeHead(401).end();
  if (request.url === "/v1/state") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state()));
  if (request.url?.startsWith("/v1/logs/")) {
    return response.writeHead(200, { "content-type": "text/plain" }).end(
      Array.from({ length: 30 }, (_, i) => `${iso((30 - i) * 60_000)} {"message":"pass unchanged","commit":"7c1fd9c"} <b>not html</b>`).join("\n"),
    );
  }
  if (request.url === "/v1/sync" && request.method === "POST") return response.writeHead(202, { "content-type": "application/json" }).end('{"started":true}');
  response.writeHead(404).end();
}).listen(Number(process.env.FAKE_RECONCILER_PORT ?? 4012));
