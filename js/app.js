// app.js - AuditionMusic5: live-sync (music.slk + /api/list), player, download.
// example: const WORKER = "https://auditionmusic5.xxx.workers.dev";
const WORKER = "https://WORKER_URL_DISINI";
// Decode server (server-vps.js di VPS): TBM -> OGG dilakukan di server,
// decoder JS (tbm.js/tbm-crypto.js/heads.au5) TIDAK ikut ke browser.
// Kosongkan ("") untuk decode di browser (butuh 3 file decoder itu di folder web).
const DECODE_BASE = "https://vm.auditionmusic5.com/am5";
const DIRECT_BASE = "http://122.102.49.131/audition/ABM";  // local fallback (no worker)
const DIRECT_PKG_BASE = "http://122.102.49.131/audition/package/ABM";  // .abm files live here
const VTC_BASE = "http://aumusic.vtcgame.vn/abm";
const NEXT_BASE = "http://auto-audiph.playpark.net/live/audition/package/abm";
const TH_BASE = "https://auto-au.playpark.com/package/abm";
const CN_BASE = "http://au.patch1.9you.com/ABM";
const KR_BASE = "http://au-patch.hanbiton.com/adtpatch/audition/package/ABM";
const TW_BASE = "http://patch-au.mangot5.com.tw/audition_patch/patch/live/audition/package/abm";
const AX_BASE = "http://audl.axeso5.com/update/content/ABM";

// Server list: table + files come per server. enc = legacy charset of the
// .slk (browsers would decode it as UTF-8 -> "?"); decoded manually below.
const SERVERS = [
  { id: "ayo", name: "Audition AyoDance", slk: "auayo.slk", api: "ayo", rawDirect: true, enc: "euc-kr",
    cols: { a: 1, t: 2, f: 3, bpm: 6, web: 12 },
    direct: (f) => ((/\.abm$/i.test(f) ? DIRECT_PKG_BASE : DIRECT_BASE) + "/" + encodeURIComponent(f)) },
  { id: "vtc", name: "Audition VTC", slk: "auvtc.slk", api: "vtc", rawDirect: false, enc: "windows-1258",
    cols: { a: 1, t: 2, f: 3, bpm: 6, web: 12 },
    direct: (f) => VTC_BASE + "/" + encodeURIComponent(f) },
  { id: "next", name: "Audition Next Gen", slk: "aunext.slk", api: "next", rawDirect: true, enc: "euc-kr",
    cols: { a: 1, t: 2, f: 3, bpm: 6, web: 12 },
    direct: (f) => NEXT_BASE + "/" + encodeURIComponent(f) },
  { id: "th", name: "Audition Thailand", slk: "auth.slk", api: "th", rawDirect: true, enc: "windows-874",
    cols: { a: 1, t: 2, f: 3, bpm: 6, web: 12 },
    direct: (f) => TH_BASE + "/" + encodeURIComponent(f) },
  { id: "cn", name: "Audition 9you", slk: "aucn.slk", api: "cn", rawDirect: false, enc: "gbk",
    cols: { a: 1, t: 2, f: 3, bpm: 6, web: 12 },
    direct: (f) => CN_BASE + "/" + encodeURIComponent(f) },
  { id: "kr", name: "Audition Hanbiton", slk: "aukr.slk", api: "kr", rawDirect: false, enc: "euc-kr",
    cols: { a: 1, t: 2, f: 3, bpm: 6, web: 12 },
    direct: (f) => KR_BASE + "/" + encodeURIComponent(f) },
  { id: "tw", name: "Audition Mangot5", slk: "autw.slk", api: "tw", rawDirect: false, enc: "big5",
    cols: { a: 1, t: 2, f: 3, bpm: 6, web: 12 },
    direct: (f) => TW_BASE + "/" + encodeURIComponent(f) },
  { id: "ax", name: "Audition Axeso5", slk: "auax.slk", api: "ax", rawDirect: false, enc: "windows-1252",
    cols: { a: 1, t: 2, f: 3, bpm: 6, web: 12 },
    direct: (f) => AX_BASE + "/" + encodeURIComponent(f) },
];
let SRV = SERVERS[0];
try {
  const saved = localStorage.getItem("am5srv");
  if (saved) {
    const found = SERVERS.find((s) => s.id === saved);
    if (found) SRV = found;
  }
} catch (e) {}
const LAMEJS_CDN = "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js";
const SLK_DIR = "script/";   // semua .slk (server + ballroom + _gt) di subfolder ini
const ASSET_V = "?v=170";   // naikkan tiap update biar browser tidak pakai cache lama
const PAGE = 300;

function workerReady() { return WORKER && !WORKER.includes("WORKER_URL"); }
// API ready when worker is set OR running locally (http).
function apiReady() { return workerReady() || location.protocol === "http:"; }
// Base API: worker when set, else same-origin.
function apiBase() { return workerReady() ? WORKER : ""; }

