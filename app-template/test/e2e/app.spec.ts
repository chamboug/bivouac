import { get } from "node:http";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

test("the health endpoint is public and sees the database", async ({ request }) => {
  const reply = await request.get("/api/health");
  expect(reply.status()).toBe(200);
  expect(await reply.json()).toEqual({ status: "ok" });
});

test("migrations ran at startup", async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const [row] = await sql`select to_regclass('public.notes') as name`;
  await sql.end();
  expect(row.name).toBe("notes");
});

test("without a session, data routes refuse and pages go to sign-in", async ({ request }) => {
  expect((await request.get("/api/me")).status()).toBe(401);
  expect((await request.get("/api/files/a.txt")).status()).toBe(401);
  expect((await request.post("/api/anything", { headers: { origin: "http://localhost:3100" } })).status()).toBe(401);
  const page = await request.get("/some/page", { maxRedirects: 0 });
  expect(page.status()).toBe(302);
  expect(page.headers().location).toBe("/auth/login?returnTo=%2Fsome%2Fpage");
});

test("a path with dot segments is refused, even when it ends on a public one", async () => {
  // Sent raw: browsers and test clients clean such paths up before sending.
  const status = (path: string) =>
    new Promise<number | undefined>((resolve, reject) => {
      get({ host: "localhost", port: 3100, path }, (reply) => {
        reply.resume();
        resolve(reply.statusCode);
      }).on("error", reject);
    });
  expect(await status("/api/files/x/%2e%2e/%2e%2e/%2e%2e/auth/login")).toBe(400);
  expect(await status("/secret/%2E%2E/auth/login")).toBe(400);
  expect(await status("/secret/../auth/login")).toBe(400);
  expect(await status("/secret/..%2fauth/login")).toBe(400);
  // Dots elsewhere are fine: still the usual answer for a signed-out visitor.
  expect(await status("/a..b/page?next=/../x")).toBe(302);
});

test("requests that change something are refused from another site", async ({ request }) => {
  const sibling = { "sec-fetch-site": "same-site", origin: "http://other.localhost:3100" };
  expect((await request.post("/auth/logout", { headers: sibling })).status()).toBe(403);
  expect((await request.post("/api/anything")).status()).toBe(403);
});

test("the session cannot be passed in a header, and pages cannot be framed", async ({ request }) => {
  const reply = await request.get("/api/health");
  expect(reply.headers()["content-security-policy"]).toBe("frame-ancestors 'self'");
  expect((await request.get("/api/me", { headers: { "x-__host-bivouac-session-session": "x" } })).status()).toBe(401);
});

test("a callback without a sign-in in progress is refused", async ({ request }) => {
  expect((await request.get("/auth/callback?code=x&state=y")).status()).toBe(400);
});

test("signing in shows the user, with a locked-down cookie", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Hello Test User" })).toBeVisible();
  await expect(page.getByText("Groups: famille")).toBeVisible();

  const cookie = (await context.cookies()).find((c) => c.name === "__Host-bivouac-session");
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
  expect((await context.cookies()).some((c) => c.name === "__Host-bivouac-login")).toBe(false);
});

test("signing out removes the session and ends the one at the identity provider", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Hello Test User" })).toBeVisible();
  const reply = await page.request.post("/auth/logout", { maxRedirects: 0, headers: { origin: "http://localhost:3100" } });
  expect(reply.status()).toBe(303);
  expect(reply.headers().location).toBe("http://localhost:4010/logout");
  expect((await context.cookies()).some((c) => c.name === "__Host-bivouac-session")).toBe(false);
  expect((await page.request.get("/api/me")).status()).toBe(401);
});

test("a return address on another site is ignored", async ({ page }) => {
  await page.goto("/auth/login?returnTo=//evil.example/");
  await expect(page).toHaveURL("/");
});
