/* wx_core.test.js — Unit-Tests (E3) fuer wx_core.js
   Aufruf:  node wx_core.test.js
   REGEL NR.1: keine Koordinaten in dieser Datei. Testpunkte werden zur Laufzeit
   per Zufallsgenerator (fester Seed) erzeugt, in jedes Eingabeformat kodiert und
   wieder geparst (Rundreise). Optionaler Gegencheck Plus Codes gegen die
   offizielle npm-Bibliothek "open-location-code", falls installiert. */
"use strict";
var WX = require("./wx_core.js");
var pass = 0, fail = 0, fails = [];
function ok(cond, name, info) { if (cond) pass++; else { fail++; fails.push(name + (info ? "  → " + info : "")); } }
function near(a, b, tol) { return typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tol; }

// Deterministischer Zufall (mulberry32)
var seed = 0x7a6b1f;
function rnd() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
function randPoint(qLat, qLon) {   // Quadrant: +1/-1; Laenge > 90 erzwingbar
  var lat = (1 + rnd() * 78) * qLat, lon = (1 + rnd() * 178) * qLon;
  return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
}
function dms(v, pos, neg, mode, sym) {
  sym = sym || { d: "\u00B0", m: "'", s: '"' };
  var a = Math.abs(v), d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf), s = (mf - m) * 60, h = v < 0 ? neg : pos;
  if (mode === "ddm") return d + sym.d + mf.toFixed(4) + sym.m + h;
  if (mode === "ddm_comma") return d + sym.d + mf.toFixed(4).replace(".", ",") + sym.m + h;
  if (mode === "spaces") return d + " " + m + " " + s.toFixed(2) + " " + h;
  if (mode === "prefix") return h + " " + d + sym.d + m + sym.m + s.toFixed(2) + sym.s;
  return d + sym.d + m + sym.m + s.toFixed(2) + sym.s + h;
}
function hemiDec(v, pos, neg, prefix) { var h = v < 0 ? neg : pos; return prefix ? h + Math.abs(v).toFixed(6) : Math.abs(v).toFixed(6) + h; }