const $ = (id) => document.getElementById(id);
const status = (t) => { $("status").textContent = t; };
// thead sticks below the sticky header (header height changes when player on/off)
function fixTh() {
  const h = document.querySelector("header").offsetHeight;
  document.querySelectorAll("thead th").forEach((th) => { th.style.top = h + "px"; });
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function setNow(label, song) {
  $("np-label").textContent = label;
  $("np-song").textContent = song;
  $("np-song").href = song ? "javascript:void(0)" : "javascript:void(0)";
  $("np-end").textContent = song ? " ♪" : "";
}

// ---- SYLK parser (cursor-based: F; records set the Y/X cursor, C;
// records may omit Y/X and inherit it — all three servers mix both) ----
function parseSLK(text, cols) {
  const rows = new Map();
  let curY = null, curX = null;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;  // SYLK = CRLF
    if (line.startsWith("F;")) {
      const my = line.match(/;Y(\d+)(;|$)/), mx = line.match(/;X(\d+)(;|$)/);
      if (my) curY = parseInt(my[1], 10);
      if (mx) curX = parseInt(mx[1], 10);
    } else if (line.startsWith("C;")) {
      const my = line.match(/;Y(\d+)(;|$)/), mx = line.match(/;X(\d+)(;|$)/);
      const mk = line.match(/;K([\s\S]*)$/);
      if (!mk) continue;
      if (my) curY = parseInt(my[1], 10);
      if (mx) curX = parseInt(mx[1], 10);
      if (curY === null || curX === null) continue;
      let v = mk[1];
      if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (!rows.has(curY)) rows.set(curY, {});
      rows.get(curY)[curX] = v;
    }
  }
  // column map differs per server (ayo/vtc: artist1 title2 file3 bpm6 new12;
  // next/ballroom: singer1 title2 file3 bpm8 new11)
  const c = cols || { a: 1, t: 2, f: 3, bpm: 6, web: 12 };
  const meta = [];   // LIST per slk row (2 rows may share 1 file,
  for (const r of rows.values()) {   // e.g. Easy/Hard) - NEVER dedupe
    const fn = r[c.f];
    if (fn && /\.(tbm|abm)$/i.test(fn)) {
      meta.push({
        file: fn, a: r[c.a] || "", t: r[c.t] || "", bpm: r[c.bpm] || "",
        web: r[c.web] === "1",
        lvl: (c.lvl != null && r[c.lvl] != null) ? r[c.lvl] : "",
      });
    }
  }
  return meta;
}

let SONGS = [];        // {f, s, a, t, bpm, isNew}
let BALL = [];         // ballroom list (same shape, isNew always false)
let GT = [];           // guitar list per server (adds lvl)
let MODE = "all";      // "all" | "ball" | "gt"
const cur = () => (MODE === "ball" ? BALL : MODE === "gt" ? GT : SONGS);
let FILTERED = [];
let SHOWN = 0;
const OGG_CACHE = new Map();   // filename -> Uint8Array ogg (decoded)
let HEADS = null;              // Array<Uint8Array> from heads.au5 (lazy)
let HEADS_FAIL = false;

async function boot() {
  try {
    status("Loading " + SRV.slk + "...");
    const rslk = await fetch(SLK_DIR + SRV.slk + ASSET_V);
    if (!rslk.ok) throw new Error(SRV.slk + " not found (" + rslk.status + ")");
    // decode with the server's legacy charset (never response.text():
    // the file is not UTF-8 and the static host sends no charset).
    const raw = await rslk.arrayBuffer();
    let dec;
    try { dec = new TextDecoder(SRV.enc || "utf-8"); }
    catch (e) { dec = new TextDecoder("utf-8"); }
    const meta = parseSLK(dec.decode(raw), SRV.cols);
    // table = ALL slk rows (thousands), REVERSED order: bottom slk row
    // (newest) shows first. X12=1 = NEW badge (not a filter).
    SONGS = [];
    for (const mm of meta) {
      SONGS.push({ f: mm.file, s: 0, a: mm.a, t: mm.t, bpm: mm.bpm, isNew: mm.web, lvl: mm.lvl || "" });
    }
    SONGS.reverse();
    loadBallroom().catch(() => {});
    loadGt().catch(() => {});
    applyFilter("");
    status("");
    // merge live server list (size only) when the server has one
    if (SRV.api === "ayo") mergeServerList(meta).catch(() => {});
  } catch (e) {
    SONGS = [];
    applyFilter("");
    $("rows").innerHTML =
      `<tr><td colspan="5" style="text-align:center;padding:26px;color:#aaaac4;">` +
      esc(SRV.slk) + " not found — upload it to the script/ folder to enable " +
      esc(SRV.name) + ".</td></tr>";
    status("Failed to load " + SRV.slk + ": " + e.message);
  }
  hideBar("");   // player bar always visible; "Empty" until first play
}

