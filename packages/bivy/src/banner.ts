// The Bivouac logo in a terminal (docs/brand): a tent with its light on, in
// plain ASCII so it reads in any terminal, with or without colour.

// 256-colour codes closest to the brand's `canvas` (#d4501c) and `glow` (#f5bd4f).
const CANVAS = "\u001b[38;5;166m";
const GLOW = "\u001b[38;5;215m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

export interface BannerOutput {
  isTTY?: boolean;
}

// Shown only to a person: never when the output goes to a file or a script.
export function shouldShowBanner(output: BannerOutput): boolean {
  return output.isTTY === true;
}

// Colour unless NO_COLOR is set to anything but an empty string (no-color.org).
export function useColor(env: NodeJS.ProcessEnv): boolean {
  return env.NO_COLOR === undefined || env.NO_COLOR === "";
}

export function banner(color: boolean): string {
  const [t, l, b, d, r] = color ? [CANVAS, GLOW, BOLD, DIM, RESET] : ["", "", "", "", ""];
  return [
    `     ${t}/\\${r}`,
    `    ${t}/  \\${r}      ${b}bivouac${r}`,
    `   ${t}/${r} ${l}/\\${r} ${t}\\${r}     ${d}zero config, never silent${r}`,
    `  ${t}/_/${r}  ${t}\\_\\${r}    ${d}the bivy command line${r}`,
    "",
  ].join("\n");
}

export function printBanner(output: BannerOutput & { write(text: string): unknown } = process.stdout, env = process.env): void {
  if (shouldShowBanner(output)) output.write(`${banner(useColor(env))}\n`);
}
