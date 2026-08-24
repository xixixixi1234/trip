import React, { useState, useEffect, useMemo, useRef } from "react";
import { CITIES as SEED_CITIES, CITY_LISTINGS as SEED_LISTINGS } from "./cities.js";

/* Data loads live from the API (so admin CSV imports show up). The bundled
   cities.js is only a fallback for `npm run dev` without the API server. */
async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* POST helper that REJECTS on network/HTTP failure so callers can show an error state. */
async function postJsonStrict(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
/* fire-and-forget variant for background tracking */
function postJson(url, body) { return postJsonStrict(url, body).catch(() => null); }

/* ============================================================
   Participant research tracking (module-level singleton)
   pid comes from the opening modal; all activity is attributed to it.
   ============================================================ */
const Track = {
  pid: null,
  seenSent: new Set(),   // hotelIds already counted as "seen" this session
  start(pid) {
    this.pid = pid;
    this.seenSent = new Set();
    // heartbeat: report dwell time every 5s while the tab is visible
    if (this._hb) clearInterval(this._hb);
    let last = Date.now();
    this._hb = setInterval(() => {
      if (!this.pid || document.hidden) { last = Date.now(); return; }
      const now = Date.now();
      const ms = now - last; last = now;
      if (ms > 0 && ms < 60000) postJson("/api/track/session", { pid: this.pid, ms });
    }, 5000);
    postJson("/api/track/session", { pid, ms: 0 });
    window.addEventListener("visibilitychange", () => { last = Date.now(); });
  },
  seen(hotelId) {
    if (!this.pid || this.seenSent.has(hotelId)) return;
    this.seenSent.add(hotelId);
    postJson("/api/track/event", { pid: this.pid, hotelId, type: "seen" });
  },
  click(hotelId) {
    if (!this.pid) return;
    postJson("/api/track/event", { pid: this.pid, hotelId, type: "click" });
  },
};

/* ============================================================
   Design tokens — coastal: ink-teal, paper white, life-buoy orange.
   ============================================================ */
const C = {
  ink: "#122B33",
  inkSoft: "#3D5860",
  paper: "#F7F9F8",
  card: "#FFFFFF",
  sea: "#DCE9E6",
  seaDeep: "#9FBFB8",
  buoy: "#E8542F",
  buoyDim: "#F3C9BC",
  green: "#2E7D5B",
  line: "#E2EAE8",
  danger: "#B3261E",
  dangerBg: "#FCEDEB",
  successBg: "#E6F3EC",
};

/* Global stylesheet: hover / focus / active / disabled states for every
   button and card, mobile layout breakpoints, text-overflow guards and
   reduced-motion support. Inline styles cannot express :hover/:focus, so the
   state layer lives here and components opt in with the wp-* classes. */
const GLOBAL_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body { overflow-x: hidden; -webkit-text-size-adjust: 100%; }
img, svg { max-width: 100%; }
button, input, textarea { font-family: 'Roboto', sans-serif; }
button { -webkit-tap-highlight-color: transparent; }
h1, h2, h3, h4 { font-style: normal; overflow-wrap: anywhere; }
.wp-text { overflow-wrap: anywhere; min-width: 0; }

.wp-btn { transition: background .12s ease, color .12s ease, border-color .12s ease, box-shadow .12s ease, transform .08s ease, opacity .12s ease; }
.wp-btn:not(:disabled) { cursor: pointer; }
.wp-btn:disabled, .wp-btn[aria-busy="true"] { opacity: .6; cursor: not-allowed; }
.wp-btn:not(:disabled):active { transform: translateY(1px); }
.wp-btn:focus-visible, .wp-card:focus-visible, .wp-input:focus-visible { outline: 2px solid ${C.buoy}; outline-offset: 2px; }

.wp-primary:not(:disabled):hover { background: #1F4450 !important; box-shadow: 0 4px 12px rgba(18,43,51,.18); }
.wp-ghost:not(:disabled):hover { background: #EEF4F2 !important; border-color: ${C.seaDeep} !important; }
.wp-accent:not(:disabled):hover { background: #D0451F !important; box-shadow: 0 4px 12px rgba(232,84,47,.25); }
.wp-vote:not(:disabled):hover { border-color: ${C.seaDeep} !important; background: #EEF4F2 !important; }
.wp-vote.is-up:not(:disabled):hover { background: #256A4D !important; border-color: #256A4D !important; }
.wp-vote.is-down:not(:disabled):hover { background: #D0451F !important; border-color: #D0451F !important; }
.wp-link { background: none; border: none; padding: 0; }
.wp-link:not(:disabled):hover { text-decoration: underline; }

.wp-card { transition: transform .15s ease, box-shadow .15s ease; cursor: pointer; }
.wp-card:hover, .wp-card:focus-visible { transform: translateY(-2px); box-shadow: 0 12px 28px rgba(18,43,51,.14); }

.wp-input { transition: border-color .12s ease, box-shadow .12s ease; }
.wp-input:hover { border-color: ${C.seaDeep}; }
.wp-input:focus { border-color: ${C.ink}; box-shadow: 0 0 0 3px ${C.sea}; outline: none; }
.wp-input.is-error { border-color: ${C.danger}; box-shadow: 0 0 0 3px ${C.dangerBg}; }

.wp-row { display: grid; grid-template-columns: 180px minmax(0, 1fr); }
.wp-row .wp-art { height: 100%; min-height: 128px; }
.wp-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }

@media (max-width: 600px) {
  .wp-row { grid-template-columns: minmax(0, 1fr); }
  .wp-row .wp-art { height: 160px; min-height: 0; }
  .wp-main { padding: 14px 14px 48px !important; }
  .wp-detail-pad { padding: 16px 16px 18px !important; }
  .wp-city-grid { grid-template-columns: 1fr !important; }
}
@media (max-width: 380px) {
  .wp-amenities { grid-template-columns: 1fr !important; }
}

@keyframes wp-spin { to { transform: rotate(360deg); } }
.wp-spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: wp-spin .7s linear infinite; display: inline-block; vertical-align: -2px; flex: 0 0 auto; }
@keyframes wp-fade { from { opacity: 0; } to { opacity: 1; } }
.wp-fade { animation: wp-fade .25s ease; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
`;

/* ----------------------- atoms ----------------------- */

function Buoys({ value, size = 14 }) {
  const rings = [];
  for (let i = 1; i <= 5; i++) {
    const fill = Math.min(Math.max(value - (i - 1), 0), 1);
    rings.push(
      <span key={i} style={{ position: "relative", width: size, height: size, display: "inline-block" }}>
        <span style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `${Math.max(2, size * 0.22)}px solid ${C.buoyDim}` }} />
        <span style={{
          position: "absolute", inset: 0, borderRadius: "50%",
          border: `${Math.max(2, size * 0.22)}px solid ${C.buoy}`,
          clipPath: fill >= 1 ? "none" : `inset(0 ${100 - fill * 100}% 0 0)`,
          opacity: fill > 0 ? 1 : 0,
        }} />
      </span>
    );
  }
  return <span aria-label={`${value} out of 5`} style={{ display: "inline-flex", gap: size * 0.28, alignItems: "center", flex: "0 0 auto" }}>{rings}</span>;
}

function Spinner() { return <span className="wp-spinner" aria-hidden="true" />; }

/* Small inline status line used under interactive controls.
   kind: 'error' | 'success' | 'info' */
function Status({ kind, children, onRetry }) {
  if (!children) return null;
  const color = kind === "error" ? C.danger : kind === "success" ? C.green : C.inkSoft;
  return (
    <div role={kind === "error" ? "alert" : "status"} className="wp-fade" style={{ fontSize: 12.5, color, marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span>{children}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="wp-btn wp-link" style={{ color, fontWeight: 600, fontSize: 12.5, minHeight: 32, padding: "4px 6px", margin: "-4px 0" }}>Try again</button>
      )}
    </div>
  );
}

function Tag({ children }) {
  return (
    <span className="wp-text" style={{
      fontFamily: "'Roboto Mono', monospace", fontSize: 11, letterSpacing: "0.04em",
      background: C.sea, color: C.ink, padding: "3px 8px", borderRadius: 4,
    }}>{children}</span>
  );
}

/* Per-browser voter id (module-level; stable for the page's lifetime). */
let VOTER_ID = null;
function getVoterId() {
  if (Track.pid) return Track.pid;
  if (!VOTER_ID) VOTER_ID = "v_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  return VOTER_ID;
}

/* ----------------------- votes ----------------------- */

/* Shared vote state: this participant's own choices plus per-hotel request
   state so every Like/Dislike control can show pending / error / saved. */
function useVotes() {
  const [mine, setMine] = useState({});         // { hotelId: 'up'|'down' }
  const [pending, setPending] = useState({});   // { hotelId: true }
  const [errors, setErrors] = useState({});     // { hotelId: message }
  const [saved, setSaved] = useState({});       // { hotelId: true } — brief "Saved" flash
  const timers = useRef({});

  const vote = async (hotelId, choice) => {
    if (pending[hotelId]) return;
    const prev = mine[hotelId];
    // optimistic update
    setMine(m => ({ ...m, [hotelId]: prev === choice ? undefined : choice }));
    setPending(p => ({ ...p, [hotelId]: true }));
    setErrors(e => ({ ...e, [hotelId]: undefined }));
    setSaved(s => ({ ...s, [hotelId]: false }));
    try {
      const d = await postJsonStrict("/api/vote", { hotelId, voterId: getVoterId(), choice });
      setMine(m => ({ ...m, [hotelId]: d.your || undefined }));
      setSaved(s => ({ ...s, [hotelId]: true }));
      clearTimeout(timers.current[hotelId]);
      timers.current[hotelId] = setTimeout(() => setSaved(s => ({ ...s, [hotelId]: false })), 1800);
    } catch (e) {
      // roll back and surface the failure so the participant can retry
      setMine(m => ({ ...m, [hotelId]: prev }));
      setErrors(er => ({ ...er, [hotelId]: "Couldn't save your vote. Check your connection and try again." }));
    } finally {
      setPending(p => ({ ...p, [hotelId]: false }));
    }
  };

  return { mine, pending, errors, saved, vote };
}

function LikeDislike({ hotelId, mine, pending, errors, saved, vote, size = "sm", stop = true }) {
  const my = mine[hotelId];
  const busy = Boolean(pending[hotelId]);
  const err = errors[hotelId];
  const ok = Boolean(saved[hotelId]);
  const lastChoice = useRef(null);
  const pad = size === "lg" ? "8px 14px" : "6px 11px";
  const fs = size === "lg" ? 14 : 12.5;
  const handle = (choice) => (e) => { if (stop) e.stopPropagation(); lastChoice.current = choice; vote(hotelId, choice); };
  const btn = (active, activeColor) => ({
    display: "inline-flex", alignItems: "center", gap: 6, padding: pad, fontSize: fs,
    borderRadius: 99, minHeight: 34,
    border: `1px solid ${active ? activeColor : C.line}`,
    background: active ? activeColor : C.card,
    color: active ? "#fff" : C.inkSoft, fontWeight: active ? 600 : 500,
  });
  return (
    <div onClick={stop ? (e => e.stopPropagation()) : undefined} onKeyDown={stop ? (e => e.stopPropagation()) : undefined}>
      <div style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label="Rate this hotel">
        <button type="button" onClick={handle("up")} disabled={busy} aria-busy={busy} aria-pressed={my === "up"}
          className={`wp-btn wp-vote${my === "up" ? " is-up" : ""}`} style={btn(my === "up", C.green)}>
          {busy && lastChoice.current === "up" ? <Spinner /> : null}
          <span>{my === "up" ? "Liked" : "Like this hotel"}</span>
        </button>
        <button type="button" onClick={handle("down")} disabled={busy} aria-busy={busy} aria-pressed={my === "down"}
          className={`wp-btn wp-vote${my === "down" ? " is-down" : ""}`} style={btn(my === "down", C.buoy)}>
          {busy && lastChoice.current === "down" ? <Spinner /> : null}
          <span>{my === "down" ? "Disliked" : "Dislike this hotel"}</span>
        </button>
      </div>
      {err && <Status kind="error" onRetry={() => vote(hotelId, lastChoice.current || "up")}>{err}</Status>}
      {!err && ok && <Status kind="success">Saved</Status>}
    </div>
  );
}

/* ----------------------- bookmark (site) ----------------------- */

function BookmarkButton({ favs, size = "md" }) {
  if (!favs) return null;
  const { siteFav, sitePending, siteError, siteSaved, toggleSite } = favs;
  const big = size === "lg";
  return (
    <div>
      <button type="button" onClick={toggleSite} disabled={sitePending} aria-busy={sitePending} aria-pressed={siteFav}
        className={`wp-btn ${siteFav ? "wp-accent" : "wp-ghost"}`} style={{
          display: "inline-flex", alignItems: "center", gap: 7, minHeight: big ? 42 : 38,
          fontSize: big ? 14.5 : 14, fontWeight: 600,
          padding: big ? "9px 20px" : "8px 18px", borderRadius: 99,
          border: `1.5px solid ${siteFav ? C.buoy : C.ink}`,
          background: siteFav ? C.buoy : C.card, color: siteFav ? "#fff" : C.ink,
        }}>
        {sitePending ? <Spinner /> : <span aria-hidden="true">★</span>}
        {sitePending ? (siteFav ? "Removing…" : "Saving…") : (siteFav ? "Bookmarked" : "Bookmark this site")}
      </button>
      {siteError && <Status kind="error" onRetry={toggleSite}>{siteError}</Status>}
      {!siteError && siteSaved && <Status kind="success">{siteFav ? "Bookmark saved" : "Bookmark removed"}</Status>}
    </div>
  );
}

/* ----------------------- detail page ----------------------- */

function DetailPage({ listing, onBack, votes }) {
  return (
    <div>
      <button type="button" onClick={onBack} className="wp-btn wp-ghost" style={{ display: "inline-flex", alignItems: "center", gap: 8, background: C.card, border: `1px solid ${C.line}`, color: C.ink, fontWeight: 700, fontSize: 15, padding: "10px 18px", borderRadius: 99, marginBottom: 16, minHeight: 42 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
        Back
      </button>

      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden", marginBottom: 20 }}>
        <CityArt gradient={listing.gradient} image={listing.image} imageFallback={listing.imageRemote} big flat />
        <div className="wp-detail-pad" style={{ padding: "22px 24px" }}>
          <div style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 11, letterSpacing: "0.14em", color: C.inkSoft, textTransform: "uppercase", marginBottom: 6 }}>
            {listing.type} · {listing.cityName || listing.city}
          </div>
          <h1 style={{ fontFamily: "'Poppins', sans-serif", fontSize: "clamp(23px, 5vw, 34px)", fontWeight: 700, margin: "0 0 6px", color: C.ink, lineHeight: 1.15 }}>
            {listing.name}
          </h1>
          <div className="wp-text" style={{ fontSize: 14.5, color: C.inkSoft, marginBottom: 12, lineHeight: 1.5 }}>{listing.place} · {listing.price}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 26, fontWeight: 700, color: C.ink }}>{listing.rating.toFixed(1)}</span>
            <Buoys value={listing.rating} size={16} />
            <span style={{ fontSize: 14, color: C.inkSoft }}>{(listing.reviewCount || 0).toLocaleString()} traveller reviews</span>
          </div>
          {listing.tags.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
              {listing.tags.map(t => <Tag key={t}>{t}</Tag>)}
            </div>
          )}
          <p className="wp-text" style={{ fontSize: 15, lineHeight: 1.7, color: C.inkSoft, margin: "0 0 18px", maxWidth: 720 }}>{listing.about}</p>
          {votes && (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap", paddingTop: 16, borderTop: `1px solid ${C.line}` }}>
              <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600, paddingTop: 8 }}>Would you stay here?</span>
              <LikeDislike hotelId={listing.id} {...votes} size="lg" stop={false} />
            </div>
          )}
        </div>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 28 }}>
        <h2 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 19, fontWeight: 600, margin: "0 0 14px", color: C.ink }}>Amenities</h2>
        {listing.amenities.length > 0 ? (
          <div className="wp-amenities" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "8px 14px" }}>
            {listing.amenities.map(a => <div key={a} className="wp-text" style={{ fontSize: 13.5, color: C.inkSoft }}>· {a}</div>)}
          </div>
        ) : (
          <div style={{ fontSize: 13.5, color: C.inkSoft }}>No amenity details are listed for this hotel.</div>
        )}
      </div>
    </div>
  );
}

/* ----------------------- city / hotel art ----------------------- */

/* Image with gradient placeholder. States: loading (gradient, image fading in),
   loaded, broken (falls back to the gradient skyline). */
function CityArt({ gradient, big, flat, image, imageFallback, className }) {
  const [a, b, c] = gradient || ["#1d3a5f", "#4a7ba6", "#dce7f0"];
  // src candidates: local copy first (if the server found one), then the original URL
  const sources = useMemo(() => [image, imageFallback].filter((u, i, arr) => u && arr.indexOf(u) === i), [image, imageFallback]);
  const [srcIdx, setSrcIdx] = useState(0);
  const [status, setStatus] = useState(sources.length ? "loading" : "none");
  useEffect(() => { setSrcIdx(0); setStatus(sources.length ? "loading" : "none"); }, [sources]);
  const src = sources[srcIdx];
  const onError = () => {
    if (srcIdx + 1 < sources.length) { setSrcIdx(srcIdx + 1); setStatus("loading"); }
    else setStatus("broken");
  };
  const showImg = src && status !== "broken";
  return (
    <div className={className} style={{
      position: "relative", overflow: "hidden",
      height: big ? 200 : 128,
      borderRadius: flat ? 0 : (big ? 14 : "10px 10px 0 0"),
      background: `linear-gradient(150deg, ${a} 0%, ${b} 58%, ${c} 100%)`,
    }}>
      {showImg && (
        <img src={src} alt="" loading="lazy" decoding="async"
          onLoad={() => setStatus("loaded")} onError={onError}
          style={{
            position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover",
            opacity: status === "loaded" ? 1 : 0, transition: "opacity .3s ease",
          }} />
      )}
      {(!showImg || status !== "loaded") && (
        <svg viewBox="0 0 400 80" preserveAspectRatio="none" aria-hidden="true" style={{ position: "absolute", bottom: 0, left: 0, width: "100%", height: big ? 80 : 54, opacity: 0.5 }}>
          <path d="M0,80 L0,50 L20,50 L20,34 L38,34 L38,50 L60,50 L60,22 L74,22 L74,50 L96,50 L96,40 L120,40 L120,18 L134,18 L134,40 L160,40 L160,52 L188,52 L188,30 L206,30 L206,52 L236,52 L236,38 L262,38 L262,20 L276,20 L276,38 L300,38 L300,50 L324,50 L324,28 L340,28 L340,50 L364,50 L364,42 L400,42 L400,80 Z" fill={c} opacity="0.85" />
        </svg>
      )}
    </div>
  );
}

function CityHero({ city, gradient }) {
  return <CityArt gradient={gradient} image={city && city.image} big />;
}

/* keyboard-accessible clickable card helper */
function cardProps(onOpen, label) {
  return {
    role: "button", tabIndex: 0, "aria-label": label,
    onClick: onOpen,
    onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } },
  };
}

/* ----------------------- home (city picker) ----------------------- */

function HomePage({ onOpenCity, favs, cities, hotels }) {
  const countFor = (key) => hotels.filter(l => l.city === key).length;
  const shownCities = cities.filter(c => countFor(c.key) > 0);

  return (
    <div>
      <div style={{ textAlign: "center", padding: "34px 8px 26px" }}>
        <h1 style={{ fontFamily: "'Poppins', sans-serif", fontSize: "clamp(28px, 6vw, 46px)", fontWeight: 700, color: C.ink, margin: "0 0 18px", lineHeight: 1.15 }}>
          Find your perfect hotel
        </h1>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <BookmarkButton favs={favs} size="lg" />
        </div>
      </div>

      <div style={{ margin: "8px 2px 14px" }}>
        <h2 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 22, fontWeight: 700, color: C.ink, margin: 0 }}>
          Choose a destination
        </h2>
      </div>

      {shownCities.length === 0 ? (
        <div style={{ textAlign: "center", color: C.inkSoft, padding: 40, fontSize: 14.5, background: C.card, border: `1px solid ${C.line}`, borderRadius: 12 }}>
          No destinations are available yet.
        </div>
      ) : (
        <div className="wp-city-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 18 }}>
          {shownCities.map(c => (
            <div key={c.key} className="wp-card" {...cardProps(() => onOpenCity(c.key), `Explore hotels in ${c.name}`)} style={{
              background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden",
            }}>
              <CityArt gradient={c.gradient} image={c.image} />
              <div style={{ padding: "14px 16px 16px" }}>
                <div className="wp-text" style={{ fontFamily: "'Poppins', sans-serif", fontSize: 21, fontWeight: 700, color: C.ink }}>{c.name}</div>
                <div className="wp-text" style={{ fontSize: 12.5, color: C.inkSoft, marginBottom: 10 }}>{c.country}</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: 12.5, color: C.inkSoft }}>{countFor(c.key)} hotels</span>
                  <span style={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>Explore</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------- city page (hotels in a city) ----------------------- */

/* Per-participant fixed shuffle.
   Each participant sees the hotels of a city in a random order that is
   fixed for that participant (same ID -> same order on every visit/device),
   while different participants get different orders. Seed = hash(pid + city).
   No SEO-first / rating / manual ordering is applied. */
function hashStr(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(list, seedStr) {
  // sort by id first so the input order never influences the result
  const arr = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rnd = mulberry32(hashStr(seedStr));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function CityPage({ cityKey, onBack, onOpen, votes, favs, cities, hotels: allHotels, pid }) {
  const city = cities.find(c => c.key === cityKey) || { name: cityKey, country: "", gradient: null };
  const [page, setPage] = useState(1);
  const PER_PAGE = 20;

  const hotels = useMemo(() => {
    const list = allHotels.filter(l => l.city === cityKey);
    return seededShuffle(list, `${pid || "anon"}::${cityKey}`);
  }, [cityKey, allHotels, pid]);

  const totalPages = Math.max(1, Math.ceil(hotels.length / PER_PAGE));
  const curPage = Math.min(page, totalPages);
  const pageHotels = hotels.slice((curPage - 1) * PER_PAGE, curPage * PER_PAGE);

  useEffect(() => { setPage(1); }, [cityKey]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [curPage]);

  return (
    <div>
      <button type="button" onClick={onBack} className="wp-btn wp-ghost" style={{ display: "inline-flex", alignItems: "center", gap: 8, background: C.card, border: `1px solid ${C.line}`, color: C.ink, fontWeight: 700, fontSize: 15, padding: "10px 18px", borderRadius: 99, marginBottom: 16, minHeight: 42 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
        All destinations
      </button>

      <div style={{ marginBottom: 22 }}>
        <CityHero city={city} gradient={city.gradient} />
        <div style={{ marginTop: 16 }}>
          <div style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 11, letterSpacing: "0.14em", color: C.inkSoft, textTransform: "uppercase", marginBottom: 4 }}>
            {city.country}
          </div>
          <h1 style={{ fontFamily: "'Poppins', sans-serif", fontSize: "clamp(26px, 5.5vw, 40px)", fontWeight: 700, color: C.ink, margin: "0 0 12px", lineHeight: 1.1 }}>
            Hotels in {city.name}
          </h1>
          <BookmarkButton favs={favs} />
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
        <span style={{ fontSize: 13, color: C.inkSoft }}>
          {hotels.length > 0
            ? `Showing ${(curPage - 1) * PER_PAGE + 1}–${Math.min(curPage * PER_PAGE, hotels.length)} of ${hotels.length}`
            : "No results"}
        </span>
        <span style={{ fontSize: 13, color: C.inkSoft }}>Page {curPage} / {totalPages}</span>
      </div>

      {/* hotel list — order is a fixed random shuffle per participant */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {pageHotels.map(l => (
          <CityHotelRow key={l.id} l={l} onOpen={() => { Track.click(l.id); onOpen(l); }} votes={votes} />
        ))}
      </div>
      {hotels.length === 0 && (
        <div style={{ textAlign: "center", color: C.inkSoft, padding: 40, fontSize: 14.5, background: C.card, border: `1px solid ${C.line}`, borderRadius: 12 }}>
          No hotels are listed for {city.name} yet.
        </div>
      )}

      {totalPages > 1 && (
        <Pagination page={curPage} totalPages={totalPages} onGo={setPage} />
      )}
    </div>
  );
}

/* pager: Prev / numbered pages (with ellipses) / Next */
function Pagination({ page, totalPages, onGo }) {
  const nums = [];
  const push = n => nums.push(n);
  const win = 1;
  push(1);
  if (page - win > 2) push("…l");
  for (let n = Math.max(2, page - win); n <= Math.min(totalPages - 1, page + win); n++) push(n);
  if (page + win < totalPages - 1) push("…r");
  if (totalPages > 1) push(totalPages);

  const btn = (active) => ({
    minWidth: 40, minHeight: 40, padding: "8px 12px", borderRadius: 8, fontSize: 13.5,
    border: `1px solid ${active ? C.ink : C.line}`, background: active ? C.ink : C.card,
    color: active ? C.paper : C.ink, fontWeight: active ? 700 : 500,
  });
  return (
    <nav aria-label="Pagination" style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", marginTop: 26, flexWrap: "wrap" }}>
      <button type="button" disabled={page === 1} onClick={() => onGo(page - 1)} className="wp-btn wp-ghost" style={btn(false)}>Prev</button>
      {nums.map((n, i) => typeof n === "string"
        ? <span key={n + i} aria-hidden="true" style={{ color: C.inkSoft, padding: "0 2px" }}>…</span>
        : <button type="button" key={n} onClick={() => onGo(n)} aria-current={n === page ? "page" : undefined}
            className={`wp-btn ${n === page ? "wp-primary" : "wp-ghost"}`} style={btn(n === page)}>{n}</button>
      )}
      <button type="button" disabled={page === totalPages} onClick={() => onGo(page + 1)} className="wp-btn wp-ghost" style={btn(false)}>Next</button>
    </nav>
  );
}

/* a horizontal result row.
   Shows the platform AI summary if the hotel has one (full text);
   otherwise falls back to the first real guest quote (fetched on demand,
   with loading / error / empty states). */
function CityHotelRow({ l, onOpen, votes }) {
  const [quote, setQuote] = useState({ status: l.seo ? "skip" : "loading", data: null });
  const rowRef = useRef(null);

  const loadQuote = () => {
    let alive = true;
    setQuote({ status: "loading", data: null });
    fetchJson(`/api/hotels/${encodeURIComponent(l.id)}/reviews`)
      .then(rs => { if (alive) setQuote({ status: "done", data: (rs || []).find(r => r.source === "quote") || null }); })
      .catch(() => { if (alive) setQuote({ status: "error", data: null }); });
    return () => { alive = false; };
  };
  useEffect(() => {
    if (l.seo) { setQuote({ status: "skip", data: null }); return; }
    return loadQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [l.id, l.seo]);

  // count a "seen" impression once the row actually scrolls into view
  useEffect(() => {
    const el = rowRef.current;
    if (!el || !("IntersectionObserver" in window)) { Track.seen(l.id); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { Track.seen(l.id); io.disconnect(); } });
    }, { threshold: 0.5 });
    io.observe(el);
    return () => io.disconnect();
  }, [l.id]);

  const showSeo = Boolean(l.seo);
  const badgeColor = showSeo ? C.buoy : C.green;
  const badge = (label, color) => (
    <span style={{
      flex: "0 0 auto", fontFamily: "'Roboto Mono', monospace", fontSize: 9.5,
      color, border: `1px solid ${color}`, borderRadius: 4, padding: "2px 5px", marginTop: 2,
    }}>{label}</span>
  );

  let body = null;
  if (showSeo) {
    body = <>{badge("AI", badgeColor)}<p className="wp-text" style={{ fontSize: 13, lineHeight: 1.55, color: C.inkSoft, margin: 0 }}>{l.seo}</p></>;
  } else if (quote.status === "loading") {
    body = <span style={{ fontSize: 12.5, color: C.inkSoft, display: "inline-flex", gap: 8, alignItems: "center" }}><Spinner /> Loading a guest quote…</span>;
  } else if (quote.status === "error") {
    body = (
      <span style={{ fontSize: 12.5, color: C.danger, display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        Couldn't load a guest quote.
        <button type="button" className="wp-btn wp-link" onClick={e => { e.stopPropagation(); loadQuote(); }} onKeyDown={e => e.stopPropagation()} style={{ color: C.danger, fontWeight: 600, fontSize: 12.5, minHeight: 32, padding: "4px 6px", margin: "-4px 0" }}>Try again</button>
      </span>
    );
  } else if (quote.data) {
    body = (
      <>
        {badge("GUEST", badgeColor)}
        <p className="wp-text" style={{ fontSize: 13, lineHeight: 1.55, color: C.inkSoft, margin: 0 }}>
          “{quote.data.text}”{quote.data.author && <span style={{ color: C.inkSoft, fontStyle: "italic" }}> — {quote.data.author}</span>}
        </p>
      </>
    );
  } else {
    body = <span style={{ fontSize: 12.5, color: C.inkSoft }}>No summary or guest quote available for this hotel.</span>;
  }

  return (
    <div ref={rowRef} className="wp-card wp-row" {...cardProps(onOpen, `Open ${l.name}`)} style={{
      background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden",
    }}>
      <div style={{ position: "relative" }}>
        <CityArt className="wp-art" gradient={l.gradient} image={l.image} imageFallback={l.imageRemote} />
        {l.tc && (
          <span style={{
            position: "absolute", top: 10, left: 10, background: C.buoy, color: "#fff",
            fontFamily: "'Roboto Mono', monospace", fontSize: 10, fontWeight: 500,
            padding: "3px 7px", borderRadius: 4, letterSpacing: "0.04em",
          }}>2026 WINNER</span>
        )}
      </div>
      <div className="wp-text" style={{ padding: "14px 18px", minWidth: 0 }}>
        <div className="wp-text" style={{ fontFamily: "'Poppins', sans-serif", fontSize: 18, fontWeight: 700, color: C.ink, lineHeight: 1.25 }}>{l.name}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0 10px", flexWrap: "wrap" }}>
          <Buoys value={l.rating} size={12} />
          <span style={{ fontWeight: 700, fontSize: 13.5, color: C.ink }}>{l.rating.toFixed(1)}</span>
          <span style={{ fontSize: 12.5, color: C.inkSoft }}>({(l.reviewCount || 0).toLocaleString()})</span>
          <span className="wp-text" style={{ fontSize: 12, color: C.inkSoft }}>· {l.price}</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>{body}</div>
        {votes && (
          <div style={{ marginTop: 12 }}>
            <LikeDislike hotelId={l.id} {...votes} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------- app shell ----------------------- */

/* favorites hook: loads this participant's favorites, exposes the site toggle
   with pending / error / saved state */
function useFavorites(pid) {
  const [siteFav, setSiteFav] = useState(false);
  const [sitePending, setSitePending] = useState(false);
  const [siteError, setSiteError] = useState(null);
  const [siteSaved, setSiteSaved] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!pid) return;
    let alive = true;
    fetchJson(`/api/fav?pid=${encodeURIComponent(pid)}`)
      .then(d => { if (alive && d) setSiteFav(Boolean(d.siteFav)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [pid]);

  const toggleSite = async () => {
    if (sitePending) return;
    const next = !siteFav;
    setSiteFav(next); setSitePending(true); setSiteError(null); setSiteSaved(false);
    try {
      await postJsonStrict("/api/fav/site", { pid, on: next });
      setSiteSaved(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setSiteSaved(false), 1800);
    } catch (e) {
      setSiteFav(!next);
      setSiteError("Couldn't update your bookmark. Check your connection and try again.");
    } finally {
      setSitePending(false);
    }
  };
  return { siteFav, sitePending, siteError, siteSaved, toggleSite };
}

/* opening modal that asks for the participant id.
   States: default (button disabled until an ID is typed), validation error,
   submitting (registering the ID with the server), server error with retry
   or continue-offline, success (modal closes). */
const PID_RE = /^[A-Za-z0-9_-]{1,32}$/;
function ParticipantModal({ onSubmit }) {
  const [val, setVal] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [serverFail, setServerFail] = useState(false);

  const submit = async () => {
    const v = val.trim();
    if (!v) { setError("Enter your participant ID to continue."); return; }
    if (!PID_RE.test(v)) { setError("Use letters, numbers, - or _ only (up to 32 characters)."); return; }
    setError(null); setServerFail(false); setBusy(true);
    try {
      await postJsonStrict("/api/track/session", { pid: v, ms: 0 });
      onSubmit(v);
    } catch (e) {
      setServerFail(true);
      setError("Couldn't reach the study server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const invalid = Boolean(error);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="wp-modal-title" style={{
      position: "fixed", inset: 0, zIndex: 1000, background: "rgba(18,43,51,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div style={{ background: C.card, borderRadius: 16, padding: "28px 24px", maxWidth: 420, width: "100%", boxShadow: "0 24px 60px rgba(0,0,0,0.3)" }}>
        <h2 id="wp-modal-title" style={{ fontFamily: "'Poppins', sans-serif", fontSize: 22, fontWeight: 700, color: C.ink, margin: "0 0 8px" }}>
          Welcome to the study
        </h2>
        <p style={{ fontSize: 14.5, color: C.inkSoft, lineHeight: 1.6, margin: "0 0 18px" }}>
          Enter your <b>participant ID</b> to begin. Your browsing and actions on this site are recorded under this ID for research analysis.
        </p>
        <label htmlFor="wp-pid" style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.ink, marginBottom: 6 }}>Participant ID</label>
        <input id="wp-pid" autoFocus value={val} disabled={busy}
          onChange={e => { setVal(e.target.value); if (error) setError(null); }}
          onKeyDown={e => e.key === "Enter" && submit()}
          placeholder="e.g. P001" autoComplete="off" spellCheck={false}
          aria-invalid={invalid} aria-describedby={invalid ? "wp-pid-error" : undefined}
          className={`wp-input${invalid ? " is-error" : ""}`}
          style={{ width: "100%", padding: "12px 14px", fontSize: 16, borderRadius: 10, border: `1.5px solid ${C.line}`, color: C.ink, marginBottom: error ? 6 : 16, background: busy ? C.paper : C.card }} />
        {error && <div id="wp-pid-error" role="alert" className="wp-fade" style={{ fontSize: 13, color: C.danger, margin: "0 0 14px" }}>{error}</div>}
        <button type="button" onClick={submit} disabled={!val.trim() || busy} aria-busy={busy} className="wp-btn wp-primary" style={{
          width: "100%", minHeight: 46, padding: "12px", fontSize: 15, fontWeight: 600, borderRadius: 10, border: "none",
          background: C.ink, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
        }}>
          {busy ? <><Spinner /> Starting…</> : serverFail ? "Try again" : "Start"}
        </button>
        {serverFail && (
          <button type="button" onClick={() => onSubmit(val.trim())} className="wp-btn wp-link" style={{ marginTop: 12, width: "100%", fontSize: 13, color: C.inkSoft, fontWeight: 600 }}>
            Continue anyway (activity may not be recorded)
          </button>
        )}
      </div>
    </div>
  );
}

/* non-blocking banner for data-loading problems */
function DataBanner({ state, onRetry, onDismiss }) {
  if (state.status !== "error") return null;
  return (
    <div role="alert" className="wp-fade" style={{
      background: C.dangerBg, color: C.danger, border: `1px solid ${C.danger}33`, borderRadius: 10,
      padding: "10px 14px", fontSize: 13.5, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 16,
    }}>
      <span style={{ flex: "1 1 200px" }}>Live hotel data couldn't be loaded — showing the built-in copy. Votes and bookmarks may not save until the connection is back.</span>
      <button type="button" onClick={onRetry} disabled={state.retrying} aria-busy={state.retrying} className="wp-btn wp-ghost" style={{ padding: "6px 12px", borderRadius: 8, border: `1px solid ${C.danger}`, background: C.card, color: C.danger, fontWeight: 600, fontSize: 13, display: "inline-flex", gap: 6, alignItems: "center" }}>
        {state.retrying ? <><Spinner /> Retrying…</> : "Retry"}
      </button>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="wp-btn wp-link" style={{ color: C.danger, fontSize: 18, lineHeight: 1 }}>×</button>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState({ name: "home" });
  const votes = useVotes();

  // participant id (research tracking) — persisted so a refresh keeps the same participant
  const [pid, setPid] = useState(() => {
    try { return localStorage.getItem("fah_pid") || null; } catch { return null; }
  });
  const favs = useFavorites(pid);

  useEffect(() => {
    if (pid) Track.start(pid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live data from the API, falling back to bundled seed data.
  const [cities, setCities] = useState(SEED_CITIES);
  const [hotels, setHotels] = useState(SEED_LISTINGS);
  const [dataState, setDataState] = useState({ status: "loading", retrying: false });

  const loadData = async (isRetry = false) => {
    setDataState(s => ({ status: isRetry ? "error" : "loading", retrying: isRetry }));
    try {
      const [c, h] = await Promise.all([fetchJson("/api/cities"), fetchJson("/api/hotels")]);
      if (c?.length && h?.length) { setCities(c); setHotels(h); }
      setDataState({ status: "ok", retrying: false });
    } catch (e) {
      setDataState({ status: "error", retrying: false });
    }
  };
  useEffect(() => { loadData(false); }, []);

  useEffect(() => { window.scrollTo(0, 0); }, [page]);

  // trackpad: swipe right goes back one level (detail -> city -> home)
  useEffect(() => {
    let acc = 0, fired = false;
    const onWheel = (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      acc += e.deltaX;
      if (acc > 0) acc = 0;
      if (acc < -110 && !fired) {
        fired = true;
        setPage(prev => {
          if (prev.name === "detail") {
            return prev.from === "city" ? { name: "city", cityKey: prev.cityKey } : { name: "home" };
          }
          if (prev.name === "city") return { name: "home" };
          return prev;
        });
        setTimeout(() => { fired = false; acc = 0; }, 600);
      }
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  const startSession = (id) => {
    try { localStorage.setItem("fah_pid", id); } catch {}
    setPid(id); Track.start(id);
  };

  const navBtn = (active) => ({
    background: "none", border: "none", fontSize: 13.5, minHeight: 36, padding: "6px 8px", borderRadius: 8,
    color: active ? C.ink : C.inkSoft, fontWeight: active ? 600 : 400,
  });

  return (
    <div style={{ minHeight: "100vh", background: C.paper, fontFamily: "'Roboto', sans-serif", color: C.ink }}>
      <style>{GLOBAL_CSS}</style>
      {!pid && <ParticipantModal onSubmit={startSession} />}
      <header style={{
        position: "sticky", top: 0, zIndex: 10, background: "rgba(247,249,248,0.92)",
        backdropFilter: "blur(8px)", borderBottom: `1px solid ${C.line}`,
      }}>
        <div className="wp-header" style={{ maxWidth: 1080, margin: "0 auto", padding: "10px 16px" }}>
          <button type="button" onClick={() => setPage({ name: "home" })} className="wp-btn wp-link" aria-label="Find a Hotel — home" style={{ display: "flex", alignItems: "center", minHeight: 36 }}>
            <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 20, fontWeight: 700, color: C.ink, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>Find a Hotel</span>
          </button>
          <nav style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
            {pid && (
              <span className="wp-text" title={`Participant ${pid}`} style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 12, color: C.inkSoft, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                ID {pid}
              </span>
            )}
            <button type="button" onClick={() => setPage({ name: "home" })} className="wp-btn wp-ghost" style={navBtn(page.name === "home")}>Destinations</button>
          </nav>
        </div>
      </header>

      <main className="wp-main" style={{ maxWidth: 1080, margin: "0 auto", padding: "20px 20px 60px" }}>
        <DataBanner state={dataState} onRetry={() => loadData(true)} onDismiss={() => setDataState({ status: "ok", retrying: false })} />
        {page.name === "home" && (
          <HomePage
            favs={favs}
            cities={cities}
            hotels={hotels}
            onOpenCity={key => setPage({ name: "city", cityKey: key })}
          />
        )}
        {page.name === "city" && (
          <CityPage
            cityKey={page.cityKey}
            pid={pid}
            votes={votes}
            favs={favs}
            cities={cities}
            hotels={hotels}
            onBack={() => setPage({ name: "home" })}
            onOpen={l => setPage({ name: "detail", listing: l, from: "city", cityKey: page.cityKey })}
          />
        )}
        {page.name === "detail" && (
          <DetailPage
            listing={page.listing}
            votes={votes}
            onBack={() => {
              if (page.from === "city") setPage({ name: "city", cityKey: page.cityKey });
              else setPage({ name: "home" });
            }}
          />
        )}
      </main>
    </div>
  );
}
