import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright-core";
import sharp from "sharp";

const root = process.cwd();
const outputDirectory = path.join(root, "docs", "readme");
const baseUrl = (process.env.LEXICON_CAPTURE_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

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

async function prepareEntryPage(browser, viewport) {
  const context = await browser.newContext({
    colorScheme: "light",
    deviceScaleFactor: 2,
    locale: "zh-CN",
    reducedMotion: "reduce",
    viewport,
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/?q=round`, { waitUntil: "domcontentloaded" });
  await page.locator(".headword-line h1").filter({ hasText: "round" }).waitFor();
  const inflectionLine = page.locator(".entry-inflected-forms").filter({ hasText: "roundest" });
  await inflectionLine.waitFor();
  const inflectionText = (await inflectionLine.innerText()).replace(/\s+/g, " ").trim();
  if (inflectionText !== "(comparative rounder, superlative roundest)") {
    throw new Error(`Unexpected round inflection line: ${inflectionText}`);
  }
  await page.locator(".etymology-resource-card").waitFor();
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
  return { context, page };
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

async function roundedScreen(input, width, height, radius) {
  const resized = await sharp(input)
    .resize(width, height, { fit: "cover", position: "top" })
    .png()
    .toBuffer();
  const mask = svgBuffer(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" rx="${radius}" fill="#fff"/>
    </svg>
  `);
  return sharp(resized).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

async function writeHero(input) {
  await sharp(input)
    .resize(2048, 1096, { fit: "cover", position: "top" })
    .webp({ effort: 6, quality: 92, smartSubsample: true })
    .toFile(path.join(outputDirectory, "hero-desktop.webp"));
}

async function writeResponsiveDevices(tabletInput, phoneInput) {
  const tablet = await roundedScreen(tabletInput, 1352, 966, 31);
  const phone = await roundedScreen(phoneInput, 424, 918, 41);
  const shell = svgBuffer(`
    <svg width="2048" height="1160" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
          <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#182133" flood-opacity=".16"/>
        </filter>
      </defs>
      <rect width="2048" height="1160" fill="#fff"/>
      <rect x="38" y="50" width="1416" height="1060" rx="54" fill="#171c27" filter="url(#shadow)"/>
      <circle cx="746" cy="70" r="5" fill="#798291"/>
      <rect x="1532" y="50" width="476" height="1060" rx="72" fill="#171c27" filter="url(#shadow)"/>
    </svg>
  `);
  const bezel = svgBuffer(`
    <svg width="2048" height="1160" xmlns="http://www.w3.org/2000/svg">
      <rect x="1708" y="68" width="124" height="22" rx="11" fill="#090c12"/>
    </svg>
  `);
  await sharp({ create: { width: 2048, height: 1160, channels: 4, background: "#fff" } })
    .composite([
      { input: shell, left: 0, top: 0 },
      { input: tablet, left: 70, top: 99 },
      { input: phone, left: 1558, top: 105 },
      { input: bezel, left: 0, top: 0 },
    ])
    .webp({ effort: 6, quality: 92, smartSubsample: true })
    .toFile(path.join(outputDirectory, "responsive-devices.webp"));
}

async function writeEtymologyReader(input) {
  const dialog = await roundedScreen(input, 1744, 1536, 24);
  const backdrop = svgBuffer(`
    <svg width="1800" height="1592" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#352d2d" flood-opacity=".16"/>
        </filter>
      </defs>
      <rect width="1800" height="1592" fill="#f4f1eb"/>
      <rect x="28" y="28" width="1744" height="1536" rx="24" fill="#fff" filter="url(#shadow)"/>
    </svg>
  `);
  await sharp({ create: { width: 1800, height: 1592, channels: 4, background: "#f4f1eb" } })
    .composite([
      { input: backdrop, left: 0, top: 0 },
      { input: dialog, left: 28, top: 28 },
    ])
    .webp({ effort: 6, quality: 92, smartSubsample: true })
    .toFile(path.join(outputDirectory, "etymology-reader.webp"));
}

async function writeEtymologyMobile(input) {
  const dialog = await roundedScreen(input, 824, 1754, 28);
  const shell = svgBuffer(`
    <svg width="1080" height="2040" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
          <feDropShadow dx="0" dy="22" stdDeviation="28" flood-color="#182133" flood-opacity=".17"/>
        </filter>
      </defs>
      <rect width="1080" height="2040" fill="#fff"/>
      <rect x="80" y="36" width="920" height="1968" rx="86" fill="#171c27" filter="url(#shadow)"/>
      <rect x="112" y="108" width="856" height="1850" rx="46" fill="#e8ebf1"/>
    </svg>
  `);
  const bezel = svgBuffer(`
    <svg width="1080" height="2040" xmlns="http://www.w3.org/2000/svg">
      <rect x="430" y="52" width="220" height="36" rx="18" fill="#090c12"/>
    </svg>
  `);
  await sharp({ create: { width: 1080, height: 2040, channels: 4, background: "#fff" } })
    .composite([
      { input: shell, left: 0, top: 0 },
      { input: dialog, left: 128, top: 156 },
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
  const [hero, tablet, phone, reader, mobileReader] = await Promise.all([
    captureEntry(browser, { width: 1440, height: 771 }),
    captureEntry(browser, { width: 1024, height: 732 }),
    captureEntry(browser, { width: 390, height: 844 }),
    captureEtymology(browser, { width: 900, height: 796 }, { dialogOnly: true }),
    captureEtymology(browser, { width: 390, height: 844 }, { dialogOnly: true }),
  ]);
  await Promise.all([
    writeHero(hero),
    writeResponsiveDevices(tablet, phone),
    writeEtymologyReader(reader),
    writeEtymologyMobile(mobileReader),
  ]);
} finally {
  await browser.close();
}

console.log(`README images written to ${outputDirectory}`);
