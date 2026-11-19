import { describe, expect, it } from "vitest";
import { banner, printBanner, useColor } from "./banner.js";

describe("banner", () => {
  it("is plain ASCII without colour, the tent and the name side by side", () => {
    const text = banner(false);
    expect(text).toMatch(/^[\x20-\x7e\n]+$/);
    expect(text.split("\n").slice(0, 4)).toEqual([
      "     /\\",
      "    /  \\      bivouac",
      "   / /\\ \\     zero config, never silent",
      "  /_/  \\_\\    the bivy command line",
    ]);
  });

  it("draws the same shape in colour", () => {
    expect(banner(true).replace(/\u001b\[[0-9;]*m/g, "")).toBe(banner(false));
  });

  it("follows NO_COLOR", () => {
    expect(useColor({})).toBe(true);
    expect(useColor({ NO_COLOR: "" })).toBe(true);
    expect(useColor({ NO_COLOR: "1" })).toBe(false);
  });

  it("prints nothing when the output is not a terminal", () => {
    const written: string[] = [];
    printBanner({ isTTY: false, write: (text: string) => written.push(text) }, {});
    printBanner({ write: (text: string) => written.push(text) }, {});
    expect(written).toEqual([]);
    printBanner({ isTTY: true, write: (text: string) => written.push(text) }, { NO_COLOR: "1" });
    expect(written).toEqual([`${banner(false)}\n`]);
  });
});
