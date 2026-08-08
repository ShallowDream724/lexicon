import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright-core";
import sharp from "sharp";

const root = process.cwd();
const outputDirectory = path.join(root, "docs", "readme");
const baseUrl = (process.env.LEXICON_CAPTURE_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const apiOverride = process.env.LEXICON_CAPTURE_API_URL?.replace(/\/$/, "");

function chromeExecutable() {
  const configured = process.env.LEXICON_CAPTURE_CHROME;
  const candidates = [
    configured,
    process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : undefined,
    process.platform === "win32"
      ? "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
      : undefined,
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error("Chrome was not found. Set LEXICON_CAPTURE_CHROME to its executable path.");
  }
  return executable;
}

async function assertApplicationAvailable() {
  const response = await fetch(baseUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Lexicon at ${baseUrl} returned HTTP ${response.status}.`);
  }
}

async function createPage(browser, viewport) {
  const context = await browser.newContext({
    colorScheme: "light",
    deviceScaleFactor: 2,
    locale: "zh-CN",
    reducedMotion: "reduce",
    viewport,
  });
  const page = await context.newPage();
  if (apiOverride) {
    await page.route("**/api/v1/search*", async (route) => {
      const original = new URL(route.request().url());
      const suffix = original.pathname.split("/api/v1")[1] ?? "";
      const requestHeaders = { ...route.request().headers() };
      delete requestHeaders.origin;
      const response = await route.fetch({
        headers: requestHeaders,
        url: `${apiOverride}${suffix}${original.search}`,
      });
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "access-control-allow-origin": new URL(baseUrl).origin,
        },
      });
    });
  }
  return { context, page };
}

async function stabilizePage(page) {
  await page.addStyleTag({
    content: `
      nextjs-portal, [data-nextjs-toast] { display: none !important; }
      * { caret-color: transparent !important; }
    `,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
}

async function prepareEntryPage(browser, viewport) {
  const { context, page } = await createPage(browser, viewport);
  await page.goto(`${baseUrl}/?q=round`, { waitUntil: "domcontentloaded" });
  await page.locator(".headword-line h1").filter({ hasText: "round" }).waitFor();
  const inflectionLine = page.locator(".entry-inflected-forms").filter({ hasText: "roundest" });
  await inflectionLine.waitFor();
  const inflectionText = (await inflectionLine.innerText()).replace(/\s+/g, " ").trim();
  if (inflectionText !== "(comparative rounder, superlative roundest)") {
    throw new Error(`Unexpected round inflection line: ${inflectionText}`);
  }
  await page.locator(".etymology-resource-card").waitFor();
  await stabilizePage(page);
  return { context, page };
}

async function captureReverseSearch(browser, viewport) {
  const { context, page } = await createPage(browser, viewport);
  await page.goto(`${baseUrl}/?q=${encodeURIComponent("放弃")}`, { waitUntil: "domcontentloaded" });
  const firstHeadword = page.locator(".search-result-item strong").first();
  await firstHeadword.waitFor();
  const firstHeadwordText = (await firstHeadword.innerText()).trim();
  if (firstHeadwordText.replace(/[·‧]/g, "") !== "abandon") {
    throw new Error(`Unexpected first reverse-search result: ${firstHeadwordText}`);
  }
  await stabilizePage(page);
  const image = await page.screenshot({ animations: "disabled", type: "png" });
  await context.close();
  return image;
}

async function captureEntry(browser, viewport) {
  const { context, page } = await prepareEntryPage(browser, viewport);
  const image = await page.screenshot({ animations: "disabled", type: "png" });
  await context.close();
  return image;
}

async function captureEtymology(browser, viewport, { dialogOnly = false } = {}) {
  const { context, page } = await prepareEntryPage(browser, viewport);
  await page.getByRole("button", { name: "打开 round 的词源" }).click();
  await page.locator(".etymology-article-copy").waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    document.querySelector(".etymology-dialog")?.scrollTo(0, 0);
  });
  const image = dialogOnly
    ? await page.locator(".etymology-dialog").screenshot({ animations: "disabled", type: "png" })
    : await page.screenshot({ animations: "disabled", type: "png" });
  await context.close();
  return image;
}

function svgBuffer(value) {
  return Buffer.from(value.trim());
}

async function resizeWithin(input, maxWidth, maxHeight) {
  const metadata = await sharp(input).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Screenshot dimensions are unavailable.");
  }
  const scale = Math.min(maxWidth / metadata.width, maxHeight / metadata.height);
  const width = Math.round(metadata.width * scale);
  const height = Math.round(metadata.height * scale);
  const image = await sharp(input)
    .resize(width, height, { fit: "fill" })
    .png()
    .toBuffer();
  return { height, image, width };
}

async function roundedScreen(input, maxWidth, maxHeight, radius) {
  const resized = await resizeWithin(input, maxWidth, maxHeight);
  const mask = svgBuffer(`
    <svg width="${resized.width}" height="${resized.height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${resized.width}" height="${resized.height}" rx="${radius}" fill="#fff"/>
    </svg>
  `);
  const image = await sharp(resized.image)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
  return { ...resized, image };
}

async function writeHero(input) {
  await sharp(input)
    .resize({ width: 2048 })
    .webp({ effort: 6, quality: 92, smartSubsample: true })
    .toFile(path.join(outputDirectory, "hero-desktop.webp"));
}

async function writeResponsiveDevices(tabletInput, phoneInput) {
  const tablet = await roundedScreen(tabletInput, 900, 1280, 32);
  const phone = await roundedScreen(phoneInput, 500, 1080, 42);
  const tabletFrame = { x: 180, y: 70, width: tablet.width + 64, height: tablet.height + 94 };
  const phoneFrame = {
    x: tabletFrame.x + tabletFrame.width + 120,
    y: 154,
    width: phone.width + 56,
    height: phone.height + 96,
  };
  const canvasHeight = Math.max(tabletFrame.y + tabletFrame.height, phoneFrame.y + phoneFrame.height) + 70;
  const shell = svgBuffer(`
    <svg width="2048" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
          <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#182133" flood-opacity=".16"/>
        </filter>
      </defs>
      <rect width="2048" height="${canvasHeight}" fill="#f1f3f7"/>
      <rect x="${tabletFrame.x}" y="${tabletFrame.y}" width="${tabletFrame.width}" height="${tabletFrame.height}" rx="54" fill="#171c27" filter="url(#shadow)"/>
      <circle cx="${tabletFrame.x + tabletFrame.width / 2}" cy="${tabletFrame.y + 20}" r="5" fill="#798291"/>
      <rect x="${phoneFrame.x}" y="${phoneFrame.y}" width="${phoneFrame.width}" height="${phoneFrame.height}" rx="72" fill="#171c27" filter="url(#shadow)"/>
    </svg>
  `);
  const bezel = svgBuffer(`
    <svg width="2048" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${phoneFrame.x + phoneFrame.width / 2 - 62}" y="${phoneFrame.y + 16}" width="124" height="24" rx="12" fill="#090c12"/>
    </svg>
  `);
  await sharp({ create: { width: 2048, height: canvasHeight, channels: 4, background: "#f1f3f7" } })
    .composite([
      { input: shell, left: 0, top: 0 },
      { input: tablet.image, left: tabletFrame.x + 32, top: tabletFrame.y + 42 },
      { input: phone.image, left: phoneFrame.x + 28, top: phoneFrame.y + 52 },
      { input: bezel, left: 0, top: 0 },
    ])
    .webp({ effort: 6, quality: 92, smartSubsample: true })
    .toFile(path.join(outputDirectory, "responsive-devices.webp"));
}

async function writeReverseSearch(input) {
  await sharp(input)
    .resize({ width: 2048 })
    .webp({ effort: 6, quality: 92, smartSubsample: true })
    .toFile(path.join(outputDirectory, "chinese-reverse-search.webp"));
}

async function writeEtymologyReader(input) {
  const dialog = await roundedScreen(input, 1744, 1536, 24);
  const canvasWidth = dialog.width + 112;
  const canvasHeight = dialog.height + 112;
  const backdrop = svgBuffer(`
    <svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#352d2d" flood-opacity=".16"/>
        </filter>
      </defs>
      <rect width="${canvasWidth}" height="${canvasHeight}" fill="#f4f1eb"/>
      <rect x="56" y="56" width="${dialog.width}" height="${dialog.height}" rx="24" fill="#fff" filter="url(#shadow)"/>
    </svg>
  `);
  await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 4, background: "#f4f1eb" } })
    .composite([
      { input: backdrop, left: 0, top: 0 },
      { input: dialog.image, left: 56, top: 56 },
    ])
    .webp({ effort: 6, quality: 92, smartSubsample: true })
    .toFile(path.join(outputDirectory, "etymology-reader.webp"));
}

async function writeEtymologyMobile(input) {
  const dialog = await roundedScreen(input, 824, 1754, 28);
  const frame = { x: 80, y: 36, width: dialog.width + 96, height: dialog.height + 132 };
  const canvasWidth = frame.width + 160;
  const canvasHeight = frame.height + 72;
  const shell = svgBuffer(`
    <svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
          <feDropShadow dx="0" dy="22" stdDeviation="28" flood-color="#182133" flood-opacity=".17"/>
        </filter>
      </defs>
      <rect width="${canvasWidth}" height="${canvasHeight}" fill="#f1f3f7"/>
      <rect x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}" rx="86" fill="#171c27" filter="url(#shadow)"/>
      <rect x="${frame.x + 32}" y="${frame.y + 72}" width="${dialog.width + 32}" height="${dialog.height + 28}" rx="46" fill="#e8ebf1"/>
    </svg>
  `);
  const bezel = svgBuffer(`
    <svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${frame.x + frame.width / 2 - 110}" y="${frame.y + 16}" width="220" height="36" rx="18" fill="#090c12"/>
    </svg>
  `);
  await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 4, background: "#f1f3f7" } })
    .composite([
      { input: shell, left: 0, top: 0 },
      { input: dialog.image, left: frame.x + 48, top: frame.y + 94 },
      { input: bezel, left: 0, top: 0 },
    ])
    .webp({ effort: 6, quality: 92, smartSubsample: true })
    .toFile(path.join(outputDirectory, "etymology-mobile.webp"));
}

await assertApplicationAvailable();
await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({
  executablePath: chromeExecutable(),
  headless: true,
  args: ["--disable-extensions", "--font-render-hinting=none"],
});

try {
  const [hero, reverseSearch, tablet, phone, reader, mobileReader] = await Promise.all([
    captureEntry(browser, { width: 1440, height: 771 }),
    captureReverseSearch(browser, { width: 1180, height: 820 }),
    captureEntry(browser, { width: 820, height: 1180 }),
    captureEntry(browser, { width: 390, height: 844 }),
    captureEtymology(browser, { width: 900, height: 796 }, { dialogOnly: true }),
    captureEtymology(browser, { width: 390, height: 844 }, { dialogOnly: true }),
  ]);
  await Promise.all([
    writeHero(hero),
    writeReverseSearch(reverseSearch),
    writeResponsiveDevices(tablet, phone),
    writeEtymologyReader(reader),
    writeEtymologyMobile(mobileReader),
  ]);
} finally {
  await browser.close();
}

console.log(`README images written to ${outputDirectory}`);
