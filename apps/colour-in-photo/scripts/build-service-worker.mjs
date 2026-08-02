import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = join(projectRoot, "out");
const serviceWorkerPath = join(outputRoot, "sw.js");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }

  return files;
}

const exportedFiles = await walk(outputRoot);
const filesToPrecache = exportedFiles
  .filter((path) => {
    const name = relative(outputRoot, path).split(sep).join("/");
    return (
      name === "index.html" ||
      name === "manifest.webmanifest" ||
      name === "favicon.png" ||
      name === "favicon.svg" ||
      name.startsWith("icons/") ||
      name.startsWith("_next/static/")
    );
  })
  .sort();

if (!filesToPrecache.some((path) => path.endsWith(".js"))) {
  throw new Error("The static export did not emit JavaScript assets to precache.");
}

const hash = createHash("sha256");
for (const path of filesToPrecache) {
  hash.update(relative(outputRoot, path));
  hash.update(await readFile(path));
}

const buildVersion = hash.digest("hex").slice(0, 16);
const precacheUrls = filesToPrecache.map((path) => {
  const name = relative(outputRoot, path).split(sep).join("/");
  return name === "index.html" ? "/" : `/${name}`;
});

const source = await readFile(serviceWorkerPath, "utf8");
if (!source.includes("__BUILD_VERSION__") || !source.includes("const PRECACHE_URLS = [")) {
  throw new Error("Service worker build placeholders are missing.");
}

const builtServiceWorker = source
  .replace("__BUILD_VERSION__", buildVersion)
  .replace(
    /const PRECACHE_URLS = \[[\s\S]*?\];/,
    `const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)};`,
  );

await writeFile(serviceWorkerPath, builtServiceWorker);
