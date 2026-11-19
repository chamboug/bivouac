# Bivouac's brand

A bivouac is a light shelter put up for the night: little gear, chosen with
care, and you sleep soundly. Bivouac does the same for small apps.

The logo is **a tent with its light on**. The tent is the shelter (the
platform); the light in its door is the project's promise: someone is always
awake, maintenance is never silent. Three words judge every choice: **calm,
sturdy, plain**.

## Logo

| File | Use |
| --- | --- |
| `bivouac-logo.svg` | Full logo, name in ink, on light backgrounds. |
| `bivouac-logo-night.svg` | Full logo, name in `snow`, on `night` or in dark mode. |
| `bivouac-logo-ink.svg` | One colour, for black-and-white printing. |
| `bivouac-mark.svg` | The tent alone, in colour, when space is short. |
| `bivouac-mark-ink.svg`, `bivouac-mark-snow.svg` | The tent alone, one colour. |
| `favicon.svg` | Browser tab: the tent on a `night` square. |
| `bivouac-avatar.svg`, `bivouac-avatar.png` | GitHub avatar, 512 × 512, safe for a round crop. |

All files come from `generate.py` (no font: the name is drawn with strokes).

- The tent fits a 64 × 64 square: a triangle split into a sunlit face
  (`canvas`) and a shaded one (`canvas-shade`), with a triangular door in
  `glow`. The name's baseline sits on the tent's base.
- Leave around the logo an empty margin as tall as the door. Smallest sizes:
  16 px for the tent, 24 px high for the full logo.
- Never recolour the tent, turn the light off (except in one-colour
  versions, where the door is cut out), set the name in a font, stretch,
  slant, shadow, or capitalise it.

## Colours

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `canvas` | `#d4501c` | `#ee6a33` | The brand's orange: logo, large marks. Never body text in light mode (3.8:1). Never a state. |
| `canvas-shade` | `#a8400f` | `#f59466` | Links, primary button, focus ring (5.5:1 and more). |
| `glow` | `#f5bd4f` | | The tent's light and the status page's "live" dot only. Never a warning. |
| `night` | `#151c1a` | | Night sky: header band, avatar, favicon, code blocks. |
| `snow` | `#f5f2eb` | | Snow: the name on `night`. |
| `background` | `#f5f2eb` | `#111715` | Page background. |
| `surface` | `#ffffff` | `#1a2220` | Cards. |
| `hairline` / `hairline-strong` | `#e2ddd2` / `#858c88` | `#2c3633` / `#6b7672` | Hairlines / control borders (3:1). |
| `ink` / `ink-soft` / `ink-faint` | `#1a221f` / `#4e5955` / `#5f6965` | `#edf0ea` / `#b0b8b3` / `#8e9893` | Text, secondary text, metadata. |
| `ok` | `#1d6f63` | `#4dbfac` | "Running". A pine green leaning blue, apart from `down` for colour-blind readers. |
| `warning` | `#8a5d00` | `#e3b23c` | "Needs attention". |
| `down` | `#b02a1f` | `#f07465` | "Down", failures. |

Every text colour reads at 4.5:1 or more on `background` and `surface`, in both
themes (WCAG 2 ratio, computed). **A state is always a word and an icon**
(`i-lucide-circle-check`, `i-lucide-triangle-alert`, `i-lucide-circle-x`),
never a colour alone.

## Type and shapes

- **IBM Plex Sans** for text, **IBM Plex Mono** for versions, commands, logs
  and large figures (SIL Open Font License). Weights 400 and 600 (500 for
  figures). Group labels in small spaced capitals (`PLATFORM`, `APPS`).
- 4 px grid; radii 4 px (controls), 8 px (cards), full (badges).
- Borders, not shadows: no drop shadow, gradient or blur. No illustrations,
  no emoji. Icons: Lucide.
- No motion, except the `glow` dot that pulses while the reconciler passes,
  stopped when the reader asks for reduced motion.

## Voice

Plain words, short sentences, things said as they are: "Last night's backup
went fine", "The restore test failed; the data is intact". No exclamation
marks, no "Oops". The product is **Bivouac** in a sentence, **bivouac** in
the logo, **`bivy`** always lower case and in monospace.

## Where it appears

- **Status page**: a `night` header band with `bivouac-logo-night.svg` and the
  live dot; the page follows the device's light or dark mode; the tab title
  starts with "Down ·" when something is down.
- **GitHub**: `bivouac-avatar.png` as avatar; the README opens with the logo,
  switching with GitHub's theme through `<picture>`.
- **Documentation site** (later): pages on `background`, a 680 px reading column,
  links in `canvas-shade`, code blocks on `night`.
- **`bivy`**: the ASCII tent (`packages/bivy/src/banner.ts`), shown only in a
  terminal, without colour when `NO_COLOR` is set:

  ```text
       /\
      /  \      bivouac
     / /\ \     zero config, never silent
    /_/  \_\    the bivy command line
  ```
