import express from "express";
import fs from "fs";
import { CITIES as SEED_CITIES, CITY_LISTINGS as SEED_LISTINGS } from "./src/cities.js";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import * as db from "./db.js";
import { parseTravelersChoiceCsv, parseCsv as parseCsvText } from "./import_csv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "waypoint-admin"; // change in production!

app.use(express.json({ limit: "1mb" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

await db.init();

/* ---- local hotel images (downloaded by scripts/download_images.js) ----
   Scanned once at startup; /api/hotels rewrites `image` to the local path
   when a file exists and keeps the original URL in `imageRemote`. */
const IMG_DIR = path.join(__dirname, "public", "images", "hotels");
const localImages = new Map();
function scanLocalImages() {
  localImages.clear();
  try {
    for (const f of fs.readdirSync(IMG_DIR)) {
      const m = /^(.+)\.(jpe?g|png|webp|gif)$/i.exec(f);
      if (m) localImages.set(m[1], f);
    }
  } catch { /* directory missing: nothing downloaded yet */ }
  console.log(`[images] ${localImages.size} local hotel images in public/images/hotels`);
}
scanLocalImages();
/* Default: participants' browsers NEVER contact the original image host.
   `image` is the local file or "" (gradient placeholder); the original URL
   is not sent to the front end at all. Set IMAGE_REMOTE_FALLBACK=1 to let
   hotels whose download failed fall back to their original image_url. */
const REMOTE_FALLBACK = process.env.IMAGE_REMOTE_FALLBACK === "1";
let REMOTE_URLS = {};
if (REMOTE_FALLBACK) { try { REMOTE_URLS = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "image_urls.json"), "utf8")); } catch {} }
/* gallery = downloaded file (if any) + images uploaded in admin (served from the DB).
   `image` = the cover: an uploaded image marked as cover, else the downloaded file. */
async function withLocalImages(hotels) {
  const uploaded = await db.allHotelImageMeta();
  return hotels.map(h => {
    const f = localImages.get(h.id);
    const remote = REMOTE_URLS[h.id] || "";
    const fileSrc = f ? `/images/hotels/${f}` : (REMOTE_FALLBACK ? remote : "");
    const ups = (uploaded[h.id] || []).map(m => ({ src: `/images/uploaded/${m.id}`, caption: m.caption || "", isCover: Boolean(m.isCover) }));
    const coverUp = ups.find(u => u.isCover);
    const gallery = [...(fileSrc ? [{ src: fileSrc, caption: "" }] : []), ...ups.map(({ src, caption }) => ({ src, caption }))];
    const cover = coverUp ? coverUp.src : fileSrc;
    // cover first in the gallery
    gallery.sort((a, b) => (b.src === cover) - (a.src === cover));
    return { ...h, image: cover, images: gallery.map(g => g.src), gallery, imageRemote: REMOTE_FALLBACK ? remote : "" };
  });
}
app.get("/images/uploaded/:id", async (req, res) => {
  try {
    const img = await db.getHotelImage(req.params.id);
    if (!img) return res.status(404).end();
    res.set("Content-Type", img.mime || "image/jpeg"); res.set("Cache-Control", "public, max-age=86400"); res.send(img.data);
  } catch (e) { res.status(500).end(); }
});
console.log(`[images] remote fallback ${REMOTE_FALLBACK ? "ON (IMAGE_REMOTE_FALLBACK=1)" : "off — only local images are served"}`);
app.use("/images", express.static(path.join(__dirname, "public", "images"), { maxAge: "7d", immutable: true }));

/* ---- review photos (downloaded by scripts/download_review_images.js into public/images/reviews) ----
   Only photos that exist locally are sent to the browser; the original URLs never leave the server. */
const REVIEW_IMG_DIR = path.join(__dirname, "public", "images", "reviews");
const localReviewImages = new Map();   // key (photo_id or url hash) -> filename
function scanReviewImages() {
  localReviewImages.clear();
  try { for (const f of fs.readdirSync(REVIEW_IMG_DIR)) { const m = /^(.+)\.(jpe?g|png|webp|gif)$/i.exec(f); if (m) localReviewImages.set(m[1], f); } } catch {}
  console.log(`[images] ${localReviewImages.size} local review photos in public/images/reviews`);
}
scanReviewImages();
function photoKey(p) {
  if (p.photo_id) return String(p.photo_id);
  let h = 2166136261; const u = String(p.url || ""); for (let i = 0; i < u.length; i++) { h ^= u.charCodeAt(i); h = Math.imul(h, 16777619); }
  return "u" + (h >>> 0).toString(16);
}
const AVATAR_DIR = path.join(__dirname, "public", "images", "avatars");
const localAvatars = new Map();
try { for (const f of fs.readdirSync(AVATAR_DIR)) { const m = /^(.+)\.(jpe?g|png|webp|gif)$/i.exec(f); if (m) localAvatars.set(m[1], f); } } catch {}
console.log(`[images] ${localAvatars.size} local reviewer avatars in public/images/avatars`);
function withLocalReviewPhotos(reviews) {
  return reviews.map(r => {
    const af = r.avatar ? localAvatars.get(photoKey({ url: r.avatar })) : null;
    return {
      ...r,
      avatar: af ? `/images/avatars/${af}` : "",     // local file or nothing — never the original URL
      photos: (r.photos || []).map(p => { const f = localReviewImages.get(photoKey(p)); return f ? { src: `/images/reviews/${f}`, caption: p.caption || "" } : null; }).filter(Boolean),
    };
  });
}

/* ============================================================
   Public data API (hotels, cities, reviews) — served from the DB
   ============================================================ */
/* City cover image = the downloaded image of the city's cover hotel
   (coverHotelId in src/cities.js — the 100th hotel of that city in the CSV).
   Falls back to an admin-set local image; remote URLs only with IMAGE_REMOTE_FALLBACK=1. */
function withCityCovers(cities) {
  return cities.map(c => {
    const seed = SEED_CITIES.find(x => x.key === c.key);
    const coverId = seed?.coverHotelId || "";
    let f = coverId ? localImages.get(coverId) : null;
    let usedId = coverId;
    if (!f) {
      // cover hotel has no downloaded image: use the first hotel of this city that has one
      const alt = SEED_LISTINGS.find(h => h.city === c.key && localImages.has(h.id));
      if (alt) { f = localImages.get(alt.id); usedId = alt.id; }
    }
    if (f) return { ...c, image: `/images/hotels/${f}`, coverHotelId: usedId };
    const own = c.image || "";
    const keep = own.startsWith("/") || (REMOTE_FALLBACK && /^https?:/.test(own));
    return { ...c, image: keep ? own : "", coverHotelId: coverId };
  });
}
app.get("/api/cities", async (_req, res) => {
  try { res.json(withCityCovers(await db.listCities())); }
  catch (e) { console.error(e); res.status(500).json({ error: "failed to load cities" }); }
});

app.get("/api/hotels", async (req, res) => {
  try {
    let hotels = await withLocalImages(await db.listHotels({ city: req.query.city }));
    const sw = await db.getAiSwitches();
    if (!sw.search && !sw.product) hotels = hotels.map(h => ({ ...h, seo: "" }));   // both off: the browser never receives the summary
    res.json(hotels);
  }
  catch (e) { console.error(e); res.status(500).json({ error: "failed to load hotels" }); }
});

app.get("/api/hotels/:id/reviews", async (req, res) => {
  try { res.json(withLocalReviewPhotos(await db.getReviews(req.params.id))); }
  catch (e) { console.error("[reviews] load failed for", req.params.id, e); res.status(500).json({ error: "failed to load reviews: " + (e.message || e) }); }
});

/* ============================================================
   Votes
   ============================================================ */
app.get("/api/votes", async (_req, res) => {
  try { res.json(await db.tallies()); }
  catch (e) { console.error(e); res.status(500).json({ error: "failed to load votes" }); }
});

app.post("/api/vote", async (req, res) => {
  const { hotelId, voterId, choice, source } = req.body || {};   // source: 'list' | 'detail' (where the button was pressed)
  if (!hotelId || !voterId || !["up", "down"].includes(choice)) {
    return res.status(400).json({ error: "hotelId, voterId and choice ('up'|'down') are required" });
  }
  try { res.json(await db.vote({ hotelId, voterId, choice, source })); }
  catch (e) { console.error(e); res.status(500).json({ error: "failed to record vote" }); }
});

/* ============================================================
   Participant research tracking
   ============================================================ */
// welcome / consent text shown before a participant can enter (editable in admin)
async function defaultWelcome() { const sw = await db.getAiSwitches(); return (!sw.search && !sw.product) ? db.DEFAULT_WELCOME_NO_AI : db.DEFAULT_WELCOME; }
app.get("/api/settings/welcome", async (_req, res) => {
  try { res.json({ text: await db.getSetting("welcome", await defaultWelcome()) }); }
  catch (e) { console.error(e); res.json({ text: db.DEFAULT_WELCOME }); }
});
// public study config (what the front end needs to render the condition)
app.get("/api/config", async (_req, res) => {
  try { const sw = await db.getAiSwitches(); res.json({ aiSearch: sw.search, aiProduct: sw.product }); }
  catch (e) { console.error(e); res.json({ aiSearch: true, aiProduct: true }); }
});
app.post("/api/track/consent", async (req, res) => {
  const { pid } = req.body || {};
  if (!pid) return res.status(400).json({ error: "pid required" });
  try { await db.setConsent(pid, await db.getAiSwitches()); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: "track failed" }); }
});
app.get("/api/admin/settings", requireAdmin, async (_req, res) => {
  try {
    res.json({ ai: await db.getAiSwitches(), welcome: await db.getSetting("welcome", ""), welcomeDefault: await defaultWelcome() });
  } catch (e) { console.error(e); res.status(500).json({ error: "failed" }); }
});
app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  const { key, value } = req.body || {};
  if (!key || !["welcome", "ai_search", "ai_product"].includes(key)) return res.status(400).json({ error: "unknown setting" });
  if (key === "ai_search" || key === "ai_product") {
    const sw = await db.getAiSwitches();
    if ((key === "ai_search" && sw.lockedSearch) || (key === "ai_product" && sw.lockedProduct)) return res.status(400).json({ error: "This switch is fixed by an environment variable on this deployment" });
    if (!["on", "off"].includes(value)) return res.status(400).json({ error: "value must be on | off" });
  }
  try { await db.setSetting(key, value); res.json({ ok: true, key, value: String(value ?? "") }); }
  catch (e) { console.error(e); res.status(500).json({ error: "save failed" }); }
});

