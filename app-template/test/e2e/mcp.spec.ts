import { expect, test, type APIRequestContext } from "@playwright/test";

// Claude's way into an app's MCP (D85): an access token from the identity
// provider, issued for this app's /mcp address to its "-mcp" client. This
// template has no MCP of its own: a request that passes is answered 404 by
// the router, one that does not is answered 401 by the shared layer.

const ISSUER = "http://localhost:4010";
const RESOURCE = "http://localhost:3100/mcp";
const MCP_CLIENT = "test-client-mcp";
const BODY = { jsonrpc: "2.0", id: 1, method: "tools/list" };

async function token(params: Record<string, string>): Promise<string> {
  const reply = await fetch(`${ISSUER}/test/access-token?${new URLSearchParams(params)}`);
  return ((await reply.json()) as { token: string }).token;
}

const call = (request: APIRequestContext, bearer?: string) =>
  request.post("/mcp", { data: BODY, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

test("the protected resource metadata tells Claude where to sign in", async ({ request }) => {
  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    const reply = await request.get(path);
    expect(reply.status()).toBe(200);
    expect(await reply.json()).toMatchObject({ resource: RESOURCE, authorization_servers: [ISSUER] });
  }
});

test("without a token, /mcp answers 401 and points to the metadata", async ({ request }) => {
  const reply = await call(request);
  expect(reply.status()).toBe(401);
  expect(reply.headers()["www-authenticate"]).toBe(
    'Bearer resource_metadata="http://localhost:3100/.well-known/oauth-protected-resource/mcp"',
  );
});

test("a valid token passes, from any site: no cookie is involved", async ({ request }) => {
  const reply = await request.post("/mcp", {
    data: BODY,
    headers: { authorization: `Bearer ${await token({ aud: RESOURCE, client_id: MCP_CLIENT })}`, origin: "https://claude.ai" },
  });
  expect(reply.status()).toBe(404);
  expect(reply.headers()["www-authenticate"]).toBeUndefined();
});

test.describe("tokens that must not pass", () => {
  const cases: [string, Record<string, string>][] = [
    ["issued for another address", { aud: "http://localhost:3100/other", client_id: MCP_CLIENT }],
    ["issued for the app's sign-in client", { aud: "test-client", client_id: "test-client" }],
    ["from another client", { aud: RESOURCE, client_id: "someone-else" }],
    ["an ID token, not an access token", { aud: RESOURCE, client_id: MCP_CLIENT, typ: "JWT" }],
    ["expired", { aud: RESOURCE, client_id: MCP_CLIENT, exp: "-120" }],
    ["signed with another key", { aud: RESOURCE, client_id: MCP_CLIENT, foreign: "1" }],
  ];
  for (const [name, params] of cases) {
    test(name, async ({ request }) => {
      const reply = await call(request, await token(params));
      expect(reply.status()).toBe(401);
      expect(reply.headers()["www-authenticate"]).toContain('error="invalid_token"');
    });
  }

  test("garbage, or a token sent another way", async ({ request }) => {
    expect((await call(request, "not-a-token")).status()).toBe(401);
    const valid = await token({ aud: RESOURCE, client_id: MCP_CLIENT });
    expect((await request.post(`/mcp?access_token=${valid}`, { data: BODY })).status()).toBe(401);
    expect((await request.post("/mcp", { data: BODY, headers: { authorization: `bearer  ${valid}` } })).status()).toBe(401);
  });
});

test("the session cookie alone does not open /mcp", async ({ page }) => {
  await page.goto("/");
  const reply = await page.request.post("/mcp", { data: BODY, headers: { origin: "http://localhost:3100" } });
  expect(reply.status()).toBe(401);
});
