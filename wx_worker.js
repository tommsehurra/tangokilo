/* wx_worker.js — Tango Kilo · Flight Weather · Proxy
   Laeuft als Worker vor den statischen Dateien, aber NUR fuer /api/* (siehe
   wrangler.toml: run_worker_first). Alle anderen Anfragen gehen unveraendert an
   die statischen Dateien (env.ASSETS).

   Grundsaetze
   - Keine Logs (keinerlei Konsolenausgabe), keine Speicherung von Standorten.
   - Edge-Cache nur mit vergroeberten Schluesseln (Raster), nie exakte Positionen.
   - Keys nur hier (Secret WINDY_KEY im Cloudflare-Dashboard), nie im Client.
   - Nur gleiche Herkunft: Anfragen brauchen den Header X-TK-WX: 1. Ohne CORS-
     Freigabe koennen fremde Websites den Proxy nicht aus dem Browser nutzen.

   Routen (GET): health · geocode · reverse · resolve · metar · taf · webcams ·
                 metno · warnings · kp                                           */

const UA = "TangoKiloFlightWeather/1.0 (+https://www.tangokilo.de/weather.html)";
const TTL = { geocode: 604800, reverse: 604800, metar: 300, taf: 600, webcams: 120, metno: 1800, warnings: 600, kp: 900 };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/wx/")) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    }
    if (request.method !== "GET") return json({ error: "method" }, 405);
    if (request.headers.get("X-TK-WX") !== "1") return json({ error: "forbidden" }, 403);
    const route = url.pathname.slice("/api/wx/".length).replace(/\/+$/, "");
    const q = url.searchParams;
    try {
      switch (route) {
        case "health":   return json({ ok: true, webcams: !!env.WINDY_KEY, v: 1 }, 200, 0);
        case "geocode":  return await geocode(q, ctx);
        case "reverse":  return await reverse(q, ctx);
        case "resolve":  return await resolve(q);
        case "metar":    return await metar(q, ctx);
        case "taf":      return await taf(q, ctx);
        case "webcams":  return await webcams(q, env, ctx);
        case "metno":    return await metno(q, ctx);
        case "warnings": return await warnings(q, ctx);
        case "kp":       return await kp(ctx);
        default:         return json({ error: "not_found" }, 404);
      }
    } catch (e) {
      return json({ error: e && e.code ? e.code : "upstream" }, e && e.status ? e.status : 502);
    }
  }
};

/* ── Helfer ─────────────────────────────────────────────────────────── */
function json(obj, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": maxAge ? `public, max-age=${Math.min(maxAge, 300)}` : "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    }
  });
}
function fail(code, status = 400) { const e = new Error(code); e.code = code; e.status = status; return e; }
function num(v, lo, hi) {
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw fail("bad_param");
  return n;
}
function snap(v, step) { return Math.round(v / step) * step; }
function fix(v, d) { return Number(v.toFixed(d)); }