// ballroom catalog: singer/title/bpm only per file (no NEW), same for all
// servers; filename kept internally so play/download keep working.
async function loadBallroom() {
  const r = await fetch(SLK_DIR + "ballroommusic.slk" + ASSET_V);
  if (!r.ok) return;
  const raw = await r.arrayBuffer();
  const meta = parseSLK(new TextDecoder("euc-kr").decode(raw),
    { a: 1, t: 2, f: 3, bpm: 8, web: 99 });
  BALL = [];
  for (const mm of meta) {
    BALL.push({ f: mm.file, s: 0, a: mm.a, t: mm.t, bpm: mm.bpm, isNew: false, lvl: "" });
  }
  BALL.reverse();
  if (MODE === "ball") applyFilter($("q").value);
}

// guitar catalog per server (<slk>_gt.slk): singer/title/file/bpm/new +
// level (X10). Same encoding as the server. Backing file per row; the note
// twin (<base>_note.tbm) plays via the note button in guitar mode.
async function loadGt() {
  GT = [];
  try {
    const r = await fetch(SLK_DIR + SRV.slk.replace(/\.slk$/, "_gt.slk") + ASSET_V);
    if (!r.ok) return;
    const raw = await r.arrayBuffer();
    let dec;
    try { dec = new TextDecoder(SRV.enc || "utf-8"); }
    catch (e) { dec = new TextDecoder("utf-8"); }
    const meta = parseSLK(dec.decode(raw),
      { a: 1, t: 2, f: 3, bpm: 6, web: 8, lvl: 10 });
    for (const mm of meta) {
      const backing = { f: mm.file, s: 0, a: mm.a, t: mm.t, bpm: mm.bpm, isNew: mm.web, lvl: mm.lvl || "" };
      const nf = noteName(mm.file);
      GT.push({ f: nf, s: 0, a: mm.a, t: mm.t, bpm: mm.bpm, isNew: mm.web, lvl: mm.lvl || "", note: true });
      GT.push(backing);
    }
    GT.reverse();
  } catch (e) {}
  if (MODE === "gt") applyFilter($("q").value);
}

// live list from Worker: fill sizes of shown rows only.
async function mergeServerList(meta) {
  if (!WORKER || WORKER.includes("WORKER_URL")) return;
  const list = await (await fetch(apiBase() + "/api/list")).json();
  if (!list.ok || !list.files) return;
  const byCode = new Map(SONGS.map((s) => [s.f.toLowerCase(), s]));
  for (const e of list.files) {
    const ex = byCode.get(e.f.toLowerCase());
    // only fill size for rows already shown; skip other files.
    // order untouched (slk-bottom stays on top).
    if (ex) ex.s = e.s;
  }
  applyFilter($("q").value);
  status("");
}

function fmtSize(b) {
  return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";
}

function badgeFor(f, isNew) {
  // X12=1 -> NEW badge. (Old prefix-based format badge removed: clashed.)
  return isNew ? '<img class="newimg" src="image/new.png" alt="NEW"> ' : '';
}

const ICO_PLAY = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICO_DL = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';

function applyFilter(q) {
  q = q.trim().toLowerCase();
  const list = cur();
  FILTERED = !q ? list.slice() : list.filter((s) =>
    s.f.toLowerCase().includes(q) || s.a.toLowerCase().includes(q) ||
    s.t.toLowerCase().includes(q) || String(s.bpm).includes(q));
  SHOWN = 0;
  $("rows").innerHTML = "";
  $("count").textContent = FILTERED.length + " / " + list.length;
  more();
}

function more() {
  const tb = $("rows");
  const slice = FILTERED.slice(SHOWN, SHOWN + PAGE);
  for (const s of slice) {
    const tr = document.createElement("tr");
    // guitar pairs render as one visual unit: backing rows (first
    // after the reverse) lose their bottom divider.
    if (MODE === "gt" && !s.note) tr.classList.add("pair");
    const isAbm = /\.abm$/i.test(s.f);
    const rawLabel = isAbm ? "abm" : "tbm";
    const rawTitle = isAbm ? "Download ABM" : "Download TBM";
    const fileCell =
      `<td>${esc(s.f)}` +
      (s.s ? `<br><span class="badge">${fmtSize(s.s)}</span>` : "") + `</td>`;
    const newCell = MODE === "ball" ? "" : `<td class="newc">${badgeFor(s.f, s.isNew)}</td>`;
    const lvlCell = MODE === "gt" ? `<td class="lvlc">${esc(s.lvl) || "-"}</td>` : "";
    tr.innerHTML =
      `<td>${esc(s.a) || "-"}</td><td>${esc(s.t) || "-"}</td>` +
      fileCell +
      `<td class="num">${esc(s.bpm) || "-"}</td>` +
      newCell +
      lvlCell +
      `<td class="btns">
        <button class="play" title="Play" data-act="play" data-f="${esc(s.f)}">${ICO_PLAY} play</button>
        <button class="tbm" title="${rawTitle}" data-act="tbm" data-f="${esc(s.f)}">${ICO_DL} ${rawLabel}</button>
        <button class="mp3" title="Download MP3" data-act="mp3" data-f="${esc(s.f)}">${ICO_DL} mp3</button>
        <button class="ogg" title="Download OGG" data-act="ogg" data-f="${esc(s.f)}">${ICO_DL} ogg</button>
        ${MODE === "gt" && !s.note ? `<button class="both" title="Play backing + note together" data-act="both" data-f="${esc(s.f)}">${ICO_PLAY} both</button>` : ""}
      </td>`;
    if (s.f === NOW_NAME) tr.classList.add("playing");
    tb.appendChild(tr);
  }
  SHOWN += slice.length;
  $("more").style.display = SHOWN < FILTERED.length ? "block" : "none";
}

