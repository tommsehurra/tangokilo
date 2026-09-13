/* flugspur_parse.js
 * Browser-Portierung von flugspur_log.py — liest EdgeTX/OpenTX-Telemetrie-CSV
 * und baut exakt das Flug-Objekt (Payload), das flugspur_report erwartet.
 * Laeuft im Browser (window.FlugspurParse) und in Node (module.exports).
 * Reine Logik, keine Abhaengigkeiten. Ergebnis 1:1 wie das Python-Original.
 */
(function(root){
"use strict";

var CESIUM_VERSION = "1.120";

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

function load(text, sourceName, maxPoints){
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
      rss2:fl.rss2, rsnr:fl.rsnr, tpwr:fl.tpwr, ptch:fl.ptch, roll:fl.roll, txbat:fl.txbat, yaw:fl.yaw, fm:fl.fm },
    battery:{ profiles:[], active:0 },
    defaults:{}
  };
}

var API={ load:load, LogError:LogError, CESIUM_VERSION:CESIUM_VERSION,
  _internals:{ norm:norm, unit:unit, toFloat:toFloat, parseClock:parseClock, haversine:haversine, median:median } };
if(typeof module!=="undefined" && module.exports) module.exports=API;
root.FlugspurParse=API;
})(typeof self!=="undefined"?self:this);
