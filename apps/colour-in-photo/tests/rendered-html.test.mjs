import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, sep } from "node:path";
import test from "node:test";

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) files.push(...(await listFiles(child)));
    else if (entry.isFile()) files.push(child);
  }

  return files;
}

test("exports the finished photo-to-puzzle experience as static HTML", async () => {
  const html = await readFile(new URL("../out/index.html", import.meta.url), "utf8");
  assert.match(
    html,
    /<title>Colour in Photo — Make your own colour-by-numbers<\/title>/i,
  );
  assert.match(html, /Turn a favourite photo into a canvas you can colour\./i);
  assert.match(html, /Processed on this device\./i);
  assert.match(html, /Your photo isn’t uploaded\./i);
  assert.match(html, /large photos resized automatically/i);
  assert.doesNotMatch(html, /up to 20 MB/i);
  assert.match(html, /Private by design/i);
  assert.match(html, /https:\/\/colour\.lyndonfawcett\.com\/og\.png/i);
  assert.match(html, /manifest\.webmanifest/i);
  assert.match(html, /icons\/apple-touch-icon\.png/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("exports installable PWA assets for Netlify", async () => {
  const [manifestText, serviceWorker, netlifyConfig, icon192, icon512, appleIcon] =
    await Promise.all([
      readFile(new URL("../out/manifest.webmanifest", import.meta.url), "utf8"),
      readFile(new URL("../out/sw.js", import.meta.url), "utf8"),
      readFile(new URL("../netlify.toml", import.meta.url), "utf8"),
      stat(new URL("../out/icons/icon-192.png", import.meta.url)),
      stat(new URL("../out/icons/icon-512.png", import.meta.url)),
      readFile(new URL("../out/icons/apple-touch-icon.png", import.meta.url)),
    ]);

  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
  assert.match(serviceWorker, /self\.addEventListener\("fetch"/);
  assert.match(serviceWorker, /cache\.addAll\(PRECACHE_URLS\)/);
  assert.doesNotMatch(
    serviceWorker,
    /__BUILD_VERSION__|__PRECACHE_URLS__|allSettled|skipWaiting|clients\.claim/,
  );
  assert.match(netlifyConfig, /publish = "out"/);
  assert.ok(icon192.size > 0);
  assert.ok(icon512.size > 0);
  assert.equal(appleIcon[25], 2, "Apple touch icon should be an opaque RGB PNG");

  const outputRoot = new URL("../out/", import.meta.url);
  const staticFiles = await listFiles(new URL("_next/static/", outputRoot));
  const staticAssetUrls = staticFiles
    .filter((file) => /\.(?:css|js)$/.test(file.pathname))
    .map((file) => {
      const name = relative(fileURLToPath(outputRoot), fileURLToPath(file))
        .split(sep)
        .join("/");
      return `/${name}`;
    });

  assert.ok(staticAssetUrls.some((url) => url.endsWith(".css")));
  assert.ok(staticAssetUrls.filter((url) => url.endsWith(".js")).length > 3);
  for (const assetUrl of staticAssetUrls) {
    assert.ok(
      serviceWorker.includes(JSON.stringify(assetUrl)),
      `${assetUrl} should be in the offline precache`,
    );
  }

  const pageChunkUrl = staticAssetUrls.find((url) => /\/chunks\/app\/page-.*\.js$/.test(url));
  assert.ok(pageChunkUrl, "The app page chunk should exist");
  const pageChunk = await readFile(new URL(pageChunkUrl.slice(1), outputRoot), "utf8");
  const workerChunkId = pageChunk.match(/new Worker\([^;]{0,400}?\.u\((\d+)\)/)?.[1];
  assert.ok(workerChunkId, "The app page should reference its puzzle worker chunk");
  const workerChunkUrl = staticAssetUrls.find((url) =>
    url.includes(`/chunks/${workerChunkId}.`),
  );
  assert.ok(workerChunkUrl, "The emitted puzzle worker chunk should exist");
  assert.ok(serviceWorker.includes(JSON.stringify(workerChunkUrl)));
});

test("keeps the product client-only and removes starter surfaces", async () => {
  const [page, layout, component, styles, hosting, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ColourGame.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ColourGame.module.css", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<ColourGame \/>/);
  assert.match(component, /new Worker\(/);
  assert.match(component, /URL\.createObjectURL/);
  assert.match(component, /image\/png/);
  assert.match(layout, /\/og\.png/);
  assert.match(styles, /env\(safe-area-inset-(?:top|right|bottom|left)/);
  assert.deepEqual(JSON.parse(hosting), { d1: null, r2: null });
  assert.doesNotMatch(packageJson, /react-loading-skeleton|drizzle/);

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)),
  );
  await assert.rejects(access(new URL("../app/api/", import.meta.url)));
});
