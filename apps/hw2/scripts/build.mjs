import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(appRoot, "src", "index.html");
const publicDir = path.join(appRoot, "public");
const output = path.join(appRoot, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, path.join(output, "index.html"));
await cp(publicDir, output, { recursive: true });

const html = await readFile(path.join(output, "index.html"), "utf8");
if (!html.includes("https://hw2.lyndonfawcett.com/")) {
  throw new Error("Production canonical URL is missing from the built dashboard.");
}

const built = await stat(path.join(output, "index.html"));
console.log(`Built HW2 dashboard (${built.size.toLocaleString()} bytes) in dist/`);