var FORMATS = [
  ["dec comma-space", function (p) { return p.lat + ", " + p.lon; }],
  ["dec space", function (p) { return p.lat + " " + p.lon; }],
  ["dec semicolon", function (p) { return p.lat + ";" + p.lon; }],
  ["dec slash", function (p) { return p.lat + " / " + p.lon; }],
  ["dec comma nospace", function (p) { return p.lat + "," + p.lon; }],
  ["dec decimal-comma space", function (p) { return String(p.lat).replace(".", ",") + " " + String(p.lon).replace(".", ","); }],
  ["dec decimal-comma semicolon", function (p) { return String(p.lat).replace(".", ",") + "; " + String(p.lon).replace(".", ","); }],
  ["dec decimal-comma comma-space", function (p) { return String(p.lat).replace(".", ",") + ", " + String(p.lon).replace(".", ","); }],
  ["dec plus sign", function (p) { return (p.lat > 0 ? "+" : "") + p.lat + ", " + (p.lon > 0 ? "+" : "") + p.lon; }],
  ["hemi suffix", function (p) { return hemiDec(p.lat, "N", "S") + " " + hemiDec(p.lon, "E", "W"); }],
  ["hemi prefix", function (p) { return hemiDec(p.lat, "N", "S", true) + " " + hemiDec(p.lon, "E", "W", true); }],
  ["hemi lon first", function (p) { return hemiDec(p.lon, "E", "W") + ", " + hemiDec(p.lat, "N", "S"); }],
  ["hemi German O", function (p) { return hemiDec(p.lat, "N", "S") + " " + hemiDec(p.lon, "O", "W"); }],
  ["hemi lowercase", function (p) { return hemiDec(p.lat, "n", "s") + " " + hemiDec(p.lon, "e", "w"); }],
  ["DMS", function (p) { return dms(p.lat, "N", "S") + " " + dms(p.lon, "E", "W"); }],
  ["DMS comma sep", function (p) { return dms(p.lat, "N", "S") + ", " + dms(p.lon, "E", "W"); }],
  ["DMS unicode primes", function (p) { var s = { d: "\u00B0", m: "\u2032", s: "\u2033" }; return dms(p.lat, "N", "S", null, s) + " " + dms(p.lon, "E", "W", null, s); }],
  ["DMS prefix hemi", function (p) { return dms(p.lat, "N", "S", "prefix") + " " + dms(p.lon, "E", "W", "prefix"); }],
  ["DMS lon first", function (p) { return dms(p.lon, "E", "W") + " " + dms(p.lat, "N", "S"); }],
  ["DMS spaces no symbols", function (p) { return dms(p.lat, "N", "S", "spaces") + " " + dms(p.lon, "E", "W", "spaces"); }],
  ["DMS German O", function (p) { return dms(p.lat, "N", "S") + " " + dms(p.lon, "O", "W"); }],
  ["DDM", function (p) { return dms(p.lat, "N", "S", "ddm") + " " + dms(p.lon, "E", "W", "ddm"); }],
  ["DDM decimal comma", function (p) { return dms(p.lat, "N", "S", "ddm_comma") + " " + dms(p.lon, "E", "W", "ddm_comma"); }],
  ["DDM double apostrophe", function (p) { var s = { d: "\u00B0", m: "'", s: "''" }; return dms(p.lat, "N", "S", null, s) + " " + dms(p.lon, "E", "W", null, s); }],
  ["geo URI", function (p) { return "geo:" + p.lat + "," + p.lon; }],
  ["geo URI zero+q", function (p) { return "geo:0,0?q=" + p.lat + "," + p.lon + "(Spot)"; }],
  ["google q", function (p) { return "https://www.google.com/maps?q=" + p.lat + "," + p.lon; }],
  ["google ll", function (p) { return "https://maps.google.com/?ll=" + p.lat + "," + p.lon + "&z=14"; }],
  ["google query", function (p) { return "https://www.google.com/maps/search/?api=1&query=" + p.lat + "%2C" + p.lon; }],
  ["google destination", function (p) { return "https://www.google.com/maps/dir/?api=1&destination=" + p.lat + "," + p.lon; }],
  ["google search path", function (p) { return "https://www.google.de/maps/search/" + p.lat + ",+" + p.lon + "?entry=ttu"; }],
  ["google @ only", function (p) { return "https://www.google.com/maps/@" + p.lat + "," + p.lon + ",15z"; }],
  ["google no scheme", function (p) { return "google.com/maps?q=" + p.lat + "," + p.lon; }],
  ["apple ll", function (p) { return "https://maps.apple.com/?ll=" + p.lat + "," + p.lon + "&q=Spot"; }],
  ["apple q coords", function (p) { return "https://maps.apple.com/?q=" + p.lat + "," + p.lon; }],
  ["osm hash", function (p) { return "https://www.openstreetmap.org/#map=15/" + p.lat + "/" + p.lon; }],
  ["osm mlat", function (p) { return "https://www.openstreetmap.org/?mlat=" + p.lat + "&mlon=" + p.lon + "#map=15/0/0"; }],
  ["osm.org short", function (p) { return "osm.org/#map=12/" + p.lat + "/" + p.lon; }],
  ["bing cp", function (p) { return "https://www.bing.com/maps?cp=" + p.lat + "%7E" + p.lon + "&lvl=14"; }],
  ["here l", function (p) { return "https://share.here.com/l/" + p.lat + "," + p.lon + "?z=15"; }],
  ["komoot @", function (p) { return "https://www.komoot.com/plan/@" + p.lat + "," + p.lon + ",13z"; }],
  ["generic lat lon", function (p) { return "https://example.org/spot?lat=" + p.lat + "&lon=" + p.lon; }],
  ["generic lat lng", function (p) { return "https://example.org/x?lng=" + p.lon + "&lat=" + p.lat; }],
  ["text with url", function (p) { return "Treffpunkt hier: https://www.google.com/maps?q=" + p.lat + "," + p.lon + " bis gleich"; }]
];

