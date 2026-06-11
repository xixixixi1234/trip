import React, { useState, useEffect, useMemo } from "react";
import { LISTINGS, REVIEWS_BY_LISTING } from "./data.js";

/* ============================================================
   WAYPOINT — honest travel reviews
   Coastal design: ink-teal, paper white, life-buoy orange.
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
};

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
  return <span style={{ display: "inline-flex", gap: size * 0.28, alignItems: "center" }}>{rings}</span>;
}

function Tag({ children }) {
  return (
    <span style={{
      fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: "0.04em",
      background: C.sea, color: C.ink, padding: "3px 8px", borderRadius: 4,
    }}>{children}</span>
  );
}

function RatingBar({ label, value }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
      <span style={{ width: 96, fontSize: 13, color: C.inkSoft }}>{label}</span>
      <div style={{ flex: 1, height: 8, background: C.sea, borderRadius: 99, overflow: "hidden" }}>
        <div style={{ width: `${(value / 5) * 100}%`, height: "100%", borderRadius: 99, background: `linear-gradient(90deg, ${C.seaDeep}, ${C.buoy})` }} />
      </div>
      <span style={{ width: 28, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: C.ink }}>{value.toFixed(1)}</span>
    </div>
  );
}

function HeroArt({ gradient, icon, big }) {
  const [a, b, c] = gradient;
  return (
    <div style={{
      position: "relative", overflow: "hidden",
      height: big ? 220 : 150, borderRadius: big ? "12px 12px 0 0" : "10px 10px 0 0",
      background: `linear-gradient(180deg, ${a} 0%, ${b} 62%, ${c} 100%)`,
    }}>
      <svg viewBox="0 0 400 60" preserveAspectRatio="none" style={{ position: "absolute", bottom: 0, left: 0, width: "100%", height: big ? 70 : 48, opacity: 0.85 }}>
        <path d="M0,30 C60,10 120,50 200,30 C280,10 340,50 400,30 L400,60 L0,60 Z" fill={c} />
        <path d="M0,42 C70,28 140,56 210,42 C290,28 350,54 400,42 L400,60 L0,60 Z" fill="#ffffff" opacity="0.55" />
      </svg>
      <span style={{ position: "absolute", top: big ? 26 : 16, right: 26, fontSize: big ? 54 : 36, filter: "saturate(0.8)" }}>{icon}</span>
      <span style={{
        position: "absolute", top: 14, left: 16, fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 10, letterSpacing: "0.12em", color: "rgba(255,255,255,0.85)", textTransform: "uppercase",
      }}>Illustration · demo</span>
    </div>
  );
}

/* ----------------------- AI summary ----------------------- */

function AiSummary({ listing, reviews }) {
  const [state, setState] = useState("idle");
  const [data, setData] = useState(null);

  // reset when navigating between listings
  useEffect(() => { setState("idle"); setData(null); }, [listing.id]);

  const generate = async () => {
    setState("loading");
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: listing.name, place: listing.place, reviews }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setState("done");
    } catch (e) {
      console.error("AI summary failed:", e);
      setData({
        live: false,
        summary: `Guests rate ${listing.name} highly for its setting and core experience, while some reviews flag value-for-money concerns. Read individual reviews below for the full picture.`,
        pros: ["Location and setting", "Cleanliness", "Core experience"],
        cons: ["Value on extras"],
        bestFor: "Travellers seeking a relaxed stay",
      });
      setState("error");
    }
  };

  return (
    <div style={{ border: `1.5px solid ${C.ink}`, borderRadius: 12, background: C.card, padding: 20, marginBottom: 28 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: "0.14em", color: C.buoy, textTransform: "uppercase", marginBottom: 4 }}>
            ◍ AI review summary
          </div>
          <div style={{ fontSize: 13, color: C.inkSoft }}>
            Generated by Claude from {reviews.length} guest reviews on this page. AI can make mistakes — the reviews themselves are the source of truth.
          </div>
        </div>
        {state !== "done" && state !== "error" && (
          <button onClick={generate} disabled={state === "loading"} style={{
            background: C.ink, color: C.paper, border: "none", borderRadius: 8,
            padding: "10px 18px", fontFamily: "'Archivo', sans-serif", fontWeight: 600,
            fontSize: 14, cursor: state === "loading" ? "wait" : "pointer",
          }}>
            {state === "loading" ? "Reading reviews…" : "Generate summary"}
          </button>
        )}
      </div>

      {(state === "done" || state === "error") && data && (
        <div style={{ marginTop: 16 }}>
          {data.live === false && (
            <div style={{ fontSize: 12, color: C.buoy, marginBottom: 8, fontFamily: "'IBM Plex Mono', monospace" }}>
              Live AI is not configured — showing a locally prepared summary.
            </div>
          )}
          <p style={{ fontSize: 15, lineHeight: 1.65, color: C.ink, margin: "0 0 14px" }}>{data.summary}</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
            <div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.green, letterSpacing: "0.1em", marginBottom: 6 }}>GUESTS PRAISE</div>
              {(data.pros || []).map((p, i) => <div key={i} style={{ fontSize: 13.5, color: C.ink, marginBottom: 4 }}>+ {p}</div>)}
            </div>
            <div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.buoy, letterSpacing: "0.1em", marginBottom: 6 }}>GUESTS FLAG</div>
              {(data.cons || []).map((p, i) => <div key={i} style={{ fontSize: 13.5, color: C.ink, marginBottom: 4 }}>− {p}</div>)}
            </div>
            <div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.inkSoft, letterSpacing: "0.1em", marginBottom: 6 }}>BEST FOR</div>
              <div style={{ fontSize: 13.5, color: C.ink }}>{data.bestFor}</div>
            </div>
          </div>
          <button onClick={generate} style={{
            marginTop: 14, background: "transparent", color: C.inkSoft, border: `1px solid ${C.line}`,
            borderRadius: 8, padding: "6px 12px", fontSize: 12.5, cursor: "pointer",
          }}>↻ Regenerate</button>
        </div>
      )}
    </div>
  );
}

