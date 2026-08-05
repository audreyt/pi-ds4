#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const ogHtmlPath = join(root, "og-image.html");
const ogJpgPath = join(root, "og-pi-ds4.jpg");
const indexPath = join(root, "index.html");
const packagePath = join(root, "package.json");
const renderScriptPath = join(root, "scripts", "render-og-image.mjs");

function fail(message) {
  console.error(`OG verification failed: ${message}`);
  process.exit(1);
}

function readUtf8(path) {
  return readFileSync(path, "utf8");
}

function decodeEntities(text) {
  return text
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8209;/g, "‑")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function textContent(html) {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function jpegSize(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) fail("og-pi-ds4.jpg is not a JPEG file");
  let offset = 2;
  while (offset < buffer.length) {
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2) fail(`invalid JPEG marker length at offset ${offset}`);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  fail("could not find JPEG dimensions");
}

function parseAttributes(tag) {
  const attrs = new Map();
  for (const [, name, value] of tag.matchAll(/\s([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) {
    attrs.set(name, decodeEntities(value));
  }
  return attrs;
}

function metaContent(html, selectorName, selectorValue) {
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(tag);
    if (attrs.get(selectorName) !== selectorValue) continue;
    const content = attrs.get("content");
    if (!content) fail(`index.html meta ${selectorName}="${selectorValue}" is missing content`);
    return content;
  }
  fail(`index.html is missing meta ${selectorName}="${selectorValue}"`);
}

function verifyCacheBustedOgImageUrl(label, rawUrl, expectedVersion) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail(`${label} must be an absolute URL: ${rawUrl}`);
  }
  if (url.origin !== "https://pi.audreyt.org") fail(`${label} must use https://pi.audreyt.org, got ${url.origin}`);
  if (url.pathname !== "/og-pi-ds4.jpg") fail(`${label} must point at /og-pi-ds4.jpg, got ${url.pathname}`);
  if (url.searchParams.get("v") !== expectedVersion) fail(`${label} cache-busting v= must equal current JPEG hash ${expectedVersion}`);
  if ([...url.searchParams.keys()].length !== 1) fail(`${label} must only carry the v= cache-busting query`);
  if (url.hash) fail(`${label} must not include a fragment`);
}

if (!existsSync(renderScriptPath)) fail("scripts/render-og-image.mjs is missing");

const packageJson = JSON.parse(readUtf8(packagePath));
if (packageJson.scripts?.["og:render"] !== "node scripts/render-og-image.mjs") {
  fail("package.json is missing script: og:render = node scripts/render-og-image.mjs");
}
if (packageJson.scripts?.["og:check-render"] !== "node scripts/render-og-image.mjs --check") {
  fail("package.json is missing script: og:check-render = node scripts/render-og-image.mjs --check");
}
if (packageJson.scripts?.["og:verify"] !== "node scripts/verify-og-image.mjs") {
  fail("package.json is missing script: og:verify = node scripts/verify-og-image.mjs");
}

if (!existsSync(ogHtmlPath)) fail("og-image.html source page is missing");

const ogHtml = readUtf8(ogHtmlPath);
const ogText = textContent(ogHtml);
for (const required of ["pi-ds4 Guide", "v 0.5.0", "96+ GB", "~87", "Headroom128", "545 t/s", "35 t/s"]) {
  if (!ogText.includes(required)) fail(`og-image.html is missing current fact: ${required}`);
}
for (const stale of ["Q2_K", "~99 GB", "87/91", "87/98", "1M", "360 tok/s", "33 tok/s", "xhigh"]) {
  if (ogText.includes(stale)) fail(`og-image.html still contains stale OG text: ${stale}`);
}

const ogJpg = readFileSync(ogJpgPath);
const ogImageVersion = createHash("sha256").update(ogJpg).digest("hex").slice(0, 12);
const { width, height } = jpegSize(ogJpg);
if (width !== 1200 || height !== 630) fail(`og-pi-ds4.jpg is ${width}×${height}; expected 1200×630`);

const indexHtml = readUtf8(indexPath);
verifyCacheBustedOgImageUrl("og:image", metaContent(indexHtml, "property", "og:image"), ogImageVersion);
verifyCacheBustedOgImageUrl("twitter:image", metaContent(indexHtml, "name", "twitter:image"), ogImageVersion);
if (!indexHtml.includes('property="og:image:width" content="1200"')) fail("index.html og:image:width is not 1200");
if (!indexHtml.includes('property="og:image:height" content="630"')) fail("index.html og:image:height is not 630");
const alt = indexHtml.match(/<meta property="og:image:alt" content="([^"]+)"/);
if (!alt) fail("index.html is missing og:image:alt");
const decodedAlt = decodeEntities(alt[1]);
for (const required of ["~87 GB", "Headroom128", "545 t/s", "35 t/s"]) {
  if (!decodedAlt.includes(required)) fail(`og:image:alt is missing current fact: ${required}`);
}
for (const stale of ["Q2_K", "~99 GB", "87/91", "87/98", "1M", "360 tok/s", "33 tok/s", "xhigh"]) {
  if (decodedAlt.includes(stale)) fail(`og:image:alt still contains stale OG text: ${stale}`);
}

console.log(`OG image verified: ${width}×${height}, source facts, and metadata are current.`);
