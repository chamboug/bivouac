import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The guide quotes bivy's messages in <samp>, with … for what changes from
 * one run to the next. Each quoted piece must still be in the code that
 * prints it, so a reworded message cannot leave a page behind.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const PAGES = join(repo, "guide", "src", "content", "docs");
/** Where the messages come from: bivy, and the reconciler's answers it prints (restore, status, backup). */
const SOURCES = ["packages/bivy/src", "packages/reconciler/src", "packages/manifest/src"].map((path) => join(repo, path));

const files = (directory: string, extension: string): string[] =>
  readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(extension) && !path.endsWith(".test.ts"))
    .map((path) => join(directory, path));

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'" };
const decode = (html: string) => html.replace(/&(?:lt|gt|amp|quot|#39);/g, (entity) => ENTITIES[entity] as string);

/** The code, with string escapes undone, as the messages read on screen. */
const code = SOURCES.flatMap((directory) => files(directory, ".ts"))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n")
  .replace(/\\(["'`])/g, "$1");

/** bivy capitalises every error it prints (say.ts): the code may hold it in lower case. */
const inCode = (piece: string) => code.includes(piece) || code.includes(piece.charAt(0).toLowerCase() + piece.slice(1));

/**
 * A piece of a quote is in the code as it is, or in up to three parts around
 * the values the code fills in (`The last pass ${…}`, `${file}: ${message}`).
 * Each part keeps at least two words or six letters, so a message cannot
 * pass on common words alone; only the first may be one short word (`No ${…}`).
 */
function covered(piece: string, splits = 2, first = true): boolean {
  const clean = piece.replace(/^[\s:;,]+|[\s:;,]+$/g, "");
  if (clean === "" || inCode(clean)) return true;
  if (splits === 0) return false;
  const words = clean.split(" ");
  const enough = (part: string) => part.includes(" ") || part.length >= 6;
  for (let at = 1; at < words.length; at++) {
    const head = words.slice(0, at).join(" ");
    const tail = words.slice(at).join(" ");
    if ((first || enough(head)) && enough(tail) && covered(head, 0, false) && covered(tail, splits - 1, false)) return true;
  }
  return false;
}

/** The literal pieces of a quote: what … stands for is left out, with a word it cuts in two (`auth.…`). */
const pieces = (quote: string): string[] =>
  quote.split("…").map((piece, index, all) => {
    let words = piece.split(" ");
    if (index > 0 && !piece.startsWith(" ")) words = words.slice(1);
    if (index < all.length - 1 && !piece.endsWith(" ")) words = words.slice(0, -1);
    return words.join(" ").trim();
  });

const quotes = files(PAGES, ".md").flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/<samp>([\s\S]*?)<\/samp>/g)].map((match) => ({
    page: file.slice(PAGES.length + 1),
    quote: decode(match[1] as string),
  })),
);

describe("the messages the guide quotes", () => {
  it("are found in the guide", () => {
    expect(quotes.length).toBeGreaterThan(50);
  });

  it("are told apart from a message bivy does not print", () => {
    expect(pieces("The last pass found the instance repo invalid").every((piece) => covered(piece))).toBe(true);
    expect(pieces("The reconciler set the instance repo on fire: …").every((piece) => covered(piece))).toBe(false);
    expect(pieces("No sha-… for ghcr.io/…: CI has not published that commit, maybe").every((piece) => covered(piece))).toBe(false);
  });

  it("are all still in bivy's code", () => {
    const missing = quotes.flatMap(({ page, quote }) =>
      pieces(quote)
        .filter((piece) => piece.length >= 3 && !covered(piece))
        .map((piece) => `${page}: "${piece}" (in "${quote}")`),
    );
    expect(missing).toEqual([]);
  });
});
