import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(appRoot, "src", "index.html"), "utf8");

test("publishes the canonical HW2 hostname and social metadata", () => {
  assert.match(source, /<link rel="canonical" href="https:\/\/hw2\.lyndonfawcett\.com\/">/);
  assert.match(source, /<meta property="og:url" content="https:\/\/hw2\.lyndonfawcett\.com\/">/);
  assert.match(source, /<meta property="og:image" content="https:\/\/hw2\.lyndonfawcett\.com\/social-preview\.png">/);
  assert.match(source, /<link rel="icon" href="\/favicon\.svg"/);
});

test("keeps the published snapshot private and offline", () => {
  assert.doesNotMatch(source, /\b[a-f0-9]{32}\b/i);
  assert.doesNotMatch(source, /HALO_API_KEY|Ocp-Apim-Subscription-Key|\bXuid\b|\bgamertag\b/i);
  assert.match(source, /connect-src 'none'/);
  assert.doesNotMatch(source, /<(?:script|iframe)[^>]+src=["']https?:\/\//i);
  assert.doesNotMatch(source, /<link[^>]+href=["']https?:\/\/[^"']+["'][^>]+rel=["']stylesheet["']/i);
});

test("keeps detail tables collapsed behind accessible disclosures", () => {
  assert.match(source, /observed corpus/i);
  for (const [id, label] of [
    ["leaders-table-details", "Expand detailed leader results table"],
    ["pairs-table-details", "Expand detailed leader-pair results table"],
    ["openings-table-details", "Expand detailed opening-strategy results table"],
  ]) {
    assert.match(
      source,
      new RegExp(`<details class="table-details" id="${id}">\\s*<summary>${label}<\\/summary>`),
    );
  }
  assert.doesNotMatch(source, /<details class="table-details"[^>]*\sopen(?:\s|>)/);
});

test("omits the removed warning callouts and footer copy", () => {
  assert.doesNotMatch(source, /class="notice"|--warning-bg|--warning-fg/);
  assert.doesNotMatch(source, /Coverage caveat|Adjustment methodology|partial-notice/);
  assert.doesNotMatch(source, /<footer|Aggregate run|Halo © Microsoft Corporation/);
});
