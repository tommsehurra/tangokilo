/* wx_core.js — Tango Kilo · Flight Weather
   Reine Funktionen ohne DOM: Standort-Parser, Open Location Code, Einheiten,
   Formeln, Sonne/Mond, Flugprofile + Score, Normalisierung der API-Antworten.
   Laeuft im Browser (window.WX) und in Node (module.exports) — gleiche Logik,
   gleiche Ergebnisse (Website, Tests, spaeter Discord-Bot).

   Grundsaetze:
   - Intern IMMER SI: m/s, °C, m, hPa, mm. Umrechnung nur bei der Anzeige (conv).
   - Unbekannt = null. Nie 0 erfinden.
   - Keine Koordinaten in dieser Datei (REGEL NR.1).

   Open Location Code: eigene Implementierung nach der offiziellen
   Spezifikation (github.com/google/open-location-code, Apache-2.0). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WX = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERSION = "1.0.0";
  var RAD = Math.PI / 180, DEG = 180 / Math.PI;

  /* ───────────── Helfer ───────────── */
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function num(x) { return isNum(x) ? x : null; }
  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function round(x, d) { if (!isNum(x)) return null; var f = Math.pow(10, d || 0); return Math.round(x * f) / f; }
  function normLon(lon) {
    if (!isNum(lon)) return null;
    if (lon >= -180 && lon <= 180) return lon;
    var r = ((lon + 180) % 360 + 360) % 360 - 180;
    return r;
  }

  /* ───────────── Geo ───────────── */
  function distance(lat1, lon1, lat2, lon2) {          // Meter, Haversine
    var R = 6371008.8, p1 = lat1 * RAD, p2 = lat2 * RAD;
    var dp = (lat2 - lat1) * RAD, dl = (lon2 - lon1) * RAD;
    var a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function bearing(lat1, lon1, lat2, lon2) {           // Grad 0..360 von 1 nach 2
    var p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) * DEG + 360) % 360;
  }
  function compassIndex(deg) { return isNum(deg) ? Math.round(((deg % 360) + 360) % 360 / 22.5) % 16 : null; }
  var COMPASS = {
    en: ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"],
    de: ["N","NNO","NO","ONO","O","OSO","SO","SSO","S","SSW","SW","WSW","W","WNW","NW","NNW"]
  };
  function compass(deg, lang) { var i = compassIndex(deg); return i === null ? null : (COMPASS[lang] || COMPASS.en)[i]; }

  /* ───────────── Open Location Code ───────────── */
  var OLC = (function () {
    var A = "23456789CFGHJMPQRVWX", SEP = "+", SEP_POS = 8, PAD = "0";
    var BASE = 20, LAT_MAX = 90, LNG_MAX = 180, MAX_DIGITS = 15, PAIR_LEN = 10;
    var PAIR_FIRST_PV = Math.pow(BASE, 4);       // 160000
    var PAIR_PREC = Math.pow(BASE, 3);           // 8000
    var ROWS = 5, COLS = 4, GRID_LEN = MAX_DIGITS - PAIR_LEN;
    var GRID_ROW_FIRST_PV = Math.pow(ROWS, GRID_LEN - 1), GRID_COL_FIRST_PV = Math.pow(COLS, GRID_LEN - 1);
    var FINAL_LAT_PREC = PAIR_PREC * Math.pow(ROWS, GRID_LEN);
    var FINAL_LNG_PREC = PAIR_PREC * Math.pow(COLS, GRID_LEN);

    function isValid(code) {
      if (typeof code !== "string" || !code) return false;
      code = code.toUpperCase();
      if (code.indexOf(SEP) === -1 || code.indexOf(SEP) !== code.lastIndexOf(SEP)) return false;
      var sp = code.indexOf(SEP);
      if (sp > SEP_POS || sp % 2 === 1) return false;
      if (code.length === 1) return false;
      var pi = code.indexOf(PAD);
      if (pi > -1) {
        if (sp < SEP_POS) return false;
        if (pi === 0) return false;
        var pads = code.match(/0+/g);
        if (pads.length > 1 || pads[0].length % 2 === 1 || pads[0].length > SEP_POS - 2) return false;
        if (code.charAt(code.length - 1) !== SEP) return false;
      }
      if (code.length - sp - 1 === 1) return false;
      var c = code.replace(SEP, "").replace(/0+/g, "");
      for (var i = 0; i < c.length; i++) if (A.indexOf(c.charAt(i)) === -1) return false;
      return true;
    }
    function isShort(code) { return isValid(code) && code.indexOf(SEP) >= 0 && code.indexOf(SEP) < SEP_POS; }
    function isFull(code) {
      if (!isValid(code) || isShort(code)) return false;
      code = code.toUpperCase();
      if (A.indexOf(code.charAt(0)) * BASE >= LAT_MAX * 2) return false;
      if (code.length > 1 && A.indexOf(code.charAt(1)) * BASE >= LNG_MAX * 2) return false;
      return true;
    }
    function latPrecision(len) {
      if (len <= PAIR_LEN) return Math.pow(BASE, Math.floor(len / -2 + 2));
      return Math.pow(BASE, -3) / Math.pow(ROWS, len - PAIR_LEN);
    }
    function encode(lat, lng, len) {
      if (len === undefined) len = PAIR_LEN;
      if (len < 2 || (len < PAIR_LEN && len % 2 === 1)) throw new Error("invalid length");
      len = Math.min(len, MAX_DIGITS);
      lat = clamp(lat, -LAT_MAX, LAT_MAX);
      lng = normLon(lng); if (lng === 180) lng = -180;
      if (lat === LAT_MAX) lat = lat - latPrecision(len);
      var latVal = Math.floor(Math.round((lat + LAT_MAX) * FINAL_LAT_PREC * 1e6) / 1e6);
      var lngVal = Math.floor(Math.round((lng + LNG_MAX) * FINAL_LNG_PREC * 1e6) / 1e6);
      var code = "", i;
      if (len > PAIR_LEN) {
        for (i = 0; i < GRID_LEN; i++) {
          var ld = latVal % ROWS, gd = lngVal % COLS;
          code = A.charAt(ld * COLS + gd) + code;
          latVal = Math.floor(latVal / ROWS); lngVal = Math.floor(lngVal / COLS);
        }
      } else {
        latVal = Math.floor(latVal / Math.pow(ROWS, GRID_LEN));
        lngVal = Math.floor(lngVal / Math.pow(COLS, GRID_LEN));
      }
      for (i = 0; i < PAIR_LEN / 2; i++) {
        code = A.charAt(lngVal % BASE) + code; code = A.charAt(latVal % BASE) + code;
        latVal = Math.floor(latVal / BASE); lngVal = Math.floor(lngVal / BASE);
      }
      code = code.substr(0, SEP_POS) + SEP + code.substr(SEP_POS);
      if (len >= SEP_POS) return code.substr(0, len + 1);
      return code.substr(0, len) + new Array(SEP_POS - len + 1).join(PAD) + SEP;
    }
    function decode(code) {
      if (!isFull(code)) throw new Error("not a full code");
      code = code.toUpperCase().replace(SEP, "").replace(/0+/g, "").substr(0, MAX_DIGITS);
      var nLat = -LAT_MAX * PAIR_PREC, nLng = -LNG_MAX * PAIR_PREC, gLat = 0, gLng = 0;
      var digits = Math.min(code.length, PAIR_LEN), pv = PAIR_FIRST_PV, i;
      for (i = 0; i < digits; i += 2) {
        nLat += A.indexOf(code.charAt(i)) * pv;
        nLng += A.indexOf(code.charAt(i + 1)) * pv;
        if (i < digits - 2) pv /= BASE;
      }
      var latP = pv / PAIR_PREC, lngP = pv / PAIR_PREC;
      if (code.length > PAIR_LEN) {
        var rpv = GRID_ROW_FIRST_PV, cpv = GRID_COL_FIRST_PV;
        digits = Math.min(code.length, MAX_DIGITS);
        for (i = PAIR_LEN; i < digits; i++) {
          var d = A.indexOf(code.charAt(i));
          gLat += Math.floor(d / COLS) * rpv; gLng += (d % COLS) * cpv;
          if (i < digits - 1) { rpv /= ROWS; cpv /= COLS; }
        }
        latP = rpv / FINAL_LAT_PREC; lngP = cpv / FINAL_LNG_PREC;
      }
      var lat = nLat / PAIR_PREC + gLat / FINAL_LAT_PREC;
      var lng = nLng / PAIR_PREC + gLng / FINAL_LNG_PREC;
      return {
        latLo: lat, lngLo: lng, latHi: lat + latP, lngHi: lng + lngP, codeLength: code.length,
        latCenter: Math.min(lat + latP / 2, LAT_MAX), lngCenter: Math.min(lng + lngP / 2, LNG_MAX)
      };
    }
    function recoverNearest(shortCode, refLat, refLng) {
      if (!isShort(shortCode)) {
        if (isFull(shortCode)) return shortCode.toUpperCase();
        throw new Error("invalid code");
      }
      refLat = clamp(refLat, -LAT_MAX, LAT_MAX); refLng = normLon(refLng);
      shortCode = shortCode.toUpperCase();
      var padLen = SEP_POS - shortCode.indexOf(SEP);
      var res = Math.pow(BASE, 2 - padLen / 2), half = res / 2;
      var cd = decode(encode(refLat, refLng).substr(0, padLen) + shortCode);
      var la = cd.latCenter, lo = cd.lngCenter;
      if (refLat + half < la && la - res >= -LAT_MAX) la -= res;
      else if (refLat - half > la && la + res <= LAT_MAX) la += res;
      if (refLng + half < lo) lo -= res; else if (refLng - half > lo) lo += res;
      return encode(la, lo, cd.codeLength);
    }
    return { isValid: isValid, isShort: isShort, isFull: isFull, encode: encode, decode: decode, recoverNearest: recoverNearest };
  })();

  /* ───────────── Standort-Parser ─────────────
     parseInput(text) →
       {ok:true, kind:"coords", lat, lon, source, swapped?, nullIsland?, label?}
       {ok:true, kind:"query", query, source}
       {ok:true, kind:"shortlink", url, source}
       {ok:true, kind:"pluscode_short", code, ref, source}
       {ok:false, error, source?}                                          */
  var RX_NUM = "[+-]?\\d+(?:\\.\\d+)?";

  function coordResult(a, b, source, opt) {
    opt = opt || {};
    if (!isNum(a) || !isNum(b)) return { ok: false, error: "coord_format", source: source };
    var lat = a, lon = b, swapped = false;
    if (!opt.fixedOrder) {
      if (Math.abs(a) > 90 && Math.abs(b) <= 90) { lat = b; lon = a; swapped = true; }
    }
    if (Math.abs(lat) > 90) return { ok: false, error: "lat_range", source: source };
    if (Math.abs(lon) > 360) return { ok: false, error: "lon_range", source: source };
    lon = normLon(lon);
    var r = { ok: true, kind: "coords", lat: lat, lon: lon, source: source };
    if (swapped) r.swapped = true;
    if (Math.abs(lat) < 1e-7 && Math.abs(lon) < 1e-7) r.nullIsland = true;
    if (opt.label) r.label = opt.label;
    return r;
  }

  function parseDecimalPair(s, source) {
    s = s.replace(/\s+/g, " ").trim();
    var m = s.match(new RegExp("^(" + RX_NUM + ")\\s*(?:[,;\\/]\\s*|\\s+)(" + RX_NUM + ")$"));
    if (m) return coordResult(parseFloat(m[1]), parseFloat(m[2]), source || "decimal");
    m = s.match(/^([+-]?\d+,\d+)\s*(?:;\s*|,\s+|\s+|\/\s*)([+-]?\d+,\d+)$/);
    if (m) {
      var r = coordResult(parseFloat(m[1].replace(",", ".")), parseFloat(m[2].replace(",", ".")), source || "decimal_comma");
      return r;
    }
    return null;
  }

  function normalizeSymbols(s) {
    return s.replace(/[\u2032\u2019\u2018\u00B4`]/g, "'")
      .replace(/[\u2033\u201C\u201D]/g, '"').replace(/''/g, '"')
      .replace(/[\u00BA\u02DA]/g, "\u00B0")
      .replace(/[\u2212\u2013\u2014]/g, "-");
  }

  function parseDmsPair(s) {
    s = s.replace(/(\d),(\d)/g, "$1.$2").replace(/[,;\/]/g, " ");
    var re = /([NSEWO])|([+-]?\d+(?:\.\d+)?)\s*(\u00B0|'|"|:)?/gi, m, toks = [];
    while ((m = re.exec(s))) {
      if (m[1]) toks.push({ t: "h", v: m[1].toUpperCase() === "O" ? "E" : m[1].toUpperCase() });
      else toks.push({ t: "n", v: parseFloat(m[2]), raw: m[2], u: m[3] || null });
    }
    var groups = [], cur = { hemi: null, nums: [], lastUnit: null };
    function close() { if (cur.nums.length || cur.hemi) groups.push(cur); cur = { hemi: null, nums: [], lastUnit: null }; }
    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i];
      if (tk.t === "h") {
        if (!cur.nums.length) { if (cur.hemi) return null; cur.hemi = tk.v; }
        else if (!cur.hemi) { cur.hemi = tk.v; close(); }
        else { close(); cur.hemi = tk.v; }
      } else {
        if (cur.nums.length && (tk.u === "\u00B0" || cur.nums.length === 3 || cur.lastUnit === '"')) close();
        cur.nums.push(tk); cur.lastUnit = tk.u;
      }
    }
    close();
    if (groups.length !== 2) return null;
    var vals = [];
    for (var g = 0; g < 2; g++) {
      var G = groups[g];
      if (!G.nums.length || G.nums.length > 3) return null;
      var d = G.nums[0], mi = G.nums[1], se = G.nums[2];
      if (mi && /\./.test(d.raw)) return null;
      if (se && /\./.test(mi.raw)) return null;
      if (mi && (mi.v < 0 || mi.v >= 60)) return null;
      if (se && (se.v < 0 || se.v >= 60)) return null;
      var neg = d.v < 0 || /^-/.test(d.raw);
      var v = Math.abs(d.v) + (mi ? mi.v / 60 : 0) + (se ? se.v / 3600 : 0);
      if (G.hemi === "S" || G.hemi === "W") neg = true;
      vals.push({ v: neg ? -v : v, hemi: G.hemi });
    }
    var h0 = vals[0].hemi, h1 = vals[1].hemi;
    var isLat = function (h) { return h === "N" || h === "S"; };
    var isLon = function (h) { return h === "E" || h === "W"; };
    if (h0 && h1) {
      if (isLat(h0) && isLon(h1)) return coordResult(vals[0].v, vals[1].v, "dms", { fixedOrder: true });
      if (isLon(h0) && isLat(h1)) return coordResult(vals[1].v, vals[0].v, "dms", { fixedOrder: true });
      return { ok: false, error: "hemisphere", source: "dms" };
    }
    if (h0 || h1) {
      var hv = h0 ? vals[0] : vals[1], ov = h0 ? vals[1] : vals[0];
      if (isLat(hv.hemi)) return coordResult(hv.v, ov.v, "dms", { fixedOrder: true });
      return coordResult(ov.v, hv.v, "dms", { fixedOrder: true });
    }
    return coordResult(vals[0].v, vals[1].v, "dms");
  }

  function parseCoordText(s0) {
    var s = normalizeSymbols(s0).trim();
    s = s.replace(/\b(north|nord)\b/gi, "N").replace(/\b(south|s\u00FCd|sued)\b/gi, "S")
         .replace(/\b(east|ost)\b/gi, "E").replace(/\bwest\b/gi, "W");
    if (!/\d/.test(s)) return null;
    if (!/^[\s\d.,;:\u00B0'"+\-\/NSEWOnsewo]*$/.test(s)) return null;
    var hasHemi = /[NSEWO]/i.test(s), hasSym = /[\u00B0'"]/.test(s);
    if (!hasHemi && !hasSym) return parseDecimalPair(s) || { ok: false, error: "coord_format", source: "decimal" };
    return parseDmsPair(s) || { ok: false, error: "coord_format", source: "dms" };
  }

  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  function coordsFromParam(v, source) {
    if (!v) return null;
    v = safeDecode(String(v)).replace(/\+/g, " ").trim();
    var r = parseDecimalPair(v, source);
    if (r && r.ok) return r;
    var d = parseCoordText(v);
    if (d && d.ok) { d.source = source; return d; }
    return null;
  }
  function textFromParam(v) {
    if (!v) return null;
    v = safeDecode(String(v).replace(/\+/g, " ")).trim();
    return v.length >= 2 ? v : null;
  }

  var URL_HOST_HINT = /(google\.|goo\.gl|maps\.apple|openstreetmap\.|osm\.org|bing\.com|here\.com|komoot\.)/i;

  function parseUrl(str) {
    var u;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(str) ? str : "https://" + str); } catch (e) { return null; }
    var host = u.hostname.toLowerCase().replace(/^www\./, "");
    var full = safeDecode(str);
    var p = u.searchParams, r, m, k;

    if (host === "maps.app.goo.gl" || (host === "goo.gl" && /^\/maps/i.test(u.pathname)) || host === "g.co")
      return { ok: true, kind: "shortlink", url: u.href, source: "google_short" };

    if (/(^|\.)google\.[a-z.]{2,7}$/.test(host) || /^maps\.google\./.test(host)) {
      var all = full.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g);
      if (all && all.length) {
        m = all[all.length - 1].match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
        return coordResult(parseFloat(m[1]), parseFloat(m[2]), "google_pin", { fixedOrder: true });
      }
      var keys = ["q", "query", "ll", "destination", "daddr", "center", "sll"];
      for (k = 0; k < keys.length; k++) { r = coordsFromParam(p.get(keys[k]), "google_param"); if (r) return r; }
      m = u.pathname.match(/\/maps\/(?:search|dir)\/(?:[^\/]*\/)*?(-?\d+(?:\.\d+)?),\s*\+?(-?\d+(?:\.\d+)?)/);
      if (m) return coordResult(parseFloat(m[1]), parseFloat(m[2]), "google_path", { fixedOrder: true });
      m = full.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
      var place = u.pathname.match(/\/maps\/place\/([^\/@]+)/);
      if (place) {
        var pname = textFromParam(place[1]);
        var pc = pname && parseCoordText(pname);
        if (pc && pc.ok) { pc.source = "google_place_coords"; return pc; }
        if (m) return coordResult(parseFloat(m[1]), parseFloat(m[2]), "google_center", { fixedOrder: true, label: pname });
        if (pname) return { ok: true, kind: "query", query: pname, source: "google_name" };
      }
      if (m) return coordResult(parseFloat(m[1]), parseFloat(m[2]), "google_center", { fixedOrder: true });
      var qt = textFromParam(p.get("q") || p.get("query") || p.get("destination"));
      if (qt) return { ok: true, kind: "query", query: qt, source: "google_name" };
      return { ok: false, error: "url_unrecognized", source: "google" };
    }

    if (/^maps\.apple(\.com)?$/.test(host) || host === "maps.apple.com") {
      var ak = ["ll", "q", "sll", "coordinate", "center"];
      for (k = 0; k < ak.length; k++) { r = coordsFromParam(p.get(ak[k]), "apple"); if (r) return r; }
      var at = textFromParam(p.get("q") || p.get("address") || p.get("name"));
      if (at) return { ok: true, kind: "query", query: at, source: "apple_name" };
      return { ok: false, error: "url_unrecognized", source: "apple" };
    }

    if (/(^|\.)openstreetmap\.(org|de|fr)$/.test(host) || host === "osm.org") {
      m = (u.hash || "").match(/map=\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
      if (p.get("mlat") && p.get("mlon")) return coordResult(parseFloat(p.get("mlat")), parseFloat(p.get("mlon")), "osm", { fixedOrder: true });
      if (m) return coordResult(parseFloat(m[1]), parseFloat(m[2]), "osm", { fixedOrder: true });
      var ot = textFromParam(p.get("query"));
      if (ot) { r = parseCoordText(ot); if (r && r.ok) { r.source = "osm"; return r; } return { ok: true, kind: "query", query: ot, source: "osm_name" }; }
      return { ok: false, error: "url_unrecognized", source: "osm" };
    }

    if (/(^|\.)bing\.com$/.test(host)) {
      var cp = p.get("cp");
      if (cp) { m = safeDecode(cp).match(/(-?\d+(?:\.\d+)?)[~_ ,](-?\d+(?:\.\d+)?)/); if (m) return coordResult(parseFloat(m[1]), parseFloat(m[2]), "bing", { fixedOrder: true }); }
      var sp = p.get("sp");
      if (sp) { m = safeDecode(sp).match(/point\.(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)/); if (m) return coordResult(parseFloat(m[1]), parseFloat(m[2]), "bing", { fixedOrder: true }); }
      r = coordsFromParam(p.get("where1") || p.get("q"), "bing"); if (r) return r;
      var bt = textFromParam(p.get("where1") || p.get("q"));
      if (bt) return { ok: true, kind: "query", query: bt, source: "bing_name" };
      return { ok: false, error: "url_unrecognized", source: "bing" };
    }

    if (/(^|\.)here\.com$/.test(host)) {
      m = u.pathname.match(/\/l\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/) || (p.get("map") || "").match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
      if (m) return coordResult(parseFloat(m[1]), parseFloat(m[2]), "here", { fixedOrder: true });
      return { ok: false, error: "url_unrecognized", source: "here" };
    }

    if (/(^|\.)komoot\.(com|de)$/.test(host)) {
      m = full.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
      if (m) return coordResult(parseFloat(m[1]), parseFloat(m[2]), "komoot", { fixedOrder: true });
      return { ok: false, error: "url_unrecognized", source: "komoot" };
    }

    // Generisch: lat/lon-Parameter, ll, center, @lat,lon, q
    var la = p.get("lat") || p.get("latitude") || p.get("mlat");
    var lo = p.get("lon") || p.get("lng") || p.get("long") || p.get("longitude") || p.get("mlon");
    if (la && lo && isNum(parseFloat(la)) && isNum(parseFloat(lo)))
      return coordResult(parseFloat(la), parseFloat(lo), "url_params", { fixedOrder: true });
    var gk = ["ll", "center", "q", "query", "coords", "position"];
    for (k = 0; k < gk.length; k++) { r = coordsFromParam(p.get(gk[k]), "url_params"); if (r) return r; }
    m = full.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/) || (u.hash || "").match(/(-?\d{1,2}\.\d+)\/(-?\d{1,3}\.\d+)/);
    if (m) return coordResult(parseFloat(m[1]), parseFloat(m[2]), "url_generic", { fixedOrder: true });
    return { ok: false, error: "url_unrecognized", source: "url" };
  }

  var W3W_TLD = /^(com|de|org|net|io|app|gl|co|uk|eu|info|biz|me|tv|fr|nl|at|ch)$/i;

  function parseInput(text) {
    var s = String(text == null ? "" : text).replace(/\u00A0/g, " ").trim();
    if (!s) return { ok: false, error: "empty" };

    // what3words — bewusst nicht unterstuetzt (E9)
    if (/^\/\/\/[^\s\/]/.test(s)) return { ok: false, error: "w3w_unsupported", source: "w3w" };
    var w3 = s.match(/^([^\s.\/:]{2,})\.([^\s.\/:]{2,})\.([^\s.\/:]{2,})$/);
    if (w3 && !/\d/.test(s) && !W3W_TLD.test(w3[3]))
      return { ok: false, error: "w3w_unsupported", source: "w3w" };

    // URL irgendwo im Text
    var urlTok = s.match(/(?:https?:\/\/|www\.)\S+/i);
    if (!urlTok && URL_HOST_HINT.test(s) && !/\s/.test(s)) urlTok = [s];
    if (urlTok) {
      var ur = parseUrl(urlTok[0]);
      if (ur) return ur;
      return { ok: false, error: "url_unrecognized", source: "url" };
    }

    // geo:-URI (inkl. Android geo:0,0?q=lat,lon(Label))
    var g = s.match(/^geo:\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)(?:,[^?;]*)?(?:;[^?]*)?(\?.*)?$/i);
    if (g) {
      var glat = parseFloat(g[1]), glon = parseFloat(g[2]);
      if (glat === 0 && glon === 0 && g[3]) {
        var qq = g[3].match(/[?&]q=([^&]*)/);
        if (qq) {
          var qv = safeDecode(qq[1]).replace(/\(.*\)$/, "");
          var qr = parseDecimalPair(qv, "geo");
          if (qr && qr.ok) return qr;
          var qn = textFromParam(qv); if (qn) return { ok: true, kind: "query", query: qn, source: "geo_name" };
        }
      }
      return coordResult(glat, glon, "geo", { fixedOrder: true });
    }
    if (/^geo:/i.test(s)) return { ok: false, error: "coord_format", source: "geo" };

    // Plus Code (voll oder kurz + Bezugsort)
    var pm = s.match(/^([23456789CFGHJMPQRVWX0]{2,8}\+[23456789CFGHJMPQRVWX]{0,7})(?:[\s,]+(.*))?$/i);
    if (pm && OLC.isValid(pm[1])) {
      var code = pm[1].toUpperCase(), ref = (pm[2] || "").replace(/^[\s,]+|[\s,]+$/g, "");
      if (OLC.isFull(code)) {
        var dc = OLC.decode(code);
        var pr = coordResult(dc.latCenter, dc.lngCenter, "pluscode", { fixedOrder: true });
        pr.code = code; pr.precisionM = Math.round((dc.latHi - dc.latLo) * 111320);
        return pr;
      }
      if (!ref) return { ok: false, error: "pluscode_ref", source: "pluscode_short", code: code };
      return { ok: true, kind: "pluscode_short", code: code, ref: ref, source: "pluscode_short" };
    }

    var c = parseCoordText(s);
    if (c) return c;

    if (s.length < 2) return { ok: false, error: "too_short" };
    return { ok: true, kind: "query", query: s, source: "name" };
  }

  /* ───────────── Einheiten ───────────── */
  var UNITS = {
    wind: { ms: 1, kmh: 3.6, kn: 1.9438445, mph: 2.2369363 },
    temp: { C: null, F: null },
    alt: { m: 1, ft: 3.2808399 },
    press: { hPa: 1, inHg: 0.0295299831 },
    dist: { km: 0.001, mi: 0.000621371192 },
    precip: { mm: 1, "in": 0.0393700787 }
  };
  function conv(kind, v, unit) {
    if (!isNum(v)) return null;
    if (kind === "temp") return unit === "F" ? v * 9 / 5 + 32 : v;
    if (kind === "tempDelta") return unit === "F" ? v * 9 / 5 : v;
    var f = UNITS[kind] && UNITS[kind][unit];
    return isNum(f) ? v * f : v;
  }
  function unconv(kind, v, unit) {
    if (!isNum(v)) return null;
    if (kind === "temp") return unit === "F" ? (v - 32) * 5 / 9 : v;
    var f = UNITS[kind] && UNITS[kind][unit];
    return isNum(f) ? v / f : v;
  }
  function defaultUnits(locale) {
    locale = String(locale || "en").toLowerCase();
    var us = /-(us|lr|mm)$/.test(locale) || locale === "en-us";
    var gb = /-gb$/.test(locale);
    return {
      wind: us || gb ? "mph" : "kmh", temp: us ? "F" : "C", alt: us ? "ft" : "m",
      press: us ? "inHg" : "hPa", dist: us || gb ? "mi" : "km", precip: us ? "in" : "mm",
      h12: us
    };
  }
  // API-Einheiten pruefen/umrechnen → SI (Fehlerquelle "Einheiten vertauscht")
  function toSIFactor(unitStr, kind) {
    var u = String(unitStr || "").toLowerCase().replace(/\s/g, "");
    if (kind === "wind") {
      if (u === "m/s" || u === "ms") return { f: 1 };
      if (u === "km/h" || u === "kmh") return { f: 1 / 3.6 };
      if (u === "kn" || u === "kt" || u === "knots") return { f: 1 / 1.9438445 };
      if (u === "mph" || u === "mp/h") return { f: 1 / 2.2369363 };
    } else if (kind === "temp") {
      if (u === "°c" || u === "c") return { f: 1 };
      if (u === "°f" || u === "f") return { fn: function (v) { return (v - 32) * 5 / 9; } };
    } else if (kind === "len") {
      if (u === "m") return { f: 1 };
      if (u === "ft") return { f: 0.3048 };
      if (u === "km") return { f: 1000 };
    } else if (kind === "precip") {
      if (u === "mm" || u === "mm/h") return { f: 1 };
      if (u === "inch" || u === "in") return { f: 25.4 };
      if (u === "cm") return { f: 10 };
    } else if (kind === "press") {
      if (u === "hpa" || u === "mb") return { f: 1 };
      if (u === "inhg") return { f: 33.8638866 };
      if (u === "pa") return { f: 0.01 };
    } else return { f: 1 };
    return null;
  }

  /* ───────────── Meteorologische Formeln ───────────── */
  function satVapor(T) { return isNum(T) ? 6.1094 * Math.exp(17.625 * T / (T + 243.04)) : null; }  // hPa
  function dewPoint(T, RH) {
    if (!isNum(T) || !isNum(RH) || RH <= 0) return null;
    var g = Math.log(RH / 100) + 17.625 * T / (243.04 + T);
    return 243.04 * g / (17.625 - g);
  }
  function relHum(T, Td) { return isNum(T) && isNum(Td) ? clamp(100 * satVapor(Td) / satVapor(T), 0, 100) : null; }
  // Wolkenbasis ueber Grund (LCL), Faustformel 125 m/K — "berechnet"
  function cloudBaseLCL(T, Td) { return isNum(T) && isNum(Td) ? Math.max(0, 125 * (T - Td)) : null; }
  function gustFactor(gust, wind) { return isNum(gust) && isNum(wind) && wind >= 1 ? gust / wind : null; }
  function shear(wTop, wBottom) { return isNum(wTop) && isNum(wBottom) ? wTop - wBottom : null; }
  var RHO0 = 1.225, DA_EXP = 0.234969;   // ISA-Dichte Meereshoehe (kg/m³), Exponent Dichtehoehe
  // Luftdichte + Dichtehoehe aus Stationsdruck (hPa), T (°C), Td (°C) mit virtueller Temperatur
  function densityAltitude(p, T, Td) {
    if (!isNum(p) || !isNum(T) || p < 100) return null;
    var e = isNum(Td) ? satVapor(Td) : 0;
    var Tv = (T + 273.15) / (1 - 0.378 * e / p);
    var rho = p * 100 / (287.05 * Tv);
    var da = 44307.69 * (1 - Math.pow(rho / RHO0, DA_EXP));
    var pa = 44307.69 * (1 - Math.pow(p / 1013.25, 0.190284));
    return { rho: rho, ratio: rho / RHO0, da: da, pa: pa, tv: Tv - 273.15 };
  }
  // Nebel-/Dunstrisiko: 0 keins, 1 erhoeht, 2 hoch
  function fogRisk(T, Td, wind, night, vis) {
    if (isNum(vis) && vis < 1000) return 2;
    if (!isNum(T) || !isNum(Td)) return null;
    var spread = T - Td;
    if (spread < 2.5 && (!isNum(wind) || wind < 3)) return night || spread < 1 ? 2 : 1;
    if (spread < 4 && night && (!isNum(wind) || wind < 2)) return 1;
    return 0;
  }
  // Beschlag: Geraet kaelter als Taupunkt der Umgebungsluft → Kondensation
  function condensation(TdAir, deviceT) {
    if (!isNum(TdAir) || !isNum(deviceT)) return null;
    return { risk: TdAir > deviceT, margin: TdAir - deviceT };
  }
  // Thermik: konvektive Geschwindigkeitsskala w* (Deardorff), grob — "berechnet"
  function thermal(sw, blh, T, T850, zSpot, z850) {
    var out = { wstar: null, lapse: null, cls: null };
    if (isNum(T) && isNum(T850) && isNum(z850) && isNum(zSpot) && z850 - zSpot > 200)
      out.lapse = (T - T850) / (z850 - zSpot) * 1000;          // K/km
    if (isNum(sw) && isNum(blh) && isNum(T)) {
      if (sw < 50 || blh < 100) out.wstar = 0;
      else out.wstar = Math.cbrt(9.81 / (T + 273.15) * (0.25 * sw) / 1200 * blh);
    }
    if (isNum(out.wstar)) out.cls = out.wstar < 0.8 ? 0 : out.wstar < 1.5 ? 1 : out.wstar < 2.5 ? 2 : 3;
    return out;
  }
  function thunderLevel(code, cape, li) {
    if (code === 95 || code === 96 || code === 99) return 2;
    if (isNum(cape) && isNum(li) && cape >= 1000 && li <= -2) return 2;
    if ((isNum(cape) && cape >= 500) || (isNum(li) && li <= 0 && isNum(cape) && cape >= 100)) return 1;
    if (!isNum(cape) && !isNum(li) && !isNum(code)) return null;
    return 0;
  }
  function kpLevel(kp) { return !isNum(kp) ? null : kp >= 7 ? 2 : kp >= 5 ? 1 : 0; }
  function flightCategory(ceilFt, visSm) {
    var c = isNum(ceilFt) ? ceilFt : Infinity, v = isNum(visSm) ? visSm : Infinity;
    if (c < 500 || v < 1) return "LIFR";
    if (c < 1000 || v < 3) return "IFR";
    if (c <= 3000 || v <= 5) return "MVFR";
    return "VFR";
  }

  /* ───────────── Sonne (NOAA Solar Calculator) ───────────── */
  function sunPosition(ms, lat, lon) {
    var jd = ms / 86400000 + 2440587.5, jc = (jd - 2451545) / 36525;
    var L = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
    var M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
    var e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
    var C = Math.sin(M * RAD) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * jc) + Math.sin(3 * M * RAD) * 0.000289;
    var om = 125.04 - 1934.136 * jc;
    var lam = L + C - 0.00569 - 0.00478 * Math.sin(om * RAD);
    var eps0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
    var eps = eps0 + 0.00256 * Math.cos(om * RAD);
    var decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lam * RAD)) * DEG;
    var y = Math.pow(Math.tan(eps / 2 * RAD), 2);
    var eqt = 4 * DEG * (y * Math.sin(2 * L * RAD) - 2 * e * Math.sin(M * RAD) + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L * RAD) - 0.5 * y * y * Math.sin(4 * L * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD));
    var minUTC = ((ms / 60000) % 1440 + 1440) % 1440;
    var tst = ((minUTC + eqt + 4 * lon) % 1440 + 1440) % 1440;
    var ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;
    var cz = Math.sin(lat * RAD) * Math.sin(decl * RAD) + Math.cos(lat * RAD) * Math.cos(decl * RAD) * Math.cos(ha * RAD);
    var zen = Math.acos(clamp(cz, -1, 1)) * DEG;
    var elev = 90 - zen, az;
    var den = Math.cos(lat * RAD) * Math.sin(zen * RAD);
    if (Math.abs(den) < 1e-9) az = lat > 0 ? 180 : 0;
    else {
      var a = Math.acos(clamp((Math.sin(lat * RAD) * Math.cos(zen * RAD) - Math.sin(decl * RAD)) / den, -1, 1)) * DEG;
      az = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
    }
    // Refraktion (NOAA-Naeherung) fuer die angezeigte Hoehe
    var r = 0, te = Math.tan(elev * RAD);
    if (elev > 85) r = 0;
    else if (elev > 5) r = 58.1 / te - 0.07 / Math.pow(te, 3) + 0.000086 / Math.pow(te, 5);
    else if (elev > -0.575) r = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
    else r = -20.772 / te;
    return { elevation: elev, apparent: elev + r / 3600, azimuth: az, declination: decl, eqTime: eqt };
  }
  // Ereignisse eines Ortstages. dayStart/dayEnd: Unix-Sekunden (lokale Mitternacht)
  function crossings(fn, t0, t1, step, thr) {
    var out = [], prev = fn(t0), t = t0;
    while (t < t1) {
      var tn = Math.min(t + step, t1), cur = fn(tn);
      if ((prev - thr) * (cur - thr) < 0 || (cur === thr && prev !== thr)) {
        var a = t, b = tn, fa = prev;
        for (var i = 0; i < 18; i++) {
          var mid = (a + b) / 2, fm = fn(mid);
          if ((fa - thr) * (fm - thr) <= 0) b = mid; else { a = mid; fa = fm; }
        }
        out.push({ t: Math.round((a + b) / 2), rising: cur > prev });
      }
      prev = cur; t = tn;
    }
    return out;
  }
  function firstOf(list, rising) { for (var i = 0; i < list.length; i++) if (list[i].rising === rising) return list[i].t; return null; }
  function lastOf(list, rising) { for (var i = list.length - 1; i >= 0; i--) if (list[i].rising === rising) return list[i].t; return null; }
  function sunEvents(dayStart, lat, lon, dayEnd) {
    dayEnd = dayEnd || dayStart + 86400;
    var fn = function (t) { return sunPosition(t * 1000, lat, lon).elevation; };
    var c0 = crossings(fn, dayStart, dayEnd, 300, -0.833);
    var c6 = crossings(fn, dayStart, dayEnd, 300, -6);
    var c12 = crossings(fn, dayStart, dayEnd, 300, -12);
    var cg = crossings(fn, dayStart, dayEnd, 300, 6);
    var cb = crossings(fn, dayStart, dayEnd, 300, -4);
    // Hoechststand
    var best = -99, bt = dayStart;
    for (var t = dayStart; t <= dayEnd; t += 600) { var e = fn(t); if (e > best) { best = e; bt = t; } }
    var ev = {
      sunrise: firstOf(c0, true), sunset: lastOf(c0, false),
      civilDawn: firstOf(c6, true), civilDusk: lastOf(c6, false),
      nauticalDawn: firstOf(c12, true), nauticalDusk: lastOf(c12, false),
      goldenMorningEnd: firstOf(cg, true), goldenEveningStart: lastOf(cg, false),
      blueMorningEnd: firstOf(cb, true), blueEveningStart: lastOf(cb, false),
      noon: bt, maxElevation: best, polar: null
    };
    if (!c0.length) ev.polar = fn(dayStart + 43200) > -0.833 ? "day" : "night";
    return ev;
  }

  /* ───────────── Mond (niedrige Genauigkeit, Meeus/suncalc-Ansatz) ───────────── */
  var J2000 = 2451545, OBL = RAD * 23.4397;
  function daysJ2000(ms) { return ms / 86400000 + 2440587.5 - J2000; }
  function raDec(l, b) {
    return {
      ra: Math.atan2(Math.sin(l) * Math.cos(OBL) - Math.tan(b) * Math.sin(OBL), Math.cos(l)),
      dec: Math.asin(Math.sin(b) * Math.cos(OBL) + Math.cos(b) * Math.sin(OBL) * Math.sin(l))
    };
  }
  function sunCoordsLow(d) {
    var M = RAD * (357.5291 + 0.98560028 * d);
    var C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    var L = M + C + RAD * 102.9372 + Math.PI;
    return raDec(L, 0);
  }
  function moonCoords(d) {
    var L = RAD * (218.316 + 13.176396 * d), M = RAD * (134.963 + 13.064993 * d), F = RAD * (93.272 + 13.229350 * d);
    var l = L + RAD * 6.289 * Math.sin(M), b = RAD * 5.128 * Math.sin(F), dt = 385001 - 20905 * Math.cos(M);
    var rd = raDec(l, b); rd.dist = dt; return rd;
  }
  function moonPosition(ms, lat, lon) {
    var d = daysJ2000(ms), c = moonCoords(d), phi = RAD * lat, lw = RAD * -lon;
    var H = RAD * (280.16 + 360.9856235 * d) - lw - c.ra;
    var h = Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H));
    var az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(c.dec) * Math.cos(phi));
    h = h + RAD * 0.017 / Math.tan(h + RAD * 10.26 / (h * DEG + 5.10));      // Refraktion
    return { altitude: h * DEG, azimuth: (az * DEG + 180 + 360) % 360, dist: c.dist };
  }
  function moonIllumination(ms) {
    var d = daysJ2000(ms), s = sunCoordsLow(d), m = moonCoords(d), sdist = 149598000;
    var phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
    var inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
    var ang = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
    return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + 0.5 * inc * (ang < 0 ? -1 : 1) / Math.PI };
  }
  function moonPhaseIndex(phase) { return Math.round(phase * 8) % 8; }   // 0 Neumond … 4 Vollmond
  function moonTimes(dayStart, lat, lon, dayEnd) {
    dayEnd = dayEnd || dayStart + 86400;
    var fn = function (t) { return moonPosition(t * 1000, lat, lon).altitude; };
    var c = crossings(fn, dayStart, dayEnd, 600, 0.133);
    var up = fn(dayStart) > 0.133;
    return { rise: firstOf(c, true), set: firstOf(c, false), alwaysUp: !c.length && up, alwaysDown: !c.length && !up };
  }

  /* ───────────── Flugprofile + Score ─────────────
     Grenzwerte in SI (m/s, m, °C). Defaults aus dem Plan (km/h → m/s).   */
  function kmh(v) { return v === null ? null : v / 3.6; }
  var PROFILES = {
    whoop:     { id: "whoop",     wind10: kmh(15), gust: kmh(20), windAlt: null,    altM: 80,  rain: "none",  vis: 1000, cold: 5, gps: false },
    freestyle: { id: "freestyle", wind10: kmh(30), gust: kmh(40), windAlt: kmh(45), altM: 120, rain: "light", vis: 2000, cold: 5, gps: false },
    lr:        { id: "lr",        wind10: kmh(35), gust: kmh(45), windAlt: kmh(55), altM: 120, rain: "none",  vis: 5000, cold: 0, gps: true },
    wing:      { id: "wing",      wind10: kmh(35), gust: kmh(45), windAlt: kmh(55), altM: 120, rain: "none",  vis: 5000, cold: 0, gps: true },
    glider:    { id: "glider",    wind10: kmh(25), gust: kmh(35), windAlt: kmh(40), altM: 120, rain: "none",  vis: 5000, cold: 0, gps: false }
  };
  var PROFILE_ORDER = ["whoop", "freestyle", "lr", "wing", "glider"];
  function cloneProfiles() { return JSON.parse(JSON.stringify(PROFILES)); }

  // Teil-Score aus Verhaeltnis Wert/Grenze: ≤0.6 → 100, 0.8 → 75, 1.0 → 50, 1.3 → 0
  function subScore(r) {
    if (!isNum(r)) return null;
    if (r <= 0.6) return 100;
    if (r <= 0.8) return 100 - (r - 0.6) / 0.2 * 25;
    if (r <= 1.0) return 75 - (r - 0.8) / 0.2 * 25;
    if (r <= 1.3) return 50 - (r - 1.0) / 0.3 * 50;
    return 0;
  }
  function levelFromRatio(r) { return r > 1 ? 2 : r > 0.8 ? 1 : 0; }

  /* h: normalisierte Stunde (SI). ctx: {night, kp, gustSpread, sunElev, fog}
     → {level 0/1/2, score 0..100, reasons:[{key, level, v?, lim?}], hard} */
  function evaluateHour(h, prof, ctx) {
    ctx = ctx || {};
    var reasons = [], score = 100, level = 0, hard = false, known = 0;
    function add(key, lv, sc, v, lim, isHard) {
      reasons.push({ key: key, level: lv, v: v, lim: lim });
      if (lv > level) level = lv;
      if (isNum(sc) && sc < score) score = sc;
      if (isHard) { hard = true; score = 0; }
    }
    function ratio(key, v, lim) {
      if (!isNum(v) || !isNum(lim) || lim <= 0) return;
      known++;
      var r = v / lim, lv = levelFromRatio(r);
      add(key, lv, subScore(r), v, lim, false);
    }
    ratio("wind10", h.w10, prof.wind10);
    ratio("gust", h.gust, prof.gust);
    if (isNum(prof.windAlt)) ratio("windAlt", prof.altM >= 120 ? h.w120 : h.w80, prof.windAlt);

    // Niederschlag
    if (isNum(h.precip) || isNum(h.snow)) {
      known++;
      var pr = h.precip || 0, sn = h.snow || 0;
      if (prof.rain === "none") {
        if (pr >= 0.1 || sn > 0) add("rain", 2, 0, pr, 0.1, true);
        else if (isNum(h.pp) && h.pp >= 50) add("rainProb", 1, 70, h.pp, 50);
      } else {
        if (pr > 1 || sn > 0.2) add("rain", 2, 20, pr, 1);
        else if (pr > 0.2) add("rainLight", 1, 65, pr, 0.2);
        else if (isNum(h.pp) && h.pp >= 70) add("rainProb", 1, 70, h.pp, 70);
      }
    }
    // Sicht
    if (isNum(h.vis) && isNum(prof.vis)) {
      known++;
      if (h.vis < prof.vis) add("vis", 2, 0, h.vis, prof.vis, true);
      else if (h.vis < 2 * prof.vis) add("visLow", 1, 70, h.vis, prof.vis);
    }
    // Gewitter
    var tl = thunderLevel(h.code, h.cape, h.li);
    if (tl === 2) add("thunder", 2, 0, h.cape, null, true);
    else if (tl === 1) add("thunderRisk", 1, 60, h.cape, null);
    // Dunkelheit (nach buergerlicher Daemmerung)
    if (isNum(ctx.sunElev) && ctx.sunElev < -6 && !ctx.night) add("dark", 2, 0, ctx.sunElev, -6, true);
    // Wolkenbasis / tiefe Wolken in Flughoehe
    var base = cloudBaseLCL(h.temp, h.dew);
    if (isNum(base) && isNum(h.cl)) {
      if (base < 60 && h.cl >= 80) add("cloudLow", 2, 30, base, 60);
      else if (base < prof.altM && h.cl >= 50) add("cloudBase", 1, 70, base, prof.altM);
    }
    // Nebel
    if (ctx.fog === 2) add("fog", 1, 60, null, null);
    // Temperatur (Hinweis, kein No-Go)
    if (isNum(h.temp) && isNum(prof.cold) && h.temp < prof.cold) add("cold", 1, 80, h.temp, prof.cold);
    if (isNum(h.temp) && h.temp > 38) add("heat", 1, 80, h.temp, 38);
    // GNSS / Kp
    var kl = kpLevel(ctx.kp);
    if (kl === 2) add("kp", prof.gps ? 2 : 1, prof.gps ? 30 : 70, ctx.kp, 7);
    else if (kl === 1) add("kp", 1, 75, ctx.kp, 5);
    // Unsicherheit: Modellstreuung ueberlappt die Grenze → gruen wird gelb
    if (level === 0 && isNum(ctx.gustSpreadMax) && isNum(prof.gust) && ctx.gustSpreadMax > prof.gust) {
      add("uncertain", 1, Math.min(score, 74), ctx.gustSpreadMax, prof.gust);
    }
    if (!known) return { level: null, score: null, reasons: [{ key: "nodata", level: null }], hard: false };
    // Score und Ampel konsistent halten
    if (level === 2 && score > 49) score = 49;
    if (level === 1 && score > 74) score = 74;
    if (level === 0 && score < 75) score = 75;
    reasons.sort(function (a, b) { return (b.level || 0) - (a.level || 0); });
    return { level: level, score: Math.round(score), reasons: reasons, hard: hard };
  }

  // Bestes Fenster: zusammenhaengende Stunden mit max. Ampel-Level 'maxLevel'
  function bestWindows(hours, evals, dayStarts, maxLevel) {
    maxLevel = isNum(maxLevel) ? maxLevel : 0;
    var res = [];
    for (var d = 0; d < dayStarts.length; d++) {
      var ds = dayStarts[d], de = dayStarts[d + 1] || ds + 86400, best = null, cur = null;
      for (var i = 0; i < hours.length; i++) {
        var t = hours[i].t, ev = evals[i];
        if (t < ds || t >= de) { cur = null; continue; }
        if (ev && ev.level !== null && ev.level <= maxLevel) {
          if (!cur) cur = { start: t, end: t + 3600, sum: 0, n: 0 };
          cur.end = t + 3600; cur.sum += ev.score; cur.n++;
          var cs = cur.n * 100 + cur.sum / cur.n;
          if (!best || cs > best.n * 100 + best.sum / best.n) best = { start: cur.start, end: cur.end, sum: cur.sum, n: cur.n };
        } else cur = null;
      }
      res.push(best ? { day: ds, start: best.start, end: best.end, hours: best.n, score: Math.round(best.sum / best.n) } : { day: ds, start: null });
    }
    return res;
  }

  /* ───────────── Normalisierung ───────────── */
  var HOURLY_MAP = {
    temp: ["temperature_2m", "temp"], rh: ["relative_humidity_2m", null], dew: ["dew_point_2m", "temp"],
    app: ["apparent_temperature", "temp"], pp: ["precipitation_probability", null],
    precip: ["precipitation", "precip"], rain: ["rain", "precip"], showers: ["showers", "precip"],
    snow: ["snowfall", "snow"], code: ["weather_code", null], pmsl: ["pressure_msl", "press"],
    psfc: ["surface_pressure", "press"], cloud: ["cloud_cover", null], cl: ["cloud_cover_low", null],
    cm: ["cloud_cover_mid", null], ch: ["cloud_cover_high", null], vis: ["visibility", "len"],
    w10: ["wind_speed_10m", "wind"], d10: ["wind_direction_10m", null], gust: ["wind_gusts_10m", "wind"],
    w80: ["wind_speed_80m", "wind"], d80: ["wind_direction_80m", null],
    w120: ["wind_speed_120m", "wind"], d120: ["wind_direction_120m", null],
    w180: ["wind_speed_180m", "wind"], d180: ["wind_direction_180m", null],
    cape: ["cape", null], li: ["lifted_index", null], cin: ["convective_inhibition", null],
    blh: ["boundary_layer_height", "len"], frz: ["freezing_level_height", "len"],
    uv: ["uv_index", null], sw: ["shortwave_radiation", null], sun: ["sunshine_duration", null],
    isDay: ["is_day", null], t850: ["temperature_850hPa", "temp"]
  };
  var LEVELS = [1000, 975, 950, 925, 900, 850];
  var HOURLY_VARS = Object.keys(HOURLY_MAP).map(function (k) { return HOURLY_MAP[k][0]; })
    .concat(LEVELS.reduce(function (a, p) { return a.concat(["wind_speed_" + p + "hPa", "wind_direction_" + p + "hPa", "geopotential_height_" + p + "hPa"]); }, []));
  var DAILY_VARS = ["weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_sum", "precipitation_probability_max", "wind_speed_10m_max", "wind_gusts_10m_max", "sunrise", "sunset"];
  // Kernvariablen, die immer funktionieren sollten (Rueckfall bei API-Fehler)
  var CORE_VARS = ["temperature_2m", "relative_humidity_2m", "dew_point_2m", "apparent_temperature", "precipitation_probability", "precipitation", "snowfall", "weather_code", "pressure_msl", "surface_pressure", "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high", "visibility", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "wind_speed_80m", "wind_speed_120m", "wind_direction_120m", "cape", "is_day"];

  function makeConverter(units, name, kind) {
    if (!kind) return { fn: function (v) { return v; }, ok: true };
    var u = units && units[name];
    if (u === undefined) return { fn: function (v) { return v; }, ok: true };
    var k = kind === "snow" ? "len_snow" : kind;
    if (k === "len_snow") {        // Schneefall: cm (Open-Meteo) → mm Wasser-Aequivalent ~ cm*1 (grob); wir behalten cm
      return { fn: function (v) { return v; }, ok: true, unit: u };
    }
    var f = toSIFactor(u, kind);
    if (!f) return { fn: function () { return null; }, ok: false, unit: u };
    return { fn: f.fn || function (v) { return v * f.f; }, ok: true, unit: u };
  }

  function normalizeForecast(j) {
    var H = j.hourly || {}, U = j.hourly_units || {}, T = H.time || [], problems = [];
    var keys = Object.keys(HOURLY_MAP), conv = {};
    keys.forEach(function (k) {
      var nm = HOURLY_MAP[k][0], c = makeConverter(U, nm, HOURLY_MAP[k][1]);
      if (!c.ok) problems.push(nm + ":" + c.unit);
      conv[k] = c.fn;
    });
    var lvConv = {};
    LEVELS.forEach(function (p) {
      lvConv[p] = { w: makeConverter(U, "wind_speed_" + p + "hPa", "wind").fn, z: makeConverter(U, "geopotential_height_" + p + "hPa", "len").fn };
    });
    var hours = [];
    for (var i = 0; i < T.length; i++) {
      var o = { t: T[i] };
      for (var k = 0; k < keys.length; k++) {
        var arr = H[HOURLY_MAP[keys[k]][0]];
        var v = arr && isNum(arr[i]) ? conv[keys[k]](arr[i]) : null;
        o[keys[k]] = isNum(v) ? v : null;
      }
      o.lv = {};
      for (var q = 0; q < LEVELS.length; q++) {
        var p = LEVELS[q], ws = H["wind_speed_" + p + "hPa"], wd = H["wind_direction_" + p + "hPa"], gz = H["geopotential_height_" + p + "hPa"];
        o.lv[p] = { w: ws && isNum(ws[i]) ? lvConv[p].w(ws[i]) : null, d: wd && isNum(wd[i]) ? wd[i] : null, z: gz && isNum(gz[i]) ? lvConv[p].z(gz[i]) : null };
      }
      if (o.dew === null && isNum(o.temp) && isNum(o.rh)) { o.dew = dewPoint(o.temp, o.rh); o.dewCalc = true; }
      hours.push(o);
    }
    var D = j.daily || {}, DU = j.daily_units || {}, days = [];
    var dW = makeConverter(DU, "wind_gusts_10m_max", "wind").fn, dW2 = makeConverter(DU, "wind_speed_10m_max", "wind").fn;
    var dT = makeConverter(DU, "temperature_2m_max", "temp").fn, dP = makeConverter(DU, "precipitation_sum", "precip").fn;
    (D.time || []).forEach(function (t, i) {
      function g(n, f) { var a = D[n]; return a && isNum(a[i]) ? (f ? f(a[i]) : a[i]) : null; }
      days.push({ t: t, code: g("weather_code"), tmax: g("temperature_2m_max", dT), tmin: g("temperature_2m_min", dT),
        psum: g("precipitation_sum", dP), pmax: g("precipitation_probability_max"), wmax: g("wind_speed_10m_max", dW2),
        gmax: g("wind_gusts_10m_max", dW), sunrise: g("sunrise"), sunset: g("sunset") });
    });
    var M = j.minutely_15 || {}, MU = j.minutely_15_units || {}, m15 = [];
    var mP = makeConverter(MU, "precipitation", "precip").fn;
    (M.time || []).forEach(function (t, i) {
      var a = M.precipitation;
      m15.push({ t: t, precip: a && isNum(a[i]) ? mP(a[i]) : null });
    });
    return {
      tz: j.timezone || "GMT", tzAbbr: j.timezone_abbreviation || "", utcOffset: isNum(j.utc_offset_seconds) ? j.utc_offset_seconds : 0,
      elevation: num(j.elevation), hours: hours, days: days, m15: m15, unitProblems: problems,
      generationMs: num(j.generationtime_ms)
    };
  }
  function firstHourIndex(hours, nowSec) {
    for (var i = 0; i < hours.length; i++) if (hours[i].t + 3600 > nowSec) return i;
    return Math.max(0, hours.length - 1);
  }
  // Fallback-Kette: fehlende best_match-Werte aus den Modellen ergaenzen (markiert)
  var FALLBACK = { vis: "visibility", pp: "precipitation_probability", w120: "wind_speed_120m", cape: "cape" };
  function applyFallbacks(hours, models) {
    if (!models || !models.length) return 0;
    var filled = 0;
    hours.forEach(function (h) {
      Object.keys(FALLBACK).forEach(function (k) {
        if (h[k] !== null) return;
        for (var m = 0; m < models.length; m++) {
          var row = models[m].byT[h.t];
          if (row && isNum(row[k])) { h[k] = row[k]; (h.fb = h.fb || {})[k] = models[m].id; filled++; return; }
        }
      });
    });
    return filled;
  }
  // Einzelmodell-Antwort → {id, byT: {t: {temp,w10,gust,d10,precip,w120,vis,pp,cape}}}
  function normalizeModel(id, j) {
    var H = j.hourly || {}, U = j.hourly_units || {}, T = H.time || [], byT = {}, any = false;
    var map = { temp: ["temperature_2m", "temp"], w10: ["wind_speed_10m", "wind"], gust: ["wind_gusts_10m", "wind"], d10: ["wind_direction_10m", null],
      precip: ["precipitation", "precip"], w120: ["wind_speed_120m", "wind"], vis: ["visibility", "len"], pp: ["precipitation_probability", null], cape: ["cape", null] };
    var cv = {}; Object.keys(map).forEach(function (k) {
      // Variablen koennen mit Modell-Suffix kommen (z. B. temperature_2m_icon_seamless)
      var nm = map[k][0], key = H[nm] ? nm : (H[nm + "_" + id] ? nm + "_" + id : nm);
      cv[k] = { key: key, fn: makeConverter(U, key, map[k][1]).fn };
    });
    for (var i = 0; i < T.length; i++) {
      var row = {};
      Object.keys(map).forEach(function (k) {
        var a = H[cv[k].key]; var v = a && isNum(a[i]) ? cv[k].fn(a[i]) : null;
        row[k] = isNum(v) ? v : null; if (row[k] !== null) any = true;
      });
      byT[T[i]] = row;
    }
    return { id: id, byT: byT, has: any };
  }
  // Modellstreuung → Vertrauen. hoursT: Liste Zeitstempel (naechste 12 h)
  function modelConfidence(models, hoursT) {
    var gr = [], tr = [], pd = [], perHour = {};
    hoursT.forEach(function (t) {
      var g = [], te = [], wet = 0, n = 0;
      models.forEach(function (m) {
        var r = m.byT[t]; if (!r) return;
        if (isNum(r.gust)) g.push(r.gust);
        if (isNum(r.temp)) te.push(r.temp);
        if (isNum(r.precip)) { n++; if (r.precip >= 0.1) wet++; }
      });
      if (g.length >= 2) { gr.push(Math.max.apply(null, g) - Math.min.apply(null, g)); perHour[t] = { gustMax: Math.max.apply(null, g), gustMin: Math.min.apply(null, g) }; }
      if (te.length >= 2) tr.push(Math.max.apply(null, te) - Math.min.apply(null, te));
      if (n >= 2) { var f = wet / n; pd.push(f > 0 && f < 1 ? Math.min(f, 1 - f) * 2 : 0); }
    });
    function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
    var g = mean(gr), te2 = mean(tr), p = mean(pd);
    if (g === null && te2 === null) return { level: null, perHour: perHour };
    var bad = 0;
    if (isNum(g)) bad += g > 6 ? 2 : g > 3 ? 1 : 0;
    if (isNum(p)) bad += p > 0.5 ? 2 : p > 0.25 ? 1 : 0;
    if (isNum(te2)) bad += te2 > 4 ? 1 : 0;
    return { level: bad >= 3 ? "low" : bad >= 1 ? "medium" : "high", gustRange: g, tempRange: te2, precipDisagree: p, perHour: perHour, n: models.length };
  }
  // Ensemble: Wahrscheinlichkeit P(var > thr) je Zeitstempel
  function ensembleProb(j, base, thr) {
    var H = j.hourly || {}, U = j.hourly_units || {}, T = H.time || [], keys = Object.keys(H).filter(function (k) {
      return k === base || k.indexOf(base + "_member") === 0;
    });
    if (!keys.length) return null;
    var fn = makeConverter(U, keys[0], "wind").fn, out = {};
    T.forEach(function (t, i) {
      var n = 0, c = 0;
      keys.forEach(function (k) { var v = H[k][i]; if (isNum(v)) { n++; if (fn(v) > thr) c++; } });
      out[t] = n ? { p: c / n, n: n } : null;
    });
    return out;
  }

  // METAR (aviationweather.gov Data API, JSON) → SI
  function visToM(v) {
    if (v === null || v === undefined || v === "") return { m: null, plus: false };
    var s = String(v).trim(), plus = /\+$/.test(s) || /^P/i.test(s);
    var core = s.replace(/^[PM]/i, "").replace(/\+$/, "").replace(/SM$/i, "").trim(), n;
    var fr = core.match(/^(?:(\d+)\s+)?(\d+)\/(\d+)$/);
    if (fr) n = (fr[1] ? +fr[1] : 0) + (+fr[2]) / (+fr[3]);
    else n = /^\d+(?:\.\d+)?$/.test(core) ? parseFloat(core) : NaN;
    return { m: isNum(n) ? n * 1609.344 : null, sm: isNum(n) ? n : null, plus: plus };
  }
  function normalizeMetar(o) {
    if (!o || !o.icaoId) return null;
    var vis = visToM(o.visib), clouds = [], ceil = null;
    (o.clouds || []).forEach(function (c) {
      var b = isNum(c.base) ? c.base * 0.3048 : null;
      clouds.push({ cover: c.cover, base: b });
      if ((c.cover === "BKN" || c.cover === "OVC" || c.cover === "OVX" || c.cover === "VV") && isNum(b) && (ceil === null || b < ceil)) ceil = b;
    });
    var kt = 0.514444;
    var cat = o.fltCat || flightCategory(ceil === null ? null : ceil / 0.3048, vis.sm);
    return {
      icao: o.icaoId, name: o.name || o.icaoId, lat: num(o.lat), lon: num(o.lon), elev: num(o.elev),
      time: isNum(o.obsTime) ? o.obsTime : (o.reportTime ? Math.round(Date.parse(o.reportTime) / 1000) : null),
      temp: num(o.temp), dew: num(o.dewp), wdir: isNum(o.wdir) ? o.wdir : null, vrb: o.wdir === "VRB",
      wspd: isNum(o.wspd) ? o.wspd * kt : null, wgst: isNum(o.wgst) ? o.wgst * kt : null,
      vis: vis.m, visPlus: vis.plus, ceiling: ceil, clouds: clouds, cover: o.cover || null,
      altim: num(o.altim), fltCat: cat || null, raw: o.rawOb || ""
    };
  }
  var DEV_TOL = { temp: 4, wind: 15 / 3.6, gust: 20 / 3.6, visRatio: 0.5 };
  function compareModelMetar(h, m) {
    var d = {}, flags = [];
    if (isNum(h.temp) && isNum(m.temp)) { d.temp = h.temp - m.temp; if (Math.abs(d.temp) > DEV_TOL.temp) flags.push("temp"); }
    if (isNum(h.w10) && isNum(m.wspd)) { d.wind = h.w10 - m.wspd; if (Math.abs(d.wind) > DEV_TOL.wind) flags.push("wind"); }
    if (isNum(h.gust) && isNum(m.wgst)) { d.gust = h.gust - m.wgst; if (Math.abs(d.gust) > DEV_TOL.gust) flags.push("gust"); }
    if (isNum(h.vis) && isNum(m.vis) && !(m.visPlus && h.vis >= m.vis)) {
      d.vis = h.vis - m.vis;
      var lo = Math.min(h.vis, m.vis), hi = Math.max(h.vis, m.vis);
      if (hi > 0 && lo / hi < DEV_TOL.visRatio && lo < 8000) flags.push("vis");
    }
    return { delta: d, flags: flags };
  }

  // NOAA SWPC Kp — robust gegen beide Formate (Array-of-Arrays mit Kopfzeile / Objekte)
  function parseKp(j) {
    if (!Array.isArray(j)) return [];
    var out = [];
    if (Array.isArray(j[0])) {
      var hd = j[0].map(function (x) { return String(x).toLowerCase(); });
      var it = hd.indexOf("time_tag"), ik = hd.indexOf("kp"), io = hd.indexOf("observed");
      if (ik < 0) ik = hd.indexOf("kp_index");
      for (var i = 1; i < j.length; i++) {
        var r = j[i], t = Date.parse(String(r[it]).replace(" ", "T") + (/Z$/.test(r[it]) ? "" : "Z"));
        var k = parseFloat(r[ik]);
        if (isNum(t) && isNum(k)) out.push({ t: Math.round(t / 1000), kp: k, type: io >= 0 ? String(r[io] || "").toLowerCase() : "observed" });
      }
    } else {
      j.forEach(function (o) {
        if (!o || typeof o !== "object") return;
        var tt = o.time_tag || o.time || o.timeTag, kk = o.kp !== undefined ? o.kp : (o.Kp !== undefined ? o.Kp : (o.kp_index !== undefined ? o.kp_index : o.estimated_kp));
        var t2 = Date.parse(String(tt).replace(" ", "T") + (/Z$|[+-]\d\d:?\d\d$/.test(tt) ? "" : "Z")), k2 = parseFloat(kk);
        if (isNum(t2) && isNum(k2)) out.push({ t: Math.round(t2 / 1000), kp: k2, type: String(o.observed || o.kp_type || o.type || "observed").toLowerCase() });
      });
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  /* ───────────── Zeit (immer Ortszeit des Spots) ───────────── */
  var fmtCache = {};
  function dtf(lang, tz, opts) {
    var key = lang + "|" + tz + "|" + JSON.stringify(opts);
    if (!fmtCache[key]) {
      try { fmtCache[key] = new Intl.DateTimeFormat(lang, Object.assign({ timeZone: tz }, opts)); }
      catch (e) { fmtCache[key] = null; }
    }
    return fmtCache[key];
  }
  // Fallback ohne Intl-Zeitzone: fester Offset
  function partsByOffset(sec, off) {
    var d = new Date((sec + off) * 1000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay() };
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function fmtTime(sec, tz, lang, h12, off) {
    if (!isNum(sec)) return "\u2014";
    var f = dtf(lang, tz, { hour: "2-digit", minute: "2-digit", hour12: !!h12 });
    if (f) return f.format(new Date(sec * 1000));
    var p = partsByOffset(sec, off || 0);
    return pad2(p.h) + ":" + pad2(p.mi);
  }
  function localHour(sec, tz, off) {
    var f = dtf("en-GB", tz, { hour: "2-digit", hour12: false });
    if (f) return parseInt(f.format(new Date(sec * 1000)), 10) % 24;
    return partsByOffset(sec, off || 0).h;
  }
  function tzOffsetAt(sec, tz) {          // Sekunden, via Intl
    var f = dtf("en-US", tz, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    if (!f) return null;
    var p = {}; f.formatToParts(new Date(sec * 1000)).forEach(function (x) { p[x.type] = x.value; });
    var asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round(asUTC / 1000 - sec);
  }

  /* ───────────── WMO-Wettercodes ───────────── */
  var WMO = {
    0: ["Clear sky", "Klar"], 1: ["Mainly clear", "Überwiegend klar"], 2: ["Partly cloudy", "Teils bewölkt"], 3: ["Overcast", "Bedeckt"],
    45: ["Fog", "Nebel"], 48: ["Rime fog", "Reifnebel"], 51: ["Light drizzle", "Leichter Niesel"], 53: ["Drizzle", "Niesel"], 55: ["Dense drizzle", "Starker Niesel"],
    56: ["Freezing drizzle", "Gefrierender Niesel"], 57: ["Dense freezing drizzle", "Starker gefr. Niesel"], 61: ["Light rain", "Leichter Regen"], 63: ["Rain", "Regen"], 65: ["Heavy rain", "Starker Regen"],
    66: ["Freezing rain", "Gefrierender Regen"], 67: ["Heavy freezing rain", "Starker gefr. Regen"], 71: ["Light snow", "Leichter Schnee"], 73: ["Snow", "Schnee"], 75: ["Heavy snow", "Starker Schnee"],
    77: ["Snow grains", "Schneegriesel"], 80: ["Light showers", "Leichte Schauer"], 81: ["Showers", "Schauer"], 82: ["Violent showers", "Heftige Schauer"],
    85: ["Snow showers", "Schneeschauer"], 86: ["Heavy snow showers", "Starke Schneeschauer"], 95: ["Thunderstorm", "Gewitter"], 96: ["Thunderstorm, hail", "Gewitter mit Hagel"], 99: ["Thunderstorm, heavy hail", "Gewitter, starker Hagel"]
  };
  function wmoText(code, lang) { var e = WMO[code]; return e ? e[lang === "de" ? 1 : 0] : (isNum(code) ? "WMO " + code : "\u2014"); }

  return {
    VERSION: VERSION, isNum: isNum, clamp: clamp, round: round, normLon: normLon,
    distance: distance, bearing: bearing, compass: compass, compassIndex: compassIndex,
    OLC: OLC, parseInput: parseInput, parseUrl: parseUrl, parseCoordText: parseCoordText,
    conv: conv, unconv: unconv, defaultUnits: defaultUnits, toSIFactor: toSIFactor, UNITS: UNITS,
    satVapor: satVapor, dewPoint: dewPoint, relHum: relHum, cloudBaseLCL: cloudBaseLCL, gustFactor: gustFactor,
    shear: shear, densityAltitude: densityAltitude, fogRisk: fogRisk, condensation: condensation,
    thermal: thermal, thunderLevel: thunderLevel, kpLevel: kpLevel, flightCategory: flightCategory,
    sunPosition: sunPosition, sunEvents: sunEvents, moonPosition: moonPosition, moonIllumination: moonIllumination,
    moonPhaseIndex: moonPhaseIndex, moonTimes: moonTimes,
    PROFILES: PROFILES, PROFILE_ORDER: PROFILE_ORDER, cloneProfiles: cloneProfiles, subScore: subScore,
    evaluateHour: evaluateHour, bestWindows: bestWindows,
    HOURLY_VARS: HOURLY_VARS, DAILY_VARS: DAILY_VARS, CORE_VARS: CORE_VARS, LEVELS: LEVELS,
    normalizeForecast: normalizeForecast, firstHourIndex: firstHourIndex, applyFallbacks: applyFallbacks,
    normalizeModel: normalizeModel, modelConfidence: modelConfidence, ensembleProb: ensembleProb,
    normalizeMetar: normalizeMetar, visToM: visToM, compareModelMetar: compareModelMetar, DEV_TOL: DEV_TOL,
    parseKp: parseKp, fmtTime: fmtTime, localHour: localHour, tzOffsetAt: tzOffsetAt, wmoText: wmoText, WMO: WMO
  };
});