// ── 1. Rundreise-Korpus ───────────────────────────────────────────────
var quads = [[1, 1], [1, -1], [-1, 1], [-1, -1]], corpus = 0;
quads.forEach(function (q) {
  for (var rep = 0; rep < 2; rep++) {
    var p = randPoint(q[0], q[1]);
    FORMATS.forEach(function (f) {
      var inp = f[1](p), r = WX.parseInput(inp); corpus++;
      var good = r.ok && r.kind === "coords" && near(r.lat, p.lat, 1e-4) && near(r.lon, p.lon, 1e-4);
      ok(good, "roundtrip " + f[0] + " q" + q.join(""), JSON.stringify(r).slice(0, 160));
    });
  }
});

// Google: Pin (!3d!4d) hat Vorrang vor @ (Kartenmitte)
(function () {
  var pin = randPoint(1, 1), ctr = randPoint(-1, -1);
  var url = "https://www.google.com/maps/place/Some+Field/@" + ctr.lat + "," + ctr.lon + ",17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d" + pin.lat + "!4d" + pin.lon + "!16s";
  var r = WX.parseInput(url); corpus++;
  ok(r.ok && near(r.lat, pin.lat, 1e-6) && near(r.lon, pin.lon, 1e-6) && r.source === "google_pin", "google pin before center", JSON.stringify(r));
  // Name ohne Koordinaten → Geocoder
  r = WX.parseInput("https://www.google.com/maps/place/Flugplatz+Musterfeld/"); corpus++;
  ok(r.ok && r.kind === "query" && r.query === "Flugplatz Musterfeld", "google place name only", JSON.stringify(r));
  // Name + @ → Koordinaten der Kartenmitte, Name als Label
  r = WX.parseInput("https://www.google.com/maps/place/Feld/@" + ctr.lat + "," + ctr.lon + ",15z"); corpus++;
  ok(r.ok && r.kind === "coords" && near(r.lat, ctr.lat, 1e-6) && r.label === "Feld", "google place + center", JSON.stringify(r));
})();

// Reihenfolge-Heuristik: |Wert|>90 ⇒ Laenge (vertauscht eingegeben)
(function () {
  for (var i = 0; i < 4; i++) {
    var q = quads[i], p = { lat: +((5 + rnd() * 80) * q[0]).toFixed(5), lon: +((95 + rnd() * 80) * q[1]).toFixed(5) };
    var r = WX.parseInput(p.lon + ", " + p.lat); corpus++;
    ok(r.ok && r.swapped && near(r.lat, p.lat, 1e-6) && near(r.lon, p.lon, 1e-6), "swap heuristic q" + q.join(""), JSON.stringify(r));
  }
})();

