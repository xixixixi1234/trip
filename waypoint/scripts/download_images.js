#!/usr/bin/env node
/* ============================================================
   Download every hotel's cover image (the CSV image_url column, carried
   into src/cities.js as `image`) to public/images/hotels/<hotel-id>.<ext>.

   Runs automatically as `prebuild` (npm run build → Railway deploy), so a
   fresh deploy downloads the images into the build before the server starts.
   Never fails the build: failed URLs are listed in failed.tsv and the front
   end falls back to the original image_url for those hotels.

   Usage:
     npm run images                             # download missing images
     node scripts/download_images.js --force    # re-download everything
     CONCURRENCY=4 npm run images
     SKIP_IMAGE_DOWNLOAD=1 npm run build        # skip in CI if needed

   No dependencies (Node 18+ fetch). Skips files that already exist, retries
   each URL 3 times, and writes public/images/hotels/manifest.json.
   Once the files exist, server.js serves them at /images/hotels/... and
   /api/hotels returns the local path as `image` (remote URL kept in
   `imageRemote` as a fallback).
   ============================================================ */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "public", "images", "hotels");
const FORCE = process.argv.includes("--force");
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || "6", 10));
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

if (process.env.SKIP_IMAGE_DOWNLOAD === "1") { console.log("[images] SKIP_IMAGE_DOWNLOAD=1 — skipping."); process.exit(0); }
process.on("unhandledRejection", e => { console.error("[images] unexpected error (build continues):", e?.message || e); process.exit(0); });
const { CITY_LISTINGS } = await import(path.join(ROOT, "src", "cities.js"));
fs.mkdirSync(OUT, { recursive: true });

function extOf(url, contentType) {
  const m = /\.(jpe?g|png|webp|gif)(?:[?#]|$)/i.exec(url);
  if (m) return m[1].toLowerCase().replace("jpeg", "jpg");
  if (/png/i.test(contentType || "")) return "png";
  if (/webp/i.test(contentType || "")) return "webp";
  return "jpg";
}
function existing(id) {
  for (const ext of ["jpg", "png", "webp", "gif"]) {
    const f = path.join(OUT, `${id}.${ext}`);
    if (fs.existsSync(f) && fs.statSync(f).size > 0) return `${id}.${ext}`;
  }
  return null;
}

const jobs = CITY_LISTINGS.filter(h => h.image && /^https?:\/\//i.test(h.image));
const noImage = CITY_LISTINGS.length - jobs.length;
const manifest = {};
let done = 0, skipped = 0, failed = 0;
const failures = [];

async function download(h) {
  const have = existing(h.id);
  if (have && !FORCE) { manifest[h.id] = have; skipped++; return; }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(h.image, {
        headers: { "User-Agent": UA, "Accept": "image/avif,image/webp,image/*,*/*;q=0.8", "Referer": "https://www.tripadvisor.com/" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get("content-type") || "";
      if (!/^image\//i.test(ct)) throw new Error(`not an image (${ct})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) throw new Error("empty response");
      const file = `${h.id}.${extOf(h.image, ct)}`;
      fs.writeFileSync(path.join(OUT, file), buf);
      manifest[h.id] = file; done++;
      return;
    } catch (e) {
      if (attempt === 3) { failed++; failures.push(`${h.id}\t${h.image}\t${e.message}`); }
      else await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
}

console.log(`Hotels: ${CITY_LISTINGS.length}  with image_url: ${jobs.length}  without: ${noImage}`);
console.log(`Saving to ${OUT}  (concurrency ${CONCURRENCY}${FORCE ? ", --force" : ""})`);
let idx = 0;
async function worker() {
  while (idx < jobs.length) {
    const h = jobs[idx++];
    await download(h);
    const n = done + skipped + failed;
    if (n % 25 === 0 || n === jobs.length) process.stdout.write(`  ${n}/${jobs.length}  downloaded ${done}  skipped ${skipped}  failed ${failed}\n`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
if (failures.length) {
  fs.writeFileSync(path.join(OUT, "failed.tsv"), "id\turl\terror\n" + failures.join("\n") + "\n");
  console.log(`\n${failed} failed — see public/images/hotels/failed.tsv (re-run to retry just those).`);
}
console.log(`\nDone. ${done} downloaded, ${skipped} already present, ${failed} failed. manifest.json written.`);