/* ----------------------- review card & form ----------------------- */

function ReviewCard({ r }) {
  const [expanded, setExpanded] = useState(false);
  const long = r.text.length > 320;
  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{
            width: 40, height: 40, borderRadius: "50%", background: C.sea, color: C.ink,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 16,
          }}>{r.author[0]}</div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14.5, color: C.ink }}>
              {r.author}{" "}
              {r.verified && (
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.green, border: `1px solid ${C.green}`, borderRadius: 4, padding: "1px 5px", marginLeft: 6 }}>
                  ✓ verified stay
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: C.inkSoft }}>{r.from} · {r.tripType} · {r.month}</div>
          </div>
        </div>
        <Buoys value={r.rating} size={13} />
      </div>
      <h4 style={{ fontFamily: "'Fraunces', serif", fontSize: 17.5, margin: "12px 0 6px", color: C.ink }}>{r.title}</h4>
      <p style={{ fontSize: 14.5, lineHeight: 1.65, color: C.inkSoft, margin: 0 }}>
        {long && !expanded ? r.text.slice(0, 320) + "…" : r.text}
      </p>
      <div style={{ display: "flex", gap: 16, marginTop: 12, alignItems: "center" }}>
        {long && (
          <button onClick={() => setExpanded(!expanded)} style={{ background: "none", border: "none", color: C.buoy, fontWeight: 600, fontSize: 13, cursor: "pointer", padding: 0 }}>
            {expanded ? "Show less" : "Read full review"}
          </button>
        )}
        <span style={{ fontSize: 12.5, color: C.inkSoft }}>👍 {r.helpful} found this helpful</span>
      </div>
    </div>
  );
}

const inputStyle = {
  width: "100%", boxSizing: "border-box", marginBottom: 10, padding: "10px 12px",
  border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 14, fontFamily: "'Archivo', sans-serif",
  background: C.paper, color: C.ink, outline: "none",
};

