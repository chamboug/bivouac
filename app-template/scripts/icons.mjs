// Draws the PNG icons from public/icon.svg: `npm run icons`, then commit them.
// Phones want PNGs: iOS takes its home-screen icon from apple-touch-icon only,
// Android from the manifest. Playwright's Chromium (already used by the tests)
// does the drawing: no other tool to install.
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const svg = await readFile("public/icon.svg");
const src = `data:image/svg+xml;base64,${svg.toString("base64")}`;
const sizes = { "favicon.png": 64, "icon-180.png": 180, "icon-192.png": 192, "icon-512.png": 512 };

const browser = await chromium.launch();
try {
  for (const [name, size] of Object.entries(sizes)) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<body style="margin:0"><img src="${src}" width="${size}" height="${size}" style="display:block">`);
    await page.locator("img").evaluate((img) => img.decode());
    await page.screenshot({ path: `public/${name}` });
    await page.close();
    console.log(`public/${name}`);
  }
} finally {
  await browser.close();
}