// heartbeat: register participant + add dwell time
app.post("/api/track/session", async (req, res) => {
  const { pid, ms } = req.body || {};
  if (!pid) return res.status(400).json({ error: "pid required" });
  try {
    await db.touchParticipant(pid);
    if (ms) await db.addDwell(pid, Number(ms));
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "track failed" }); }
});

// hotel event: seen (card entered viewport) | click (detail opened) | list_ms | detail_ms (dwell, n = ms)
const EVENT_TYPES = ["seen", "click", "list_ms", "detail_ms"];
app.post("/api/track/event", async (req, res) => {
  const { pid, hotelId, type, n } = req.body || {};
  if (!pid || !hotelId || !EVENT_TYPES.includes(type)) {
    return res.status(400).json({ error: "pid, hotelId, type(seen|click|list_ms|detail_ms) required" });
  }
  try { await db.trackHotelEvent(pid, hotelId, type, n == null ? 1 : n); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: "track failed" }); }
});

// batched events { pid, items: [{hotelId, type, n}] } — used for periodic dwell flushes and
// navigator.sendBeacon on page hide (body may arrive as text/plain).
app.post("/api/track/batch", express.text({ type: "*/*", limit: "200kb" }), async (req, res) => {
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const { pid, items } = body || {};
  if (!pid || !Array.isArray(items)) return res.status(400).json({ error: "pid and items[] required" });
  try {
    await db.touchParticipant(pid);
    for (const it of items.slice(0, 500)) {
      if (it && it.hotelId && EVENT_TYPES.includes(it.type)) await db.trackHotelEvent(pid, it.hotelId, it.type, it.n == null ? 1 : it.n);
    }
    res.json({ ok: true, n: items.length });
  } catch (e) { console.error(e); res.status(500).json({ error: "track failed" }); }
});

// favorites: this participant's current favorites
app.get("/api/fav", async (req, res) => {
  try { res.json(await db.getFavorites(req.query.pid)); }
  catch (e) { console.error(e); res.status(500).json({ error: "fav load failed" }); }
});

// toggle whole-site favorite
app.post("/api/fav/site", async (req, res) => {
  const { pid, on } = req.body || {};
  if (!pid) return res.status(400).json({ error: "pid required" });
  try { await db.touchParticipant(pid); res.json(await db.setSiteFav(pid, Boolean(on))); }
  catch (e) { console.error(e); res.status(500).json({ error: "fav failed" }); }
});

// toggle a hotel favorite
app.post("/api/fav/hotel", async (req, res) => {
  const { pid, hotelId, on } = req.body || {};
  if (!pid || !hotelId) return res.status(400).json({ error: "pid, hotelId required" });
  try { await db.touchParticipant(pid); res.json(await db.setHotelFav(pid, hotelId, Boolean(on))); }
  catch (e) { console.error(e); res.status(500).json({ error: "fav failed" }); }
});

/* ============================================================
   AI review summary
   ============================================================ */
