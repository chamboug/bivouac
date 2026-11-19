// Bivouac's brand (docs/brand/README.md): cards are white on the warm page
// background, with a hairline border and no shadow.
export default defineAppConfig({
  ui: {
    card: { variants: { variant: { outline: { root: "bg-elevated ring ring-default divide-y divide-default" } } } },
  },
});
