#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const SOURCE_URL = "http://127.0.0.1:43173/www.igloo.inc/index.html";
const TARGET_URL = "http://127.0.0.1:45173/";
const OUT_DIR = ".fork-skill/evidence/stable";
const REPORT_DIR = ".fork-skill/reports/stable";
const THRESHOLD = 0.02;
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const INTERACTIONS = [
  { name: "scroll-middle", y: 800 },
  { name: "scroll-bottom", y: 1600 },
];

const stableSeedScript = `(() => {
  let seed = 123456789;
  Math.random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
})();`;

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function settlePage(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function capturePage(browser, label, url, viewport) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
  });
  const network = [];

  page.on("response", (response) => {
    const request = response.request();
    network.push({
      url: response.url(),
      status: response.status(),
      method: request.method(),
      resourceType: request.resourceType(),
      contentType: response.headers()["content-type"] || "",
    });
  });

  await page.addInitScript(stableSeedScript);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await settlePage(page);

  const baseDir = path.join(OUT_DIR, label, viewport.name);
  await ensureDir(baseDir);
  await page.screenshot({ path: path.join(baseDir, "viewport.png"), fullPage: false });
  await writeJson(path.join(baseDir, "network.json"), network);
  await writeJson(path.join(baseDir, "dom.json"), await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    text: document.body.innerText.trim(),
    elementCount: document.querySelectorAll("body *").length,
    webglSize: (() => {
      const element = document.querySelector("#webgl");
      const rect = element?.getBoundingClientRect();
      return rect ? { width: rect.width, height: rect.height } : null;
    })(),
  })));

  const interactionResults = [];
  for (const interaction of INTERACTIONS) {
    const beforeY = await page.evaluate(() => scrollY);
    await page.evaluate((y) => window.scrollTo(0, y), interaction.y);
    await page.waitForTimeout(80);
    const scrollState = await page.evaluate(() => ({
      y: scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    }));
    interactionResults.push({
      name: interaction.name,
      requestedY: interaction.y,
      beforeY,
      afterY: scrollState.y,
      ok: scrollState.y === interaction.y || scrollState.scrollHeight <= scrollState.viewportHeight,
    });
  }
  await writeJson(path.join(baseDir, "interaction-results.json"), interactionResults);
  await page.close();

  return { label, viewport: viewport.name, networkCount: network.length, interactionResults };
}

async function compareViewport(viewport) {
  const sourcePath = path.join(OUT_DIR, "source", viewport.name, "viewport.png");
  const targetPath = path.join(OUT_DIR, "target", viewport.name, "viewport.png");
  const diffPath = path.join(REPORT_DIR, "diffs", viewport.name, "viewport.png");
  const source = PNG.sync.read(await readFile(sourcePath));
  const target = PNG.sync.read(await readFile(targetPath));
  const diff = new PNG({ width: source.width, height: source.height });
  const mismatchedPixels = pixelmatch(source.data, target.data, diff.data, source.width, source.height, {
    threshold: 0.1,
    includeAA: true,
  });
  await ensureDir(path.dirname(diffPath));
  await writeFile(diffPath, PNG.sync.write(diff));
  return {
    viewport: viewport.name,
    sourcePath,
    targetPath,
    diffPath,
    width: source.width,
    height: source.height,
    mismatchedPixels,
    mismatchRatio: mismatchedPixels / (source.width * source.height),
  };
}

async function main() {
  await ensureDir(OUT_DIR);
  await ensureDir(REPORT_DIR);
  const browser = await chromium.launch();
  const captures = [];

  try {
    for (const viewport of VIEWPORTS) {
      captures.push(await capturePage(browser, "source", SOURCE_URL, viewport));
      captures.push(await capturePage(browser, "target", TARGET_URL, viewport));
    }
  } finally {
    await browser.close();
  }

  const comparisons = [];
  for (const viewport of VIEWPORTS) {
    comparisons.push(await compareViewport(viewport));
  }

  const domPairs = await Promise.all(VIEWPORTS.map(async (viewport) => {
    const source = JSON.parse(await readFile(path.join(OUT_DIR, "source", viewport.name, "dom.json"), "utf8"));
    const target = JSON.parse(await readFile(path.join(OUT_DIR, "target", viewport.name, "dom.json"), "utf8"));
    return {
      viewport: viewport.name,
      titleMatch: source.title === target.title,
      textMatch: source.text === target.text,
      elementCountMatch: source.elementCount === target.elementCount,
      webglSizeMatch: JSON.stringify(source.webglSize) === JSON.stringify(target.webglSize),
    };
  }));

  const report = {
    tool: "stable-validate",
    source: SOURCE_URL,
    target: TARGET_URL,
    threshold: THRESHOLD,
    pass: comparisons.every((item) => item.mismatchRatio <= THRESHOLD)
      && domPairs.every((item) => item.titleMatch && item.textMatch && item.elementCountMatch && item.webglSizeMatch)
      && captures.every((capture) => capture.interactionResults.every((interaction) => interaction.ok)),
    captures,
    comparisons,
    domPairs,
    note: "Stable validation fixes Math.random before page scripts run. This removes WebGL particle seed drift while preserving the mirrored production bundle.",
  };

  await writeJson(path.join(REPORT_DIR, "report.json"), report);
  const lines = [
    "# Stable Fork Evidence Report",
    "",
    `Status: ${report.pass ? "pass" : "fail"}`,
    `Threshold: ${(THRESHOLD * 100).toFixed(2)}%`,
    "",
    "## Screenshot Diffs",
    "",
    "| Viewport | Mismatch | Diff Image |",
    "| --- | ---: | --- |",
    ...comparisons.map((item) => `| ${item.viewport} | ${(item.mismatchRatio * 100).toFixed(2)}% | ${path.resolve(item.diffPath)} |`),
    "",
    "## DOM",
    "",
    "| Viewport | Title | Text | Elements | WebGL Size |",
    "| --- | --- | --- | --- | --- |",
    ...domPairs.map((item) => `| ${item.viewport} | ${item.titleMatch ? "pass" : "fail"} | ${item.textMatch ? "pass" : "fail"} | ${item.elementCountMatch ? "pass" : "fail"} | ${item.webglSizeMatch ? "pass" : "fail"} |`),
    "",
    "## Interactions",
    "",
    "| Capture | Result |",
    "| --- | --- |",
    ...captures.map((capture) => `| ${capture.label}/${capture.viewport} | ${capture.interactionResults.every((item) => item.ok) ? "pass" : "fail"} |`),
    "",
    report.note,
    "",
  ];
  await writeFile(path.join(REPORT_DIR, "report.md"), lines.join("\n"));
  console.log(`Stable report written to ${path.resolve(REPORT_DIR)}`);
  process.exit(report.pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