async function fetchTbm(name) {
  // Server mode: the decode server also proxies the raw file (/api/<srv>/f/),
  // so no CF worker is needed at all.
  if (DECODE_BASE) {
    const r = await fetch(DECODE_BASE + "/api/" + SRV.api + "/f/" + encodeURIComponent(name));
    if (!r.ok) throw new Error("download " + r.status);
    return new Uint8Array(await r.arrayBuffer());
  }
  const base = apiBase() + "/api/" + (SRV.api === "ayo" ? "f/" : SRV.api + "/f/");
  const r = await fetch(base + encodeURIComponent(name));
  if (!r.ok) throw new Error("download " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

// OGG bytes for a song. Server mode (DECODE_BASE set): ask the decode server,
// the decoder never reaches the browser. Browser mode: fetch raw TBM and
// decode locally with tbm.js (requires the decoder files in the web folder).
async function fetchOgg(name) {
  const key = SRV.id + "|" + name;
  if (OGG_CACHE.has(key)) return OGG_CACHE.get(key);
  let ogg;
  if (DECODE_BASE) {
    const url = DECODE_BASE + "/api/" + SRV.api + "/ogg/" + encodeURIComponent(name);
    const r = await fetch(url);
    if (!r.ok) throw new Error("decode server " + r.status);
    ogg = new Uint8Array(await r.arrayBuffer());
  } else {
    ogg = await decodeName(name, await fetchTbm(name));
  }
  OGG_CACHE.set(key, ogg);
  return ogg;
}

async function ensureHeads() {
  if (HEADS) return HEADS;
  if (HEADS_FAIL) throw new Error("heads.au5 is missing from the web server");
  const r = await fetch("js/heads.au5" + ASSET_V);
  if (!r.ok) { HEADS_FAIL = true; throw new Error("heads.au5 is missing (decoder needs the head pack)"); }
  const buf = new Uint8Array(await r.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const n = dv.getUint32(0, true);
  HEADS = [];
  let p = 4;
  for (let i = 0; i < n; i++) {
    const len = dv.getUint32(p, true); p += 4;
    HEADS.push(buf.slice(p, p + len)); p += len;
  }
  return HEADS;
}

async function decodeName(name, tbmBytes) {
  const key = SRV.id + "|" + name;
  if (OGG_CACHE.has(key)) return OGG_CACHE.get(key);
  const heads = await ensureHeads();
  const r = await decodeTbm(tbmBytes, heads);
  if (!r.ok) throw new Error(r.error);
  OGG_CACHE.set(key, r.ogg);
  return r.ogg;
}

function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}



let SHUFFLE = false;
let REPEAT_STATE = 0; // 0 = off, 1 = repeat all, 2 = repeat one

// ---- Play Both (backing + note twin, sample-accurate mix) ----
let BOTH = null;   // {ctx, gain, src, bufs, timer, t0, off, dur, backing, paused}
function backingOf(name) {
  return name.replace(/_note\.(tbm|abm)$/i, ".$1");
}
function stopBoth() {
  if (!BOTH) return;
  try { clearInterval(BOTH.timer); } catch (e) {}
  BOTH.src.forEach((s) => { try { s.onended = null; } catch (e) {} try { s.stop(); } catch (e) {} });
  try { BOTH.ctx.close(); } catch (e) {}
  BOTH = null;
}
function advanceAfterEnd() {
  document.querySelectorAll("tr.playing").forEach((r) => r.classList.remove("playing"));
  if (SHUFFLE) {
    const list = cur();
    const pool = (FILTERED.length ? FILTERED : list).filter((s) => s.f !== NOW_NAME);
    const pick = (pool.length ? pool : list)[Math.floor(Math.random() * (pool.length ? pool.length : list.length))];
    if (pick) playFile(pick.f).catch((e) => status("Shuffle failed: " + e.message));
  } else if (REPEAT_STATE === 1) {
    const pool = FILTERED.length ? FILTERED : cur();
    const i = pool.findIndex((s) => s.f === NOW_NAME);
    const nxt = pool[(i + 1) % pool.length];
    if (nxt) playFile(nxt.f).catch((e) => status("Repeat failed: " + e.message));
  }
}
function updateBothUI() {
  if (!BOTH) return;
  const el = BOTH.off + (BOTH.ctx.currentTime - BOTH.t0);
  $("pv-cur").textContent = fmtT(el);
  const pct = BOTH.dur ? (el / BOTH.dur) * 100 : 0;
  $("pv-seek").value = Math.round(pct * 10);
  $("pv-fill").style.width = pct + "%";
}
function onBothEnded() {
  if (!BOTH) return;
  try { clearInterval(BOTH.timer); } catch (e) {}
  BOTH = null;
  setPlayIcon();
  advanceAfterEnd();
}
function restartBoth(offset) {
  const rec = BOTH;
  if (!rec) return;
  rec.src.forEach((s) => { try { s.onended = null; } catch (e) {} try { s.stop(); } catch (e) {} });
  const mk = (buf) => {
    const s = rec.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = (REPEAT_STATE === 2);
    s.connect(rec.gain);
    return s;
  };
  rec.src = [mk(rec.bufs[0]), mk(rec.bufs[1])];
  rec.src[0].onended = () => onBothEnded();
  rec.off = Math.max(0, Math.min(offset, rec.dur));
  rec.t0 = rec.ctx.currentTime;
  rec.src[0].start(0, rec.off);
  rec.src[1].start(0, rec.off);
}
let BOTH_GEN = 0;
async function playBoth(backing) {
  showWait();
  stopBoth();
  try { $("audio").pause(); } catch (e) {}
  const myGen = ++BOTH_GEN;
  const note = noteName(backing);
  const ogB = await fetchOgg(backing);
  const ogN = await fetchOgg(note);
  if (myGen !== BOTH_GEN) return;   // superseded by a newer Both request
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  if (ctx.state === "suspended") await ctx.resume();
  const abB = await ctx.decodeAudioData(ogB.slice().buffer);
  const abN = await ctx.decodeAudioData(ogN.slice().buffer);
  const gain = ctx.createGain();
  gain.gain.value = Number($("pv-vol").value) / 100;
  gain.connect(ctx.destination);
  const mk = (buf) => {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = (REPEAT_STATE === 2);
    s.connect(gain);
    return s;
  };
  const s1 = mk(abB), s2 = mk(abN);
  const dur = Math.max(abB.duration, abN.duration);
  NOW_NAME = backing;
  BOTH = { ctx, gain, src: [s1, s2], bufs: [abB, abN], timer: 0,
           t0: 0, off: 0, dur, backing, paused: false };
  s1.onended = () => onBothEnded();
  BOTH.t0 = ctx.currentTime;
  s1.start(0);
  s2.start(0);
  document.querySelectorAll("tr.playing").forEach((r) => r.classList.remove("playing"));
  const btn2 = document.querySelector(`button[data-act="play"][data-f="${CSS.escape(backing)}"]`);
  if (btn2 && btn2.closest("tr")) btn2.closest("tr").classList.add("playing");
  hideBar(backing);
  $("pv-dur").textContent = fmtT(dur);
  setPlayIcon();
  updateBothUI();
  BOTH.timer = setInterval(updateBothUI, 250);
}
let NOW_NAME = "";

// every process shows in the player bar as "Please wait..."
function showWait() {
  const pl = $("player");
  pl.style.display = "flex";
  pl.classList.add("on");
  setNow("Please wait...", "");
  fixTh();
}
function songLabel(name) {
  const info = cur().find((s) => s.f === name) ||
    SONGS.find((s) => s.f === name) ||
    BALL.find((s) => s.f === name) ||
    GT.find((s) => s.f === name);
  return info && (info.a || info.t)
    ? [info.a, info.t].filter(Boolean).join(" - ")
    : name;
}
function hideBar(name) {
  const pl = $("player");
  pl.style.display = "flex";
  pl.classList.add("on");
  if (!$("audio").src && !BOTH) setNow("♪ Now playing: ", "Empty");
  else setNow("♪ Now playing: ", songLabel(name || NOW_NAME));
  fixTh();
}

async function playFile(name) {
  showWait();
  stopBoth();
  const ogg = await fetchOgg(name);
  const url = URL.createObjectURL(new Blob([ogg], { type: "audio/ogg" }));
  const au = $("audio");
  if (au.src && au.src.startsWith("blob:")) URL.revokeObjectURL(au.src);
  au.src = url;
  NOW_NAME = name;
  await au.play();
  document.querySelectorAll("tr.playing").forEach((r) => r.classList.remove("playing"));
  const btn2 = document.querySelector(`button[data-act="play"][data-f="${CSS.escape(name)}"]`);
  if (btn2 && btn2.closest("tr")) btn2.closest("tr").classList.add("playing");
  hideBar(name);
}

function noteName(name) {
  return name.replace(/\.(tbm|abm)$/i, "_note.$1");
}

async function onAction(btn) {
  const act = btn.dataset.act, name = btn.dataset.f;
  const base = name.replace(/\.(tbm|abm)$/i, "");
  // play/ogg/mp3 need OGG bytes. With DECODE_BASE set the decode server
  // supplies them; otherwise they go through the worker/same-origin API.
  if (act !== "tbm" && !DECODE_BASE && !apiReady()) {
    status("Play/OGG/MP3 need DECODE_BASE or the worker URL in app.js.");
    return;
  }
  if (!SRV.api && (act === "play" || act === "ogg" || act === "mp3" || !SRV.rawDirect)) {
    status(SRV.name + " files are not hosted yet.");
    return;
  }
  btn.disabled = true;
  const done = () => { btn.disabled = false; };
  try {
    if (act === "play") {
      await playFile(name);
      done();
    } else if (act === "both") {
      await playBoth(backingOf(name));
      done();
    } else if (act === "tbm") {
      // raw download: straight to the file server where possible (browser
      // navigates itself, no API/JSON involved at all), else fetch+save
      // (needed when the file may live under another name/place).
      if (SRV.rawDirect) {
        const a = document.createElement("a");
        a.href = SRV.direct(name);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        showWait();
        const tbm = await fetchTbm(name);
        saveBlob(new Blob([tbm], { type: "application/octet-stream" }), name);
        hideBar(name);
      }
    } else if (act === "ogg") {
      showWait();
      const ogg = await fetchOgg(name);
      saveBlob(new Blob([ogg], { type: "audio/ogg" }), base + ".ogg");
      hideBar(name);
    } else if (act === "mp3") {
      showWait();
      const ogg = await fetchOgg(name);
      const actx = new (window.AudioContext || window.webkitAudioContext)();
      const ab = await actx.decodeAudioData(ogg.slice().buffer);
      // fixed 44.1 kHz: resample via OfflineAudioContext (browser does it)
      const TARGET_RATE = 44100;
      let pcmBuf = ab;
      if (ab.sampleRate !== TARGET_RATE) {
        const off = new OfflineAudioContext(ab.numberOfChannels,
          Math.ceil(ab.duration * TARGET_RATE), TARGET_RATE);
        const src = off.createBufferSource();
        src.buffer = ab;
        src.connect(off.destination);
        src.start(0);
        pcmBuf = await off.startRendering();
      }
      if (typeof lamejs === "undefined")
        await new Promise((res, rej) => {
          const sc = document.createElement("script");
          sc.src = LAMEJS_CDN; sc.onload = res; sc.onerror = () => rej(new Error("failed to load lamejs"));
          document.head.appendChild(sc);
        });
      const enc = new lamejs.Mp3Encoder(pcmBuf.numberOfChannels, TARGET_RATE, 128);
      const n = pcmBuf.length, ch0 = pcmBuf.getChannelData(0);
      const ch1 = pcmBuf.numberOfChannels > 1 ? pcmBuf.getChannelData(1) : null;
      const i16 = (f) => {
        const o = new Int16Array(f.length);
        for (let i = 0; i < f.length; i++) {
          let v = f[i]; if (v > 1) v = 1; if (v < -1) v = -1;
          o[i] = v < 0 ? v * 32768 : v * 32767;
        }
        return o;
      };
      const b0 = i16(ch0), b1 = ch1 ? i16(ch1) : null;
      const parts = [];
      const CH = 1152;
      for (let i = 0; i < n; i += CH) {
        const a0 = b0.subarray(i, i + CH), a1 = b1 ? b1.subarray(i, i + CH) : a0;
        const mp = enc.encodeBuffer(a0, a1);
        if (mp.length) parts.push(mp);
      }
      const end = enc.flush();
      if (end.length) parts.push(end);
      // concat mp3 frames, then scrub every "LAME" marker lamejs plants
      // (one per frame) so players stop reporting this file as LAME-made.
      let total = 0;
      for (const c of parts) total += c.length;
      const bin = new Uint8Array(total);
      let bp = 0;
      for (const c of parts) { bin.set(c, bp); bp += c.length; }
      for (let i = 0; i + 4 < bin.length; i++) {
        if (bin[i] === 0x4c && bin[i+1] === 0x41 && bin[i+2] === 0x4d && bin[i+3] === 0x45) {
          bin[i] = 0x41; bin[i+1] = 0x55; bin[i+2] = 0x44; bin[i+3] = 0x49;
        }
      }
      saveBlob(new Blob([bin], { type: "audio/mpeg" }), base + ".mp3");
      hideBar(name);
    }
  } catch (e) {
    console.error("[AM5 temp-debug]", name, act, e && e.stack || e);
    status((act || "play") + " failed: " + (e && e.message || e));
    hideBar(name);
  }
  done();
}

const SVG_PLAY = '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M15.82 9.383a81.65 81.65 0 0 0-4.534-2.618 74.589 74.589 0 0 0-3.378-1.702.662.662 0 0 0-.94.543 74.476 74.476 0 0 0-.216 3.777 81.376 81.376 0 0 0 0 5.234 74.47 74.47 0 0 0 .215 3.777c.038.458.525.739.94.543a74.596 74.596 0 0 0 3.379-1.702 81.654 81.654 0 0 0 4.533-2.618 74.416 74.416 0 0 0 3.195-2.096.635.635 0 0 0 0-1.041 74.368 74.368 0 0 0-3.195-2.097Z"/></svg>';
const SVG_PAUSE = '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M11.125 5v14H7.206a.848.848 0 01-.832-.72 39.734 39.734 0 01-.498-6.648c.017-2.261.217-4.24.481-5.908A.849.849 0 017.19 5h3.936ZM16.794 5c.41 0 .764.302.832.72a39.746 39.746 0 01.498 6.648 39.686 39.686 0 01-.481 5.908.849.849 0 01-.833.724H12.875V5h3.919Z"/></svg>';
const SVG_REPEAT_ALL = '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.993 4.518c.11.065.2.118.381.234.61.391 1.019.671 1.616 1.11a1.18 1.18 0 0 1 .286 1.609 29.367 29.367 0 0 1-1.14 1.597 7.699 7.699 0 0 1-.289.36l-.11.136-.977-.785.13-.16.01-.012c.068-.083.127-.154.239-.3.132-.174.248-.33.36-.481l.17-.232-.282.058C6.683 8.205 5.254 9.709 5.254 12c0 3.32 2.882 4.298 5.347 4.527l-.104 1.25C6.367 17.393 4 15.292 4 12c0-2.945 1.869-4.932 5.26-5.597l.261-.051-.221-.15c-.186-.125-.38-.251-.603-.395a8.155 8.155 0 0 0-.349-.213l-.168-.1.649-1.073.164.097Zm4.51 1.706C17.634 6.606 20 8.707 20 12c0 2.902-1.818 4.88-5.118 5.572l-.255.053.216.147c.197.134.403.268.64.421.17.108.249.155.352.214l.166.1-.649 1.072-.16-.095-.011-.006a9.166 9.166 0 0 1-.375-.23 27.485 27.485 0 0 1-1.616-1.11 1.18 1.18 0 0 1-.285-1.609c.4-.598.687-1.001 1.14-1.596.126-.165.193-.246.27-.34l.018-.021.112-.136.977.785-.132.16c-.072.088-.13.159-.246.311-.12.157-.226.298-.328.435l-.176.24.29-.067c2.563-.587 3.916-2.074 3.916-4.3 0-3.32-2.881-4.298-5.347-4.527l.105-1.25Z"/></svg>';
// Deezer uses one icon whose loop encloses the "1" — copy that instead of
// floating a badge outside the glyph.
const SVG_REPEAT_ONE = '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M12 4.6a7.4 7.4 0 1 0 7.4 7.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M12 4.6 L14.3 2.3 L14.3 6.9 Z" fill="currentColor"/><path d="M19.4 12 L17.1 14.3 L21.7 14.3 Z" fill="currentColor"/><text x="12" y="15.8" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="8.5" font-weight="800" fill="currentColor">1</text></svg>';
const fmtT = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
};
const setPlayIcon = () => {
  const playing = BOTH ? !BOTH.paused : !$("audio").paused;
  $("pv-play").innerHTML = playing ? SVG_PAUSE : SVG_PLAY;
};

function switchServer(id) {
  const found = SERVERS.find((s) => s.id === id);
  if (!found) return;
  SRV = found;
  try { localStorage.setItem("am5srv", id); } catch (e) {}
  try {
    const au = $("audio");
    au.pause();
    au.removeAttribute("src");
    au.load();
  } catch (e) {}
  stopBoth();
  NOW_NAME = "";
  $("pv-play").innerHTML = SVG_PLAY;
  REPEAT_STATE = 0;
  $("audio").loop = false;
  $("repeat").classList.remove("on");
  $("repeat").innerHTML = SVG_REPEAT_ALL;
  $("pv-fill").style.width = "0%";
  $("pv-vol").value = 100;
  $("pv-volpct").textContent = "100%";
  $("pv-vol").style.background = "linear-gradient(to right, #a238ff 100%, var(--rail) 100%)";
  $("pv-cur").textContent = "0:00";
  $("pv-dur").textContent = "0:00";
  $("pv-seek").value = 0;
  document.querySelectorAll("tr.playing").forEach((r) => r.classList.remove("playing"));
  hideBar("");   // keep the player bar visible; reset to "Empty"
  boot();
}

function doInit() {
  const sel = $("srv");
  for (const s of SERVERS) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.name;
    if (s.id === SRV.id) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => switchServer(sel.value));
  boot();
  fixTh();
  window.addEventListener("resize", fixTh);
  $("audio").addEventListener("ended", () => advanceAfterEnd());
  $("np-song").addEventListener("click", () => {
    if (!NOW_NAME) return;
    if (!cur().some((s) => s.f === NOW_NAME) &&
        !SONGS.some((s) => s.f === NOW_NAME) &&
        !BALL.some((s) => s.f === NOW_NAME) &&
        !GT.some((s) => s.f === NOW_NAME)) return;
    const findBtn = () => document.querySelector(`button[data-act="play"][data-f="${CSS.escape(NOW_NAME)}"]`);
    let btn = findBtn();
    // row may be unrendered (pagination) — render more until found
    while (!btn && SHOWN < FILTERED.length) {
      more();
      btn = findBtn();
    }
    // row hidden by search filter — clear search, then render until found
    if (!btn && FILTERED.length !== cur().length) {
      $("q").value = "";
      applyFilter("");
      $("qclear").hidden = true;
      btn = findBtn();
      while (!btn && SHOWN < FILTERED.length) {
        more();
        btn = findBtn();
      }
    }
    if (!btn) return;
    const row = btn.closest("tr");
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("found");
    setTimeout(() => row.classList.remove("found"), 1800);
  });
  $("shuf").addEventListener("click", () => {
    SHUFFLE = !SHUFFLE;
    $("shuf").classList.toggle("on", SHUFFLE);
  });
  // Single repeat button, 3 stages like Deezer:
  // 0 = off, 1 = repeat all, 2 = repeat one (small "1" badge on the icon).
  $("repeat").innerHTML = SVG_REPEAT_ALL;
  const applyRepeat = () => {
    const on = REPEAT_STATE !== 0;
    $("repeat").classList.toggle("on", on);
    $("repeat").innerHTML = REPEAT_STATE === 2 ? SVG_REPEAT_ONE : SVG_REPEAT_ALL;
    $("audio").loop = REPEAT_STATE === 2;
  };
  $("repeat").addEventListener("click", () => {
    REPEAT_STATE = (REPEAT_STATE + 1) % 3;
    applyRepeat();
  });
  applyRepeat();
  const paintSeek = () => {
    const au = $("audio");
    if (!au.duration) return;
    const pct = (au.currentTime / au.duration) * 100;
    $("pv-seek").value = Math.round(pct * 10);
    $("pv-fill").style.width = pct + "%";
  };
  $("pv-play").addEventListener("click", () => {
    if (BOTH) {
      if (BOTH.paused) {
        BOTH.ctx.resume();
        BOTH.t0 = BOTH.ctx.currentTime;
        BOTH.paused = false;
      } else {
        BOTH.ctx.suspend();
        BOTH.paused = true;
      }
      setPlayIcon();
      return;
    }
    const au = $("audio");
    if (!au.src) return;
    if (au.paused) au.play().catch(() => {});
    else au.pause();
  });
  const stepTrack = (dir) => {
    const pool = FILTERED.length ? FILTERED : cur();
    if (!pool.length) return;
    let i = pool.findIndex((s) => s.f === NOW_NAME);
    if (i < 0) i = dir > 0 ? -1 : 0;
    const nxt = pool[(i + dir + pool.length) % pool.length];
    if (nxt) playFile(nxt.f).catch((e) => status("Skip failed: " + e.message));
  };
  $("pv-prev").addEventListener("click", () => stepTrack(-1));
  $("pv-next").addEventListener("click", () => stepTrack(1));
  $("audio").addEventListener("timeupdate", () => {
    const au = $("audio");
    $("pv-cur").textContent = fmtT(au.currentTime);
    paintSeek();
  });
  $("audio").addEventListener("loadedmetadata", () => {
    $("pv-dur").textContent = fmtT($("audio").duration);
    $("pv-fill").style.width = "0%";
    setPlayIcon();
    paintSeek();
  });
  $("audio").addEventListener("play", setPlayIcon);
  $("audio").addEventListener("pause", setPlayIcon);
  $("pv-seek").addEventListener("input", (e) => {
    if (BOTH && BOTH.dur) {
      restartBoth((e.target.value / 1000) * BOTH.dur);
      return;
    }
    const au = $("audio");
    if (au.duration) au.currentTime = (e.target.value / 1000) * au.duration;
  });
  const paintVol = () => {
    const v = Number($("pv-vol").value);
    $("pv-vol").style.background =
      "linear-gradient(to right, #a238ff " + v + "%, var(--rail) " + v + "%)";
  };
  $("pv-vol").addEventListener("input", (e) => {
    const au = $("audio");
    au.muted = false;
    au.volume = e.target.value / 100;
    if (BOTH) BOTH.gain.gain.value = e.target.value / 100;
    $("pv-volpct").textContent = e.target.value + "%";
    paintVol();
  });
  paintVol();
  const syncClear = () => { $("qclear").hidden = $("q").value.length === 0; };
  $("q").addEventListener("input", (e) => { applyFilter(e.target.value); syncClear(); });
  const setMode = (m) => {
    MODE = m;
    $("tab-all").classList.toggle("on", m === "all");
    $("tab-ball").classList.toggle("on", m === "ball");
    $("tab-gt").classList.toggle("on", m === "gt");
    $("th-new").style.display = m === "ball" ? "none" : "";
    $("th-lvl").style.display = m === "gt" ? "" : "none";
    applyFilter($("q").value);
  };
  $("tab-all").addEventListener("click", () => setMode("all"));
  $("tab-ball").addEventListener("click", () => setMode("ball"));
  $("tab-gt").addEventListener("click", () => setMode("gt"));
  $("th-lvl").style.display = "none";
  $("qclear").addEventListener("click", () => {
    $("q").value = "";
    applyFilter("");
    syncClear();
    $("q").focus();
  });
  syncClear();
  $("more").addEventListener("click", more);
  // auto-load next 300 when button shows (scroll) - all 6187
  // show everything without repeated clicks
  new IntersectionObserver((es) => {
    if (es.some((e) => e.isIntersecting)) more();
  }).observe($("more"));
  $("rows").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (b) onAction(b);
  });
}
if (document.readyState !== "loading") {
  doInit();
} else {
  document.addEventListener("DOMContentLoaded", doInit);
}
