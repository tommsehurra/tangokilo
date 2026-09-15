# Tango Kilo ✈️📡

The telemetry site behind my stream, plus the little tools I built around my FPV and fixed-wing flying. A live overlay while I'm in the air, a flight-path viewer for after you land, and an offline map downloader that puts a moving map right on the radio.

🌐 **Live:** [tangokilo.de](https://www.tangokilo.de) &nbsp;·&nbsp; 📖 **Docs:** [the Wiki](https://github.com/tommsehurra/tangokilo/wiki)

![EdgeTX](https://img.shields.io/badge/EdgeTX-2.10.x-3FA9FF)
![Runs in browser](https://img.shields.io/badge/tools-run%20in%20your%20browser-33D68A)
![Cloudflare Pages](https://img.shields.io/badge/hosted-Cloudflare%20Pages-F38020)
![No build step](https://img.shields.io/badge/build-none%20(vanilla%20JS)-9b6cff)

---

## What this repo is

This is the **static site** for tangokilo.de — plain HTML, CSS and JavaScript, no build step, deployed on Cloudflare Pages. It's three things that don't depend on each other; use whichever you want.

| Page | What it is |
|---|---|
| [`index.html`](index.html) | 🛰️ **Live telemetry overlay** — the page that's on stream. Speed, altitude, battery, an artificial horizon, GPS, all-time records, and a photo gallery. |
| [`flugpfad.html`](flugpfad.html) | 🛩️ **Flight Path Viewer** — drop in a flight log and see it as an interactive 3D map. Reads EdgeTX telemetry CSV **and** raw INAV / Betaflight blackbox logs. Everything runs in your browser — nothing is uploaded. |
| [`maps.html`](maps.html) | 📡 **Map Downloader** — grab offline map tiles for your flying spot, write them to your SD card, and generate the matching **SatMap** EdgeTX widget (`main.lua`). |

Supporting files: `flugspur_parse.js` + `flugspur_report_tpl.html` power the Flight Path Viewer, and `images/` holds the gallery photos (drop a new one in and it shows up on its own).

> ℹ️ The live overlay only shows data while I'm **actually flying and streaming**. Between flights it just sits idle. The two tools work on their own anytime — no stream needed.

---

## 📖 Docs are in the Wiki

The full guides — how the whole thing works, how to use each tool, how to set up the radio widget, and a proper FAQ — live in the **[Wiki](https://github.com/tommsehurra/tangokilo/wiki)**. Start there if you're here to actually use something.

---

## Tech

- **Vanilla HTML / CSS / JS**, no framework, no build step.
- [Leaflet](https://leafletjs.com/) for the map picker in the Map Downloader.
- [CesiumJS](https://cesium.com/platform/cesiumjs/) for the 3D globe in the Flight Path Viewer.
- The blackbox and CSV decoding is hand-rolled and runs entirely client-side (`flugspur_parse.js`).

## Running it locally

It's a static site, so just serve the folder and open it:

```bash
# any static server works
python -m http.server 8080
# then open http://localhost:8080
```

The Flight Path Viewer and Map Downloader work fully offline in the browser. The live overlay needs the telemetry feed to show anything — that backend runs on my machine and isn't part of this repo.

## Deploying

`main` deploys automatically to Cloudflare Pages. Push to `main` → it goes live at tangokilo.de. That's the whole pipeline.

---

Made for my own flying and my stream 🛫 — the tools are here to use, have fun with them.
