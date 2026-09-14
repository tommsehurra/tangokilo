/* flugspur_parse.js
 * Browser-Portierung von flugspur_log.py — liest EdgeTX/OpenTX-Telemetrie-CSV
 * und baut exakt das Flug-Objekt (Payload), das flugspur_report erwartet.
 * Laeuft im Browser (window.FlugspurParse) und in Node (module.exports).
 * Reine Logik, keine Abhaengigkeiten. Ergebnis 1:1 wie das Python-Original.
 */
(function(root){
"use strict";

var CESIUM_VERSION = "1.120";

/* =====================================================================================
 * BB: client-side decoder for raw INAV / Betaflight blackbox logs (Nicholas Sherlock format).
 * Verified value-for-value against the reference decoder (orangebox) across all fields.
 * Self-contained; exposes BB.decode(bytes, opts) -> { headers, sysConfig, fieldNames, rows }.
 * ===================================================================================== */
var BB = (function(){
"use strict";
var ENC_SIGNED_VB=0, ENC_UNSIGNED_VB=1, ENC_NEG_14BIT=3, ENC_TAG8_8SVB=6, ENC_TAG2_3S32=7, ENC_TAG8_4S16=8, ENC_NULL=9;
var P_0=0, P_PREVIOUS=1, P_STRAIGHT=2, P_AVERAGE2=3, P_MINTHROTTLE=4, P_MOTOR0=5,
    P_INC=6, P_HOME0=7, P_1500=8, P_VBATREF=9, P_LAST_MAIN_TIME=10, P_MINMOTOR=11, P_HOME1=256;
var TWO32=4294967296;
function sx(v,bits){ var m=Math.pow(2,bits-1); return (v & (m-1)) - (v & m); }
function sx8(v){ return v<0x80?v:v-0x100; }
function sx16(v){ return v<0x8000?v:v-0x10000; }
function sx24(v){ return v<0x800000?v:v-0x1000000; }
function sx14(v){ return v<0x2000?v:v-0x4000; }
function sx2(v){ return v<0x2?v:v-0x4; }
function sx4(v){ return v<0x8?v:v-0x10; }
function sx6(v){ return v<0x20?v:v-0x40; }
function Stream(bytes){ this.b=bytes; this.i=0; this.n=bytes.length; }
Stream.prototype.u8=function(){ return this.b[this.i++]; };
Stream.prototype.peek=function(){ return this.i<this.n ? this.b[this.i] : -1; };
Stream.prototype.eof=function(){ return this.i>=this.n; };
Stream.prototype.uvb=function(){ var r=0, sh=0, b, k=0; for(k=0;k<5;k++){ b=this.b[this.i++]; r += (b & 0x7f) * Math.pow(2,sh); if(b<128) return r; sh+=7; } return r; };
Stream.prototype.svb=function(){ var u=this.uvb(); var m=u % TWO32; var h=Math.floor(m/2); return (m%2) ? -(h+1) : h; };
Stream.prototype.tag8_8svb=function(n,out){ if(n===1){ out[0]=this.svb(); return; } var h=this.u8(), i; for(i=0;i<n;i++){ out[i] = (h & 0x01) ? this.svb() : 0; h>>=1; } };
Stream.prototype.tag2_3s32=function(out){
  var lead=this.u8(), sh=lead>>6, i, a,b,c,d, ft;
  if(sh===0){ out[0]=sx2((lead>>4)&3); out[1]=sx2((lead>>2)&3); out[2]=sx2(lead&3); }
  else if(sh===1){ out[0]=sx4(lead&0x0F); a=this.u8(); out[1]=sx4(a>>4); out[2]=sx4(a&0x0F); }
  else if(sh===2){ out[0]=sx6(lead&0x3F); out[1]=sx6(this.u8()&0x3F); out[2]=sx6(this.u8()&0x3F); }
  else{ for(i=0;i<3;i++){ ft=lead&0x03;
    if(ft===0){ out[i]=sx8(this.u8()); }
    else if(ft===1){ a=this.u8(); b=this.u8(); out[i]=sx16(a|(b<<8)); }
    else if(ft===2){ a=this.u8(); b=this.u8(); c=this.u8(); out[i]=sx24(a|(b<<8)|(c<<16)); }
    else { a=this.u8(); b=this.u8(); c=this.u8(); d=this.u8(); out[i]= a + b*256 + c*65536 + d*16777216; }
    lead>>=2; } }
};
Stream.prototype.tag8_4s16v2=function(out){
  var sel=this.u8(), i, ft, nib=0, buf=0, a, b;
  for(i=0;i<4;i++){ ft=sel&0x03;
    if(ft===0){ out[i]=0; }
    else if(ft===1){ if(nib===0){ buf=this.u8(); out[i]=sx4(buf>>4); nib=1; } else { out[i]=sx4(buf&0x0F); nib=0; } }
    else if(ft===2){ if(nib===0){ out[i]=sx8(this.u8()); } else { a=(buf&0x0F)<<4; buf=this.u8(); a|=buf>>4; out[i]=sx8(a); } }
    else{ if(nib===0){ a=this.u8(); b=this.u8(); out[i]=sx16((a<<8)|b); } else { a=this.u8(); b=this.u8(); out[i]=sx16(((buf&0x0F)<<12)|(a<<4)|(b>>4)); buf=b; } }
    sel>>=2; }
};
function parseHeaderAndDefs(bytes){
  var pos=0, n=bytes.length, H={}, dataStart=n;
  while(pos<n){
    if(bytes[pos]===0x49){ dataStart=pos; break; }
    var le=pos; while(le<n && bytes[le]!==0x0A) le++;
    if(bytes[pos]===0x48){ var s=""; for(var k=pos+2;k<le;k++) s+=String.fromCharCode(bytes[k]); var ci=s.indexOf(":"); if(ci>=0) H[s.slice(0,ci).trim()] = s.slice(ci+1); pos = le+1; }
    else { dataStart = (le<n)? le+1 : n; break; }
  }
  return { H:H, dataStart:dataStart };
}
function intList(v){ return String(v).split(",").map(function(x){ return parseInt(x.trim(),10); }); }
function buildDefs(H){
  function fieldDef(letter){ var name=H["Field "+letter+" name"]; if(name===undefined) return null;
    return { names:String(name).split(",").map(function(x){return x.trim();}),
      signed:H["Field "+letter+" signed"]?intList(H["Field "+letter+" signed"]):null,
      predictor:H["Field "+letter+" predictor"]?intList(H["Field "+letter+" predictor"]):null,
      encoding:H["Field "+letter+" encoding"]?intList(H["Field "+letter+" encoding"]):null }; }
  var I=fieldDef("I"), G=fieldDef("G"), Hh=fieldDef("H"), S=fieldDef("S");
  if(I){ I.count=I.names.length; }
  var Pdef=null;
  if(I && H["Field P predictor"] && H["Field P encoding"]){ Pdef={ names:I.names, count:I.count, signed:I.signed, predictor:intList(H["Field P predictor"]), encoding:intList(H["Field P encoding"]) }; }
  [G,Hh,S].forEach(function(d){ if(d) d.count=d.names.length; });
  function fixCoord(def){ if(!def||!def.predictor) return; for(var i=0;i<def.count;i++){ if(def.names[i]==="GPS_coord[1]" && def.predictor[i]===7) def.predictor[i]=256; } }
  fixCoord(G);
  var motorOut = H["motorOutput"]?intList(H["motorOutput"]):[1000,2000];
  var sys={ minthrottle: H["minthrottle"]!==undefined?parseInt(H["minthrottle"],10):(motorOut[0]||1000),
    motorOutputLow: motorOut[0], motorOutputHigh: motorOut[1],
    vbatref: H["vbatref"]!==undefined?parseInt(H["vbatref"],10):4095,
    dataVersion: H["Data version"]!==undefined?parseInt(H["Data version"],10):2,
    iInterval: H["I interval"]!==undefined?parseInt(H["I interval"],10):32,
    pNum:1, pDenom:1, craft:H["Craft name"]||"", firmware:H["Firmware revision"]||"", logStart:H["Log start datetime"]||"" };
  if(sys.iInterval<1) sys.iInterval=1;
  var pint=H["P interval"];
  if(pint){ var mm=/(\d+)\s*\/\s*(\d+)/.exec(pint); if(mm){ sys.pNum=+mm[1]; sys.pDenom=+mm[2]; } else { var pv=parseInt(pint,10); if(!isNaN(pv)){ sys.pNum=1; sys.pDenom=pv; } } }
  return { I:I, P:Pdef, G:G, H:Hh, S:S, sys:sys, raw:H };
}
var FRAME_CHARS={0x49:1,0x50:1,0x47:1,0x48:1,0x53:1,0x45:1};
function zeros(n){ var a=new Array(n); for(var i=0;i<n;i++) a[i]=0; return a; }
function strToBytes(s){ var n=s.length, a=new Uint8Array(n); for(var i=0;i<n;i++) a[i]=s.charCodeAt(i)&0xff; return a; }
function decode(input, opts){
  opts=opts||{};
  var maxRows = opts.maxRows || Infinity;
  var bytes = (typeof input==="string") ? strToBytes(input) : input;
  var hd = parseHeaderAndDefs(bytes);
  var defs = buildDefs(hd.H);
  if(!defs.I) throw new Error("Not a blackbox log (no 'Field I name' header).");
  var sys=defs.sys;
  var st=new Stream(bytes); st.i=hd.dataStart;
  var Icount=defs.I.count, Gdef=defs.G, Gcount=Gdef?Gdef.count:0, Sdef=defs.S, Scount=Sdef?Sdef.count:0, Hdef=defs.H;
  var past0=zeros(Icount), past1=zeros(Icount), past2=zeros(Icount);
  var homeVals=[0,0], homeSet=false, lastSlow=null, lastGps=null;
  var haveMain=false, lastIter=-1;
  var motor0Index=-1, timeIndex=1, loopIndex=0;
  for(var q=0;q<Icount;q++){ var nm=defs.I.names[q]; if(nm==="motor[0]")motor0Index=q; if(nm==="time")timeIndex=q; if(nm==="loopIteration")loopIndex=q; }
  var mergedNames=[], seen={};
  (function(){ function add(a){ if(!a)return; for(var i=0;i<a.length;i++){ if(!seen[a[i]]){ seen[a[i]]=1; mergedNames.push(a[i]); } } }
    add(defs.I.names); if(Sdef) add(Sdef.names); if(Gdef) add(Gdef.names); })();
  var tmp=[0,0,0,0,0,0,0,0], rows=[];
  var wl=null; if(opts.fields && opts.fields.length){ wl={}; for(var w=0;w<opts.fields.length;w++) wl[opts.fields[w]]=1; }
  var minDtUs = opts.minDtUs || 0, lastEmitTime = null;
  function shouldHaveFrameAt(index){ return ((index % sys.iInterval) + sys.pNum - 1) % sys.pDenom < sys.pNum; }
  function countSkipped(){ if(lastIter===-1) return 0; var idx=lastIter+1; while(!shouldHaveFrameAt(idx)) idx++; return idx-lastIter-1; }
  function applyPred(pred, fieldIdx, raw, cur, prevArr, prev2Arr){
    switch(pred){
      case P_0: return raw;
      case P_PREVIOUS: return raw + prevArr[fieldIdx];
      case P_STRAIGHT: return raw + 2*prevArr[fieldIdx] - prev2Arr[fieldIdx];
      case P_AVERAGE2: return raw + Math.trunc((prevArr[fieldIdx] + prev2Arr[fieldIdx]) / 2);
      case P_MINTHROTTLE: return raw + sys.minthrottle;
      case P_MOTOR0: return raw + (motor0Index>=0 ? cur[motor0Index] : 0);
      case P_INC: return 1 + prevArr[fieldIdx] + countSkipped();
      case P_HOME0: return homeSet ? raw + homeVals[0] : 0;
      case P_HOME1: return homeSet ? raw + homeVals[1] : 0;
      case P_1500: return raw + 1500;
      case P_VBATREF: return raw + sys.vbatref;
      case P_LAST_MAIN_TIME: return raw + prev2Arr[fieldIdx];
      case P_MINMOTOR: return raw + sys.motorOutputLow;
      default: return raw;
    }
  }
  function parseFrame(def, prevArr, prev2Arr){
    var cur=new Array(def.count), i=0, enc, n, j;
    while(i<def.count){ enc=def.encoding[i];
      if(enc===ENC_SIGNED_VB){ cur[i]=st.svb(); i++; }
      else if(enc===ENC_UNSIGNED_VB){ cur[i]=st.uvb(); i++; }
      else if(enc===ENC_NEG_14BIT){ cur[i]= -sx14(st.uvb()); i++; }
      else if(enc===ENC_NULL){ cur[i]=0; i++; }
      else if(enc===ENC_TAG8_8SVB){ n=1; while(n<8 && (i+n)<def.count && def.encoding[i+n]===ENC_TAG8_8SVB) n++; st.tag8_8svb(n,tmp); for(j=0;j<n;j++) cur[i+j]=tmp[j]; i+=n; }
      else if(enc===ENC_TAG2_3S32){ st.tag2_3s32(tmp); for(j=0;j<3;j++) cur[i+j]=tmp[j]; i+=3; }
      else if(enc===ENC_TAG8_4S16){ st.tag8_4s16v2(tmp); for(j=0;j<4;j++) cur[i+j]=tmp[j]; i+=4; }
      else throw new Error("Unsupported blackbox encoding "+enc+" ("+def.names[i]+")");
    }
    for(i=0;i<def.count;i++) cur[i]=applyPred(def.predictor[i], i, cur[i], cur, prevArr, prev2Arr);
    return cur;
  }
  function emitRow(cur){
    var o={}, i, n2;
    for(i=0;i<Icount;i++){ n2=defs.I.names[i]; if(!wl || wl[n2]) o[n2]=cur[i]; }
    if(Sdef){ for(i=0;i<Scount;i++){ n2=Sdef.names[i]; if((!wl||wl[n2]) && o[n2]===undefined) o[n2]= lastSlow?lastSlow[i]:null; } }
    if(Gdef){ for(i=0;i<Gcount;i++){ n2=Gdef.names[i]; if((!wl||wl[n2]) && o[n2]===undefined) o[n2]= lastGps?lastGps[i]:null; } }
    rows.push(o);
  }
  function parseEvent(){
    if(st.eof()) return false;
    var et=st.u8();
    if(et===0){ st.uvb(); }
    else if(et===13){ st.u8(); st.svb(); }
    else if(et===14){ st.uvb(); st.uvb(); }
    else if(et===30){ st.uvb(); st.uvb(); }
    else if(et===255){ var g=0; while(!st.eof() && g<32){ if(st.u8()===0) break; g++; } return false; }
    else { return false; }
    return true;
  }
  var lastFramePos=st.i, lastFrameCorrupt=false, cmd, cont=true;
  while(cont && !st.eof() && rows.length<maxRows){
    var here=st.i; cmd=st.u8();
    if(!FRAME_CHARS[cmd]){ if(!lastFrameCorrupt){ st.i=lastFramePos+1; } lastFrameCorrupt=true; continue; }
    lastFrameCorrupt=false; lastFramePos=here;
    if(cmd===0x45){ cont=parseEvent(); continue; }
    if(cmd===0x53){ if(Sdef) lastSlow=parseFrame(Sdef, past0, past1); continue; }
    if(cmd===0x47){ if(Gdef) lastGps=parseFrame(Gdef, past0, past1); continue; }
    if(cmd===0x48){ if(Hdef){ var hf=parseFrame(Hdef, past0, past1); homeVals[0]=hf[0]; homeVals[1]=hf[1]; homeSet=true; } continue; }
    var isI = (cmd===0x49);
    if(!isI && !haveMain) continue;
    var cur = parseFrame(isI?defs.I:defs.P, past0, past1);
    lastIter = cur[loopIndex];
    var nb = st.peek();
    if(nb<0 || !FRAME_CHARS[nb]) continue; // corrupt frame -> drop
    if(isI){ past0=cur; past1=cur.slice(); past2=cur.slice(); } else { past2=past1; past1=past0; past0=cur; }
    haveMain=true;
    var ct = cur[timeIndex];
    if(minDtUs && lastEmitTime!==null && (ct - lastEmitTime) < minDtUs) continue;
    lastEmitTime = ct; emitRow(cur);
  }
  return { headers:defs.raw, sysConfig:sys, fieldNames:mergedNames, rows:rows, dataStart:hd.dataStart };
}
return { decode:decode, strToBytes:strToBytes };
})();

/* Fields we pull from a blackbox log, and the extra channels they feed (beyond the CSV set). */
var BB_FIELDS = ["time","GPS_coord[0]","GPS_coord[1]","GPS_altitude","GPS_speed","GPS_ground_course",
  "GPS_numSat","GPS_hdop","BaroAlt","AirSpeed","vbat","sagCompensatedVBat","amperage","rssi",
  "attitude[0]","attitude[1]","attitude[2]","navVel[2]","baroTemperature","wind[0]","wind[1]",
  "escRPM","escTemperature","IMUTemperature","accSmooth[0]","accSmooth[1]","accSmooth[2]"];
var EXTRA_KEYS = ["airspd","balt","vbatsag","baroT","windspd","hdop","gforce","rpm","esct","imut"];

function bbLooksLikeBlackbox(bytes){
  var lim=Math.min(bytes.length, 400), s="";
  for(var i=0;i<lim;i++) s+=String.fromCharCode(bytes[i]);
  return /H Product:Blackbox|Field I name/.test(s);
}
function bbSecOfDay(iso){
  var m=/(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(iso||"");
  if(!m) return { date:"", sec:0 };
  return { date:m[1], sec:parseInt(m[2],10)*3600+parseInt(m[3],10)*60+parseFloat(m[4]) };
}

var ALIASES = {
  gps:    ["gps","gpscoord","gpscoords","coords","position"],
  lat:    ["lat","latitude","gpslat","glat","gpslatitude"],
  lon:    ["lon","long","longitude","gpslon","glon","gpslongitude"],
  alt:    ["alt","galt","gpsalt","altitude","height","hgt","balt"],
  spd:    ["gspd","gpsspeed","gspeed","speed","spd","gsp"],
  vspd:   ["vspd","vspeed","vsi","vario","climb","vv"],
  hdg:    ["hdg","heading","cog","course","gpshdg","track"],
  sats:   ["sats","satellites","numsat","gpssats","sat"],
  dist:   ["dist","distance","gpsdist","dtoh","disttohome","home"],
  rxbt:   ["rxbt","rxbat","vfas","vbat","batt","voltage","a1","rxv"],
  curr:   ["curr","current","amps","a","a2"],
  capa:   ["capa","capacity","mah","consumption","used","fuel"],
  batpct: ["bat","batpercent","batt","battery","remain"],
  rqly:   ["rqly","rql","lq","linkquality","rssi"],
  rss1:   ["1rss","rss1","rssi1","1rssi","rssidbm"],
  rss2:   ["2rss","rss2","rssi2","2rssi"],
  rsnr:   ["rsnr","snr","1snr"],
  tpwr:   ["tpwr","txpower","power"],
  tqly:   ["tqly","tql"],
  trss:   ["trss","trssi"],
  ptch:   ["ptch","pitch"],
  roll:   ["roll"],
  yaw:    ["yaw"],
  fm:     ["fm","flightmode","mode","fmod"],
  txbat:  ["txbat","txbatt","txv","txvoltage","tx"],
  rfmd:   ["rfmd","rfmode"]
};
var FIELD_ORDER = ["gps","lat","lon","alt","spd","vspd","hdg","sats","dist",
  "rss1","rss2","rsnr","rqly","tqly","trss","tpwr","rfmd",
  "rxbt","curr","capa","ptch","roll","yaw","fm","txbat","batpct"];

var NUM_RE = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?$/;

function norm(name){
  name = String(name).trim();
  name = name.replace(/[([{].*?[)\]}]/g, "");
  name = name.replace(/%/g,"").replace(/°/g,"");
  name = name.replace(/[^0-9A-Za-z]/g,"");
  return name.toLowerCase();
}
function unit(name){
  var m = /[([{](.*?)[)\]}]/.exec(String(name));
  if (!m) return "";
  return m[1].replace(/[^0-9A-Za-z/]/g,"").toLowerCase();
}
function toFloat(raw){
  if (raw === null || raw === undefined) return null;
  var s = String(raw).trim().replace(/^"|"$/g,"").trim();
  if (!s) return null;
  var low = s.toLowerCase();
  if (low==="-"||low==="--"||low==="n/a"||low==="na"||low==="nan"||low==="null") return null;
  if (s.indexOf("0x")===0 || s.indexOf("0X")===0) return null;
  if (!NUM_RE.test(s)) return null;
  if (s.indexOf(",")>=0 && s.indexOf(".")<0) s = s.replace(/,/g,".");
  else s = s.replace(/,/g,"");
  var v = parseFloat(s);
  return isNaN(v) ? null : v;
}
function parseClock(s){
  if (!s) return null;
  s = String(s).trim().replace(/^"|"$/g,"");
  var m = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:[.,]\d+)?))?$/.exec(s);
  if (!m) return null;
  var h = parseInt(m[1],10), mi = parseInt(m[2],10);
  var se = parseFloat((m[3]||"0").replace(",","."));
  return h*3600 + mi*60 + se;
}
function speedFactor(u){ if(["kmh","kph","kmph","kmh1"].indexOf(u)>=0)return 1; if(["ms","m/s","mps"].indexOf(u)>=0)return 3.6; if(u==="mph")return 1.609344; if(["kts","kt","knots","kn"].indexOf(u)>=0)return 1.852; return 1; }
function lenFactor(u){ if(["ft","feet","foot"].indexOf(u)>=0)return 0.3048; return 1; }
function vspdFactor(u){ if(["fts","ft/s"].indexOf(u)>=0)return 0.3048; if(["ftmin","ft/min","fpm"].indexOf(u)>=0)return 0.00508; return 1; }