// Edge-Cache mit kuenstlichem Schluessel (enthaelt nur gerasterte Werte)
async function cached(key, ttl, ctx, producer, bypass) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const req = new Request("https://wx-cache.tangokilo.internal/" + key);
  if (cache && !bypass) {
    const hit = await cache.match(req);
    if (hit) return hit;
  }
  const data = await producer();
  const res = new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, s-maxage=${ttl}, max-age=${ttl}` }
  });
  if (cache && ttl > 0) ctx.waitUntil(cache.put(req, res.clone()));
  return withClientHeaders(res, ttl);
}
function withClientHeaders(res, ttl) {
  const h = new Headers(res.headers);
  h.set("Cache-Control", ttl ? `public, max-age=${Math.min(ttl, 300)}` : "no-store");
  h.set("X-Content-Type-Options", "nosniff");
  return new Response(res.body, { status: res.status, headers: h });
}
async function upstream(u, opts = {}) {
  const r = await fetch(u, {
    headers: Object.assign({ "User-Agent": UA, "Accept": "application/json" }, opts.headers || {}),
    redirect: opts.redirect || "follow",
    cf: { cacheTtl: 0 }
  });
  if (r.status === 204) return null;
  if (!r.ok) throw fail("upstream_" + r.status, r.status === 429 ? 429 : 502);
  return opts.text ? r.text() : r.json();
}

/* ── Geocoding (Nominatim) ──────────────────────────────────────────── */
async function geocode(q, ctx) {
  const text = (q.get("q") || "").trim().slice(0, 200);
  if (text.length < 2) throw fail("bad_param");
  const lang = /^[a-z]{2}$/.test(q.get("lang") || "") ? q.get("lang") : "en";
  const key = "geocode/" + lang + "/" + encodeURIComponent(text.toLowerCase());
  return cached(key, TTL.geocode, ctx, async () => {
    const u = "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&q=" + encodeURIComponent(text) + "&accept-language=" + lang;
    const r = (await upstream(u)) || [];
    return { results: r.map(x => ({
      name: x.name || (x.display_name || "").split(",")[0], display: x.display_name, lat: +x.lat, lon: +x.lon,
      type: x.type, cls: x.category || x.class, cc: x.address && x.address.country_code,
      country: x.address && x.address.country, region: x.address && (x.address.state || x.address.region || x.address.county)
    })) };
  });
}
// Reverse-Geocoding: auf ~1 km gerastert (2 Nachkommastellen) — reicht fuer Ortsnamen
async function reverse(q, ctx) {
  const lat = fix(snap(num(q.get("lat"), -90, 90), 0.01), 2), lon = fix(snap(num(q.get("lon"), -180, 180), 0.01), 2);
  const lang = /^[a-z]{2}$/.test(q.get("lang") || "") ? q.get("lang") : "en";
  return cached(`reverse/${lang}/${lat}/${lon}`, TTL.reverse, ctx, async () => {
    const u = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=14&lat=${lat}&lon=${lon}&accept-language=${lang}`;
    const r = await upstream(u);
    if (!r || r.error) return { name: null };
    const a = r.address || {};
    return {
      name: a.village || a.town || a.city || a.hamlet || a.suburb || a.municipality || r.name || null,
      municipality: a.municipality || a.city || a.town || a.village || null,
      county: a.county || a.state_district || null, state: a.state || a.region || null,
      country: a.country || null, cc: a.country_code || null, display: r.display_name || null
    };
  });
}

