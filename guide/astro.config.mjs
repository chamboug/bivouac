// The bivy user guide (D111): Starlight, published on GitHub Pages.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

// Bivouac's night sky (docs/brand/README.md): code blocks sit on it in both themes.
const NIGHT = "#151c1a";

export default defineConfig({
  site: "https://chamboug.github.io",
  base: "/bivouac",
  integrations: [
    starlight({
      title: "Bivouac",
      description: "The bivy user guide: install Bivouac and run your platform.",
      logo: {
        light: "./src/assets/bivouac-logo.svg",
        dark: "./src/assets/bivouac-logo-night.svg",
        alt: "Bivouac",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/chamboug/bivouac" }],
      editLink: { baseUrl: "https://github.com/chamboug/bivouac/edit/main/guide/" },
      customCss: [
        "@fontsource/ibm-plex-sans/400.css",
        "@fontsource/ibm-plex-sans/600.css",
        "@fontsource/ibm-plex-mono/400.css",
        "@fontsource/ibm-plex-mono/600.css",
        "./src/styles/bivouac.css",
      ],
      expressiveCode: {
        themes: ["github-dark"],
        useStarlightDarkModeSwitch: false,
        styleOverrides: {
          codeBackground: NIGHT,
          borderRadius: "8px",
          borderColor: "transparent",
          codeFontFamily: "'IBM Plex Mono', monospace",
          uiFontFamily: "'IBM Plex Sans', sans-serif",
          frames: {
            editorBackground: NIGHT,
            terminalBackground: NIGHT,
            terminalTitlebarBackground: NIGHT,
            terminalTitlebarBorderBottomColor: "#2c3633",
            editorTabBarBackground: NIGHT,
            shadowColor: "transparent",
          },
        },
      },
      // Sections only: the error messages (###) stay linkable but out of "On this page".
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 2 },
      sidebar: [
        { label: "Commands", items: [{ autogenerate: { directory: "commands" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
      ],
      plugins: [starlightLlmsTxt()],
    }),
  ],
});
