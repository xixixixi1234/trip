import express from "express";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import * as db from "./db.js";
import { parseTravelersChoiceCsv } from "./import_csv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "waypoint-admin"; // change in production!

app.use(express.json({ limit: "1mb" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

await db.init();

/* ============================================================
   Public data API (hotels, cities, reviews) — served from the DB
   ============================================================ */
app.get("/api/cities", async (_req, res) => {
  try { res.json(await db.listCities()); }
  catch (e) { console.error(e); res.status(500).json({ error: "failed to load cities" }); }
});

app.get("/api/hotels", async (req, res) => {
  try { res.json(await db.listHotels({ city: req.query.city })); }
  catch (e) { console.error(e); res.status(500).json({ error: "failed to load hotels" }); }
});

app.get("/api/hotels/:id/reviews", async (req, res) => {
  try { res.json(await db.getReviews(req.params.id)); }
  catch (e) { console.error(e); res.status(500).json({ error: "failed to load reviews" }); }
});

/* ============================================================
   Votes
   ============================================================ */
app.get("/api/votes", async (_req, res) => {
  try { res.json(await db.tallies()); }
  catch (e) { console.error(e); res.status(500).json({ error: "failed to load votes" }); }
});

app.post("/api/vote", async (req, res) => {
  const { hotelId, voterId, choice } = req.body || {};
  if (!hotelId || !voterId || !["up", "down"].includes(choice)) {
    return res.status(400).json({ error: "hotelId, voterId and choice ('up'|'down') are required" });
  }
  try { res.json(await db.vote({ hotelId, voterId, choice })); }
  catch (e) { console.error(e); res.status(500).json({ error: "failed to record vote" }); }
});

/* ============================================================
   Participant research tracking
   ============================================================ */
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

// hotel event: seen (list impression) or click (card opened)
app.post("/api/track/event", async (req, res) => {
  const { pid, hotelId, type, n } = req.body || {};
  if (!pid || !hotelId || !["seen", "click"].includes(type)) {
    return res.status(400).json({ error: "pid, hotelId, type('seen'|'click') required" });
  }
  try { await db.trackHotelEvent(pid, hotelId, type, n || 1); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: "track failed" }); }
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

/* CSV import (multipart form-data, field name "file") */
app.post("/api/admin/import", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "请选择一个 CSV 文件。" });
    const text = req.file.buffer.toString("utf8");
    const opts = {
      cityKey: (req.body.cityKey || "").trim() || undefined,
      cityName: (req.body.cityName || "").trim() || undefined,
      country: (req.body.country || "").trim() || undefined,
      limit: req.body.limit ? parseInt(req.body.limit, 10) : 400,
    };
    const parsed = parseTravelersChoiceCsv(text, opts);
    if (!parsed.hotels.length) {
      return res.status(400).json({ error: "没有可导入的酒店（每行需要有效的酒店名、评分和至少 1 条评论）。" });
    }
    const result = await db.importHotels(parsed.hotels);
    res.json({
      ok: true, city: parsed.cityName, cityKey: parsed.cityKey,
      hotels: parsed.hotels.length, inserted: result.inserted, updated: result.updated,
      sample: parsed.hotels.slice(0, 5).map(h => h.name),
    });
  } catch (e) {
    console.error("Import failed:", e);
    res.status(400).json({ error: e.message || "导入失败" });
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
<html lang="zh"><head><meta charset="utf-8"><title>Find a Hotel · 后台</title>
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
  <h1>Find a Hotel 后台</h1>
  <p class="sub">用户投票参与数据、酒店管理 &amp; 批量导入。<span id="dbmode" class="muted"></span></p>

  <div class="tabs">
    <div class="tab active" data-tab="stats">参与数据</div>
    <div class="tab" data-tab="participants">被试数据</div>
    <div class="tab" data-tab="manage">管理酒店 / 排序</div>
    <div class="tab" data-tab="import">批量导入酒店</div>
  </div>

  <!-- STATS -->
  <div class="view active" id="view-stats">
    <div class="cards">
      <div class="card"><div class="k">总投票数</div><div class="v" id="s-total">–</div></div>
      <div class="card"><div class="k">独立用户</div><div class="v" id="s-voters">–</div></div>
      <div class="card"><div class="k">被投票酒店</div><div class="v" id="s-hotels">–</div></div>
      <div class="card"><div class="k">👍 赞</div><div class="v up" id="s-up">–</div></div>
      <div class="card"><div class="k">👎 踩</div><div class="v down" id="s-down">–</div></div>
    </div>

    <h2>各酒店投票明细</h2>
    <div id="breakdown"></div>

    <h2>最近投票记录（每位用户）</h2>
    <p class="sub">显示最近 300 条投票事件。原始数据也可从 <code>/api/admin/stats</code> 获取。</p>
    <div id="recent"></div>
  </div>

  <!-- PARTICIPANTS -->
  <div class="view" id="view-participants">
    <p class="sub">每个被试的浏览时长、收藏、点赞与逐酒店的「看到 / 点击」次数。数据实时记录，20 秒自动刷新。原始数据也可从 <code>/api/admin/participants</code> 获取。</p>
    <div class="cards">
      <div class="card"><div class="k">被试数</div><div class="v" id="p-count">–</div></div>
      <div class="card"><div class="k">收藏本站人数</div><div class="v" id="p-sitefav">–</div></div>
      <div class="card"><div class="k">总浏览时长</div><div class="v" id="p-time">–</div></div>
    </div>
    <div id="participants"></div>
  </div>

  <!-- MANAGE / REORDER -->
  <div class="view" id="view-manage">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:4px">
      <label style="margin:0">城市</label>
      <select id="citySel"></select>
      <span class="muted" id="cityCount"></span>
    </div>

    <div class="panel" style="margin:12px 0 18px;padding:14px 16px">
      <div style="font-weight:600;font-size:14px;margin-bottom:6px">首页城市代表图</div>
      <p class="sub" style="margin:0 0 8px">填一个图片链接，作为该城市在首页卡片上的代表图。留空则用默认渐变图。</p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input type="text" id="cityImageInput" placeholder="https://…/city.jpg" style="flex:1 1 320px;min-width:200px" />
        <button id="saveCityImage" style="margin-top:0">保存城市图</button>
        <span class="msg" id="cityImageMsg" style="display:none;margin:0;padding:8px 12px"></span>
      </div>
      <div id="cityImagePreview" style="margin-top:10px"></div>
    </div>

    <p class="sub">拖动每一行调整前台显示顺序。<b>有 AI 点评（SEO）的酒店会自动排在最前面</b>，其余按你拖的顺序排。改完记得点「保存顺序」。</p>
    <ul class="hlist" id="hotelList"></ul>
    <div class="sticky-save">
      <button id="saveOrder">保存顺序</button>
      <span class="msg" id="orderMsg" style="display:inline-block;margin-left:12px;padding:8px 12px"></span>
    </div>
  </div>

  <!-- IMPORT -->
  <div class="view" id="view-import">
    <div class="panel">
      <p class="sub" style="margin-top:0">上传一个 <b>Travelers' Choice 格式</b> 的 CSV（中文表头，和示例数据同格式）。系统会自动清洗，按「有 AI 点评 → 有住客引文 → 获奖 → 高分」排序，默认每城取前 400 家（评分不设硬门槛，混合质量），写入数据库。已存在的酒店会被更新（按酒店名去重）。</p>
      <form id="importForm">
        <label>CSV 文件（必填）</label>
        <input type="file" name="file" accept=".csv" required />
        <div class="row">
          <div>
            <label>城市显示名（可选，默认取 CSV 里的「城市」列）</label>
            <input type="text" name="cityName" placeholder="例如：Berlin" />
          </div>
          <div>
            <label>国家 / 地区（可选）</label>
            <input type="text" name="country" placeholder="例如：Germany" />
          </div>
        </div>
        <div class="row">
          <div>
            <label>城市 key（可选，URL 用，留空自动生成）</label>
            <input type="text" name="cityKey" placeholder="例如：berlin" />
          </div>
          <div>
            <label>每城保留数量（默认 200，填 0 表示不限）</label>
            <input type="number" name="limit" value="400" min="0" />
          </div>
        </div>
        <button type="submit" id="importBtn">上传并导入</button>
      </form>
      <div class="msg" id="importMsg"></div>
    </div>
  </div>
</div>

<script>
  // tabs
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('view-' + t.dataset.tab).classList.add('active');
  });

  async function loadStats() {
    try {
      const r = await fetch('/api/admin/stats');
      if (!r.ok) throw new Error('load failed');
      const { stats, breakdown, recent } = await r.json();
      document.getElementById('s-total').textContent = stats.totalVotes ?? 0;
      document.getElementById('s-voters').textContent = stats.uniqueVoters ?? 0;
      document.getElementById('s-hotels').textContent = stats.hotelsVoted ?? 0;
      document.getElementById('s-up').textContent = stats.totalUp ?? 0;
      document.getElementById('s-down').textContent = stats.totalDown ?? 0;

      const bd = document.getElementById('breakdown');
      if (!breakdown.length) { bd.innerHTML = '<div class="empty">还没有任何投票。去前台点几个 👍 / 👎 试试。</div>'; }
      else {
        bd.innerHTML = '<table><thead><tr><th>酒店</th><th class="n">👍</th><th class="n">👎</th><th class="n">净值</th></tr></thead><tbody>' +
          breakdown.map(function(b){ return '<tr><td>'+esc(b.name||b.id)+'<div class="muted">'+esc(b.id)+'</div></td>'+
            '<td class="n up">'+b.up+'</td><td class="n down">'+b.down+'</td><td class="n">'+(b.net>=0?'+':'')+b.net+'</td></tr>'; }).join('') +
          '</tbody></table>';
      }

      const rc = document.getElementById('recent');
      if (!recent.length) { rc.innerHTML = '<div class="empty">暂无投票记录。</div>'; }
      else {
        rc.innerHTML = '<table><thead><tr><th>用户 ID</th><th>酒店</th><th>选择</th><th>时间</th></tr></thead><tbody>' +
          recent.map(function(v){ return '<tr><td class="muted">'+esc(v.voter_id)+'</td>'+
            '<td>'+esc(v.hotel_name||v.hotel_id)+'</td>'+
            '<td><span class="pill '+v.choice+'">'+(v.choice==='up'?'👍 赞':'👎 踩')+'</span></td>'+
            '<td class="muted">'+(v.updated_at?new Date(v.updated_at).toLocaleString():'—')+'</td></tr>'; }).join('') +
          '</tbody></table>';
      }
    } catch(e) { console.error(e); }
  }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function fmtDur(ms){
    ms = Number(ms)||0; const s = Math.round(ms/1000);
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s/60), r = s%60;
    if (m < 60) return m + ' 分 ' + r + ' 秒';
    const h = Math.floor(m/60); return h + ' 时 ' + (m%60) + ' 分';
  }

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
      if (!participants.length){ box.innerHTML = '<div class="empty">还没有被试数据。前台输入被试编号并浏览后，这里会出现记录。</div>'; return; }
      box.innerHTML = participants.map(function(p){
        const hotelsRows = (p.hotels||[]).map(function(h){
          return '<tr><td>'+esc(h.name)+'</td><td class="n">'+h.seen+'</td><td class="n">'+h.clicks+'</td></tr>';
        }).join('');
        const favList = (p.favHotels||[]).map(f=>esc(f.name)).join('、') || '<span class="muted">无</span>';
        return '<div class="panel" style="margin-bottom:14px">'+
          '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">'+
            '<div style="font-weight:700;font-size:16px">被试 '+esc(p.pid)+'</div>'+
            '<div class="muted">首次 '+(p.firstSeen?new Date(p.firstSeen).toLocaleString():'—')+' · 最近 '+(p.lastSeen?new Date(p.lastSeen).toLocaleString():'—')+'</div>'+
          '</div>'+
          '<div style="display:flex;gap:18px;flex-wrap:wrap;margin:10px 0 4px;font-size:13.5px">'+
            '<span>⏱ 浏览时长：<b>'+fmtDur(p.totalMs)+'</b></span>'+
            '<span>👍 点赞总数：<b>'+(p.upvotes||0)+'</b></span>'+
            '<span>收藏本站：<b>'+(p.siteFav?'是':'否')+'</b></span>'+
          '</div>'+
          '<div style="font-size:13.5px;margin-bottom:8px">收藏的酒店：'+favList+'</div>'+
          (hotelsRows
            ? '<table><thead><tr><th>酒店</th><th class="n">看到</th><th class="n">点击</th></tr></thead><tbody>'+hotelsRows+'</tbody></table>'
            : '<div class="muted">暂无酒店浏览记录</div>')+
        '</div>';
      }).join('');
    } catch(e){ console.error(e); }
  }

  document.getElementById('importForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('importBtn'); const msg = document.getElementById('importMsg');
    btn.disabled = true; btn.textContent = '导入中…'; msg.className = 'msg'; msg.style.display='none';
    try {
      const r = await fetch('/api/admin/import', { method:'POST', body: new FormData(e.target) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '导入失败');
      msg.className = 'msg ok';
      msg.innerHTML = '✅ 成功导入城市 <b>'+esc(d.city)+'</b>（key: '+esc(d.cityKey)+'）。共 '+d.hotels+' 家酒店，新增 '+d.inserted+'、更新 '+d.updated+'。<br>示例：'+d.sample.map(esc).join('、');
      loadStats();
      manageCity = d.cityKey; loadManage(true);
    } catch(err) {
      msg.className = 'msg err'; msg.textContent = '❌ ' + err.message;
    } finally { btn.disabled = false; btn.textContent = '上传并导入'; }
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
    document.getElementById('cityCount').textContent = manageHotels.length + ' 家酒店';
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
      : '<span class="muted">（未设置，首页用默认渐变图）</span>';
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
          (hasAi ? '<span class="pill ai">AI 点评</span>' : '<span class="pill guest">住客引文</span>')+
        '</span>'+
        '<span class="meta">★'+(h.rating||0).toFixed(1)+' · '+(h.reviewCount||0).toLocaleString()+' 评论'+(h.tc?' · 获奖':'')+'</span>';
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
    btn.disabled = true; btn.textContent = '保存中…'; msg.className='msg'; msg.style.display='none';
    try {
      const r = await fetch('/api/admin/reorder', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ city: manageCity, orderedIds }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error||'保存失败');
      msg.className='msg ok'; msg.textContent = '✅ 已保存（'+d.updated+' 家）。前台会按这个顺序显示，有 AI 点评的仍排最前。';
    } catch(err){ msg.className='msg err'; msg.textContent = '❌ '+err.message; }
    finally { btn.disabled=false; btn.textContent='保存顺序'; }
  });

  document.getElementById('saveCityImage').addEventListener('click', async () => {
    const btn = document.getElementById('saveCityImage'); const msg = document.getElementById('cityImageMsg');
    const image = document.getElementById('cityImageInput').value.trim();
    btn.disabled = true; btn.textContent = '保存中…'; msg.style.display='none';
    try {
      const r = await fetch('/api/admin/city-image', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ city: manageCity, image }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error||'保存失败');
      // update local cache + preview
      const c = (manageCities||[]).find(x=>x.key===manageCity); if (c) c.image = d.image || '';
      renderCityImagePreview(d.image || '');
      msg.className='msg ok'; msg.style.display='inline-block'; msg.textContent = '✅ 已保存';
    } catch(err){ msg.className='msg err'; msg.style.display='inline-block'; msg.textContent = '❌ '+err.message; }
    finally { btn.disabled=false; btn.textContent='保存城市图'; }
  });

  // load manage data when its tab is first opened
  document.querySelector('.tab[data-tab="manage"]').addEventListener('click', () => { if(!manageLoaded) loadManage(); });
  document.querySelector('.tab[data-tab="participants"]').addEventListener('click', () => { loadParticipants(); participantsLoaded = true; });
  setInterval(() => { if (participantsLoaded && document.getElementById('view-participants').classList.contains('active')) loadParticipants(); }, 20000);

  fetch('/api/health').then(r=>r.json()).then(h=>{
    document.getElementById('dbmode').textContent = h.db ? '（数据库：Postgres）' : '（数据库：内存模式，重启后清空）';
  }).catch(()=>{});
  loadStats();
  setInterval(loadStats, 20000);
</script>
</body></html>`;