app.post("/api/summarize", async (req, res) => {
  const { name, place, reviews } = req.body || {};
  if (!Array.isArray(reviews) || reviews.length === 0 || !name) {
    return res.status(400).json({ error: "name and reviews[] are required" });
  }
  if (!API_KEY) {
    const avg = reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length;
    return res.json({
      live: false,
      summary: `Guests give ${name} an average of ${avg.toFixed(1)}/5 across ${reviews.length} reviews. Opinions are mostly positive about the core experience, with some recurring notes on value. Set ANTHROPIC_API_KEY on the server to enable live AI summaries.`,
      pros: ["Location & setting", "Cleanliness", "Breakfast / core experience"],
      cons: ["Value for money on extras"],
      bestFor: "Travellers seeking a relaxed stay",
    });
  }
  const corpus = reviews.slice(0, 40)
    .map(r => `[${r.rating}/5, ${r.tripType || "guest"}, ${r.month || ""}] ${r.title || ""}: ${r.text || ""}`)
    .join("\n\n");
  const prompt = `You are the review-summary engine for a travel site. Based ONLY on the guest reviews below for "${name}" (${place || ""}), respond with ONLY a JSON object (no markdown fences, no preamble) with this shape:
{"summary": "3-4 sentence balanced overview in a warm, neutral voice",
 "pros": ["3-5 short phrases guests consistently praise"],
 "cons": ["2-4 short phrases guests consistently criticise"],
 "bestFor": "one short phrase: who this place suits best"}

Reviews:
${corpus}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 1000, messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) { console.error("Anthropic API error:", r.status, await r.text()); return res.status(502).json({ error: "AI service error" }); }
    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    return res.json({ live: true, ...JSON.parse(text.replace(/```json|```/g, "").trim()) });
  } catch (e) {
    console.error("Summarize failed:", e);
    return res.status(500).json({ error: "Failed to generate summary" });
  }
});

app.get("/api/health", async (_req, res) =>
  res.json({ ok: true, ai: Boolean(API_KEY), db: db.usingDb() }));

/* ============================================================
   Admin — password gate (Basic auth), participation + import
   ============================================================ */
function requireAdmin(req, res, next) {
  const hdr = req.headers.authorization || "";
  const [scheme, encoded] = hdr.split(" ");
  if (scheme === "Basic" && encoded) {
    const [, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (pass === ADMIN_PASSWORD) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Find a Hotel admin"').status(401).send("Authentication required.");
}

/* admin JSON APIs */
app.get("/api/admin/stats", requireAdmin, async (_req, res) => {
  try {
    const [stats, breakdown, recent] = await Promise.all([db.voteStats(), db.voteBreakdown(), db.recentVotes(300)]);
    res.json({ stats, breakdown, recent });
  } catch (e) { console.error(e); res.status(500).json({ error: "failed to load admin stats" }); }
});

/* admin: per-participant research data */
app.get("/api/admin/participants", requireAdmin, async (_req, res) => {
  try { res.json({ participants: await db.participantSummaries() }); }
  catch (e) { console.error(e); res.status(500).json({ error: "failed to load participants" }); }
});

/* ---------- CSV export ---------- */
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  return "\uFEFF" + lines.join("\r\n"); // BOM so Excel reads UTF-8
}
function sendCsv(res, filename, csv) {
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}

// export raw vote events
app.get("/api/admin/export/votes.csv", requireAdmin, async (_req, res) => {
  try {
    const rows = await db.recentVotes(1000000);
    const csv = toCsv(
      ["participant_id", "hotel_id", "hotel_name", "action", "result", "page", "time"],
      rows.map(v => [v.voter_id, v.hotel_id, v.hotel_name || "", v.choice === "up" ? "like" : "dislike", v.result || "set", v.source || "", v.updated_at || ""])
    );
    sendCsv(res, "votes.csv", csv);
  } catch (e) { console.error(e); res.status(500).json({ error: "export failed" }); }
});

// export per-participant summary (one row per participant)
app.get("/api/admin/export/participants.csv", requireAdmin, async (_req, res) => {
  try {
    const ps = await db.participantSummaries();
    const rows = ps.map(p => [
      p.pid,
      p.likes || 0, p.dislikes || 0,
      p.hotelsSeen || 0, p.hotelsClicked || 0,
      ((p.avgHotelMs || 0) / 1000).toFixed(1),       // mean seconds per hotel (list + detail)
      Math.round((p.totalMs || 0) / 1000),          // total seconds on site
      p.siteFav ? "yes" : "no",
      p.consentedAt ? "yes" : "no",
      p.aiSearch == null ? "" : (p.aiSearch ? "yes" : "no"),
      p.aiProduct == null ? "" : (p.aiProduct ? "yes" : "no"),
      p.consentedAt || "",
      p.firstSeen || "",
      p.lastSeen || "",
    ]);
    const csv = toCsv(
      ["participant_id", "hotels_liked", "hotels_disliked", "hotels_viewed", "hotels_clicked",
       "avg_seconds_per_hotel", "total_seconds_on_site", "bookmarked_site", "consented", "ai_summary_in_search_page", "ai_summary_in_product_page", "consent_time", "first_seen", "last_seen"],
      rows
    );
    sendCsv(res, "participants.csv", csv);
  } catch (e) { console.error(e); res.status(500).json({ error: "export failed" }); }
});

// export one row per participant × hotel: hotel facts + views/clicks + vote + dwell times
app.get("/api/admin/export/hotel_events.csv", requireAdmin, async (_req, res) => {
  try {
    const rows = (await db.hotelEventRows()).map(r => [
      r.pid, r.hotel_id, r.hotel_name, r.city, r.rating, r.review_count,
      r.seen, r.clicks,
      r.vote === "up" ? "like" : r.vote === "down" ? "dislike" : "",
      r.vote ? (r.vote_source || "") : "",
      (r.list_ms / 1000).toFixed(1), (r.detail_ms / 1000).toFixed(1), ((r.list_ms + r.detail_ms) / 1000).toFixed(1),
      r.ai_search == null ? "" : (r.ai_search ? "yes" : "no"), r.ai_product == null ? "" : (r.ai_product ? "yes" : "no"),
    ]);
    const csv = toCsv(
      ["participant_id", "hotel_id", "hotel_name", "city", "hotel_rating", "hotel_review_count",
       "list_views", "clicks", "vote", "vote_page", "list_dwell_seconds", "detail_dwell_seconds", "total_dwell_seconds", "ai_summary_in_search_page", "ai_summary_in_product_page"],
      rows
    );
    sendCsv(res, "hotel_events.csv", csv);
  } catch (e) { console.error(e); res.status(500).json({ error: "export failed" }); }
});

/* guest reviews CSV (produced by scripts/filter_reviews.py) → rows for db.importReviews
   columns: hotel_id (TripAdvisor id, e.g. 210755), author, location, rating, date, date_visited,
            title, text, trip_type, helpful, photos, language, contributions, avatar */
function parseReviewsCsv(text) {
  const table = parseCsvText(text);
  if (table.length < 2) throw new Error("CSV appears to be empty.");
  const header = table[0].map(h => h.trim().replace(/^\ufeff/, "").toLowerCase());
  const col = name => header.indexOf(name);
  for (const n of ["hotel_id", "text"]) if (col(n) < 0) throw new Error(`Missing column "${n}". Expected: hotel_id, author, rating, date, title, text, trip_type …`);
  const get = (r, name) => { const i = col(name); return i >= 0 ? (r[i] ?? "") : ""; };
  return table.slice(1).filter(r => r.length > 1).map(r => ({
    hotelSourceId: get(r, "hotel_id"), author: get(r, "author"), rating: get(r, "rating"),
    date: get(r, "date"), title: get(r, "title"), text: get(r, "text"), tripType: get(r, "trip_type"),
    location: get(r, "location"), dateVisited: get(r, "date_visited"), helpful: get(r, "helpful"), photos: get(r, "photos"), language: get(r, "language"),
    contributions: get(r, "contributions"), avatar: get(r, "avatar"),
  })).filter(r => String(r.text).trim());
}

/* Auto-load data/reviews.csv at startup.
   In-memory mode: every start (the store is empty anyway).
   Postgres: only when the file changed since the last load (hash kept in settings),
   so admin edits are not overwritten on every restart. */
async function autoloadReviews() {
  const file = path.join(__dirname, "data", "reviews.csv");
  if (!fs.existsSync(file)) { console.log("[reviews] no data/reviews.csv — nothing auto-loaded"); return; }
  try {
    const text = fs.readFileSync(file, "utf8");
    let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    const hash = (h >>> 0).toString(16) + ":" + text.length;
    if (db.usingDb() && (await db.getSetting("reviews_file_hash", "")) === hash) { console.log("[reviews] data/reviews.csv unchanged — already loaded"); return; }
    const result = await db.importReviews(parseReviewsCsv(text));
    if (db.usingDb()) await db.setSetting("reviews_file_hash", hash);
    console.log(`[reviews] auto-loaded data/reviews.csv: ${result.reviews} reviews for ${result.hotels} hotels (${result.unmatchedRows} rows unmatched)`);
  } catch (e) { console.error("[reviews] auto-load failed:", e.message); }
}
await autoloadReviews();

/* admin: import guest reviews by upload (same format; replaces reviews of the hotels in the file) */
const uploadBig = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
app.post("/api/admin/import-reviews", requireAdmin, uploadBig.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Please choose a CSV file." });
    const rows = parseReviewsCsv(req.file.buffer.toString("utf8"));
    const result = await db.importReviews(rows);
    res.json({ ok: true, rowsInFile: rows.length, ...result });
  } catch (e) { console.error("Review import failed:", e); res.status(400).json({ error: e.message || "Import failed" }); }
});
/* admin: manage reviews of one hotel */
app.get("/api/admin/reviews", requireAdmin, async (req, res) => {
  try {
    const hotelId = String(req.query.hotelId || "");
    if (!hotelId) return res.status(400).json({ error: "hotelId required" });
    const rows = (await db.getReviews(hotelId)).filter(r => r.source === "quote");
    // admin sees raw photo entries plus whether each is available locally
    res.json(rows.map(r => ({ ...r, photos: (r.photos || []).map(p => ({ ...p, local: Boolean(localReviewImages.get(photoKey(p))) })) })));
  } catch (e) { console.error(e); res.status(500).json({ error: "failed" }); }
});
app.post("/api/admin/reviews", requireAdmin, async (req, res) => {
  try { const { hotelId, ...fields } = req.body || {}; if (!hotelId) return res.status(400).json({ error: "hotelId required" }); res.json({ ok: true, review: await db.addReview(String(hotelId), fields) }); }
  catch (e) { res.status(400).json({ error: e.message || "failed" }); }
});
app.put("/api/admin/reviews/:id", requireAdmin, async (req, res) => {
  try { const r = await db.updateReview(req.params.id, req.body || {}); if (!r) return res.status(404).json({ error: "review not found" }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message || "failed" }); }
});
app.delete("/api/admin/reviews/:id", requireAdmin, async (req, res) => {
  try { const r = await db.deleteReview(req.params.id); if (!r) return res.status(404).json({ error: "review not found" }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message || "failed" }); }
});

/* admin: hotel image gallery */
const uploadImg = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 20 } });
app.get("/api/admin/hotel-images", requireAdmin, async (req, res) => {
  try {
    const hotelId = String(req.query.hotelId || ""); if (!hotelId) return res.status(400).json({ error: "hotelId required" });
    const f = localImages.get(hotelId);
    res.json({ file: f ? `/images/hotels/${f}` : "", uploaded: await db.listHotelImages(hotelId) });
  } catch (e) { console.error(e); res.status(500).json({ error: "failed" }); }
});
app.post("/api/admin/hotel-images", requireAdmin, uploadImg.array("files", 20), async (req, res) => {
  try {
    const hotelId = String(req.body.hotelId || ""); if (!hotelId) return res.status(400).json({ error: "hotelId required" });
    const files = (req.files || []).filter(f => /^image\/(jpeg|png|webp|gif)$/i.test(f.mimetype));
    if (!files.length) return res.status(400).json({ error: "Choose JPG / PNG / WebP / GIF files (max 8 MB each)." });
    const ids = [];
    for (const f of files) ids.push((await db.addHotelImage(hotelId, { mime: f.mimetype, data: f.buffer, caption: "" })).id);
    res.json({ ok: true, added: ids.length, ids });
  } catch (e) { console.error(e); res.status(400).json({ error: e.message || "upload failed" }); }
});
app.put("/api/admin/hotel-images/:id", requireAdmin, async (req, res) => {
  try { const r = await db.updateHotelImage(req.params.id, req.body || {}); if (!r) return res.status(404).json({ error: "not found" }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message || "failed" }); }
});
app.delete("/api/admin/hotel-images/:id", requireAdmin, async (req, res) => {
  try { const r = await db.deleteHotelImage(req.params.id); if (!r) return res.status(404).json({ error: "not found" }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message || "failed" }); }
});
app.post("/api/admin/hotel-cover", requireAdmin, async (req, res) => {
  try { const { hotelId, imageId } = req.body || {}; if (!hotelId) return res.status(400).json({ error: "hotelId required" }); res.json(await db.setHotelCover(String(hotelId), imageId == null || imageId === "" ? null : imageId)); }
  catch (e) { res.status(400).json({ error: e.message || "failed" }); }
});

app.get("/api/admin/review-counts", requireAdmin, async (_req, res) => {
  try { res.json(await db.reviewCounts()); } catch (e) { res.status(500).json({ error: "failed" }); }
});

/* admin: edit a hotel's official description / AI summary */
app.post("/api/admin/hotel-text", requireAdmin, async (req, res) => {
  const { id, about, seo } = req.body || {};
  if (!id) return res.status(400).json({ error: "id required" });
  try {
    const r = await db.updateHotelText(String(id), { about, seo });
    if (!r) return res.status(404).json({ error: "hotel not found" });
    res.json({ ok: true, hotel: r });
  } catch (e) { console.error(e); res.status(500).json({ error: "update failed" }); }
});

/* CSV import (multipart form-data, field name "file") */
app.post("/api/admin/import", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Please choose a CSV file." });
    const text = req.file.buffer.toString("utf8");
    const opts = {
      cityKey: (req.body.cityKey || "").trim() || undefined,
      cityName: (req.body.cityName || "").trim() || undefined,
      country: (req.body.country || "").trim() || undefined,
      limit: req.body.limit ? parseInt(req.body.limit, 10) : 400,
    };
    const parsed = parseTravelersChoiceCsv(text, opts);
    if (!parsed.hotels.length) {
      return res.status(400).json({ error: "No importable hotels (each row needs a valid hotel name, rating and at least 1 review)." });
    }
    const result = await db.importHotels(parsed.hotels);
    res.json({
      ok: true, city: parsed.cityName, cityKey: parsed.cityKey,
      hotels: parsed.hotels.length, inserted: result.inserted, updated: result.updated,
      sample: parsed.hotels.slice(0, 5).map(h => h.name),
    });
  } catch (e) {
    console.error("Import failed:", e);
    res.status(400).json({ error: e.message || "Import failed" });
  }
});

/* list all hotels (optionally by city) for the admin manage/reorder view */
app.get("/api/admin/hotels", requireAdmin, async (req, res) => {
  try {
    const hotels = await db.listHotels({ city: req.query.city });
    const cities = await db.listCities();
    res.json({ cities, hotels });
  } catch (e) { console.error(e); res.status(500).json({ error: "failed to load hotels" }); }
});

/* persist a manual display order for a city */
app.post("/api/admin/reorder", requireAdmin, async (req, res) => {
  try {
    const { city, orderedIds } = req.body || {};
    if (!city || !Array.isArray(orderedIds)) return res.status(400).json({ error: "city and orderedIds[] are required" });
    const result = await db.reorderHotels(city, orderedIds);
    res.json({ ok: true, ...result });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message || "failed to reorder" }); }
});

/* set a city's representative homepage image */
app.post("/api/admin/city-image", requireAdmin, async (req, res) => {
  try {
    const { city, image } = req.body || {};
    if (!city) return res.status(400).json({ error: "city is required" });
    const result = await db.setCityImage(city, (image || "").trim());
    res.json({ ok: true, ...result });
  } catch (e) { console.error(e); res.status(400).json({ error: e.message || "failed to set city image" }); }
});

/* admin dashboard page */
app.get("/admin", requireAdmin, (_req, res) => {
  res.set("Content-Type", "text/html").send(ADMIN_HTML);
});

/* ============================================================
   Static frontend
   ============================================================ */
const dist = path.join(__dirname, "dist");
app.use(express.static(dist));
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));

app.listen(PORT, () => {
  console.log(`Find a Hotel on :${PORT} — AI ${API_KEY ? "on" : "fallback"}, DB ${db.usingDb() ? "postgres" : "in-memory"}`);
});

/* ============================================================
   Admin dashboard HTML (self-contained; fetches /api/admin/* )
   ============================================================ */
const ADMIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Find a Hotel · Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root{--ink:#122B33;--soft:#3D5860;--paper:#F7F9F8;--card:#fff;--line:#E2EAE8;--up:#2E7D5B;--down:#E8542F;--buoy:#E8542F;}
  *{box-sizing:border-box}
  body{font-family:'Roboto',system-ui,-apple-system,Segoe UI,sans-serif;background:var(--paper);color:var(--ink);margin:0;padding:28px 20px 60px;}
  h1,h2{font-family:'Poppins','Roboto',sans-serif;}
  .wrap{max-width:900px;margin:0 auto;}
  h1{font-size:24px;margin:0 0 2px;} h2{font-size:17px;margin:30px 0 12px;}
  .sub{color:var(--soft);font-size:13.5px;margin:0 0 8px;}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0 8px;}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;}
  .card .k{font-size:11.5px;color:var(--soft);letter-spacing:.06em;text-transform:uppercase;}
  .card .v{font-size:26px;font-weight:700;margin-top:2px;}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:13.5px;}
  th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);}
  th{background:#eef4f2;font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--soft);}
  td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;}
  .up{color:var(--up);font-weight:600;} .down{color:var(--down);font-weight:600;}
  tr:last-child td{border-bottom:none;}
  .empty{padding:26px;text-align:center;color:var(--soft);}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;}
  label{display:block;font-size:12.5px;color:var(--soft);margin:10px 0 4px;}
  input[type=text],input[type=number]{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;font-size:14px;background:var(--paper);color:var(--ink);}
  input[type=file]{font-size:13px;margin-top:6px;}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
  button{background:var(--ink);color:#fff;border:none;border-radius:8px;padding:11px 18px;font-size:14px;font-weight:600;cursor:pointer;margin-top:16px;}
  a.dl{display:inline-block;background:var(--ink);color:#fff;text-decoration:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;margin:0 8px 8px 0;}
  a.dl:hover{opacity:.9;}
  .exports{margin:6px 0 18px;}
  button:disabled{opacity:.6;cursor:wait;}
  .msg{margin-top:14px;padding:12px 14px;border-radius:8px;font-size:13.5px;display:none;}
  .msg.ok{background:#e7f3ec;color:#1c5c3c;display:block;}
  .msg.err{background:#fdece7;color:#a53517;display:block;}
  .tabs{display:flex;gap:8px;margin:16px 0 4px;}
  .tab{padding:7px 14px;border-radius:99px;border:1px solid var(--line);background:var(--card);color:var(--soft);cursor:pointer;font-size:13.5px;}
  .tab.active{background:var(--ink);color:#fff;border-color:var(--ink);font-weight:600;}
  .view{display:none;} .view.active{display:block;}
  code{background:#eef4f2;padding:2px 6px;border-radius:4px;font-size:12.5px;}
  .pill{display:inline-block;font-size:11px;padding:1px 6px;border-radius:4px;}
  .pill.up{background:#e7f3ec;} .pill.down{background:#fdece7;}
  .pill.ai{background:#fdece7;color:#a53517;border:1px solid #e8542f;}
  .pill.guest{background:#e7f3ec;color:#1c5c3c;border:1px solid #2E7D5B;}
  .muted{color:var(--soft);font-size:12px;}
  select{padding:9px 11px;border:1px solid var(--line);border-radius:8px;font-size:14px;background:var(--paper);color:var(--ink);}
  .hlist{list-style:none;margin:14px 0 0;padding:0;}
  .hrow{display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:8px;cursor:grab;user-select:none;}
  .hrow.dragging{opacity:.45;}
  .hrow.over{border-color:var(--ink);box-shadow:0 0 0 2px rgba(18,43,51,.12);}
  .hrow .grip{color:var(--soft);font-size:16px;cursor:grab;}
  .hrow .pos{font-variant-numeric:tabular-nums;color:var(--soft);width:34px;text-align:right;font-size:13px;}
  .hrow .nm{font-weight:600;font-size:14px;flex:1;min-width:0;}
  .hrow .meta{font-size:12px;color:var(--soft);}
  .sticky-save{position:sticky;bottom:0;background:linear-gradient(180deg,transparent,var(--paper) 40%);padding-top:12px;margin-top:4px;}
</style></head>
<body><div class="wrap">
  <h1>Find a Hotel Admin</h1>
  <p class="sub">Vote participation data, hotel management &amp; bulk import.<span id="dbmode" class="muted"></span></p>

  <div class="tabs">
    <div class="tab active" data-tab="stats">Participation</div>
    <div class="tab" data-tab="participants">Participants</div>
    <div class="tab" data-tab="text">Edit hotel text</div>
    <div class="tab" data-tab="reviews">Reviews</div>
    <div class="tab" data-tab="photos">Hotel photos</div>
    <div class="tab" data-tab="welcome">Study settings</div>
    <div class="tab" data-tab="manage">Manage / Reorder</div>
    <div class="tab" data-tab="import">Bulk import</div>
  </div>

  <!-- STATS -->
  <div class="view active" id="view-stats">
    <div class="exports">
      <a class="dl" href="/api/admin/export/participants.csv">Export per-participant CSV</a>
      <a class="dl" href="/api/admin/export/votes.csv">Export raw votes CSV</a>
    </div>
    <div class="cards">
      <div class="card"><div class="k">Participants</div><div class="v" id="s-parts">–</div></div>
      <div class="card"><div class="k">Likes</div><div class="v up" id="s-up">–</div></div>
      <div class="card"><div class="k">Dislikes</div><div class="v down" id="s-down">–</div></div>
      <div class="card"><div class="k">Bookmarked site</div><div class="v" id="s-fav">–</div></div>
      <div class="card"><div class="k">Total time</div><div class="v" id="s-time">–</div></div>
    </div>

    <h2>Per participant</h2>
    <p class="sub">One row per participant ID: hotels liked / disliked, hotels viewed, average time per hotel (list + detail, over hotels they spent time on), total time on site, whether they bookmarked the site, and whether they agreed to the welcome text. Auto-refreshes every 20s.</p>
    <div id="perParticipant"></div>

    <details style="margin-top:22px"><summary style="cursor:pointer;font-weight:600">Votes by hotel (all hotels, including 0 votes)</summary><div id="breakdown" style="margin-top:10px"></div></details>
    <details style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">Recent vote events</summary><div id="recent" style="margin-top:10px"></div></details>
  </div>

  <!-- PARTICIPANTS -->
  <div class="view" id="view-participants">
    <p class="sub">Per participant: total time on site, bookmark, and for every hotel they encountered — rating, reviews, list views (card entered the viewport), clicks (detail opened), like / dislike, time the card was visible in the list, time on the detail page. Recorded live, auto-refreshes every 20s. Raw data at <code>/api/admin/participants</code>.</p>
    <div class="exports">
      <a class="dl" href="/api/admin/export/participants.csv">Export participants CSV</a>
      <a class="dl" href="/api/admin/export/hotel_events.csv">Export participant × hotel CSV (views, clicks, vote, dwell)</a>
    </div>
    <div class="cards">
      <div class="card"><div class="k">Participants</div><div class="v" id="p-count">–</div></div>
      <div class="card"><div class="k">Saved the site</div><div class="v" id="p-sitefav">–</div></div>
      <div class="card"><div class="k">Total dwell time</div><div class="v" id="p-time">–</div></div>
    </div>
    <div id="participants"></div>
  </div>

  <!-- MANAGE / REORDER -->
  <div class="view" id="view-text">
    <p class="sub">Edit the <b>official description</b> and the <b>AI summary</b> shown for each hotel. The list shows the first sentence of the description; the detail page shows the full text. Changes are saved to the database and appear on the next page load. <b>Note:</b> a deploy with <code>RESEED=1</code> resets these to the CSV values.</p>
    <div class="panel" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <label>City <select id="textCity"></select></label>
      <input type="text" id="textFilter" placeholder="Filter by hotel name…" style="flex:1 1 220px;min-width:180px" />
      <span class="muted" id="textCount"></span>
    </div>
    <div id="textList"></div>
  </div>

  <div class="view" id="view-reviews">
    <p class="sub">View, edit, delete or add the guest reviews shown on each hotel's detail page. Photos can be removed here (adding photos is done through <code>data/reviews.csv</code> + <code>npm run review-images</code>). Changes are saved to the database — with the in-memory store they are lost on restart.</p>
    <div class="panel" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <label>City <select id="rvCity"></select></label>
      <label>Hotel <select id="rvHotel" style="max-width:420px"></select></label>
      <span class="muted" id="rvCount"></span>
      <button class="btn" id="rvAdd" style="margin-left:auto">+ Add review</button>
    </div>
    <div id="rvList"></div>
  </div>

  <div class="view" id="view-photos">
    <p class="sub">Manage each hotel's photos. The first photo is the <b>cover</b> (used on the list card, the city page and the top of the detail page); all photos appear in the detail-page gallery. Upload JPG / PNG / WebP (max 8 MB each, several at once). Uploaded photos are stored in the database, so they survive redeploys when Postgres is connected (with the in-memory store they are lost on restart). The original downloaded photo cannot be deleted here, but you can make an uploaded photo the cover instead.</p>
    <div class="panel" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <label>City <select id="phCity"></select></label>
      <label>Hotel <select id="phHotel" style="max-width:420px"></select></label>
      <span class="muted" id="phCount"></span>
      <label class="btn" style="margin-left:auto;cursor:pointer">+ Upload photos <input type="file" id="phFiles" accept="image/*" multiple style="display:none"></label>
      <span class="muted" id="phMsg"></span>
    </div>
    <div id="phGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px"></div>
  </div>

  <div class="view" id="view-welcome">
    <h2 style="margin-top:0">AI summary (experimental condition)</h2>
    <p class="sub">Two independent switches. They apply to everyone who loads the site after you save. The state of both switches at the moment a participant agrees to the welcome text is stored with their record (columns <code>ai_summary_in_search_page</code> / <code>ai_summary_in_product_page</code> in both CSV exports), so do not change them in the middle of a data-collection wave. To run conditions in parallel, deploy the same code more than once and set <code>AI_SUMMARY_SEARCH=on|off</code> and <code>AI_SUMMARY_PRODUCT=on|off</code> on each — environment variables lock the switches here.</p>
    <div class="panel" style="display:flex;gap:22px;flex-wrap:wrap;align-items:center">
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="aiSearch"> AI summary in search page</label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="aiProduct"> AI summary in product page</label>
      <button class="btn" id="aiModeSave">Save</button>
      <span class="muted" id="aiModeMsg"></span>
    </div>

    <h2>Welcome / consent text</h2>
    <p class="sub">This text is shown to every participant before they can enter the site. They must tick "I have read and agree" to continue; the time they agreed is recorded per participant ID. Plain text; blank lines start a new paragraph. Saved to the database.</p>
    <div class="panel">
      <textarea id="welcomeText" rows="18" style="width:100%;font:inherit;font-size:14px;line-height:1.5;padding:10px;border:1px solid var(--line);border-radius:8px;resize:vertical"></textarea>
      <div style="display:flex;gap:10px;align-items:center;margin-top:10px">
        <button class="btn" id="welcomeSave">Save</button>
        <button class="btn" id="welcomeReset" style="background:var(--card);color:var(--ink);border:1px solid var(--line)">Restore default</button>
        <span class="muted" id="welcomeMsg"></span>
      </div>
    </div>
  </div>

  <div class="view" id="view-manage">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:4px">
      <label style="margin:0">City</label>
      <select id="citySel"></select>
      <span class="muted" id="cityCount"></span>
    </div>

    <div class="panel" style="margin:12px 0 18px;padding:14px 16px">
      <div style="font-weight:600;font-size:14px;margin-bottom:6px">City homepage image</div>
      <p class="sub" style="margin:0 0 8px">Enter an image URL to use as this city's homepage card image. Leave empty for the default gradient.</p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input type="text" id="cityImageInput" placeholder="https://…/city.jpg" style="flex:1 1 320px;min-width:200px" />
        <button id="saveCityImage" style="margin-top:0">Save city image</button>
        <span class="msg" id="cityImageMsg" style="display:none;margin:0;padding:8px 12px"></span>
      </div>
      <div id="cityImagePreview" style="margin-top:10px"></div>
    </div>

    <p class="sub"><b>Note:</b> the public site now shows each participant the hotels of a city in a <b>random order that is fixed per participant ID</b> (same ID → same order every visit; different IDs → different orders). Dragging here only changes the order of this admin list, it does not affect what participants see.</p>
    <ul class="hlist" id="hotelList"></ul>
    <div class="sticky-save">
      <button id="saveOrder">Save order</button>
      <span class="msg" id="orderMsg" style="display:inline-block;margin-left:12px;padding:8px 12px"></span>
    </div>
  </div>

  <!-- IMPORT -->
  <div class="view" id="view-import">
    <div class="panel">
      <h2 style="margin-top:0">Import guest reviews</h2>
      <p class="sub"><b>Normally you don't need this:</b> <code>data/reviews.csv</code> in the project is loaded automatically when the server starts. Use this uploader only to replace reviews without redeploying. Upload the CSV produced by <code>scripts/filter_reviews.py</code> (columns: <code>hotel_id, author, location, rating, date, date_visited, title, text, trip_type, helpful, photos, language, contributions, avatar</code>; only <code>hotel_id</code> and <code>text</code> are required; <code>hotel_id</code> is the TripAdvisor id such as 210755). Review photos show only after <code>npm run review-images</code> has downloaded them.. Reviews are matched to the 400 hotels by that id. For each hotel present in the file, its existing reviews are <b>replaced</b>; hotels not in the file are untouched. Reviews show on the hotel detail page.</p>
      <form id="reviewForm">
        <label>Reviews CSV</label>
        <input type="file" name="file" accept=".csv" required />
        <div style="margin-top:10px;display:flex;gap:10px;align-items:center"><button class="btn" type="submit">Import reviews</button><span class="muted" id="reviewMsg"></span></div>
      </form>
      <div id="reviewStats" class="muted" style="margin-top:10px"></div>
    </div>

    <div class="panel">
      <h2 style="margin-top:0">Import hotels</h2>
      <p class="sub" style="margin-top:0">Upload a <b>Travelers' Choice format</b> CSV (same columns as the sample data). It is cleaned automatically and ranked by "has AI review, then has guest quote, then award winner, then high rating", keeping the top 400 per city by default (no hard rating cutoff, mixed quality), then written to the database. Existing hotels are updated (deduped by hotel name). If your CSV has an <b>image_url</b> column, hotel photos are loaded automatically (single URL, or several separated by | or comma).</p>
      <form id="importForm">
        <label>CSV file (required)</label>
        <input type="file" name="file" accept=".csv" required />
        <div class="row">
          <div>
            <label>City display name (optional, defaults to the CSV "city" column)</label>
            <input type="text" name="cityName" placeholder="e.g. Berlin" />
          </div>
          <div>
            <label>Country / region (optional)</label>
            <input type="text" name="country" placeholder="e.g. Germany" />
          </div>
        </div>
        <div class="row">
          <div>
            <label>City key (optional, used in the URL, auto-generated if empty)</label>
            <input type="text" name="cityKey" placeholder="e.g. berlin" />
          </div>
          <div>
            <label>Hotels to keep per city (default 400, 0 = no limit)</label>
            <input type="number" name="limit" value="400" min="0" />
          </div>
        </div>
        <button type="submit" id="importBtn">Upload &amp; import</button>
      </form>
      <div class="msg" id="importMsg"></div>
    </div>
  </div>
</div>

<script>
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function fmtDur(ms){
    ms = Number(ms)||0; const s = Math.round(ms/1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s/60), r = s%60;
    if (m < 60) return m + 'm ' + r + 's';
    const h = Math.floor(m/60); return h + 'h ' + (m%60) + 'm';
  }

  // ---- Import reviews ----
  async function loadReviewStats(){
    try { const r = await fetch('/api/admin/review-counts'); const c = await r.json();
      const n = Object.keys(c).length, total = Object.values(c).reduce((a,b)=>a+b,0);
      document.getElementById('reviewStats').textContent = n ? ('Currently: '+total+' guest reviews on '+n+' hotels.') : 'No guest reviews imported yet.';
    } catch(e){}
  }
  document.getElementById('reviewForm').onsubmit = async (ev) => {
    ev.preventDefault(); const msg = document.getElementById('reviewMsg'); msg.textContent = 'Importing…'; msg.style.color='';
    try {
      const r = await fetch('/api/admin/import-reviews', { method:'POST', body: new FormData(ev.target) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error||'Import failed');
      msg.style.color='#2E7D5B'; msg.textContent = 'Imported '+d.reviews+' reviews for '+d.hotels+' hotels ('+d.rowsInFile+' rows in file, '+d.unmatchedRows+' rows did not match any hotel).';
      loadReviewStats();
    } catch(e) { msg.style.color='#B3261E'; msg.textContent = e.message; }
  };
  document.querySelector('.tab[data-tab="import"]').addEventListener('click', loadReviewStats);

  // ---- Reviews management ----
  let rvLoaded = false, rvHotels = [];
  const TRIP_TYPES = ['', 'Traveled with family', 'Traveled as a couple', 'Traveled on business', 'Traveled with friends', 'Traveled solo'];
  async function rvInit(){
    const cities = await (await fetch('/api/cities')).json();
    const cs = document.getElementById('rvCity'); cs.innerHTML = cities.map(c => '<option value="'+esc(c.key)+'">'+esc(c.name)+'</option>').join('');
    cs.onchange = rvLoadHotels; document.getElementById('rvHotel').onchange = rvLoadReviews; document.getElementById('rvAdd').onclick = rvAddBlank;
    await rvLoadHotels();
  }
  async function rvLoadHotels(){
    const d = await (await fetch('/api/admin/hotels?city='+encodeURIComponent(document.getElementById('rvCity').value))).json();
    rvHotels = (d.hotels||[]).slice().sort((a,b)=>a.name.localeCompare(b.name));
    document.getElementById('rvHotel').innerHTML = rvHotels.map(h => '<option value="'+esc(h.id)+'">'+esc(h.name)+' ('+(h.rating??'')+')</option>').join('');
    await rvLoadReviews();
  }
  function rvCard(r, isNew){
    const opts = TRIP_TYPES.map(t => '<option value="'+esc(t)+'"'+(t===(r.tripType||'')?' selected':'')+'>'+(t||'—')+'</option>').join('');
    const photos = (r.photos||[]).map((p,i) => '<span class="rv-photo" data-i="'+i+'" style="display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:12px">'+(p.local?'📷':'⚠️ not downloaded')+' '+esc(p.caption||p.photo_id||'photo')+' <button type="button" class="rv-photo-x" title="Remove photo" style="border:none;background:none;cursor:pointer;color:#B3261E">✕</button></span>').join(' ');
    const inp = (name,val,ph,w) => '<label style="display:block;font-size:12px;color:var(--soft)">'+ph+'<input class="rv-'+name+'" value="'+esc(val==null?'':val)+'" style="display:block;width:100%;font:inherit;font-size:13.5px;padding:6px 8px;border:1px solid var(--line);border-radius:6px"></label>';
    return '<div class="panel rv-card" data-id="'+esc(r.id||'')+'" data-new="'+(isNew?'1':'')+'" style="margin-bottom:12px">'+
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:8px">'+
        inp('author', r.author, 'Reviewer name')+inp('location', r.location, 'Reviewer location')+inp('rating', r.rating, 'Rating (1–5)')+inp('date', r.month, 'Review date (YYYY-MM-DD)')+inp('dateVisited', r.dateVisited, 'Date of stay (YYYY-MM)')+
        '<label style="display:block;font-size:12px;color:var(--soft)">Trip type<select class="rv-tripType" style="display:block;width:100%;font:inherit;font-size:13.5px;padding:6px 8px;border:1px solid var(--line);border-radius:6px">'+opts+'</select></label>'+
        inp('contributions', r.contributions, 'Contributions')+inp('helpful', r.helpful, 'Helpful votes')+
      '</div>'+
      inp('title', r.title, 'Title')+
      '<label style="display:block;font-size:12px;color:var(--soft);margin-top:8px">Text<textarea class="rv-text" rows="4" style="display:block;width:100%;font:inherit;font-size:13.5px;padding:8px;border:1px solid var(--line);border-radius:6px;resize:vertical">'+esc(r.text||'')+'</textarea></label>'+
      (photos ? '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap" class="rv-photos">'+photos+'</div>' : '')+
      '<div style="display:flex;gap:10px;align-items:center;margin-top:10px"><button class="btn rv-save">'+(isNew?'Create':'Save')+'</button><button class="btn rv-del" style="background:var(--card);color:#B3261E;border:1px solid #B3261E">'+(isNew?'Cancel':'Delete')+'</button><span class="muted rv-msg"></span></div>'+
    '</div>';
  }
  let rvCurrent = [];
  async function rvLoadReviews(){
    const hid = document.getElementById('rvHotel').value; const list = document.getElementById('rvList'); if (!hid) { list.innerHTML=''; return; }
    list.innerHTML = '<div class="muted">Loading…</div>';
    rvCurrent = await (await fetch('/api/admin/reviews?hotelId='+encodeURIComponent(hid))).json();
    document.getElementById('rvCount').textContent = rvCurrent.length + ' review' + (rvCurrent.length===1?'':'s');
    list.innerHTML = rvCurrent.length ? rvCurrent.map(r => rvCard(r,false)).join('') : '<div class="empty">No reviews for this hotel yet. Click "+ Add review".</div>';
    rvBind();
  }
  function rvAddBlank(){
    const list = document.getElementById('rvList'); if (list.querySelector('.empty')) list.innerHTML='';
    list.insertAdjacentHTML('afterbegin', rvCard({ author:'', rating:5, month: new Date().toISOString().slice(0,10) }, true)); rvBind();
  }
  function rvRead(card){
    const v = c => { const el = card.querySelector('.rv-'+c); return el ? el.value : undefined; };
    const id = card.dataset.id; const cur = rvCurrent.find(x => String(x.id)===String(id));
    let photos; if (cur && cur.photos) { const keep = [...card.querySelectorAll('.rv-photo')].map(el => Number(el.dataset.i)); photos = cur.photos.filter((_,i)=>keep.includes(i)).map(p => ({ url:p.url, caption:p.caption, photo_id:p.photo_id })); }
    return { author:v('author'), location:v('location'), rating:v('rating'), date:v('date'), dateVisited:v('dateVisited'), tripType:v('tripType'), contributions:v('contributions'), helpful:v('helpful'), title:v('title'), text:v('text'), photos };
  }
  function rvBind(){
    document.querySelectorAll('#rvList .rv-card').forEach(card => {
      const msg = card.querySelector('.rv-msg');
      card.querySelectorAll('.rv-photo-x').forEach(x => x.onclick = () => { x.closest('.rv-photo').remove(); msg.textContent = 'Photo removed — click Save.'; });
      card.querySelector('.rv-save').onclick = async () => {
        const btn = card.querySelector('.rv-save'); btn.disabled = true; msg.style.color=''; msg.textContent = 'Saving…';
        try {
          const body = rvRead(card); const isNew = card.dataset.new === '1';
          const r = await fetch(isNew ? '/api/admin/reviews' : '/api/admin/reviews/'+encodeURIComponent(card.dataset.id), { method: isNew?'POST':'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(isNew ? { hotelId: document.getElementById('rvHotel').value, ...body } : body) });
          const d = await r.json(); if (!r.ok) throw new Error(d.error||'Save failed');
          msg.style.color='#2E7D5B'; msg.textContent = isNew ? 'Created' : 'Saved';
          if (isNew) await rvLoadReviews();
        } catch(e) { msg.style.color='#B3261E'; msg.textContent = e.message; } finally { btn.disabled = false; }
      };
      card.querySelector('.rv-del').onclick = async () => {
        if (card.dataset.new === '1') { card.remove(); return; }
        if (!confirm('Delete this review? This cannot be undone.')) return;
        try { const r = await fetch('/api/admin/reviews/'+encodeURIComponent(card.dataset.id), { method:'DELETE' }); const d = await r.json(); if (!r.ok) throw new Error(d.error||'Delete failed'); await rvLoadReviews(); }
        catch(e) { msg.style.color='#B3261E'; msg.textContent = e.message; }
      };
    });
  }
  document.querySelector('.tab[data-tab="reviews"]').addEventListener('click', () => { if(!rvLoaded){ rvLoaded = true; rvInit(); } });

  // ---- Hotel photos ----
  let phLoaded = false;
  async function phInit(){
    const cities = await (await fetch('/api/cities')).json();
    const cs = document.getElementById('phCity'); cs.innerHTML = cities.map(c => '<option value="'+esc(c.key)+'">'+esc(c.name)+'</option>').join('');
    cs.onchange = phLoadHotels; document.getElementById('phHotel').onchange = phLoad; document.getElementById('phFiles').onchange = phUpload;
    await phLoadHotels();
  }
  async function phLoadHotels(){
    const d = await (await fetch('/api/admin/hotels?city='+encodeURIComponent(document.getElementById('phCity').value))).json();
    const hs = (d.hotels||[]).slice().sort((a,b)=>a.name.localeCompare(b.name));
    document.getElementById('phHotel').innerHTML = hs.map(h => '<option value="'+esc(h.id)+'">'+esc(h.name)+'</option>').join('');
    await phLoad();
  }
  async function phLoad(){
    const hid = document.getElementById('phHotel').value; const grid = document.getElementById('phGrid'); if (!hid) { grid.innerHTML=''; return; }
    const d = await (await fetch('/api/admin/hotel-images?hotelId='+encodeURIComponent(hid))).json();
    const items = [];
    const coverUp = (d.uploaded||[]).find(u => u.isCover);
    if (d.file) items.push({ src: d.file, label: 'Original (downloaded)', isCover: !coverUp, file: true });
    for (const u of (d.uploaded||[])) items.push({ src: '/images/uploaded/'+u.id, id: u.id, label: (u.size/1024).toFixed(0)+' KB', caption: u.caption, isCover: !!u.isCover });
    document.getElementById('phCount').textContent = items.length + ' photo' + (items.length===1?'':'s');
    grid.innerHTML = items.length ? items.map(it =>
      '<div class="panel" style="padding:10px;margin:0">'+
        '<div style="position:relative;aspect-ratio:4/3;border-radius:8px;overflow:hidden;background:var(--sea)"><img src="'+esc(it.src)+'" style="width:100%;height:100%;object-fit:cover;display:block">'+(it.isCover?'<span style="position:absolute;top:8px;left:8px;background:#E8542F;color:#fff;font-size:11px;padding:3px 7px;border-radius:4px;font-weight:600">COVER</span>':'')+'</div>'+
        '<div class="muted" style="font-size:12px;margin:8px 0 6px">'+esc(it.label)+'</div>'+
        (it.file ? '' : '<input class="ph-cap" data-id="'+it.id+'" placeholder="Caption (optional)" value="'+esc(it.caption||'')+'" style="width:100%;font:inherit;font-size:12.5px;padding:5px 7px;border:1px solid var(--line);border-radius:6px;margin-bottom:6px">')+
        '<div style="display:flex;gap:6px;flex-wrap:wrap">'+
          (it.isCover ? '' : '<button class="btn ph-cover" data-id="'+(it.file?'':it.id)+'" style="padding:5px 10px;font-size:12.5px">Make cover</button>')+
          (it.file ? '' : '<button class="btn ph-del" data-id="'+it.id+'" style="padding:5px 10px;font-size:12.5px;background:var(--card);color:#B3261E;border:1px solid #B3261E">Delete</button>')+
        '</div>'+
      '</div>').join('') : '<div class="empty" style="grid-column:1/-1">No photos for this hotel yet — upload some.</div>';
    grid.querySelectorAll('.ph-cover').forEach(b => b.onclick = async () => { await fetch('/api/admin/hotel-cover', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ hotelId: hid, imageId: b.dataset.id || null }) }); phLoad(); });
    grid.querySelectorAll('.ph-del').forEach(b => b.onclick = async () => { if (!confirm('Delete this photo?')) return; await fetch('/api/admin/hotel-images/'+b.dataset.id, { method:'DELETE' }); phLoad(); });
    grid.querySelectorAll('.ph-cap').forEach(i => i.onchange = async () => { await fetch('/api/admin/hotel-images/'+i.dataset.id, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caption: i.value }) }); });
  }
  async function phUpload(ev){
    const files = ev.target.files; if (!files.length) return; const msg = document.getElementById('phMsg'); msg.style.color=''; msg.textContent = 'Uploading '+files.length+' file(s)…';
    const fd = new FormData(); fd.append('hotelId', document.getElementById('phHotel').value); for (const f of files) fd.append('files', f);
    try { const r = await fetch('/api/admin/hotel-images', { method:'POST', body: fd }); const d = await r.json(); if (!r.ok) throw new Error(d.error||'Upload failed'); msg.style.color='#2E7D5B'; msg.textContent = 'Added '+d.added+' photo(s)'; }
    catch(e) { msg.style.color='#B3261E'; msg.textContent = e.message; }
    ev.target.value = ''; phLoad();
  }
  document.querySelector('.tab[data-tab="photos"]').addEventListener('click', () => { if(!phLoaded){ phLoaded = true; phInit(); } });

  // ---- Edit hotel text ----
  let textHotels = [], textLoaded = false;
  async function loadTextCities(){
    const r = await fetch('/api/cities'); const cities = await r.json();
    const sel = document.getElementById('textCity');
    sel.innerHTML = cities.map(c => '<option value="'+esc(c.key)+'">'+esc(c.name)+'</option>').join('');
    sel.onchange = loadTextHotels; document.getElementById('textFilter').oninput = renderTextList;
    await loadTextHotels();
  }
  async function loadTextHotels(){
    const city = document.getElementById('textCity').value;
    const r = await fetch('/api/admin/hotels?city='+encodeURIComponent(city)); const d = await r.json();
    textHotels = (d.hotels || d || []).slice().sort((a,b)=>a.name.localeCompare(b.name)); renderTextList();
  }
  function renderTextList(){
    const q = (document.getElementById('textFilter').value||'').toLowerCase();
    const list = textHotels.filter(h => !q || h.name.toLowerCase().includes(q));
    document.getElementById('textCount').textContent = list.length+' hotels';
    document.getElementById('textList').innerHTML = list.map(h =>
      '<div class="panel" data-id="'+esc(h.id)+'" style="margin-bottom:12px">'+
        '<div style="font-weight:700;font-size:15px;margin-bottom:8px">'+esc(h.name)+' <span class="muted" style="font-weight:400">· '+(h.rating??'')+' ('+(h.reviewCount??'')+' reviews)</span></div>'+
        '<label style="display:block;font-size:12.5px;color:var(--soft);margin-bottom:4px">Official description (list shows the first sentence)</label>'+
        '<textarea class="t-about" rows="4" style="width:100%;font:inherit;font-size:13.5px;padding:8px;border:1px solid var(--line);border-radius:8px;resize:vertical">'+esc(h.about||'')+'</textarea>'+
        '<label style="display:block;font-size:12.5px;color:var(--soft);margin:8px 0 4px">AI summary</label>'+
        '<textarea class="t-seo" rows="3" style="width:100%;font:inherit;font-size:13.5px;padding:8px;border:1px solid var(--line);border-radius:8px;resize:vertical">'+esc(h.seo||'')+'</textarea>'+
        '<div style="display:flex;gap:10px;align-items:center;margin-top:8px"><button class="btn t-save">Save</button><span class="muted t-msg"></span></div>'+
      '</div>').join('') || '<div class="empty">No hotels match.</div>';
    document.querySelectorAll('#textList .t-save').forEach(btn => btn.onclick = async () => {
      const box = btn.closest('.panel'); const msg = box.querySelector('.t-msg');
      btn.disabled = true; btn.textContent = 'Saving…'; msg.textContent = '';
      try {
        const r = await fetch('/api/admin/hotel-text', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ id: box.dataset.id, about: box.querySelector('.t-about').value, seo: box.querySelector('.t-seo').value }) });
        const d = await r.json(); if (!r.ok) throw new Error(d.error||'Save failed');
        const h = textHotels.find(x => x.id === box.dataset.id); if (h) { h.about = d.hotel.about; h.seo = d.hotel.seo; }
        msg.style.color = '#2E7D5B'; msg.textContent = 'Saved';
      } catch(e) { msg.style.color = '#B3261E'; msg.textContent = e.message; }
      finally { btn.disabled = false; btn.textContent = 'Save'; }
    });
  }

  // tabs
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('view-' + t.dataset.tab).classList.add('active');
  });

  async function loadStats() {
    try {
      const [r1, r2] = await Promise.all([fetch('/api/admin/participants'), fetch('/api/admin/stats')]);
      if (!r1.ok || !r2.ok) throw new Error('load failed');
      const { participants } = await r1.json();
      const { breakdown, recent } = await r2.json();
      document.getElementById('s-parts').textContent = participants.length;
      document.getElementById('s-up').textContent = participants.reduce((a,p)=>a+(p.likes||0),0);
      document.getElementById('s-down').textContent = participants.reduce((a,p)=>a+(p.dislikes||0),0);
      document.getElementById('s-fav').textContent = participants.filter(p=>p.siteFav).length;
      document.getElementById('s-time').textContent = fmtDur(participants.reduce((a,p)=>a+(p.totalMs||0),0));

      const pp = document.getElementById('perParticipant');
      if (!participants.length) { pp.innerHTML = '<div class="empty">No participants yet.</div>'; }
      else {
        pp.innerHTML = '<table><thead><tr><th>Participant</th><th class="n">Liked</th><th class="n">Disliked</th><th class="n">Hotels viewed</th><th class="n">Clicked</th><th class="n">Avg / hotel</th><th class="n">Total time</th><th>Bookmarked</th><th>Agreed</th><th>AI in search</th><th>AI in product</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>' +
          participants.map(function(p){ return '<tr><td><b>'+esc(p.pid)+'</b></td><td class="n up">'+(p.likes||0)+'</td><td class="n down">'+(p.dislikes||0)+'</td><td class="n">'+(p.hotelsSeen||0)+'</td><td class="n">'+(p.hotelsClicked||0)+'</td><td class="n">'+fmtDur(p.avgHotelMs||0)+'</td><td class="n">'+fmtDur(p.totalMs||0)+'</td><td>'+(p.siteFav?'Yes':'No')+'</td><td>'+(p.consentedAt?'Yes':'No')+'</td><td>'+(p.aiSearch==null?'—':p.aiSearch?'On':'Off')+'</td><td>'+(p.aiProduct==null?'—':p.aiProduct?'On':'Off')+'</td><td class="muted">'+(p.firstSeen?new Date(p.firstSeen).toLocaleString():'—')+'</td><td class="muted">'+(p.lastSeen?new Date(p.lastSeen).toLocaleString():'—')+'</td></tr>'; }).join('') +
          '</tbody></table>';
      }

      const bd = document.getElementById('breakdown');
      if (!breakdown.length) { bd.innerHTML = '<div class="empty">No hotels in the database.</div>'; }
      else {
        bd.innerHTML = '<div class="muted" style="margin-bottom:8px">All '+breakdown.length+' hotels, including those with 0 votes. Sorted by net score.</div>'+
          '<table><thead><tr><th>Hotel</th><th>City</th><th class="n">Rating</th><th class="n">Likes</th><th class="n">Dislikes</th><th class="n">Net</th></tr></thead><tbody>' +
          breakdown.map(function(b){ return '<tr><td>'+esc(b.name||b.id)+'</td><td>'+esc(b.city||'')+'</td><td class="n">'+(b.rating!=null?Number(b.rating).toFixed(1):'—')+'</td>'+
            '<td class="n up">'+b.up+'</td><td class="n down">'+b.down+'</td><td class="n">'+(b.net>=0?'+':'')+b.net+'</td></tr>'; }).join('') +
          '</tbody></table>';
      }
      const rc = document.getElementById('recent');
      if (!recent.length) { rc.innerHTML = '<div class="empty">No vote records yet.</div>'; }
      else {
        rc.innerHTML = '<table><thead><tr><th>Participant</th><th>Hotel</th><th>Action</th><th>Result</th><th>Page</th><th>Time</th></tr></thead><tbody>' +
          recent.map(function(v){ return '<tr><td>'+esc(v.voter_id)+'</td><td>'+esc(v.hotel_name||v.hotel_id)+'</td><td class="'+(v.choice==='up'?'up':'down')+'">'+(v.choice==='up'?'Like':'Dislike')+'</td><td>'+(v.result==='cleared'?'<span class="muted">cancelled</span>':'set')+'</td><td>'+esc(v.source||'')+'</td><td class="muted">'+(v.updated_at?new Date(v.updated_at).toLocaleString():'—')+'</td></tr>'; }).join('') +
          '</tbody></table>';
      }
    } catch(e){ console.error(e); }
  }

  // ---- Welcome text ----
  let welcomeLoaded = false;
  async function loadWelcome(){
    const r = await fetch('/api/admin/settings'); const d = await r.json();
    document.getElementById('welcomeText').value = d.welcome || d.welcomeDefault || '';
    const a = d.ai || {}; const cs = document.getElementById('aiSearch'), cp = document.getElementById('aiProduct');
    cs.checked = !!a.search; cp.checked = !!a.product; cs.disabled = !!a.lockedSearch; cp.disabled = !!a.lockedProduct;
    document.getElementById('aiModeSave').disabled = !!(a.lockedSearch && a.lockedProduct);
    document.getElementById('aiModeMsg').textContent = (a.lockedSearch||a.lockedProduct) ? 'Locked by environment variables on this deployment.' : '';
  }
  document.getElementById('aiModeSave').onclick = async () => {
    const msg = document.getElementById('aiModeMsg'); msg.textContent = 'Saving…'; msg.style.color = '';
    try {
      for (const [key, id] of [['ai_search','aiSearch'],['ai_product','aiProduct']]) {
        const el = document.getElementById(id); if (el.disabled) continue;
        const r = await fetch('/api/admin/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key, value: el.checked ? 'on' : 'off' }) });
        const d = await r.json(); if (!r.ok) throw new Error(d.error||'Save failed');
      }
      msg.style.color = '#2E7D5B'; msg.textContent = 'Saved — search page: '+(document.getElementById('aiSearch').checked?'on':'off')+', product page: '+(document.getElementById('aiProduct').checked?'on':'off');
    } catch(e) { msg.style.color = '#B3261E'; msg.textContent = e.message; }
  };
  document.getElementById('welcomeSave').onclick = () => saveWelcome(document.getElementById('welcomeText').value);
  document.getElementById('welcomeReset').onclick = () => { if (confirm('Replace the current text with the built-in default?')) saveWelcome(''); };

  let participantsLoaded = false;
  async function loadParticipants(){
    try {
      const r = await fetch('/api/admin/participants');
      if (!r.ok) throw new Error('load failed');
      const { participants } = await r.json();
      document.getElementById('p-count').textContent = participants.length;
      document.getElementById('p-sitefav').textContent = participants.filter(p=>p.siteFav).length;
      document.getElementById('p-time').textContent = fmtDur(participants.reduce((s,p)=>s+(p.totalMs||0),0));
      const box = document.getElementById('participants');
      if (!participants.length){ box.innerHTML = '<div class="empty">No participant data yet. Once someone enters a participant ID and browses the site, records will appear here.</div>'; return; }
      box.innerHTML = participants.map(function(p){
        const hotelsRows = (p.hotels||[]).map(function(h){
          const where = h.vote && h.voteSource ? ' <span class="muted">('+esc(h.voteSource)+')</span>' : '';
          const vote = h.vote==='up' ? '<span style="color:#2E7D5B;font-weight:600">Like</span>'+where : h.vote==='down' ? '<span style="color:#E8542F;font-weight:600">Dislike</span>'+where : '<span class="muted">—</span>';
          return '<tr><td>'+esc(h.name)+'</td><td class="n">'+(h.rating!=null?Number(h.rating).toFixed(1):'—')+'</td><td class="n">'+(h.reviewCount!=null?Number(h.reviewCount).toLocaleString():'—')+'</td><td class="n">'+h.seen+'</td><td class="n">'+h.clicks+'</td><td>'+vote+'</td><td class="n">'+fmtDur(h.listMs||0)+'</td><td class="n">'+fmtDur(h.detailMs||0)+'</td></tr>';
        }).join('');
        const favList = (p.favHotels||[]).map(f=>esc(f.name)).join(', ') || '<span class="muted">None</span>';
        return '<div class="panel" style="margin-bottom:14px">'+
          '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">'+
            '<div style="font-weight:700;font-size:16px">ID '+esc(p.pid)+'</div>'+
            '<div class="muted">First '+(p.firstSeen?new Date(p.firstSeen).toLocaleString():'—')+' · Last '+(p.lastSeen?new Date(p.lastSeen).toLocaleString():'—')+'</div>'+
          '</div>'+
          '<div style="display:flex;gap:18px;flex-wrap:wrap;margin:10px 0 4px;font-size:13.5px">'+
            '<span>Dwell time: <b>'+fmtDur(p.totalMs)+'</b></span>'+
            '<span>Total likes: <b>'+(p.upvotes||0)+'</b></span>'+
            '<span>Saved site: <b>'+(p.siteFav?'Yes':'No')+'</b></span>'+
          '</div>'+
          '<div style="font-size:13.5px;margin-bottom:8px">Saved hotels: '+favList+'</div>'+
          (hotelsRows
            ? '<table><thead><tr><th>Hotel</th><th class="n">Rating</th><th class="n">Reviews</th><th class="n">List views</th><th class="n">Clicks</th><th>Vote</th><th class="n">In list</th><th class="n">On detail</th></tr></thead><tbody>'+hotelsRows+'</tbody></table>'
            : '<div class="muted">No hotel browsing records yet</div>')+
        '</div>';
      }).join('');
    } catch(e){ console.error(e); }
  }

  document.getElementById('importForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('importBtn'); const msg = document.getElementById('importMsg');
    btn.disabled = true; btn.textContent = 'Importing…'; msg.className = 'msg'; msg.style.display='none';
    try {
      const r = await fetch('/api/admin/import', { method:'POST', body: new FormData(e.target) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Import failed');
      msg.className = 'msg ok';
      msg.innerHTML = 'Imported city <b>'+esc(d.city)+'</b> (key: '+esc(d.cityKey)+'). '+d.hotels+' hotels total, '+d.inserted+' added, '+d.updated+' updated.<br>Examples: '+d.sample.map(esc).join(', ');
      loadStats();
      manageCity = d.cityKey; loadManage(true);
    } catch(err) {
      msg.className = 'msg err'; msg.textContent = err.message;
    } finally { btn.disabled = false; btn.textContent = 'Upload & import'; }
  });

  /* ---------- manage / reorder ---------- */
  let manageCities = [], manageHotels = [], manageCity = null, manageLoaded = false;

  async function loadManage(force) {
    try {
      const sel = document.getElementById('citySel');
      // load city list once
      if (!manageCities.length || force) {
        const r = await fetch('/api/admin/hotels');
        const d = await r.json();
        manageCities = d.cities || [];
        sel.innerHTML = manageCities.map(c => '<option value="'+esc(c.key)+'">'+esc(c.name)+'</option>').join('');
        manageCity = manageCity && manageCities.find(c=>c.key===manageCity) ? manageCity : (manageCities[0]?.key || null);
        sel.value = manageCity;
      }
      if (manageCity) await loadCityHotels(manageCity);
      manageLoaded = true;
    } catch(e){ console.error(e); }
  }

  async function loadCityHotels(city) {
    const r = await fetch('/api/admin/hotels?city=' + encodeURIComponent(city));
    const d = await r.json();
    manageHotels = d.hotels || [];
    manageCity = city;
    document.getElementById('cityCount').textContent = manageHotels.length + ' hotels';
    // fill the city image field for this city
    const cityObj = (manageCities || []).find(c => c.key === city) || {};
    const inp = document.getElementById('cityImageInput');
    if (inp) inp.value = cityObj.image || '';
    renderCityImagePreview(cityObj.image || '');
    renderHotelList();
  }

  function renderCityImagePreview(url) {
    const box = document.getElementById('cityImagePreview');
    if (!box) return;
    box.innerHTML = url
      ? '<img src="'+esc(url)+'" alt="" style="height:90px;border-radius:8px;border:1px solid var(--line);object-fit:cover" onerror="this.style.display=\\'none\\'">'
      : '<span class="muted">(not set — homepage uses the default gradient)</span>';
  }

  function renderHotelList() {
    const ul = document.getElementById('hotelList');
    ul.innerHTML = '';
    manageHotels.forEach((h, i) => {
      const li = document.createElement('li');
      li.className = 'hrow'; li.draggable = true; li.dataset.id = h.id;
      const hasAi = h.seo && h.seo.trim();
      li.innerHTML = '<span class="grip">⋮⋮</span>'+
        '<span class="pos">'+(i+1)+'</span>'+
        '<span class="nm">'+esc(h.name)+' '+
          (hasAi ? '<span class="pill ai">AI review</span>' : '<span class="pill guest">Guest quote</span>')+
        '</span>'+
        '<span class="meta">'+(h.rating||0).toFixed(1)+' · '+(h.reviewCount||0).toLocaleString()+' reviews'+(h.tc?' · Winner':'')+'</span>';
      ul.appendChild(li);
    });
    wireDnd(ul);
  }

  function wireDnd(ul) {
    let dragEl = null;
    ul.querySelectorAll('.hrow').forEach(row => {
      row.addEventListener('dragstart', e => { dragEl = row; row.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; });
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); ul.querySelectorAll('.over').forEach(x=>x.classList.remove('over')); reindex(); });
      row.addEventListener('dragover', e => { e.preventDefault();
        const after = e.clientY > row.getBoundingClientRect().top + row.offsetHeight/2;
        ul.querySelectorAll('.over').forEach(x=>x.classList.remove('over')); row.classList.add('over');
        if (dragEl && dragEl !== row) {
          if (after) row.after(dragEl); else row.before(dragEl);
        }
      });
      row.addEventListener('drop', e => e.preventDefault());
    });
  }

  function reindex() {
    const ul = document.getElementById('hotelList');
    const ids = [...ul.querySelectorAll('.hrow')].map(r => r.dataset.id);
    // reorder manageHotels to match DOM, refresh position numbers
    manageHotels.sort((a,b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    [...ul.querySelectorAll('.hrow')].forEach((r,i) => r.querySelector('.pos').textContent = i+1);
  }

  document.getElementById('citySel').addEventListener('change', e => loadCityHotels(e.target.value));

  document.getElementById('saveOrder').addEventListener('click', async () => {
    const btn = document.getElementById('saveOrder'); const msg = document.getElementById('orderMsg');
    const ul = document.getElementById('hotelList');
    const orderedIds = [...ul.querySelectorAll('.hrow')].map(r => r.dataset.id);
    btn.disabled = true; btn.textContent = 'Saving…'; msg.className='msg'; msg.style.display='none';
    try {
      const r = await fetch('/api/admin/reorder', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ city: manageCity, orderedIds }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error||'Save failed');
      msg.className='msg ok'; msg.textContent = 'Saved ('+d.updated+' hotels). This only changes the admin list order; participants keep their own fixed random order.';
    } catch(err){ msg.className='msg err'; msg.textContent = err.message; }
    finally { btn.disabled=false; btn.textContent='Save order'; }
  });

  document.getElementById('saveCityImage').addEventListener('click', async () => {
    const btn = document.getElementById('saveCityImage'); const msg = document.getElementById('cityImageMsg');
    const image = document.getElementById('cityImageInput').value.trim();
    btn.disabled = true; btn.textContent = 'Saving…'; msg.style.display='none';
    try {
      const r = await fetch('/api/admin/city-image', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ city: manageCity, image }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error||'Save failed');
      // update local cache + preview
      const c = (manageCities||[]).find(x=>x.key===manageCity); if (c) c.image = d.image || '';
      renderCityImagePreview(d.image || '');
      msg.className='msg ok'; msg.style.display='inline-block'; msg.textContent = 'Saved';
    } catch(err){ msg.className='msg err'; msg.style.display='inline-block'; msg.textContent = err.message; }
    finally { btn.disabled=false; btn.textContent='Save city image'; }
  });

  // load manage data when its tab is first opened
  document.querySelector('.tab[data-tab="manage"]').addEventListener('click', () => { if(!manageLoaded) loadManage(); });
  document.querySelector('.tab[data-tab="text"]').addEventListener('click', () => { if(!textLoaded) { textLoaded = true; loadTextCities(); } });
  document.querySelector('.tab[data-tab="welcome"]').addEventListener('click', () => { if(!welcomeLoaded) { welcomeLoaded = true; loadWelcome(); } });
  document.querySelector('.tab[data-tab="participants"]').addEventListener('click', () => { loadParticipants(); participantsLoaded = true; });
  setInterval(() => { if (participantsLoaded && document.getElementById('view-participants').classList.contains('active')) loadParticipants(); }, 20000);

  fetch('/api/health').then(r=>r.json()).then(h=>{
    document.getElementById('dbmode').textContent = h.db ? '(Database: Postgres)' : '(Database: in-memory, cleared on restart)';
  }).catch(()=>{});
  loadStats();
  setInterval(loadStats, 20000);
</script>
</body></html>`;
