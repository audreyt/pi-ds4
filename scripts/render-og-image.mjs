#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { accessSync, constants, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const width = 1200;
const height = 630;
const sourceHtml = join(root, "og-image.html");
const outputJpeg = join(root, "og-pi-ds4.jpg");
const pngOut = join(root, "og-pi-ds4.png");
const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const keepPng = args.has("--keep-png");
// --check is intentionally exact and same-machine: browser font rasterization and JPEG
// encoders are not portable byte-for-byte contracts. Use npm run og:verify for the
// portable metadata/source/dimension gate; use npm run og:check-render after rendering.

function die(message) {
  console.error(`OG render failed: ${message}`);
  process.exit(1);
}

function canExecute(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (canExecute(candidate)) return candidate;
  }
  return undefined;
}

function findChrome() {
  const explicit = process.env.CHROME_BIN || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit && canExecute(explicit)) return explicit;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    findOnPath("google-chrome"),
    findOnPath("google-chrome-stable"),
    findOnPath("chromium"),
    findOnPath("chromium-browser"),
    findOnPath("chrome"),
    findOnPath("microsoft-edge"),
  ].filter(Boolean);
  return candidates.find(canExecute);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) die(`${basename(command)}: ${result.error.message}`);
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    die(`${basename(command)} exited ${result.status}`);
  }
}

function renderTo(jpegPath, tmpRoot) {
  const chrome = findChrome();
  if (!chrome) die("Chrome/Chromium not found. Set CHROME_BIN to a headless-capable browser.");
  const pngPath = join(tmpRoot, "og-pi-ds4.png");
  run(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${width},${height}`,
    `--screenshot=${pngPath}`,
    pathToFileURL(sourceHtml).href,
  ]);
  if (process.platform === "darwin") {
    run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "92", pngPath, "--out", jpegPath]);
  } else if (findOnPath("magick")) {
    run(findOnPath("magick"), [pngPath, "-quality", "92", jpegPath]);
  } else if (findOnPath("convert")) {
    run(findOnPath("convert"), [pngPath, "-quality", "92", jpegPath]);
  } else {
    die("No JPEG converter found. Install ImageMagick, or run on macOS with sips.");
  }
  if (keepPng && !checkOnly) copyFileSync(pngPath, pngOut);
}

const temp = mkdtempSync(join(tmpdir(), "pi-ds4-og-"));
try {
  const target = checkOnly ? join(temp, "og-pi-ds4.check.jpg") : outputJpeg;
  renderTo(target, temp);
  if (checkOnly) {
    const expected = readFileSync(outputJpeg);
    const actual = readFileSync(target);
    if (expected.length !== actual.length || !expected.equals(actual)) {
      die("og-pi-ds4.jpg differs from a fresh render of og-image.html; run `npm run og:render`.");
    }
    console.log("OG render check passed: og-pi-ds4.jpg matches og-image.html.");
  } else {
    console.log(`Rendered ${resolve(outputJpeg)} from ${resolve(sourceHtml)}.`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
