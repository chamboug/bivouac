import { createServer } from "node:http";

// GET /api/health: 200, or 500 when TEST_FAIL_HEALTH is set (to test a
// failed deployment). GET /env: the names of the variables the platform
// injected, never their values.
const injected = Object.keys(process.env).filter((name) =>
  /^(PORT|DATABASE_URL|OIDC_|SMTP_|TEST_)/.test(name),
);

createServer((request, response) => {
  if (request.url === "/api/health") {
    response.writeHead(process.env.TEST_FAIL_HEALTH ? 500 : 200).end();
  } else if (request.url === "/env") {
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(injected.sort()));
  } else {
    response.writeHead(404).end();
  }
}).listen(Number(process.env.PORT ?? 3000));