// Plus Codes: voll (Rundreise ueber Kodieren → Dekodieren) und kurz (Bezugsort)
(function () {
  quads.forEach(function (q) {
    var p = randPoint(q[0], q[1]);
    [10, 11, 12].forEach(function (len) {
      var code = WX.OLC.encode(p.lat, p.lon, len), r = WX.parseInput(code); corpus++;
      var tol = len === 10 ? 1.3e-4 : 3e-5;
      ok(r.ok && r.kind === "coords" && near(r.lat, p.lat, tol) && near(r.lon, p.lon, tol), "pluscode full len" + len + " q" + q.join(""), code + " " + JSON.stringify(r));
    });
    var full = WX.OLC.encode(p.lat, p.lon, 10), short = full.slice(4);
    var r2 = WX.parseInput(short + " Musterstadt"); corpus++;
    ok(r2.ok && r2.kind === "pluscode_short" && r2.code === short && r2.ref === "Musterstadt", "pluscode short with ref", JSON.stringify(r2));
    var r3 = WX.parseInput(short); corpus++;
    ok(!r3.ok && r3.error === "pluscode_ref", "pluscode short without ref", JSON.stringify(r3));
    // recoverNearest: Bezug in der Naehe → gleicher Code
    var rec = WX.OLC.recoverNearest(short, p.lat + 0.3, p.lon - 0.3);
    ok(rec === full, "recoverNearest", rec + " vs " + full);
  });
  // Gegencheck gegen offizielle Bibliothek (falls vorhanden)
  var ref = null;
  try { var M = require("open-location-code"); ref = new (M.OpenLocationCode || M)(); } catch (e) { ref = null; }
  if (ref && ref.encode) {
    var n = 0, bad = 0;
    for (var i = 0; i < 400; i++) {
      var lat = rnd() * 180 - 90, lon = rnd() * 360 - 180, len = [4, 6, 8, 10, 11, 12, 13][i % 7];
      var a = WX.OLC.encode(lat, lon, len), b = ref.encode(lat, lon, len); n++;
      if (a !== b) bad++;
      if (len >= 10) { var da = WX.OLC.decode(a), db = ref.decode(b); if (!near(da.latitudeCenter || da.latCenter, db.latitudeCenter, 1e-9) || !near(da.lngCenter, db.longitudeCenter, 1e-9)) bad++; }
      var sh = a.length > 9 ? a.slice(4) : null;
      if (sh && len >= 10) { var rl = lat + (rnd() - 0.5) * 0.4, rg = lon + (rnd() - 0.5) * 0.4; if (WX.OLC.recoverNearest(sh, rl, rg) !== ref.recoverNearest(sh, rl, rg)) bad++; }
    }
    ok(bad === 0, "OLC matches reference library (" + n + " random points)", bad + " mismatches");
  } else console.log("  (Hinweis: npm-Paket open-location-code nicht installiert — Gegencheck uebersprungen)");
  ok(WX.OLC.isValid("8FVC0000+") && WX.OLC.isFull("8FVC0000+") && !WX.OLC.isValid("8FVC000+") && !WX.OLC.isValid("8FVC0000+22") && WX.OLC.isShort("8F+VC"), "OLC validity rules");
})();

// Kaputte / besondere Eingaben (ohne Koordinaten)
(function () {
  var cases = [
    ["", "empty"], ["   ", "empty"], ["x", "too_short"],
    ["///index.home.raft", "w3w_unsupported"], ["///a.b.c", "w3w_unsupported"], ["filled.count.soap", "w3w_unsupported"],
    ["https://maps.app.goo.gl/AbCdEfGh123", "shortlink"], ["https://goo.gl/maps/AbCdEf", "shortlink"],
    ["https://www.google.com/maps", "url_unrecognized"], ["https://www.komoot.com/tour/123", "url_unrecognized"],
    ["geo:abc", "coord_format"], ["N S", "query"], ["Flugplatz Musterfeld", "query"], ["Musterstraße 1, 12345 Musterstadt", "query"]
  ];
  cases.forEach(function (c) {
    var r = WX.parseInput(c[0]); corpus++;
    var got = r.ok ? r.kind : r.error;
    ok(got === c[1], "special input " + JSON.stringify(c[0]), JSON.stringify(r));
  });
  // Zahlen-Unsinn zur Laufzeit erzeugt (keine Fixtures)
  var bigA = (91 + rnd() * 80).toFixed(3), bigB = (181 + rnd() * 100).toFixed(3);
  var r1 = WX.parseInput(bigA + ", " + bigB); corpus++;
  ok(!r1.ok && /range/.test(r1.error), "both out of range", JSON.stringify(r1));
  var minBad = (10 + rnd() * 10).toFixed(0) + "\u00B0" + "75'10\"N " + (10 + rnd() * 10).toFixed(0) + "\u00B0" + "05'10\"E"; corpus++;
  ok(!WX.parseInput(minBad).ok, "DMS minutes >= 60 rejected");
  var amb = (10 + rnd() * 10).toFixed(0) + "," + (100 + rnd() * 900).toFixed(0) + "," + (10 + rnd() * 10).toFixed(0) + "," + (100 + rnd() * 900).toFixed(0); corpus++;
  ok(!WX.parseInput(amb).ok, "ambiguous comma-only input rejected", amb);
  var zero = WX.parseInput("0, 0"); corpus++;
  ok(zero.ok && zero.nullIsland === true, "null island flagged");
  var pole = WX.parseInput("90, 0"); corpus++;
  ok(pole.ok && pole.lat === 90, "pole accepted");
  var wrapLon = (190 + rnd() * 50).toFixed(4), wl = WX.parseInput("geo:" + (10 + rnd() * 10).toFixed(4) + "," + wrapLon); corpus++;
  ok(wl.ok && near(wl.lon, +wrapLon - 360, 1e-9), "longitude normalized to [-180,180]", JSON.stringify(wl));
  var dl = WX.parseInput("geo:" + (-(10 + rnd() * 10)).toFixed(4) + ",180"); corpus++;
  ok(dl.ok && Math.abs(dl.lon) === 180, "date line 180 kept");
  var hemiClash = WX.parseInput(hemiDec(12.5, "N", "S") + " " + hemiDec(13.5, "N", "S")); corpus++;
  ok(!hemiClash.ok, "two latitudes rejected");
})();
ok(corpus >= 60, "corpus size >= 60", String(corpus));
console.log("  Parser-Korpus: " + corpus + " Eingaben");