function sniffDelim(line){
  var best=",",bc=-1, ds=[",",";","\t","|"];
  for(var i=0;i<ds.length;i++){ var c=line.split(ds[i]).length-1; if(c>bc){bc=c;best=ds[i];} }
  return bc>0?best:",";
}
function splitCSV(line, delim){
  var out=[], cur="", q=false;
  for(var i=0;i<line.length;i++){
    var ch=line[i];
    if(q){ if(ch==='"'){ if(line[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=ch; }
    else { if(ch==='"') q=true; else if(ch===delim){ out.push(cur); cur=""; } else cur+=ch; }
  }
  out.push(cur);
  return out;
}
function haversine(la1,lo1,la2,lo2){
  var R=6371008.8, p1=la1*Math.PI/180, p2=la2*Math.PI/180;
  var dp=p2-p1, dl=(lo2-lo1)*Math.PI/180;
  var a=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);
  return 2*R*Math.asin(Math.min(1, Math.sqrt(a)));
}
function median(vals){
  var v=vals.slice().sort(function(a,b){return a-b;});
  if(!v.length) return null;
  var m=Math.floor(v.length/2);
  return v.length%2 ? v[m] : (v[m-1]+v[m])/2;
}
function r1(x,nd){ if(x===null||x===undefined) return null; var f=Math.pow(10,nd); return Math.round(x*f)/f; }
function ri(x){ if(x===null||x===undefined) return null; return Math.round(x); }
function pad2(n){ return (n<10?"0":"")+n; }

var GROUND_SPEED=6.0, GROUND_ALT=25.0, GROUND_SECONDS=2.0;
var LAND_ALT=30.0, LAND_SPEED=18.0, LAND_TAIL=2.0, LAND_GAP=5.0;

function LogError(msg){ this.name="LogError"; this.message=msg; }

function loadCsv(text, sourceName, maxPoints){
  maxPoints = maxPoints || 25000;
  if(!text || !text.length) throw new LogError("The file is empty.");
  var lines = text.split(/\r\n|\r|\n/);
  // erste nicht-leere Zeile = Header
  var hi=0; while(hi<lines.length && !lines[hi].trim()) hi++;
  if(hi>=lines.length) throw new LogError("The first line of the file is empty \u2013 the header row is missing.");
  var first = lines[hi];
  var delim = sniffDelim(first);
  var header = splitCSV(first, delim).map(function(h){return h.trim();});
  var rows = [];
  for(var i=hi+1;i<lines.length;i++){ if(lines[i].length) rows.push(splitCSV(lines[i], delim)); }
  // trailing leere Zeile faellt weg (letzte Zeile ""), aber splitCSV("") -> [""], laenge<2 filtert unten
  if(!rows.length) throw new LogError("The file has a header row but no data rows.");

  var nrm = header.map(norm), un = header.map(unit);

  var idx={}, used={};
  for(var fo=0; fo<FIELD_ORDER.length; fo++){
    var fname=FIELD_ORDER[fo], al=ALIASES[fname];
    for(var a=0;a<al.length;a++){
      var hit=null;
      for(var c=0;c<nrm.length;c++){ if(used[c]||!nrm[c])continue; if(nrm[c]===al[a]){hit=c;break;} }
      if(hit!==null){ idx[fname]=hit; used[hit]=true; break; }
    }
  }
  var iTime=null, iDate=null;
  for(var t=0;t<nrm.length;t++){ if(nrm[t]==="time"&&iTime===null)iTime=t; if(nrm[t]==="date"&&iDate===null)iDate=t; }

  var haveComb = idx.gps!==undefined;
  var haveSplit = idx.lat!==undefined && idx.lon!==undefined;
  if(!(haveComb||haveSplit)){
    throw new LogError("No GPS column found.\n\nExpected either a 'GPS' column with 'lat lon' "+
      "(EdgeTX standard) or separate columns for latitude and longitude. Check that GPS telemetry was "+
      "recorded on the radio.\n\nColumns found: "+header.slice(0,14).join(", ")+(header.length>14?" ...":""));
  }

  var fSpd = idx.spd!==undefined ? speedFactor(un[idx.spd]) : 1;
  var fAlt = idx.alt!==undefined ? lenFactor(un[idx.alt]) : 1;
  var fVspd = idx.vspd!==undefined ? vspdFactor(un[idx.vspd]) : 1;
  var fDist = idx.dist!==undefined ? lenFactor(un[idx.dist]) : 1;
  var attRad = (idx.ptch!==undefined ? un[idx.ptch] : "").indexOf("rad")>=0;

  function cell(row,key){ var i=idx[key]; if(i===undefined||i>=row.length) return null; return row[i]; }
  function num(row,key){ return toFloat(cell(row,key)); }

  // Rohdurchlauf
  var raw=[], prevClock=null, dayOff=0, badGps=0;
  for(var ri2=0; ri2<rows.length; ri2++){
    var row=rows[ri2];
    if(row.length<2) continue;
    var la=null, lo=null;
    if(haveComb){
      var v=cell(row,"gps");
      if(v){ var parts=String(v).trim().replace(/^"|"$/g,"").split(/[\s,;]+/).filter(function(p){return p;});
        if(parts.length>=2){ la=toFloat(parts[0]); lo=toFloat(parts[1]); } }
    }
    if(la===null && haveSplit){ la=num(row,"lat"); lo=num(row,"lon"); }
    if(la===null||lo===null){ badGps++; continue; }
    if(!(la>=-90&&la<=90)||!(lo>=-180&&lo<=180)){ badGps++; continue; }
    if(Math.abs(la)<1e-4 && Math.abs(lo)<1e-4){ badGps++; continue; }
    var cl=null;
    if(iTime!==null && iTime<row.length) cl=parseClock(row[iTime]);
    if(cl===null) cl=ri2*0.4;
    if(prevClock!==null && cl+dayOff < prevClock-43200) dayOff+=86400;
    cl+=dayOff; prevClock=cl;
    raw.push([cl,la,lo,row]);
  }
  if(raw.length<2) throw new LogError("The log has no usable GPS position ("+badGps+
    " rows without a fix). It was probably recorded without GPS reception.");

  var fl={ source_name:sourceName||"log.csv", date:"", notes:[], fm_names:[], cols:{},
    t:[],clock:[],lat:[],lon:[],alt:[],spd:[],vspd:[],hdg:[],dist:[],sats:[],
    rxbt:[],curr:[],capa:[],rqly:[],rss1:[],rss2:[],rsnr:[],tpwr:[],ptch:[],roll:[],yaw:[],txbat:[],fm:[],
    home:[0,0], land:null, land_i:null, alt_mode:"relative", home_known:true, home_source:"start",
    alt_ref:0, alt_base:0, dist_ref:"home", sample_rate:0, n_raw:raw.length, decimated:1,
    _alt_min:0, have:{}, line_idx:[], flight_from:0, flight_to:0, stats:{} };

  if(iDate!==null && rows.length && iDate<rows[0].length) fl.date = String(rows[0][iDate]).trim().replace(/^"|"$/g,"");
  var ck; for(ck in idx){ if(idx.hasOwnProperty(ck)) fl.cols[ck]=header[idx[ck]]; }

  var span = raw[raw.length-1][0]-raw[0][0];
  fl.sample_rate = span>0 ? (raw.length-1)/span : 0;
  var step=1;
  if(raw.length>maxPoints){
    step=Math.ceil(raw.length/maxPoints);
    var dec=[]; for(var s2=0;s2<raw.length;s2+=step) dec.push(raw[s2]);
    fl.notes.push("Log reduced to every "+step+" sample ("+dec.length+" of "+fl.n_raw+") so the map stays smooth.");
    raw=dec;
  }
  fl.decimated=step;

  var t0=raw[0][0], homeLat=raw[0][1], homeLon=raw[0][2];
  var fmMap={};

  var chan=[["sats",0],["rxbt",2],["curr",1],["capa",0],["rqly",0],["rss1",0],["rss2",0],["rsnr",0],["tpwr",0],["txbat",2]];
  for(var k=0;k<raw.length;k++){
    var c=raw[k][0], la2=raw[k][1], lo2=raw[k][2], row2=raw[k][3];
    fl.t.push(r1(c-t0,2));
    var hh=Math.floor(c/3600)%24, mm=Math.floor((c%3600)/60), ss=c%60;
    fl.clock.push(pad2(hh)+":"+pad2(mm)+":"+(ss<10?"0":"")+ss.toFixed(1));
    fl.lat.push(r1(la2,6)); fl.lon.push(r1(lo2,6));
    var A=num(row2,"alt"); fl.alt.push(A!==null?r1(A*fAlt,1):null);
    var S=num(row2,"spd"); fl.spd.push(S!==null?r1(S*fSpd,1):null);
    var V=num(row2,"vspd"); fl.vspd.push(V!==null?r1(V*fVspd,1):null);
    var H=num(row2,"hdg"); fl.hdg.push(H!==null?((Math.round(((H%360)+360)%360))%360):null);
    var D=num(row2,"dist"); fl.dist.push(D!==null?Math.round(D*fDist):null);
    for(var ch=0;ch<chan.length;ch++){
      var key=chan[ch][0], nd=chan[ch][1], x=num(row2,key);
      if(x===null) fl[key].push(null); else if(nd===0) fl[key].push(Math.round(x)); else fl[key].push(r1(x,nd));
    }
    var att=[["ptch",fl.ptch],["roll",fl.roll],["yaw",fl.yaw]];
    for(var at=0;at<att.length;at++){ var xx=num(row2,att[at][0]);
      att[at][1].push(xx===null?null:r1(attRad?xx*180/Math.PI:xx,1)); }
    var mo=cell(row2,"fm");
    if(mo===null) fl.fm.push(-1);
    else { mo=String(mo).trim().replace(/^"|"$/g,""); if(!mo) fl.fm.push(-1);
      else { if(!(mo in fmMap)){ fmMap[mo]=fl.fm_names.length; fl.fm_names.push(mo); } fl.fm.push(fmMap[mo]); } }
  }

  var n=fl.t.length;
  fl.home=[homeLat,homeLon];
  fl.start_clock=fl.clock[0];
  var haveKeys=["alt","spd","vspd","hdg","sats","rxbt","curr","capa","rqly","rss1","rss2","rsnr","tpwr","ptch","roll","yaw","txbat"];
  for(var hk=0;hk<haveKeys.length;hk++){ var arr=fl[haveKeys[hk]]; fl.have[haveKeys[hk]]=arr.some(function(x){return x!==null;}); }
  fl.have.dist=true; fl.have.fm=fl.fm_names.length>0;

  resolveReference(fl);

  var loI=null, hiI=null;
  for(var i2=0;i2<n;i2++){ if(!isGround(fl,i2)){ if(loI===null)loI=i2; hiI=i2; } }
  fl.flight_from = loI===null?0:loI;
  fl.flight_to = hiI===null?n-1:hiI;

  var li=[0];
  for(var i3=1;i3<n;i3++){ var j=li[li.length-1];
    if(fl.lat[i3]!==fl.lat[j]||fl.lon[i3]!==fl.lon[j]||fl.alt[i3]!==fl.alt[j]) li.push(i3); }
  fl.line_idx=li;
  if(li.length<2) throw new LogError("The log contains only a single position \u2013 no flight path can be drawn from it.");

  fl.stats=stats(fl);
  return payload(fl);
}

/* ---- blackbox path: build the same fl object from a decoded INAV/BF log, plus extra channels ---- */
function bbMeaningful(arr){
  // present and not constant
  var first=null, varied=false, any=false;
  for(var i=0;i<arr.length;i++){ var v=arr[i]; if(v===null||v===undefined) continue;
    any=true; if(first===null) first=v; else if(v!==first) varied=true; }
  return any && varied;
}
function bbPlausible(arr, lo, hi){
  // typical value (median) sits in a plausible range and the channel varies -> real sensor.
  // Filters out constant/garbage sensors (e.g. escRPM packed word, IMU temp -125, ESC temp stuck near 0).
  var vals=[]; for(var i=0;i<arr.length;i++){ if(arr[i]!==null&&arr[i]!==undefined) vals.push(arr[i]); }
  if(vals.length<2) return false;
  var m=median(vals);
  if(m===null || m<lo || m>hi) return false;
  return bbMeaningful(arr);
}

function loadBlackbox(bytes, sourceName, maxPoints){
  maxPoints = maxPoints || 25000;
  var dec;
  try { dec = BB.decode(bytes, { fields: BB_FIELDS, minDtUs: 40000 }); } // decode all frames, emit ~25 Hz
  catch(e){ throw new LogError("This blackbox log could not be decoded.\n\n"+(e&&e.message?e.message:"")+
    "\n\nSupported: INAV / Betaflight blackbox logs (raw .TXT / .BBL / .BFL)."); }
  var rows = dec.rows;
  if(!rows || rows.length<2) throw new LogError("The blackbox log contains no usable data frames.");

  // keep only rows with a valid GPS fix
  var g=[];
  for(var i=0;i<rows.length;i++){
    var r=rows[i], la=r["GPS_coord[0]"], lo=r["GPS_coord[1]"];
    if(la===null||la===undefined||lo===null||lo===undefined) continue;
    la=la/1e7; lo=lo/1e7;
    if(!(la>=-90&&la<=90)||!(lo>=-180&&lo<=180)) continue;
    if(Math.abs(la)<1e-4 && Math.abs(lo)<1e-4) continue;
    r._la=la; r._lo=lo; g.push(r);
  }
  if(g.length<2) throw new LogError("The blackbox log has no usable GPS position – it was probably recorded "+
    "without GPS reception (INAV needs a GPS fix for the flight path).");

  var notes=[];
  var nRaw=g.length, step=1;
  if(g.length>maxPoints){
    step=Math.ceil(g.length/maxPoints);
    var d2=[]; for(var s=0;s<g.length;s+=step) d2.push(g[s]);
    notes.push("Log reduced to every "+step+" sample ("+d2.length+" of "+nRaw+") so the map stays smooth.");
    g=d2;
  }

  var start=bbSecOfDay(dec.sysConfig.logStart);
  var acc1G = parseInt(dec.headers["acc_1G"],10) || 2048;
  var t0 = g[0]["time"];

  var fl={ source_name:sourceName||"log.bbl", date:start.date, notes:notes, fm_names:[], cols:{},
    t:[],clock:[],lat:[],lon:[],alt:[],spd:[],vspd:[],hdg:[],dist:[],sats:[],
    rxbt:[],curr:[],capa:[],rqly:[],rss1:[],rss2:[],rsnr:[],tpwr:[],ptch:[],roll:[],yaw:[],txbat:[],fm:[],
    airspd:[],balt:[],vbatsag:[],baroT:[],windspd:[],hdop:[],gforce:[],rpm:[],esct:[],imut:[],
    home:[0,0], land:null, land_i:null, alt_mode:"relative", home_known:true, home_source:"start",
    alt_ref:0, alt_base:0, dist_ref:"home", sample_rate:0, n_raw:nRaw, decimated:step,
    _alt_min:0, have:{}, line_idx:[], flight_from:0, flight_to:0, stats:{}, source_kind:"blackbox" };

  function gv(r,k){ var v=r[k]; return (v===null||v===undefined)?null:v; }
  var capa=0, prevT=null;
  for(var k2=0;k2<g.length;k2++){
    var row=g[k2];
    var tSec = (row["time"]-t0)/1e6;
    fl.t.push(r1(tSec,3));
    var cl = start.sec + tSec;
    var hh=Math.floor(cl/3600)%24, mm=Math.floor((cl%3600)/60), ss=cl%60; if(ss<0)ss=0;
    fl.clock.push(pad2(hh)+":"+pad2(mm)+":"+(ss<10?"0":"")+ss.toFixed(1));
    fl.lat.push(r1(row._la,6)); fl.lon.push(r1(row._lo,6));

    var alt=gv(row,"GPS_altitude");            fl.alt.push(alt!==null?r1(alt,1):null);
    var spd=gv(row,"GPS_speed");               fl.spd.push(spd!==null?r1(spd*0.036,1):null);
    var vv=gv(row,"navVel[2]");                fl.vspd.push(vv!==null?r1(vv/100,1):null); // INAV navVel[2] is climb-positive (up)
    var course=gv(row,"GPS_ground_course");    fl.hdg.push(course!==null?((Math.round(course/10)%360)+360)%360:null);
    fl.dist.push(null);
    var sat=gv(row,"GPS_numSat");              fl.sats.push(sat!==null?Math.round(sat):null);
    var vb=gv(row,"vbat");                      fl.rxbt.push(vb!==null?r1(vb/100,2):null);
    var cur=gv(row,"amperage");                var curA=cur!==null?cur/100:null; fl.curr.push(curA!==null?r1(curA,1):null);
    if(curA!==null && prevT!==null){ capa += curA*Math.max(0,(tSec-prevT))/3.6; } prevT=tSec;
    fl.capa.push(curA!==null?Math.round(capa):null);
    var rssi=gv(row,"rssi");                    fl.rqly.push(rssi!==null?Math.round(rssi/1023*100):null);
    fl.rss1.push(null); fl.rss2.push(null); fl.rsnr.push(null); fl.tpwr.push(null); fl.txbat.push(null);
    var roll=gv(row,"attitude[0]"), pit=gv(row,"attitude[1]"), yaw=gv(row,"attitude[2]");
    fl.roll.push(roll!==null?r1(roll/10,1):null);
    fl.ptch.push(pit!==null?r1(pit/10,1):null);
    fl.yaw.push(yaw!==null?((Math.round(yaw/10)%360)+360)%360:null);
    fl.fm.push(-1);

    // extra channels
    var air=gv(row,"AirSpeed");                fl.airspd.push(air!==null?r1(air*0.036,1):null);
    var ba=gv(row,"BaroAlt");                  fl.balt.push(ba!==null?r1(ba/100,1):null);
    var vsag=gv(row,"sagCompensatedVBat");     fl.vbatsag.push(vsag!==null?r1(vsag/100,2):null);
    var bt=gv(row,"baroTemperature");          fl.baroT.push(bt!==null?r1(bt/10,1):null);
    var w0=gv(row,"wind[0]"), w1=gv(row,"wind[1]");
    fl.windspd.push((w0!==null&&w1!==null)?r1(Math.sqrt(w0*w0+w1*w1)/100,2):null);
    var hd=gv(row,"GPS_hdop");                 fl.hdop.push(hd!==null?r1(hd/100,2):null);
    var ax=gv(row,"accSmooth[0]"), ay=gv(row,"accSmooth[1]"), az=gv(row,"accSmooth[2]");
    fl.gforce.push((ax!==null&&ay!==null&&az!==null)?r1(Math.sqrt(ax*ax+ay*ay+az*az)/acc1G,2):null);
    var rp=gv(row,"escRPM");                   fl.rpm.push(rp!==null?Math.round(rp):null);
    var et=gv(row,"escTemperature");           fl.esct.push(et!==null?Math.round(et):null);
    var it=gv(row,"IMUTemperature");           fl.imut.push(it!==null?r1(it/10,1):null);
  }

  var n=fl.t.length;
  fl.home=[fl.lat[0],fl.lon[0]];
  fl.start_clock=fl.clock[0];
  var span=fl.t[n-1]-fl.t[0];
  fl.sample_rate = span>0 ? (n-1)/span : 0;

  // availability flags
  var haveKeys=["alt","spd","vspd","hdg","sats","rxbt","curr","capa","rqly","rss1","rss2","rsnr","tpwr","ptch","roll","yaw","txbat"];
  for(var hk=0;hk<haveKeys.length;hk++){ var arr=fl[haveKeys[hk]]; fl.have[haveKeys[hk]]=arr.some(function(x){return x!==null;}); }
  fl.have.dist=true; fl.have.fm=false;
  // extras: present + meaningful (constant/implausible sensors stay greyed out)
  fl.have.airspd = bbMeaningful(fl.airspd);
  fl.have.balt   = bbMeaningful(fl.balt);
  fl.have.vbatsag= bbMeaningful(fl.vbatsag);
  fl.have.baroT  = bbPlausible(fl.baroT, -40, 125);
  fl.have.windspd= bbMeaningful(fl.windspd);
  fl.have.hdop   = bbPlausible(fl.hdop, 0.1, 99);
  fl.have.gforce = bbMeaningful(fl.gforce);
  fl.have.rpm    = bbPlausible(fl.rpm, 10, 500000);
  fl.have.esct   = bbPlausible(fl.esct, 10, 250);
  fl.have.imut   = bbPlausible(fl.imut, -30, 120);

  resolveReference(fl);

  var loI=null, hiI=null;
  for(var i2=0;i2<n;i2++){ if(!isGround(fl,i2)){ if(loI===null)loI=i2; hiI=i2; } }
  fl.flight_from = loI===null?0:loI;
  fl.flight_to = hiI===null?n-1:hiI;

  var li=[0];
  for(var i3=1;i3<n;i3++){ var j=li[li.length-1];
    if(fl.lat[i3]!==fl.lat[j]||fl.lon[i3]!==fl.lon[j]||fl.alt[i3]!==fl.alt[j]) li.push(i3); }
  fl.line_idx=li;
  if(li.length<2) throw new LogError("The blackbox log contains only a single position – no flight path can be drawn from it.");

  fl.stats=stats(fl);
  return payload(fl);
}

/* Router: accepts a CSV string, or a Uint8Array/ArrayBuffer (auto-detects blackbox vs CSV). */
function load(input, sourceName, maxPoints){
  if(typeof input === "string"){
    return loadCsv(input, sourceName, maxPoints);
  }
  var bytes = (input instanceof Uint8Array) ? input
            : (input && input.buffer) ? new Uint8Array(input.buffer)
            : new Uint8Array(input);
  if(bbLooksLikeBlackbox(bytes)) return loadBlackbox(bytes, sourceName, maxPoints);
  // not a blackbox log -> treat the bytes as text (CSV)
  var text;
  if(typeof TextDecoder!=="undefined"){ try{ text=new TextDecoder("utf-8",{fatal:false}).decode(bytes); }catch(e){ text=null; } }
  if(text===null||text===undefined){ text=""; for(var i=0;i<bytes.length;i++) text+=String.fromCharCode(bytes[i]); }
  return loadCsv(text, sourceName, maxPoints);
}

function isGround(fl,i){
  var s=fl.spd[i], a=fl.alt[i], known=false;
  if(s!==null){ if(s>=GROUND_SPEED) return false; known=true; }
  if(a!==null){ if(a>fl._alt_min+GROUND_ALT) return false; known=true; }
  return known;
}
function groundRuns(fl){
  var n=fl.t.length, runs=[], i=0;
  while(i<n){
    if(isGround(fl,i)){ var j=i; while(j+1<n && isGround(fl,j+1)) j++;
      if(fl.t[j]-fl.t[i]>=GROUND_SECONDS || (j-i)>=5) runs.push([i,j]); i=j+1; }
    else i++;
  }
  return runs;
}
function resolveReference(fl){
  var n=fl.t.length;
  var alts=fl.alt.filter(function(a){return a!==null;});
  fl._alt_min = alts.length?Math.min.apply(null,alts):0;
  var runs=groundRuns(fl);
  var span=fl.t[n-1]-fl.t[0];
  var chosen=null, source="none";
  for(var r=0;r<runs.length;r++){ var a=runs[r][0],b=runs[r][1];
    if(fl.t[a]-fl.t[0] <= Math.max(120, span*0.2)){ chosen=[a,b]; source="start"; break; } }
  if(chosen===null){ for(var r2=runs.length-1;r2>=0;r2--){ var a2=runs[r2][0],b2=runs[r2][1];
    if(fl.t[n-1]-fl.t[b2] <= Math.max(120, span*0.2)){ chosen=[a2,b2]; source="landing"; break; } } }
  if(chosen===null && runs.length){ chosen=runs[0]; source="start"; }

  if(chosen!==null){
    var a3=chosen[0], b3=chosen[1];
    fl.home=[r1(median(fl.lat.slice(a3,b3+1)),6), r1(median(fl.lon.slice(a3,b3+1)),6)];
    var refArr=fl.alt.slice(a3,b3+1).filter(function(x){return x!==null;});
    var ref=median(refArr);
    fl.alt_ref = ref===null?0:r1(ref,1);
    fl.home_known=true; fl.home_source=source; fl.dist_ref = source==="start"?"home":"landing";
  } else {
    fl.home=[fl.lat[0],fl.lon[0]]; fl.alt_ref=0; fl.home_known=false; fl.home_source="none"; fl.dist_ref="logstart";
  }

  resolveLanding(fl, runs, chosen);

  if(fl.home_known && Math.abs(fl.alt_ref)>0.05){
    for(var i=0;i<n;i++) fl.alt[i]=fl.alt[i]===null?null:r1(fl.alt[i]-fl.alt_ref,1);
    fl._alt_min -= fl.alt_ref;
    if(Math.abs(fl.alt_ref)>25){ fl.alt_mode="msl";
      fl.notes.push("Altitudes are absolute in the log. The ground height of "+Math.round(fl.alt_ref)+" m measured at the reference point is used as zero."); }
  } else if(!fl.home_known){ fl.alt_mode="raw"; }

  fl.alt_base = fl.home_known?0:r1(fl._alt_min,1);

  if(fl.dist.some(function(d){return d!==null;})){
    fl.dist_ref="sensor";
    for(var i4=0;i4<n;i4++) if(fl.dist[i4]===null) fl.dist[i4]=Math.round(haversine(fl.home[0],fl.home[1],fl.lat[i4],fl.lon[i4]));
  } else {
    for(var i5=0;i5<n;i5++) fl.dist[i5]=Math.round(haversine(fl.home[0],fl.home[1],fl.lat[i5],fl.lon[i5]));
  }

  if(!fl.home_known){
    fl.notes.push("The log has no phase on the ground \u2013 the recording starts and ends in the air. "+
      "Start point and height above ground cannot be derived. Distances are relative to the first sample, altitudes are unchanged log values.");
  } else if(fl.home_source==="landing"){
    fl.notes.push("The recording already starts in the air, so the landing point at the end of the log is used as the reference.");
  }
}
function tailFrom(fl,secs){ var n=fl.t.length,i=n-1; while(i>0 && fl.t[n-1]-fl.t[i-1]<=secs) i--; return i; }
function wasAirborne(fl,before){ for(var i=0;i<before;i++) if(!isGround(fl,i)) return true; return false; }
function setLand(fl,a,b){ var lat=median(fl.lat.slice(a,b+1)), lon=median(fl.lon.slice(a,b+1));
  if(lat===null||lon===null) return false; fl.land=[r1(lat,6),r1(lon,6)]; fl.land_i=a; return true; }
function touchdownIndex(fl){
  var n=fl.t.length, ref=Math.min(fl.alt_ref,fl._alt_min), lim, arr;
  if(fl.alt.some(function(a){return a!==null;})){ lim=ref+LAND_ALT; arr=fl.alt; }
  else if(fl.spd.some(function(s){return s!==null;})){ lim=LAND_SPEED; arr=fl.spd; }
  else return null;
  var tf=tailFrom(fl,2.0), tail=[]; for(var i=tf;i<n;i++) if(arr[i]!==null) tail.push(arr[i]);
  var m=median(tail); if(m===null||m>lim) return null;
  var i2=n-1; while(i2>0 && arr[i2-1]!==null && arr[i2-1]<=lim) i2--;
  return i2;
}
function resolveLanding(fl,runs,chosen){
  fl.land=null; fl.land_i=null; var n=fl.t.length;
  if(!fl.home_known || fl.home_source==="landing") return;
  if(runs.length){
    var a=runs[runs.length-1][0], b=runs[runs.length-1][1];
    var same = chosen!==null && a===chosen[0] && b===chosen[1];
    if(!same && (b>=n-1 || (fl.t[n-1]-fl.t[b])<=LAND_GAP)){
      if(wasAirborne(fl,a) && setLand(fl,a,b)) return;
    }
  }
  var td=touchdownIndex(fl);
  if(td===null || !wasAirborne(fl,td)) return;
  setLand(fl, Math.max(td, tailFrom(fl,LAND_TAIL)), n-1);
}

function rng(arr,a,b){ var o=[]; for(var i=a;i<=b;i++) if(arr[i]!==null&&arr[i]!==undefined) o.push(arr[i]); return o; }
function sum(a){ var s=0; for(var i=0;i<a.length;i++) s+=a[i]; return s; }
function stats(fl){
  var a=fl.flight_from, b=fl.flight_to, st={};
  st.log_duration=fl.t[fl.t.length-1]-fl.t[0];
  st.flight_duration=fl.t[b]-fl.t[a];
  st.points=fl.t.length; st.rate=fl.sample_rate;
  var alt=rng(fl.alt,a,b); st.alt_max=alt.length?Math.max.apply(null,alt):null; st.alt_avg=alt.length?sum(alt)/alt.length:null;
  var spd=rng(fl.spd,a,b); st.spd_max=spd.length?Math.max.apply(null,spd):null; st.spd_avg=spd.length?sum(spd)/spd.length:null;
  var vsp=rng(fl.vspd,a,b); st.climb_max=vsp.length?Math.max.apply(null,vsp):null; st.sink_max=vsp.length?Math.min.apply(null,vsp):null;
  var dist=rng(fl.dist,a,b); st.dist_max=dist.length?Math.max.apply(null,dist):null;
  if(dist.length){ var bi=a, bv=-1; for(var i=a;i<=b;i++){ var d=fl.dist[i]===null?-1:fl.dist[i]; if(d>bv){bv=d;bi=i;} } st.dist_max_i=bi; } else st.dist_max_i=null;
  var total=0, prev=null;
  for(var q=0;q<fl.line_idx.length;q++){ var i2=fl.line_idx[q]; if(i2<a||i2>b) continue;
    var cur=[fl.lat[i2],fl.lon[i2], fl.alt[i2]===null?0:fl.alt[i2]];
    if(prev!==null){ var d2=haversine(prev[0],prev[1],cur[0],cur[1]); var dz=cur[2]-prev[2]; total+=Math.sqrt(d2*d2+dz*dz); }
    prev=cur; }
  st.path_len=total;
  var cap=rng(fl.capa,a,b); st.mah=cap.length?(Math.max.apply(null,cap)-Math.min.apply(null,cap)):null;
  var cur_=rng(fl.curr,a,b); st.curr_max=cur_.length?Math.max.apply(null,cur_):null; st.curr_avg=cur_.length?sum(cur_)/cur_.length:null;
  var rx=rng(fl.rxbt,a,b); st.rxbt_start=rx.length?rx[0]:null; st.rxbt_end=rx.length?rx[rx.length-1]:null; st.rxbt_min=rx.length?Math.min.apply(null,rx):null;
  var lq=rng(fl.rqly,a,b); st.rqly_min=lq.length?Math.min.apply(null,lq):null; st.rqly_avg=lq.length?sum(lq)/lq.length:null; st.rqly_drops=lq.length?lq.filter(function(x){return x<90;}).length:null;
  var r1a=rng(fl.rss1,a,b); st.rss_min=r1a.length?Math.min.apply(null,r1a):null;
  var sn=rng(fl.rsnr,a,b); st.snr_min=sn.length?Math.min.apply(null,sn):null;
  var sa=rng(fl.sats,a,b); st.sats_min=sa.length?Math.min.apply(null,sa):null; st.sats_max=sa.length?Math.max.apply(null,sa):null;
  var tp=rng(fl.tpwr,a,b); st.tpwr_max=tp.length?Math.max.apply(null,tp):null;
  if(fl.fm_names.length){ var secs=[]; for(var z=0;z<fl.fm_names.length;z++) secs.push(0);
    var end=Math.min(b, fl.t.length-2);
    for(var i3=a;i3<=end;i3++){ var kk=fl.fm[i3]; if(kk>=0) secs[kk]+=fl.t[i3+1]-fl.t[i3]; }
    st.fm_secs=secs.map(function(s){return r1(s,1);}); }
  else st.fm_secs=[];
  return st;
}

function payload(fl){
  return {
    meta:{ source:fl.source_name, date:fl.date, start:fl.start_clock, rate:r1(fl.sample_rate,2),
      points:fl.t.length, raw:fl.n_raw, decimated:fl.decimated, altMode:fl.alt_mode,
      homeKnown:fl.home_known, homeSource:fl.home_source, altBase:fl.alt_base, distRef:fl.dist_ref,
      notes:fl.notes, cols:fl.cols, cesium:CESIUM_VERSION },
    home:[fl.home[0],fl.home[1]],
    land: fl.land?[fl.land[0],fl.land[1]]:null,
    landIdx: fl.land_i,
    have: fl.have,
    stats: fl.stats,
    fmNames: fl.fm_names,
    lineIdx: fl.line_idx,
    from: fl.flight_from,
    to: fl.flight_to,
    f:{ t:fl.t, clock:fl.clock, lat:fl.lat, lon:fl.lon, alt:fl.alt, spd:fl.spd, vspd:fl.vspd, hdg:fl.hdg,
      dist:fl.dist, sats:fl.sats, rxbt:fl.rxbt, curr:fl.curr, capa:fl.capa, rqly:fl.rqly, rss1:fl.rss1,
      rss2:fl.rss2, rsnr:fl.rsnr, tpwr:fl.tpwr, ptch:fl.ptch, roll:fl.roll, txbat:fl.txbat, yaw:fl.yaw, fm:fl.fm,
      airspd:fl.airspd, balt:fl.balt, vbatsag:fl.vbatsag, baroT:fl.baroT, windspd:fl.windspd,
      hdop:fl.hdop, gforce:fl.gforce, rpm:fl.rpm, esct:fl.esct, imut:fl.imut },
    battery:{ profiles:[], active:0 },
    defaults:{}
  };
}

var API={ load:load, loadCsv:loadCsv, loadBlackbox:loadBlackbox, LogError:LogError,
  CESIUM_VERSION:CESIUM_VERSION, BlackboxParse:BB,
  _internals:{ norm:norm, unit:unit, toFloat:toFloat, parseClock:parseClock, haversine:haversine, median:median } };
if(typeof module!=="undefined" && module.exports) module.exports=API;
root.FlugspurParse=API;
})(typeof self!=="undefined"?self:this);
