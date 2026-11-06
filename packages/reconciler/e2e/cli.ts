/**
 * `npm run platform:up`: the miniature platform on this machine, for
 * developing an app against the real base services (D43). The reconciler
 * keeps running in the background and passes every 10 s; edit the instance
 * repo it prints and commit to see the changes applied.
 *
 * `npm run platform:down`: removes every container, network and volume.
 *
 * Caddy listens on 127.0.0.1:8443 (override with BIVOUAC_LOCAL_HTTPS_PORT):
 * open https://auth.apps.bivouac.localhost:8443 and accept Caddy's local
 * certificate. Pocket ID itself believes it lives on port 443, so logins in
 * the browser will need port 443 (BIVOUAC_LOCAL_HTTPS_PORT=443).
 */
import { DOMAIN, buildImages, createPlatform, destroyPlatform, startReconciler } from "./platform.ts";

const command = process.argv[2];
if (command === "down") {
  destroyPlatform();
  console.log("Miniature platform removed.");
} else if (command === "up") {
  const port = process.env.BIVOUAC_LOCAL_HTTPS_PORT ?? "8443";
  destroyPlatform();
  console.log("Building the reconciler and test app images…");
  buildImages();
  const platform = createPlatform();
  startReconciler(platform, `443/tcp=127.0.0.1:${port}`);
  console.log(`Reconciler started. Follow it with: docker logs --follow bivouac-reconciler

Instance repo:  ${platform.repo}   (commit to apply changes)
Pocket ID:      https://auth.${DOMAIN}:${port}
Postgres:       docker exec -it bivouac-postgres psql -U postgres
Remove it all:  npm run platform:down`);
} else {
  console.error("Usage: node packages/reconciler/e2e/cli.ts up|down");
  process.exitCode = 1;
}