// ── 2. Formeln gegen Referenzwerte ────────────────────────────────────
ok(near(WX.cloudBaseLCL(20, 10), 1250, 1e-9), "LCL 125 m/K");
ok(WX.cloudBaseLCL(10, 12) === 0, "LCL never negative");
ok(near(WX.dewPoint(20, 50), 9.26, 0.05), "dew point Magnus", WX.dewPoint(20, 50));
ok(near(WX.relHum(20, WX.dewPoint(20, 63)), 63, 0.01), "RH <-> Td roundtrip");
var isa0 = WX.densityAltitude(1013.25, 15, -60);
ok(near(isa0.da, 0, 25) && near(isa0.pa, 0, 1), "density altitude ISA sea level", JSON.stringify(isa0));
var isa1 = WX.densityAltitude(898.76, 8.5, -60);
ok(near(isa1.da, 1000, 30) && near(isa1.pa, 1000, 3), "density altitude ISA 1000 m", JSON.stringify(isa1));
var hot = WX.densityAltitude(1013.25, 35, 20);
ok(hot.da > 650 && hot.da < 850, "density altitude hot+humid", hot.da);
ok(WX.densityAltitude(1013.25, 15, 14).da > WX.densityAltitude(1013.25, 15, -40).da, "humid air is less dense");
ok(near(WX.gustFactor(10, 5), 2, 1e-9) && WX.gustFactor(3, 0.2) === null, "gust factor");
ok(WX.shear(12, 5) === 7 && WX.shear(null, 5) === null, "shear");
ok(WX.flightCategory(400, 10) === "LIFR" && WX.flightCategory(800, 10) === "IFR" && WX.flightCategory(2500, 10) === "MVFR" && WX.flightCategory(5000, 10) === "VFR" && WX.flightCategory(null, 0.5) === "LIFR", "flight categories");
ok(WX.fogRisk(10, 9.5, 1, true) === 2 && WX.fogRisk(10, 2, 5, false) === 0 && WX.fogRisk(null, null, null, false, 600) === 2, "fog risk");
ok(WX.condensation(15, 8).risk === true && WX.condensation(5, 20).risk === false, "condensation direction (cold device into humid air)");
var th = WX.thermal(700, 1500, 20, 8, 100, 1500);
ok(th.wstar > 1.5 && th.wstar < 2.5 && th.lapse > 8 && th.lapse < 9 && th.cls === 2, "thermal w* + lapse", JSON.stringify(th));
ok(WX.thunderLevel(95, 0, 5) === 2 && WX.thunderLevel(3, 1500, -4) === 2 && WX.thunderLevel(3, 600, 1) === 1 && WX.thunderLevel(1, 50, 4) === 0, "thunder levels");