function WriteReview({ onSubmit }) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [author, setAuthor] = useState("");
  const [tripType, setTripType] = useState("Couple");

  const submit = () => {
    if (!rating || !title.trim() || !text.trim()) return;
    onSubmit({
      id: Date.now(), author: author.trim() || "Anonymous traveller", from: "—",
      rating, month: "June 2026", tripType, title: title.trim(), text: text.trim(),
      helpful: 0, verified: false,
    });
    setOpen(false); setRating(0); setTitle(""); setText(""); setAuthor("");
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{
        background: C.buoy, color: "#fff", border: "none", borderRadius: 8,
        padding: "11px 20px", fontWeight: 700, fontSize: 14.5, cursor: "pointer", marginBottom: 20,
      }}>✎ Write a review</button>
    );
  }
  return (
    <div style={{ background: C.card, border: `1.5px solid ${C.buoy}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 19, fontWeight: 600, marginBottom: 12, color: C.ink }}>Share your experience</div>
      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 13.5, color: C.inkSoft }}>Your rating:</span>
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} onClick={() => setRating(n)} style={{
            width: 26, height: 26, borderRadius: "50%", cursor: "pointer",
            border: `4px solid ${n <= rating ? C.buoy : C.buoyDim}`, background: "transparent",
          }} aria-label={`${n} of 5`} />
        ))}
      </div>
      <input value={author} onChange={e => setAuthor(e.target.value)} placeholder="Your name (optional)" style={inputStyle} />
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Review title" style={inputStyle} />
      <textarea value={text} onChange={e => setText(e.target.value)} rows={4}
        placeholder="Tell other travellers what you genuinely experienced — the good and the bad."
        style={{ ...inputStyle, resize: "vertical" }} />
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {["Couple", "Family", "Friends", "Solo", "Business"].map(t => (
          <button key={t} onClick={() => setTripType(t)} style={{
            padding: "5px 12px", borderRadius: 99, fontSize: 12.5, cursor: "pointer",
            border: `1px solid ${tripType === t ? C.ink : C.line}`,
            background: tripType === t ? C.ink : "transparent",
            color: tripType === t ? C.paper : C.inkSoft,
          }}>{t}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={submit} style={{ background: C.ink, color: C.paper, border: "none", borderRadius: 8, padding: "10px 18px", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>
          Publish review
        </button>
        <button onClick={() => setOpen(false)} style={{ background: "transparent", color: C.inkSoft, border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 18px", fontSize: 14, cursor: "pointer" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ----------------------- detail page ----------------------- */

function DetailPage({ listing, onBack }) {
  const [reviews, setReviews] = useState(REVIEWS_BY_LISTING[listing.id] || []);
  const [sort, setSort] = useState("recent");
  const [filter, setFilter] = useState(0);

  useEffect(() => {
    setReviews(REVIEWS_BY_LISTING[listing.id] || []);
    setSort("recent"); setFilter(0);
  }, [listing.id]);

  const visible = useMemo(() => {
    let r = [...reviews];
    if (filter) r = r.filter(x => x.rating === filter);
    if (sort === "high") r.sort((a, b) => b.rating - a.rating);
    if (sort === "low") r.sort((a, b) => a.rating - b.rating);
    if (sort === "helpful") r.sort((a, b) => b.helpful - a.helpful);
    return r;
  }, [reviews, sort, filter]);

  const dist = [5, 4, 3, 2, 1].map(n => ({ n, count: reviews.filter(r => r.rating === n).length }));
  const maxCount = Math.max(...dist.map(d => d.count), 1);

  return (
    <div>
      <button onClick={onBack} style={{ background: "none", border: "none", color: C.buoy, fontWeight: 600, fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 14 }}>
        ← Back to explore
      </button>

      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden", marginBottom: 24 }}>
        <HeroArt gradient={listing.gradient} icon={listing.icon} big />
        <div style={{ padding: "22px 24px" }}>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: "0.14em", color: C.inkSoft, textTransform: "uppercase", marginBottom: 6 }}>
            {listing.type} · {listing.rank}
          </div>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 34, fontWeight: 700, margin: "0 0 6px", color: C.ink, lineHeight: 1.1 }}>
            {listing.name}
          </h1>
          <div style={{ fontSize: 14.5, color: C.inkSoft, marginBottom: 12 }}>📍 {listing.place} · {listing.price}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <span style={{ fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 700, color: C.ink }}>{listing.rating.toFixed(1)}</span>
            <Buoys value={listing.rating} size={16} />
            <span style={{ fontSize: 14, color: C.inkSoft }}>{listing.reviewCount} traveller reviews</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            {listing.tags.map(t => <Tag key={t}>{t}</Tag>)}
          </div>
          <p style={{ fontSize: 15, lineHeight: 1.7, color: C.inkSoft, margin: 0, maxWidth: 720 }}>{listing.about}</p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20, marginBottom: 28 }}>
        <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontFamily: "'Fraunces', serif", fontSize: 19, fontWeight: 600, marginBottom: 14, color: C.ink }}>Rating breakdown</div>
          {Object.entries(listing.subRatings).map(([k, v]) => <RatingBar key={k} label={k} value={v} />)}
        </div>
        <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontFamily: "'Fraunces', serif", fontSize: 19, fontWeight: 600, marginBottom: 14, color: C.ink }}>Amenities</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 14px" }}>
            {listing.amenities.map(a => <div key={a} style={{ fontSize: 13.5, color: C.inkSoft }}>· {a}</div>)}
          </div>
        </div>
      </div>

      <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 700, color: C.ink, margin: "0 0 6px" }}>
        Traveller reviews
      </h2>
      <p style={{ fontSize: 13.5, color: C.inkSoft, margin: "0 0 18px" }}>
        Written by real guests in their own words. Reviews on this page are demo samples; we never let businesses edit or remove them.
      </p>

      <AiSummary listing={listing} reviews={reviews} />

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 20 }}>
        <div style={{ minWidth: 220, flex: "0 0 auto" }}>
          {dist.map(d => (
            <button key={d.n} onClick={() => setFilter(filter === d.n ? 0 : d.n)} style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%", marginBottom: 6,
              background: filter === d.n ? C.sea : "transparent", border: "none",
              borderRadius: 6, padding: "4px 6px", cursor: "pointer",
            }}>
              <span style={{ fontSize: 12.5, color: C.inkSoft, width: 12 }}>{d.n}</span>
              <div style={{ flex: 1, height: 7, background: C.sea, borderRadius: 99, overflow: "hidden" }}>
                <div style={{ width: `${(d.count / maxCount) * 100}%`, height: "100%", background: C.buoy, borderRadius: 99 }} />
              </div>
              <span style={{ fontSize: 12, color: C.inkSoft, width: 16, textAlign: "right" }}>{d.count}</span>
            </button>
          ))}
          {filter !== 0 && <div style={{ fontSize: 11.5, color: C.buoy, fontFamily: "'IBM Plex Mono', monospace" }}>filtering: {filter}-ring reviews · click again to clear</div>}
        </div>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            {[["recent", "Most recent"], ["helpful", "Most helpful"], ["high", "Highest"], ["low", "Lowest"]].map(([k, lbl]) => (
              <button key={k} onClick={() => setSort(k)} style={{
                padding: "6px 13px", borderRadius: 99, fontSize: 13, cursor: "pointer",
                border: `1px solid ${sort === k ? C.ink : C.line}`,
                background: sort === k ? C.ink : C.card,
                color: sort === k ? C.paper : C.inkSoft, fontWeight: sort === k ? 600 : 400,
              }}>{lbl}</button>
            ))}
          </div>
          <WriteReview onSubmit={r => setReviews(prev => [r, ...prev])} />
          {visible.map(r => <ReviewCard key={r.id} r={r} />)}
          {visible.length === 0 && (
            <div style={{ padding: 28, textAlign: "center", color: C.inkSoft, fontSize: 14, background: C.card, border: `1px dashed ${C.line}`, borderRadius: 12 }}>
              No reviews match this filter yet. Clear the filter or be the first to write one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------- explore page ----------------------- */

function ListingCard({ l, onOpen }) {
  return (
    <div onClick={onOpen} style={{
      background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden",
      cursor: "pointer", transition: "transform .15s ease, box-shadow .15s ease",
    }}
      onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-3px)"; e.currentTarget.style.boxShadow = "0 10px 26px rgba(18,43,51,0.12)"; }}
      onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}>
      <HeroArt gradient={l.gradient} icon={l.icon} />
      <div style={{ padding: 16 }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, letterSpacing: "0.12em", color: C.inkSoft, textTransform: "uppercase", marginBottom: 5 }}>
          {l.type} · {l.place.split(",").slice(-1)[0].trim()}
        </div>
        <div style={{ fontFamily: "'Fraunces', serif", fontSize: 19, fontWeight: 600, color: C.ink, marginBottom: 3 }}>{l.name}</div>
        <div style={{ fontSize: 12.5, color: C.inkSoft, marginBottom: 10 }}>{l.place}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Buoys value={l.rating} size={12} />
          <span style={{ fontWeight: 700, fontSize: 13.5, color: C.ink }}>{l.rating.toFixed(1)}</span>
          <span style={{ fontSize: 12.5, color: C.inkSoft }}>({l.reviewCount})</span>
        </div>
        <div style={{ fontSize: 12.5, color: C.inkSoft }}>{l.price}</div>
      </div>
    </div>
  );
}

function ExplorePage({ onOpen }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("All");
  const cats = ["All", "Hotel", "Restaurant", "Things to do"];
  const list = LISTINGS.filter(l =>
    (cat === "All" || l.type === cat) &&
    (l.name + l.place + l.tags.join(" ")).toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div>
      <div style={{ textAlign: "center", padding: "38px 16px 30px" }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, letterSpacing: "0.22em", color: C.buoy, textTransform: "uppercase", marginBottom: 12 }}>
          Reviews by humans · summarised by AI
        </div>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: "clamp(30px, 5vw, 46px)", fontWeight: 700, color: C.ink, margin: "0 0 10px", lineHeight: 1.08 }}>
          Where will the tide<br />take you next?
        </h1>
        <p style={{ fontSize: 15.5, color: C.inkSoft, maxWidth: 520, margin: "0 auto 24px", lineHeight: 1.6 }}>
          Honest, verified reviews of hotels, restaurants and experiences — with an AI summary so you get the gist in ten seconds and the truth in the details.
        </p>
        <div style={{ maxWidth: 540, margin: "0 auto", display: "flex", border: `1.5px solid ${C.ink}`, borderRadius: 99, overflow: "hidden", background: C.card }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder='Search places — try "Støtvig", "onsen", "London"…'
            style={{ flex: 1, border: "none", outline: "none", padding: "13px 20px", fontSize: 15, fontFamily: "'Archivo', sans-serif", background: "transparent", color: C.ink }} />
          <div style={{ padding: "13px 20px", background: C.ink, color: C.paper, fontWeight: 600, fontSize: 14.5 }}>Search</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 26, flexWrap: "wrap" }}>
        {cats.map(c2 => (
          <button key={c2} onClick={() => setCat(c2)} style={{
            padding: "7px 16px", borderRadius: 99, fontSize: 13.5, cursor: "pointer",
            border: `1px solid ${cat === c2 ? C.ink : C.line}`,
            background: cat === c2 ? C.ink : C.card,
            color: cat === c2 ? C.paper : C.inkSoft, fontWeight: cat === c2 ? 600 : 400,
          }}>{c2}</button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 18 }}>
        {list.map(l => <ListingCard key={l.id} l={l} onOpen={() => onOpen(l)} />)}
      </div>
      {list.length === 0 && (
        <div style={{ textAlign: "center", color: C.inkSoft, padding: 40, fontSize: 14.5 }}>
          Nothing found for "{q}". Try a different name or clear the category filter.
        </div>
      )}
    </div>
  );
}

/* ----------------------- app shell ----------------------- */

export default function App() {
  const [page, setPage] = useState({ name: "explore" });

  useEffect(() => { window.scrollTo(0, 0); }, [page]);

  return (
    <div style={{ minHeight: "100vh", background: C.paper, fontFamily: "'Archivo', sans-serif", color: C.ink }}>
      <header style={{
        position: "sticky", top: 0, zIndex: 10, background: "rgba(247,249,248,0.92)",
        backdropFilter: "blur(8px)", borderBottom: `1px solid ${C.line}`,
      }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button onClick={() => setPage({ name: "explore" })} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, padding: 0 }}>
            <span style={{ width: 26, height: 26, borderRadius: "50%", border: `6px solid ${C.buoy}`, display: "inline-block", boxSizing: "border-box" }} />
            <span style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700, color: C.ink, letterSpacing: "-0.01em" }}>Waypoint</span>
          </button>
          <nav style={{ display: "flex", gap: 18, alignItems: "center" }}>
            <span style={{ fontSize: 13.5, color: C.inkSoft }}>Explore</span>
            <span style={{ fontSize: 13.5, color: C.inkSoft }}>Trips</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.paper, background: C.ink, padding: "7px 14px", borderRadius: 99 }}>Sign in</span>
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "20px 20px 60px" }}>
        {page.name === "explore" && <ExplorePage onOpen={l => setPage({ name: "detail", listing: l })} />}
        {page.name === "detail" && <DetailPage listing={page.listing} onBack={() => setPage({ name: "explore" })} />}
      </main>

      <footer style={{ borderTop: `1px solid ${C.line}`, padding: "22px 20px", textAlign: "center" }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.inkSoft, letterSpacing: "0.08em" }}>
          WAYPOINT · demo prototype · listings & reviews are illustrative samples · AI summaries generated by Claude
        </div>
      </footer>
    </div>
  );
}
