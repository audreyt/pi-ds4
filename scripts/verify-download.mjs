import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await access(join(root, "download_model.sh"), constants.X_OK);
const source = await readFile(join(root, "download_model.sh"), "utf8");
const languageFile = source.match(/^LANG_FILE="([^"]+)"$/m)[1];
const visionFile = source.match(/^ENC_FILE="([^"]+)"$/m)[1];
const language = Buffer.from("model\n");
const vision = Buffer.from("vis");
const digest = createHash("sha256").update(language).digest("hex");
const script = source
  .replace(/^LANG_BYTES=\d+$/m, `LANG_BYTES=${language.length}`)
  .replace(/^ENC_BYTES=\d+$/m, `ENC_BYTES=${vision.length}`)
  .replace(/^LANG_SHA256="[^"]+"$/m, `LANG_SHA256="${digest}"`);

async function fixture(corrupt = false) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ds4-download-"));
  await mkdir(join(cwd, "bin"));
  await mkdir(join(cwd, "gguf"));
  await writeFile(join(cwd, "download.sh"), script, { mode: 0o755 });
  await writeFile(join(cwd, "language"), corrupt ? Buffer.from("broken") : language);
  await writeFile(join(cwd, "vision"), vision);
  await writeFile(join(cwd, "old.gguf"), "old");
  await symlink("old.gguf", join(cwd, "ds4flash.gguf"));
  await writeFile(join(cwd, "bin", "curl"), `#!/bin/sh
set -eu
dest=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) dest="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$url" >> "$CURL_CALLS"
case "$url" in
  *Vision.gguf) cp "$ENC_PAYLOAD" "$dest" ;;
  *) cp "$LANG_PAYLOAD" "$dest" ;;
esac
`, { mode: 0o755 });
  return cwd;
}

async function run(cwd, selector = "maya-xs") {
  const child = Bun.spawn(["./download.sh", selector], {
    cwd,
    env: {
      ...process.env,
      PATH: `${join(cwd, "bin")}:${process.env.PATH}`,
      CURL_CALLS: join(cwd, "calls"),
      LANG_PAYLOAD: join(cwd, "language"),
      ENC_PAYLOAD: join(cwd, "vision"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

const valid = await fixture();
const invalid = await fixture(true);
const stale = await fixture();
try {
  let result = await run(valid);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readlink(join(valid, "ds4flash.gguf")), `gguf/${languageFile}`);
  assert.deepEqual(await readFile(join(valid, "gguf", languageFile)), language);
  assert.deepEqual(await readFile(join(valid, "gguf", visionFile)), vision);
  assert.equal((await readFile(join(valid, "gguf", `${languageFile}.sha256`), "utf8")).trim(), digest);
  const calls = await readFile(join(valid, "calls"), "utf8");
  result = await run(valid, "q1");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(valid, "calls"), "utf8"), calls);

  result = await run(invalid);
  assert.notEqual(result.status, 0);
  assert.equal(await readlink(join(invalid, "ds4flash.gguf")), "old.gguf");
  assert.equal(await readFile(join(invalid, "old.gguf"), "utf8"), "old");

  await writeFile(join(stale, "gguf", languageFile), "broken");
  result = await run(stale, "preferred");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(join(stale, "gguf", languageFile)), language);
  console.log("Downloader verified: SHA-256, preserved fallback, alias and cached reuse");
} finally {
  await Promise.all([valid, invalid, stale].map((path) => rm(path, { recursive: true })));
}