// Einheiten
ok(near(WX.conv("wind", 10, "kmh"), 36, 1e-9) && near(WX.conv("wind", 10, "kn"), 19.438, 1e-3) && near(WX.conv("temp", 20, "F"), 68, 1e-9) && near(WX.unconv("temp", 68, "F"), 20, 1e-9), "unit conversion");
ok(WX.defaultUnits("en-US").wind === "mph" && WX.defaultUnits("de-DE").wind === "kmh" && WX.defaultUnits("de-DE").h12 === false, "default units by locale");

// Sonne: Plausibilitaet ueber Datum/Breite (Referenzvergleich gegen astral: separater Lauf)
(function () {
  var eq = Date.UTC(2027, 2, 20) / 1000;   // Tag-und-Nacht-Gleiche, Aequator, Nullmeridian
  var ev = WX.sunEvents(eq, 0, 0);
  ok(ev.sunrise && ev.sunset && near((ev.sunset - ev.sunrise) / 3600, 12.12, 0.1), "equinox day length at equator", (ev.sunset - ev.sunrise) / 3600);
  var pn = WX.sunEvents(Date.UTC(2027, 11, 21) / 1000, 80, 15);
  ok(pn.polar === "night" && pn.sunrise === null, "polar night");
  var md = WX.sunEvents(Date.UTC(2027, 5, 21) / 1000, 80, 15);
  ok(md.polar === "day", "midnight sun");
  var sp = WX.sunPosition(Date.UTC(2027, 5, 21, 12) - 0, 23.44, 0);
  ok(sp.elevation > 89.5, "subsolar point June solstice", sp.elevation);
  ok(ev.civilDawn < ev.sunrise && ev.sunset < ev.civilDusk && ev.goldenEveningStart < ev.sunset, "event ordering");
})();
// Mond
(function () {
  var t0 = Date.UTC(2027, 0, 1), prev = null, cycle = [];
  for (var d = 0; d < 60; d++) { var il = WX.moonIllumination(t0 + d * 86400000); cycle.push(il.fraction); }
  var max = Math.max.apply(null, cycle), min = Math.min.apply(null, cycle);
  ok(max > 0.98 && min < 0.02, "moon illumination full cycle within 60 days");
})();

// Zeitzonen (Ortszeit des Spots, unabhaengig von der Prozess-Zeitzone)
(function () {
  var winter = Date.UTC(2027, 0, 15, 12) / 1000, summer = Date.UTC(2027, 6, 15, 12) / 1000;
  ok(WX.tzOffsetAt(winter, "Europe/Berlin") === 3600 && WX.tzOffsetAt(summer, "Europe/Berlin") === 7200, "DST offsets Berlin");
  ok(WX.localHour(winter, "Pacific/Kiritimati") === 2 && WX.localHour(winter, "Pacific/Pago_Pago") === 1, "date line zones", WX.localHour(winter, "Pacific/Kiritimati") + "/" + WX.localHour(winter, "Pacific/Pago_Pago"));
  ok(WX.fmtTime(winter, "Asia/Kolkata", "en-GB", false) === "17:30", "half-hour zone", WX.fmtTime(winter, "Asia/Kolkata", "en-GB", false));
  ok(WX.fmtTime(winter, "Invalid/Zone", "en-GB", false, 3600) === "13:00", "invalid tz falls back to offset");
})();

