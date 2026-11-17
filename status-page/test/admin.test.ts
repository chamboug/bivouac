import type { H3Event } from "h3";
import { afterEach, describe, expect, it } from "vitest";
import { requireAdmin } from "../server/utils/reconciler";

const event = (groups?: string[]) => ({ context: groups ? { user: { sub: "s", name: "n", groups } } : {} }) as unknown as H3Event;

describe("admins only", () => {
  afterEach(() => {
    delete process.env.BIVOUAC_STATUS_GROUPS;
  });

  it("lets in a member of an allowed group", () => {
    process.env.BIVOUAC_STATUS_GROUPS = "admins,ops";
    expect(() => requireAdmin(event(["famille", "ops"]))).not.toThrow();
  });

  it("refuses any other signed-in user", () => {
    process.env.BIVOUAC_STATUS_GROUPS = "admins";
    expect(() => requireAdmin(event(["famille"]))).toThrow(/admins/);
    expect(() => requireAdmin(event([]))).toThrow();
    expect(() => requireAdmin(event())).toThrow();
  });

  it("refuses everyone when the platform named no group", () => {
    expect(() => requireAdmin(event(["admins"]))).toThrow();
    process.env.BIVOUAC_STATUS_GROUPS = "";
    expect(() => requireAdmin(event([""]))).toThrow();
  });
});