/* ── Google-Kurzlinks aufloesen (nicht gecacht) ─────────────────────── */
const SHORT_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl|g\.co)$/i;
const GOOGLE_HOSTS = /(^|\.)google\.[a-z.]{2,7}$/i;
async function resolve(q) {
  let target;
  try { target = new URL(q.get("url") || ""); } catch (e) { throw fail("bad_param"); }
  if (!SHORT_HOSTS.test(target.hostname)) throw fail("host_not_allowed");
  let cur = target.href;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(cur, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (compatible; " + UA + ")" } });
    const loc = r.headers.get("Location");
    if (r.status >= 300 && r.status < 400 && loc) {
      const next = new URL(loc, cur);
      if (/^consent\.google\./i.test(next.hostname) && next.searchParams.get("continue")) {
        return json({ url: next.searchParams.get("continue") });
      }
      if (!SHORT_HOSTS.test(next.hostname) && !GOOGLE_HOSTS.test(next.hostname)) return json({ url: next.href });
      if (GOOGLE_HOSTS.test(next.hostname) && /\/maps|[?&](q|ll|query)=/.test(next.pathname + next.search)) return json({ url: next.href });
      cur = next.href; continue;
    }
    if (r.ok) {
      // Manche Antworten liefern die Ziel-URL nur im HTML (meta/canonical)
      const html = (await r.text()).slice(0, 200000);
      const m = html.match(/https:\/\/(?:www\.)?google\.[a-z.]+\/maps[^"'\s<>]+/i);
      return json({ url: m ? m[0].replace(/&amp;/g, "&").replace(/\\u0026/g, "&") : cur });
    }
    throw fail("resolve_failed");
  }
  throw fail("too_many_redirects");
}

/* ── METAR / TAF (aviationweather.gov Data API) ─────────────────────── */
// Abfrage ueber ein 1°-Raster: Schluessel = Rasterzelle, Box ±1.5° um die Zellmitte
async function metar(q, ctx) {
  const ids = (q.get("ids") || "").toUpperCase();
  if (ids) {
    if (!/^[A-Z0-9]{3,4}(,[A-Z0-9]{3,4}){0,19}$/.test(ids)) throw fail("bad_param");
    return cached("metar/ids/" + ids, TTL.metar, ctx, async () => ({
      metars: (await upstream(`https://aviationweather.gov/api/data/metar?ids=${ids}&format=json`)) || []
    }));
  }
  const la = snap(num(q.get("lat"), -90, 90), 1), lo = snap(num(q.get("lon"), -180, 180), 1);
  return cached(`metar/cell/${la}/${lo}`, TTL.metar, ctx, async () => {
    const boxes = [];
    const s = Math.max(-90, la - 1.5), n = Math.min(90, la + 1.5);
    let w = lo - 1.5, e = lo + 1.5;
    if (w < -180) { boxes.push([s, w + 360, n, 180]); w = -180; }
    if (e > 180) { boxes.push([s, -180, n, e - 360]); e = 180; }
    boxes.push([s, w, n, e]);
    let all = [];
    for (const b of boxes) {
      const r = await upstream(`https://aviationweather.gov/api/data/metar?bbox=${b.join(",")}&format=json&hours=2`);
      if (Array.isArray(r)) all = all.concat(r);
    }
    // je Station nur die juengste Meldung
    const latest = {};
    all.forEach(m => { if (m && m.icaoId && (!latest[m.icaoId] || (m.obsTime || 0) > (latest[m.icaoId].obsTime || 0))) latest[m.icaoId] = m; });
    return { metars: Object.values(latest) };
  });
}
async function taf(q, ctx) {
  const ids = (q.get("ids") || "").toUpperCase();
  if (!/^[A-Z0-9]{3,4}(,[A-Z0-9]{3,4}){0,4}$/.test(ids)) throw fail("bad_param");
  return cached("taf/" + ids, TTL.taf, ctx, async () => {
    const r = (await upstream(`https://aviationweather.gov/api/data/taf?ids=${ids}&format=json`)) || [];
    return { tafs: r.map(t => ({ icao: t.icaoId, raw: t.rawTAF || t.rawOb || "", issue: t.issueTime || null })) };
  });
}

/* ── Webcams (Windy Webcams API v3) ─────────────────────────────────── */
// Bild-URLs enthalten Tokens mit ~10 min Gueltigkeit → nur 2 min cachen;
// fresh=1 umgeht den Cache (Client meldet abgelaufene Bilder).
async function webcams(q, env, ctx) {
  if (!env.WINDY_KEY) return json({ error: "no_key" }, 503);
  const la = fix(snap(num(q.get("lat"), -90, 90), 0.05), 2), lo = fix(snap(num(q.get("lon"), -180, 180), 0.05), 2);
  const lang = /^[a-z]{2}$/.test(q.get("lang") || "") ? q.get("lang") : "en";
  const bypass = q.get("fresh") === "1";
  return cached(`webcams/${lang}/${la}/${lo}`, TTL.webcams, ctx, async () => {
    let list = [], radius = 0;
    for (const r of [10, 25, 50, 100]) {          // +5 km Rasterpuffer
      radius = r;
      const u = `https://api.windy.com/webcams/api/v3/webcams?nearby=${la},${lo},${r + 5}&limit=40&lang=${lang}&include=images,location,player,urls,categories`;
      const res = await fetch(u, { headers: { "x-windy-api-key": env.WINDY_KEY, "User-Agent": UA } });
      if (res.status === 401 || res.status === 403) throw fail("webcams_auth", 502);
      if (!res.ok) throw fail("upstream_" + res.status, 502);
      const j = await res.json();
      list = j.webcams || [];
      if (list.length >= 6) break;
    }
    return {
      radius, fetched: Math.floor(Date.now() / 1000),
      webcams: list.map(w => ({
        id: w.webcamId, title: w.title, status: w.status,
        updated: w.lastUpdatedOn || null,
        lat: w.location && w.location.latitude, lon: w.location && w.location.longitude,
        city: w.location && w.location.city, region: w.location && w.location.region, country: w.location && w.location.country,
        preview: w.images && w.images.current && (w.images.current.preview || w.images.current.thumbnail) || null,
        thumb: w.images && w.images.current && (w.images.current.thumbnail || w.images.current.preview) || null,
        player: w.player && (w.player.day || w.player.lifetime || w.player.month) || null,
        detail: w.urls && w.urls.detail || null,
        cats: (w.categories || []).map(c => c.name || c.id).slice(0, 3)
      }))
    };
  }, bypass);
}

/* ── MET Norway Locationforecast (zweite unabhaengige Vorhersage) ───── */
async function metno(q, ctx) {
  const la = fix(snap(num(q.get("lat"), -90, 90), 0.01), 2), lo = fix(snap(num(q.get("lon"), -180, 180), 0.01), 2);
  return cached(`metno/${la}/${lo}`, TTL.metno, ctx, async () => {
    const r = await upstream(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${la}&lon=${lo}`);
    const ts = (r && r.properties && r.properties.timeseries) || [];
    return {
      updated: r && r.properties && r.properties.meta && r.properties.meta.updated_at || null,
      series: ts.slice(0, 60).map(s => {
        const d = (s.data && s.data.instant && s.data.instant.details) || {};
        const n1 = s.data && s.data.next_1_hours && s.data.next_1_hours.details || {};
        return { t: Math.floor(Date.parse(s.time) / 1000), temp: d.air_temperature ?? null, w10: d.wind_speed ?? null,
          d10: d.wind_from_direction ?? null, gust: d.wind_speed_of_gust ?? null, precip: n1.precipitation_amount ?? null,
          cloud: d.cloud_area_fraction ?? null, fog: d.fog_area_fraction ?? null };
      })
    };
  });
}

/* ── Amtliche Warnungen: MeteoAlarm (Europa, je Land) / NWS (USA) ────── */
const METEOALARM = {
  at: "austria", be: "belgium", ba: "bosnia-herzegovina", bg: "bulgaria", hr: "croatia", cy: "cyprus", cz: "czechia",
  dk: "denmark", ee: "estonia", fi: "finland", fr: "france", de: "germany", gr: "greece", hu: "hungary", is: "iceland",
  ie: "ireland", il: "israel", it: "italy", lv: "latvia", lt: "lithuania", lu: "luxembourg", mt: "malta", md: "moldova",
  me: "montenegro", nl: "netherlands", mk: "republic-of-north-macedonia", no: "norway", pl: "poland", pt: "portugal",
  ro: "romania", rs: "serbia", sk: "slovakia", si: "slovenia", es: "spain", se: "sweden", ch: "switzerland",
  ua: "ukraine", gb: "united-kingdom"
};
async function warnings(q, ctx) {
  const cc = (q.get("cc") || "").toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) throw fail("bad_param");
  if (cc === "us" || cc === "pr" || cc === "gu" || cc === "vi") {
    const la = fix(snap(num(q.get("lat"), -90, 90), 0.01), 2), lo = fix(snap(num(q.get("lon"), -180, 180), 0.01), 2);
    return cached(`warn/us/${la}/${lo}`, TTL.warnings, ctx, async () => {
      const r = await upstream(`https://api.weather.gov/alerts/active?point=${la},${lo}`, { headers: { "Accept": "application/geo+json" } });
      return { source: "nws", items: ((r && r.features) || []).map(f => {
        const p = f.properties || {};
        return { event: p.event, severity: p.severity, headline: p.headline, desc: (p.description || "").slice(0, 1500),
          onset: p.onset || p.effective, expires: p.ends || p.expires, area: p.areaDesc, matched: true };
      }) };
    });
  }
  const slug = METEOALARM[cc];
  if (!slug) return json({ source: "none", items: [] }, 200, 600);
  return cached(`warn/ma/${slug}`, TTL.warnings, ctx, async () => {
    const r = await upstream(`https://feeds.meteoalarm.org/api/v1/warnings/feeds-${slug}`);
    const items = [];
    ((r && r.warnings) || []).forEach(w => {
      const infos = (w.alert && w.alert.info) || [];
      const info = infos.find(i => /^en/i.test(i.language || "")) || infos[0];
      if (!info) return;
      const areas = (info.area || []).map(a => a.areaDesc).filter(Boolean);
      let level = null;
      (info.parameter || []).forEach(p => { if (/awareness_level/i.test(p.valueName || "")) level = p.value; });
      items.push({ event: info.event, severity: info.severity, headline: info.headline, desc: (info.description || "").slice(0, 1500),
        onset: info.onset || info.effective, expires: info.expires, areas: areas.slice(0, 60), level, lang: info.language || "" });
    });
    return { source: "meteoalarm", country: slug, items: items.slice(0, 400) };
  });
}

/* ── Kp-Index (NOAA SWPC) ───────────────────────────────────────────── */
async function kp(ctx) {
  return cached("kp/v1", TTL.kp, ctx, async () => {
    const [obs, fc] = await Promise.all([
      upstream("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json").catch(() => null),
      upstream("https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json").catch(() => null)
    ]);
    if (!obs && !fc) throw fail("upstream_kp", 502);
    return { observed: obs, forecast: fc };
  });
}