// ── 3. Score-Grenzfaelle ──────────────────────────────────────────────
(function () {
  var P = WX.PROFILES.freestyle;
  function H(o) { return Object.assign({ w10: 2, gust: 3, w80: 3, w120: 3, precip: 0, snow: 0, pp: 0, vis: 30000, code: 1, cape: 0, li: 5, temp: 15, dew: 5, cl: 0 }, o); }
  var day = { sunElev: 30 };
  var e = WX.evaluateHour(H({}), P, day);
  ok(e.level === 0 && e.score === 100, "calm = green 100", JSON.stringify(e));
  e = WX.evaluateHour(H({ gust: P.gust }), P, day);
  ok(e.level === 1 && e.score === 50, "gust exactly at limit = yellow 50", JSON.stringify(e));
  e = WX.evaluateHour(H({ gust: P.gust * 1.01 }), P, day);
  ok(e.level === 2 && e.reasons[0].key === "gust", "gust over limit = red", JSON.stringify(e.reasons[0]));
  e = WX.evaluateHour(H({ gust: P.gust * 0.81 }), P, day);
  ok(e.level === 1, "gust 81% = yellow");
  e = WX.evaluateHour(H({ precip: 0.1 }), WX.PROFILES.lr, day);
  ok(e.level === 2 && e.hard && e.score === 0, "rain with profile none = hard no-go");
  e = WX.evaluateHour(H({ precip: 0.5 }), P, day);
  ok(e.level === 1, "light rain ok-profile = yellow");
  e = WX.evaluateHour(H({}), P, { sunElev: -7 });
  ok(e.level === 2 && e.reasons[0].key === "dark", "darkness = no-go");
  e = WX.evaluateHour(H({}), P, { sunElev: -7, night: true });
  ok(e.level === 0, "night mode ignores darkness");
  e = WX.evaluateHour(H({ vis: 1500 }), P, day);
  ok(e.level === 2 && e.hard, "visibility under minimum = no-go");
  e = WX.evaluateHour(H({ code: 95 }), P, day);
  ok(e.level === 2 && e.hard, "thunderstorm code = no-go");
  e = WX.evaluateHour(H({ temp: 2 }), P, day);
  ok(e.level === 1 && e.reasons[0].key === "cold", "cold = yellow LiPo hint");
  e = WX.evaluateHour(H({}), P, { sunElev: 30, gustSpreadMax: P.gust * 1.2 });
  ok(e.level === 1 && e.reasons[0].key === "uncertain", "model spread downgrades green to yellow");
  e = WX.evaluateHour(H({}), WX.PROFILES.lr, { sunElev: 30, kp: 7.3 });
  ok(e.level === 2, "Kp 7 red for GPS profile");
  e = WX.evaluateHour({}, P, {});
  ok(e.level === null && e.reasons[0].key === "nodata", "no data = unknown, never green");
  e = WX.evaluateHour(H({ vis: null }), P, day);
  ok(e.level === 0, "missing visibility does not count as zero");
  e = WX.evaluateHour(H({ w120: null }), P, day);
  ok(e.level === 0 && !e.reasons.some(function (r) { return r.key === "windAlt"; }), "missing 120 m wind ignored");
  var hrs = [], evs = [], base = 1800000000;
  for (var i = 0; i < 24; i++) { hrs.push({ t: base + i * 3600 }); evs.push({ level: i >= 10 && i < 14 ? 0 : 2, score: i >= 10 && i < 14 ? 90 : 10 }); }
  var bw = WX.bestWindows(hrs, evs, [base]);
  ok(bw[0].start === base + 36000 && bw[0].hours === 4, "best window", JSON.stringify(bw));
})();

// ── 4. Normalisierung ─────────────────────────────────────────────────
(function () {
  var t = 1800000000;
  var j = { timezone: "Europe/Berlin", utc_offset_seconds: 3600, elevation: 123,
    hourly_units: { wind_speed_10m: "km/h", wind_gusts_10m: "km/h", temperature_2m: "°F", visibility: "ft", precipitation: "mm", wind_speed_120m: "furlongs" },
    hourly: { time: [t, t + 3600], wind_speed_10m: [36, null], wind_gusts_10m: [72, 18], temperature_2m: [68, 50], visibility: [1000, 32808.4], precipitation: [0, 0.4], wind_speed_120m: [5, 5], relative_humidity_2m: [50, 60] },
    daily: { time: [t] }, daily_units: {} };
  var n = WX.normalizeForecast(j);
  ok(near(n.hours[0].w10, 10, 1e-9) && near(n.hours[0].gust, 20, 1e-9), "km/h converted to m/s");
  ok(n.hours[1].w10 === null, "missing stays null (never 0)");
  ok(near(n.hours[0].temp, 20, 1e-9), "°F converted to °C");
  ok(near(n.hours[0].vis, 304.8, 1e-6), "visibility ft converted to m");
  ok(n.hours[0].w120 === null && n.unitProblems.length === 1, "unknown unit → null + problem reported", JSON.stringify(n.unitProblems));
  ok(n.hours[0].dewCalc && near(n.hours[0].dew, WX.dewPoint(20, 50), 1e-9), "dew point derived when missing");
  ok(WX.firstHourIndex(n.hours, t + 1800) === 0 && WX.firstHourIndex(n.hours, t + 3700) === 1, "first hour index");
  var m = WX.normalizeModel("icon_seamless", { hourly_units: { wind_gusts_10m: "m/s" }, hourly: { time: [t], wind_gusts_10m: [12], visibility: [5000] } });
  n.hours[1].vis = null;
  WX.applyFallbacks([{ t: t, vis: null, pp: 10, w120: 1, cape: 0 }], [m]);
  var hh = [{ t: t, vis: null, pp: 10, w120: 1, cape: 0 }]; WX.applyFallbacks(hh, [m]);
  ok(hh[0].vis === 5000 && hh[0].fb.vis === "icon_seamless", "fallback chain marks source");
  var m2 = WX.normalizeModel("gfs_seamless", { hourly: { time: [t], wind_gusts_10m: [20], precipitation: [2], temperature_2m: [10] } });
  var m1 = WX.normalizeModel("icon_seamless", { hourly: { time: [t], wind_gusts_10m: [8], precipitation: [0], temperature_2m: [16] } });
  var c = WX.modelConfidence([m1, m2], [t]);
  ok(c.level === "low" && c.perHour[t].gustMax === 20, "model confidence low on big spread", JSON.stringify(c));
  var ens = WX.ensembleProb({ hourly_units: { wind_gusts_10m: "m/s" }, hourly: { time: [t], wind_gusts_10m: [5], wind_gusts_10m_member01: [12], wind_gusts_10m_member02: [8], wind_gusts_10m_member03: [11] } }, "wind_gusts_10m", 10);
  ok(near(ens[t].p, 0.5, 1e-9) && ens[t].n === 4, "ensemble exceedance probability");
})();
(function () {
  var t = 1800000000;
  var metar = WX.normalizeMetar({ icaoId: "TEST", obsTime: t, temp: 12, dewp: 11, wdir: "VRB", wspd: 10, wgst: 20, visib: "10+", clouds: [{ cover: "FEW", base: 2000 }, { cover: "BKN", base: 800 }], rawOb: "TEST" });
  ok(metar.vrb && near(metar.wspd, 5.144, 1e-3) && near(metar.ceiling, 243.84, 1e-6) && metar.visPlus && metar.fltCat === "IFR", "METAR normalize", JSON.stringify(metar));
  ok(near(WX.visToM("1 1/2").m, 2414.016, 1e-3) && WX.visToM("").m === null && near(WX.visToM("1/4").m, 402.336, 1e-3) && WX.visToM("M1/4").m !== null && WX.visToM("6+").plus, "METAR fractional visibility");
  var cmp = WX.compareModelMetar({ temp: 18, w10: 5, gust: 9, vis: 20000 }, metar);
  ok(cmp.flags.indexOf("temp") >= 0 && cmp.flags.indexOf("vis") < 0, "model vs METAR deviation", JSON.stringify(cmp));
  var k1 = WX.parseKp([["time_tag", "Kp", "a_running", "station_count"], ["2027-01-01 00:00:00.000", "2.33", "9", "8"], ["2027-01-01 03:00:00.000", "4.00", "27", "8"]]);
  var k2 = WX.parseKp([{ time_tag: "2027-01-01T00:00:00", kp: 2.33, observed: "observed" }, { time_tag: "2027-01-01T03:00:00", kp: 5.67, observed: "predicted" }]);
  ok(k1.length === 2 && k1[1].kp === 4 && k2.length === 2 && k2[1].type === "predicted" && k1[0].t === k2[0].t, "Kp both formats", JSON.stringify([k1, k2]));
})();

console.log("\n" + pass + " bestanden, " + fail + " fehlgeschlagen");
if (fail) { fails.forEach(function (f) { console.log("  ✗ " + f); }); process.exit(1); }
