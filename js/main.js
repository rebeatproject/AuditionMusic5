// main.js - Worker entry: login, users, API, static assets

import { readMT, adminState, adminSet, maintenanceGate } from "./MT.js";
import { chatRoute } from "./chatapi.js";

const enc = new TextEncoder();
const ADMIN_COOKIE = "am5admin";
const SESS_COOKIE = "am5sess";
const SLK_PREFIX = "slk:";

// ---------- session / crypto helpers ----------
function b64url(buf) {
  const b = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
function constEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function secret(env) { return env.SESSION_SECRET || env.ADMIN_KEY || "am5-fallback-secret"; }

async function makeSession(env, obj) {
  const payload = b64url(enc.encode(JSON.stringify(obj)));
  return payload + "." + (await hmac(secret(env), payload));
}
async function readSession(env, cookieHeader) {
  const m = (cookieHeader || "").match(new RegExp("(?:^|;\\s*)" + SESS_COOKIE + "=([^;]+)"));
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  if (!constEq(sig, await hmac(secret(env), payload))) return null;
  try {
    const o = JSON.parse(new TextDecoder().decode(unb64url(payload)));
    if (!o.exp || o.exp < Date.now()) return null;
    return o;
  } catch (e) { return null; }
}
function setCookie(name, val, maxAge) {
  return name + "=" + val + "; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=" + maxAge;
}
function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(extra || {}) },
  });
}

// ---------- admin key bypass ----------
function isAdminKey(req, env) {
  const url = new URL(req.url);
  const key = env.ADMIN_KEY || "";
  if (!key) return false;
  const given = url.searchParams.get("admin") || url.searchParams.get("key");
  if (given && constEq(given, key)) return "grant";
  const m = (req.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + ADMIN_COOKIE + "=" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:;|$)"));
  return m ? "ok" : false;
}

// ---------- static assets ----------
async function serveAssets(env, req) {
  const a = env && env.BINDING_ASSETS;
  if (!a) return null;
  let res = await a.fetch(req);
  // ikuti redirect .aspx internal (html_handling auto)
  if (res && [301, 302, 307, 308].includes(res.status)) {
    const loc = res.headers.get("Location");
    if (loc) res = await a.fetch(new Request(new URL(loc, req.url).toString(), req));
  }
  if (res && new URL(req.url).pathname === "/js/sw.js") {
    const h = new Headers(res.headers);
    h.set("Service-Worker-Allowed", "/");
    h.set("Cache-Control", "no-cache");
    res = new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
  return res;
}

// ---------- GitHub CSV storage ----------
function ghConf(env) {
  return {
    token: env.GH_TOKEN || "",
    repo: env.GH_REPO || "",
    branch: env.GH_BRANCH || "main",
    dir: (env.GH_DIR || "data").replace(/\/+$/, ""),
  };
}
function userPath(env) { return ghConf(env).dir + "/users.csv"; }
function fbPath(env) { return ghConf(env).dir + "/fb-users.csv"; }
function googlePath(env) { return ghConf(env).dir + "/google-users.csv"; }

function ghHeaders(token) {
  return {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "AuditionMusic5-Worker",
  };
}
function b64encode(str) {
  const bytes = enc.encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(s) {
  s = s.replace(/[\r\n]/g, "");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(out);
}

async function ghReadFile(env, path) {
  const c = ghConf(env);
  if (!c.token || !c.repo) return null;
  const base = "https://api.github.com/repos/" + c.repo + "/contents/" + path;
  const r = await fetch(base + "?ref=" + encodeURIComponent(c.branch), { headers: ghHeaders(c.token) });
  if (r.status === 404) return { sha: null, text: "" };
  if (!r.ok) return null;
  const j = await r.json();
  let text = "";
  if (j.content) {
    text = b64decode(j.content);
  } else if (j.sha) {
    // file kegedean buat JSON -> fetch mentah
    const raw = await fetch(base, { headers: { ...ghHeaders(c.token), Accept: "application/vnd.github.raw" } });
    if (raw.ok) text = await raw.text();
  }
  return { sha: j.sha, text };
}
async function ghWriteFile(env, path, text, sha, message) {
  const c = ghConf(env);
  const body = { message: message || "update " + path, content: b64encode(text), branch: c.branch };
  if (sha) body.sha = sha;
  const r = await fetch("https://api.github.com/repos/" + c.repo + "/contents/" + path, {
    method: "PUT",
    headers: { ...ghHeaders(c.token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.ok;
}

// baca store: GitHub (prod) atau asset lokal (dev)
async function readStore(env, filename) {
  const c = ghConf(env);
  if (c.token && c.repo) return ghReadFile(env, c.dir + "/" + filename);
  const a = env.BINDING_ASSETS;
  if (!a) return null;
  const r = await a.fetch(new Request("https://assets.local/" + c.dir + "/" + filename));
  if (!r.ok) return null;
  return { sha: null, text: await r.text() };
}

// ---------- csv/psv helpers ----------
function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvRow(vals) { return vals.map(csvCell).join(",") + "\n"; }

function detectDelim(line) {
  const count = (d) => line.split(d).length - 1;
  let best = ",";
  let n = 0;
  for (const d of [";", "|", ","]) {
    const c = count(d);
    if (c > n) { n = c; best = d; }
  }
  return best;
}
function splitLine(line, delim) {
  if (delim !== ",") return line.split(delim).map((s) => s.trim());
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
// terima pemisah ; | , + buang baris header
function parseTable(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  const delim = detectDelim(lines[0]);
  const rows = lines.map((l) => splitLine(l, delim));
  const h = (rows[0][0] || "").trim().toLowerCase();
  if (["username", "user", "nama", "name", "time", "fb_id"].includes(h)) rows.shift();
  return rows;
}
// poweruser: 1=admin 2=vip 3=user 4=dev
function roleOf(power) {
  const v = String(power == null ? "" : power).trim().toLowerCase();
  if (v === "1" || v === "admin" || v === "a") return "admin";
  if (v === "2" || v === "vip" || v === "s") return "vip";
  if (v === "4" || v === "dev" || v === "d") return "dev";
  if (v === "3" || v === "user" || v === "u") return "user";
  return v || "user";
}

async function findUser(env, username) {
  const f = await readStore(env, "users.csv");
  if (!f || !f.text) return null;
  const target = username.toLowerCase();
  for (const r of parseTable(f.text)) {
    if ((r[0] || "").trim().toLowerCase() === target)
      return { username: (r[0] || "").trim(), password: r[1] || "", poweruser: (r[2] || "").trim() };
  }
  return null;
}

async function appendFbUser(env, u) {
  if (!env.GH_TOKEN || !env.GH_REPO) return false;
  const path = fbPath(env);
  const header = "Nama,Username,url\n";
  const row = csvRow([u.name || "", u.username || "", u.url || ""]);
  for (let i = 0; i < 3; i++) {
    const cur = await ghReadFile(env, path);
    if (!cur) return false;
    const text = (cur.text || header) + row;
    if (await ghWriteFile(env, path, text, cur.sha, "log: fb " + (u.name || u.username || ""))) return true;
    await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }
  return false;
}

// google-users.csv: 1 baris per akun (dedupe by Id)
async function appendGoogleUser(env, u) {
  if (!env.GH_TOKEN || !env.GH_REPO) return false;
  const path = googlePath(env);
  const header = "Nama,Email,Id\n";
  const row = csvRow([u.name || "", u.email || "", u.id || ""]);
  const key = String(u.id || u.email || "").trim().toLowerCase();
  for (let i = 0; i < 3; i++) {
    const cur = await ghReadFile(env, path);
    if (!cur) return false;
    const lines = String(cur.text || "").split(/\r?\n/).filter((l) => l.trim() !== "");
    const out = [];
    const seen = new Set();
    for (const l of lines) {
      if (/^(nama|name)\s*,/i.test(l)) { out.push(l); continue; }
      const cells = splitLine(l, ",");
      const k = String(cells[2] || cells[1] || "").trim().toLowerCase();
      if (k && seen.has(k)) continue; // baris ganda -> buang
      if (k) seen.add(k);
      out.push(l);
    }
    if (key && seen.has(key)) {
      // akun lama: rapikan duplikat, jangan tambah baris
      if (out.length !== lines.length) {
        await ghWriteFile(env, path, out.join("\n") + "\n", cur.sha, "dedupe: google users");
      }
      return true;
    }
    const text = (out.length ? out.join("\n") + "\n" : header) + row;
    if (await ghWriteFile(env, path, text, cur.sha, "log: google " + (u.name || u.email || ""))) return true;
    await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }
  return false;
}

// ---------- helpers ----------
function isAdmSess(s) { return !!(s && (s.t === "adm" || s.r === "admin")); }
// panel akses: admin (role 1) atau dev (role 4)
function isPanelSess(s) { return !!(s && (s.t === "adm" || s.r === "admin" || s.r === "dev")); }
function isDevSess(s) { return !!(s && s.r === "dev"); }
function isLogged(s) { return !!s; }
function fbUsername(u) {
  const link = u.link || "";
  const m = link.match(/facebook\.com\/([^/?#]+)/i);
  if (m && !/^(profile\.php|app_scoped_user_id|people)$/i.test(m[1])) return m[1];
  return u.id || "";
}
function clearCookie() {
  return SESS_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0";
}

// ---------- auth handlers ----------
// tulis log SETELAH response jalan: kalau nunggu, client timeout -> catatan ilang
function keep(ctx, p) {
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  return p;
}
function logSoon(env, req, ctx, rec) {
  return keep(ctx, logOnline(env, req, rec));
}
async function handleMe(req, env, ctx) {
  const s = await readSession(env, req.headers.get("Cookie"));
  if (!s) {
    logSoon(env, req, ctx, { user: "-", power: "-", type: "guest" });
    return json({ logged: false, fb: false, google: false, admin: false, dev: false, vip: false, user: false, name: "", role: "" });
  }
  const fb = s.t === "fb" || s.fb === true;
  const google = s.t === "goo" || s.g === true;
  const admin = s.t === "adm" || s.r === "admin";
  const vip = s.r === "vip";
  const dev = s.r === "dev";
  const user = s.t === "usr" || admin || fb || google;
  const rec = {
    user: user ? (s.n || "-") : "-",
    power: user ? rolePower(s.r || (fb || google ? "user" : "")) : "-",
    type: fb ? "Facebook" : google ? "Google" : user ? "AM5" : "guest",
  };
  const p = logSoon(env, req, ctx, rec);
  if (!ctx || !ctx.waitUntil) await p;
  return json({ logged: true, fb, google, admin, dev, vip, user, name: s.n || "", role: s.r || (fb || google ? "user" : "") });
}

async function handleLogin(req, env, ctx) {
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const u = String(body.u || "").trim();
  const p = String(body.p || "");
  if (!u) return json({ ok: false, error: "invalid credentials" }, 401);

  // lockout: maks 10 percobaan/menit per username
  if (env.LOGIN_LIMITER) {
    const gate = await env.LOGIN_LIMITER.limit({ key: "u:" + u.toLowerCase().slice(0, 64) });
    if (!gate.success) return json({ ok: false, error: "too many attempts" }, 429);
  }

  let role = null;
  const rec = await findUser(env, u);
  if (rec && rec.password === p) {
    role = roleOf(rec.poweruser);
  } else if (env.ADMIN_USER && constEq(u, env.ADMIN_USER) && constEq(p, env.ADMIN_PASS || "")) {
    // env fallback admin (used only if the CSV store has no match)
    role = "admin";
  }
  if (role === null) return json({ ok: false, error: "invalid credentials" }, 401);

  // MT nyala: cuma admin/dev boleh login
  if (await readMT(env)) {
    const ok = role === "admin" || role === "dev";
    if (!ok) return json({ ok: false, error: "maintenance" }, 403);
  }

  const t = role === "admin" ? "adm" : "usr";
  const sess = await makeSession(env, { t, n: u, r: role, exp: Date.now() + 7 * 864e5 });
  keep(ctx, logLogin(env, req, { user: u, role, type: "AM5" }));
  return json({ ok: true, role }, 200, { "Set-Cookie": setCookie(SESS_COOKIE, sess, 604800) });
}

function handleLogout() {
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
}

async function handleFbStart(req, env) {
  if (!env.FB_APP_ID) return json({ ok: false, error: "FB_APP_ID not set" }, 500);
  const url = new URL(req.url);
  const redirect = url.origin + "/api/auth/fb/callback";
  const payload = b64url(
    enc.encode(JSON.stringify({ n: Math.random().toString(36).slice(2), exp: Date.now() + 600000 }))
  );
  const st = payload + "." + (await hmac(secret(env), payload));
  const fb =
    "https://www.facebook.com/v19.0/dialog/oauth" +
    "?client_id=" + encodeURIComponent(env.FB_APP_ID) +
    "&redirect_uri=" + encodeURIComponent(redirect) +
    "&state=" + encodeURIComponent(st) +
    "&scope=" + encodeURIComponent("public_profile,email");
  return new Response(null, { status: 302, headers: { Location: fb } });
}

async function handleFbCallback(req, env, url, ctx) {
  const code = url.searchParams.get("code");
  const st = url.searchParams.get("state") || "";
  const [payload, sig] = st.split(".");
  if (!code || !payload || !constEq(sig || "", await hmac(secret(env), payload)))
    return new Response("bad state", { status: 400 });

  const redirect = url.origin + "/api/auth/fb/callback";
  const tokUrl =
    "https://graph.facebook.com/v19.0/oauth/access_token" +
    "?client_id=" + encodeURIComponent(env.FB_APP_ID) +
    "&client_secret=" + encodeURIComponent(env.FB_APP_SECRET || "") +
    "&redirect_uri=" + encodeURIComponent(redirect) +
    "&code=" + encodeURIComponent(code);
  const tr = await fetch(tokUrl);
  if (!tr.ok) return new Response("fb token error", { status: 502 });
  const tok = await tr.json();

  const ur = await fetch(
    "https://graph.facebook.com/me?fields=id,name,email,link&access_token=" + encodeURIComponent(tok.access_token)
  );
  const u = ur.ok ? await ur.json() : {};

  // history: data/fb-user.csv  (Nama, Username, url) — best effort
  try {
    await appendFbUser(env, {
      name: u.name || "",
      username: fbUsername(u),
      url: u.link || (u.id ? "https://facebook.com/" + u.id : ""),
    });
  } catch (e) {}

  // Facebook login = role 3 (user): general server + MP3/OGG download
  const sess = await makeSession(env, { t: "usr", r: "user", fb: true, n: u.name || "Facebook user", id: u.id || "", exp: Date.now() + 7 * 864e5 });
  keep(ctx, logLogin(env, req, { user: u.name || "Facebook user", role: "user", type: "Facebook" }));
  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Set-Cookie": setCookie(SESS_COOKIE, sess, 604800) },
  });
}

async function handleGoogleStart(req, env) {
  if (!env.GOOGLE_CLIENT_ID) return json({ ok: false, error: "GOOGLE_CLIENT_ID not set" }, 500);
  const url = new URL(req.url);
  const redirect = url.origin + "/api/auth/google/callback";
  const payload = b64url(
    enc.encode(JSON.stringify({ n: Math.random().toString(36).slice(2), exp: Date.now() + 600000 }))
  );
  const st = payload + "." + (await hmac(secret(env), payload));
  const go =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    "?client_id=" + encodeURIComponent(env.GOOGLE_CLIENT_ID) +
    "&redirect_uri=" + encodeURIComponent(redirect) +
    "&response_type=code" +
    "&scope=" + encodeURIComponent("openid email profile") +
    "&state=" + encodeURIComponent(st) +
    "&prompt=select_account";
  return new Response(null, { status: 302, headers: { Location: go } });
}

async function handleGoogleCallback(req, env, url, ctx) {
  const code = url.searchParams.get("code");
  const st = url.searchParams.get("state") || "";
  const [payload, sig] = st.split(".");
  if (!code || !payload || !constEq(sig || "", await hmac(secret(env), payload)))
    return new Response("bad state", { status: 400 });

  const redirect = url.origin + "/api/auth/google/callback";
  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: code,
      client_id: env.GOOGLE_CLIENT_ID || "",
      client_secret: env.GOOGLE_CLIENT_SECRET || "",
      redirect_uri: redirect,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!tr.ok) return new Response("google token error", { status: 502 });
  const tok = await tr.json();

  let u = {};
  try {
    const ur = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + (tok.access_token || "") },
    });
    if (ur.ok) u = await ur.json();
  } catch (e) {}

  // history: data/google-users.csv (Nama, Email, Id) — best effort
  try {
    await appendGoogleUser(env, { name: u.name || "", email: u.email || "", id: u.sub || "" });
  } catch (e) {}

  // Google login = role 3 (user): general server + MP3/OGG download
  const sess = await makeSession(env, { t: "usr", r: "user", g: true, n: u.name || "Google user", id: u.sub || "", exp: Date.now() + 7 * 864e5 });
  keep(ctx, logLogin(env, req, { user: u.name || u.email || "Google user", role: "user", type: "Google" }));
  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Set-Cookie": setCookie(SESS_COOKIE, sess, 604800) },
  });
}

// ---------- asset wasm/ffmpeg dari R2 ----------
async function handleFf(req, env, name) {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) return new Response("not found", { status: 404 });
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext !== "js" && ext !== "wasm") return new Response("not found", { status: 404 });
  if (!env.AM5_ASSETS) return new Response("no R2 binding", { status: 500 });
  const obj = await env.AM5_ASSETS.get("ff/" + name);
  if (!obj) return new Response("not found", { status: 404 });
  const md = obj.httpMetadata || {};
  const h = new Headers();
  h.set("Content-Type", md.contentType || (ext === "wasm" ? "application/wasm" : "text/javascript; charset=utf-8"));
  if (md.contentEncoding) h.set("Content-Encoding", md.contentEncoding);
  h.set("Cache-Control", md.cacheControl || "public, max-age=31536000, immutable");
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Accept-Ranges", "bytes");
  // byte-range: dipakai wasm streaming / download yang di-resume
  const range = req.headers.get("Range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && obj.size) {
    const size = obj.size;
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (isNaN(start) || isNaN(end) || start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + size } });
    }
    end = Math.min(end, size - 1);
    const part = await env.AM5_ASSETS.get("ff/" + name, { range: { offset: start, length: end - start + 1 } });
    if (!part) return new Response("not found", { status: 404 });
    h.set("Content-Range", "bytes " + start + "-" + end + "/" + size);
    h.set("Content-Length", String(end - start + 1));
    return new Response(part.body, { status: 206, headers: h });
  }
  return new Response(obj.body, { status: 200, headers: h });
}

// ---------- admin: download a csv ----------
async function adminDownload(req, env, filename) {
  const s = await readSession(env, req.headers.get("Cookie"));
  const ak = isAdminKey(req, env);
  // role 4 (DEV) only — dipakai tombol di dialog Create Account
  if (!isDevSess(s) && ak !== "grant" && ak !== "ok") return json({ ok: false, error: "forbidden" }, 403);
  const cur = await readStore(env, filename);
  if (!cur) return json({ ok: false, error: "store not available" }, 502);
  const isLog = /\.log$/i.test(filename);
  return new Response(cur.text || "", {
    status: 200,
    headers: {
      "Content-Type": isLog ? "text/plain; charset=utf-8" : "text/csv; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="' + filename + '"',
    },
  });
}

// ---------- admin: upload an SLK into KV ----------
async function handleAdminSlk(req, env, url) {
  const name = (url.searchParams.get("name") || "").toLowerCase();
  if (!/^[a-z0-9_]+\.slk$/.test(name)) return json({ ok: false, error: "bad name" }, 400);
  if (!env.MT_KV) return json({ ok: false, error: "no MT_KV binding" }, 500);
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > 20 * 1024 * 1024) return json({ ok: false, error: "bad size" }, 400);
  await env.MT_KV.put(SLK_PREFIX + name, buf);
  return json({ ok: true, name, size: buf.byteLength });
}

// ---------- admin/dev: create a users.csv account (role 4 only) ----------
async function handleCreateUser(req, env) {
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const u = String(body.u || "").trim();
  const p = String(body.p || "");
  const power = String(body.power == null ? "" : body.power).trim();
  if (!u || !p) return json({ ok: false, error: "Username and password are required" }, 400);
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(u))
    return json({ ok: false, error: "Username must be 3-32 chars (letters, numbers, . _ -)" }, 400);
  if (!["1", "2", "3"].includes(power)) return json({ ok: false, error: "Role must be 1, 2 or 3" }, 400);
  if (/[;\r\n]/.test(u) || /[;\r\n]/.test(p))
    return json({ ok: false, error: "Username or password contains an illegal character" }, 400);

  const path = userPath(env);
  const header = "Username;Password;PowerUser\n";
  for (let i = 0; i < 3; i++) {
    const cur = await ghReadFile(env, path);
    if (!cur) return json({ ok: false, error: "user store not available" }, 502);
    const lines = String(cur.text || "").split(/\r?\n/).filter((l) => l.trim() !== "");
    const head = lines.length && /^username/i.test(lines[0]) ? lines.shift() : "Username;Password;PowerUser";
    for (const l of lines) {
      const cells = splitLine(l, detectDelim(l));
      if ((cells[0] || "").trim().toLowerCase() === u.toLowerCase())
        return json({ ok: false, error: "Username already exist" }, 409);
    }
    const text = [head, ...lines].join("\n") + "\n" + u + ";" + p + ";" + power + "\n";
    if (await ghWriteFile(env, path, text, cur.sha, "user: create " + u)) return json({ ok: true, username: u, power });
    await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }
  return json({ ok: false, error: "write failed, try again" }, 502);
}

// ---------- login log (data/login.log) ----------
// format: [tanggal] user / role / type / ip / country
function jakartaStamp() {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
  }).formatToParts(new Date());
  const g = (t) => (p.find((x) => x.type === t) || {}).value || "";
  const ap = (g("dayPeriod") || "AM").toUpperCase().replace(/\./g, "");
  return "[" + g("day") + "/" + g("month") + "/" + g("year") + " " + g("hour") + ":" + g("minute") + ":" + g("second") + " " + ap + "]";
}
function rolePower(role) {
  const r = String(role || "").toLowerCase();
  if (r === "admin") return "1";
  if (r === "vip") return "2";
  if (r === "dev") return "4";
  return "3";
}
async function geoOf(env, ip) {
  const token = env.IPINFO_TOKEN || "";
  if (!ip || !token) return { country: "", code: "" };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch("https://api.ipinfo.io/lite/" + encodeURIComponent(ip) + "?token=" + encodeURIComponent(token), { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return { country: "", code: "" };
    const j = await r.json();
    return { country: j.country || "", code: j.country_code || "" };
  } catch (e) {
    return { country: "", code: "" };
  }
}
// best-effort: gagal log TIDAK boleh menggagalkan login
async function logLogin(env, req, rec) {
  try {
    const ip = (req && req.headers.get("CF-Connecting-IP")) || "";
    const c = ghConf(env);
    if (!c.token || !c.repo) return false;
    const path = c.dir + "/login.log";
    const header = "Date|Username|PowerUser|Login Type|IP Address|Country\n";
    const stamp = jakartaStamp();
    const geo = await geoOf(env, ip);
    const line = [stamp, rec.user, rolePower(rec.role), rec.type, ip || "-", geo.country || "-"]
      .map((v) => String(v == null ? "" : v).replace(/[|\r\n]/g, " "))
      .join("|") + "\n";
    // baca gagal (rate limit / 5xx) juga dicoba lagi, jangan langsung nyerah
    for (let i = 0; i < 4; i++) {
      const cur = await ghReadFile(env, path);
      if (cur) {
        const base = cur.text && cur.text.trim() ? cur.text.replace(/\n*$/, "\n") : header;
        if (await ghWriteFile(env, path, base + line, cur.sha, "log: login " + rec.user)) return true;
      }
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  } catch (e) {}
  return false;
}

// ---------- online log (data/online.log) ----------
function stampMs(stamp) {
  const m = /^\[(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ?(AM|PM)\]$/i.exec(String(stamp || "").trim());
  if (!m) return 0;
  let h = Number(m[4]) % 12;
  if ((m[7] || "").toUpperCase() === "PM") h += 12;
  return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), h - 7, Number(m[5]), Number(m[6]));
}
async function logOnline(env, req, rec) {
  try {
    const c = ghConf(env);
    if (!c.token || !c.repo) return false;
    const ip = (req && req.headers.get("CF-Connecting-IP")) || "";
    const path = c.dir + "/online.log";
    const header = "Date|Username|PowerUser|Login Type|IP Address|Country\n";
    for (let i = 0; i < 2; i++) {
      const cur = await ghReadFile(env, path);
      if (!cur) return false;
      const text = cur.text || "";
      const lines = text.split("\n");
      let dup = false;
      for (let k = lines.length - 1, n = 0; k >= 0 && n < 400; k--, n++) {
        const f = lines[k].split("|");
        if (f.length < 6) continue;
        if (f[1] !== rec.user || f[4] !== (ip || "-")) continue;
        dup = Date.now() - stampMs(f[0]) < 30 * 6e4;
        break;
      }
      if (dup) return false;
      const geo = await geoOf(env, ip);
      const base = text.trim() ? text.replace(/\n*$/, "\n") : header;
      const line = [jakartaStamp(), rec.user, rec.power, rec.type, ip || "-", geo.country || "-"]
        .map((v) => String(v == null ? "" : v).replace(/[|\r\n]/g, " "))
        .join("|") + "\n";
      if (await ghWriteFile(env, path, base + line, cur.sha, "log: online " + rec.user)) return true;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  } catch (e) {}
  return false;
}

// ---------- geo (IPinfo Lite) ----------
// panggil per-IP user, jangan cache global
async function handleGeo(req, env) {
  const ip = req.headers.get("CF-Connecting-IP") || "";
  const token = env.IPINFO_TOKEN || "";
  if (!ip) return json({ ok: false, error: "no client ip" }, 400);
  if (!token) return json({ ok: false, error: "IPINFO_TOKEN not set" }, 500);
  try {
    const r = await fetch("https://api.ipinfo.io/lite/" + encodeURIComponent(ip) + "?token=" + encodeURIComponent(token));
    if (!r.ok) return json({ ok: false, error: "ipinfo " + r.status }, 502);
    const j = await r.json();
    return json({
      ok: true,
      ip: j.ip || ip,
      country: j.country || "",
      country_code: j.country_code || "",
      continent: j.continent || "",
      asn: j.asn || "",
      as_name: j.as_name || "",
    });
  } catch (e) {
    return json({ ok: false, error: "ipinfo unreachable" }, 502);
  }
}

// ---------- visitor online (realtime, D1) ----------
const ONLINE_TTL = 75000;   // 3x ping client (25s)
let ONLINE_SCHEMA = false;
async function onlineEnsure(env) {
  if (ONLINE_SCHEMA) return true;
  const d = env.CHAT_DB || null;
  if (!d) return false;
  try {
    await d.batch([
      d.prepare("CREATE TABLE IF NOT EXISTS online_now (k TEXT PRIMARY KEY, name TEXT, ip TEXT, at INTEGER NOT NULL)"),
      d.prepare("CREATE INDEX IF NOT EXISTS idx_online_at ON online_now(at)"),
    ]);
    ONLINE_SCHEMA = true;
  } catch (e) { return false; }
  return true;
}
async function handleOnlinePing(req, env, sess) {
  if (!(await onlineEnsure(env))) return json({ ok: false, error: "online off" }, 503);
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const d = env.CHAT_DB;
  const ip = req.headers.get("CF-Connecting-IP") || "";
  const vid = String(body.v || "").replace(/[^0-9a-z]/gi, "").slice(0, 24);
  const nm = sess && sess.n ? String(sess.n).slice(0, 40) : "";
  const key = nm ? "u:" + nm.toLowerCase() : vid ? "v:" + vid : "ip:" + (ip || "?");
  const now = Date.now();
  try {
    await d.prepare("INSERT INTO online_now (k, name, ip, at) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET name = excluded.name, ip = excluded.ip, at = excluded.at")
      .bind(key, nm, ip, now).run();
  } catch (e) {
    return json({ ok: false, error: "db" }, 500);
  }
  const row = await d.prepare("SELECT COUNT(*) AS c, SUM(CASE WHEN k LIKE 'u:%' THEN 1 ELSE 0 END) AS m FROM online_now WHERE at >= ?").bind(now - ONLINE_TTL).first();
  if (Math.random() < 0.02) {
    try { await d.prepare("DELETE FROM online_now WHERE at < ?").bind(now - 864e5).run(); } catch (e) {}
  }
  const total = (row && row.c) || 0;
  const mem = (row && row.m) || 0;
  return json({ ok: true, now: total, members: mem, guests: Math.max(0, total - mem) });
}

// upstream per server (subdomain sendiri, proxy OFF; ayo wajib hostname karena Workers gak bisa fetch IP mentah)
const UP = {
  ayo: "http://ayo.auditionmusic5.com",
  vtc: "http://aumusic.vtcgame.vn",
  next: "http://auto-audiph.playpark.net",
  th: "https://auto-au.playpark.com",
  cn: "http://au.patch1.9you.com",
  kr: "http://au-patch.hanbiton.com",
  tw: "http://patch-au.mangot5.com.tw",
  ax: "http://audl.axeso5.com"
};

// path file mentah per server (samain dengan SRV.direct di app.src.js)
function originPath(srv, name) {
  const n = encodeURIComponent(name);
  switch (srv) {
    case "ayo":
      return (/\.abm$/i.test(name) ? "/audition/package/ABM/" : "/audition/ABM/") + n;
    case "vtc":
      return "/abm/" + n;
    case "next":
      return "/live/audition/package/abm/" + n;
    case "th":
      return "/package/abm/" + n;
    case "cn":
      return "/ABM/" + n;
    case "kr":
      return "/adtpatch/audition/package/ABM/" + n;
    case "tw":
      return "/audition_patch/patch/live/audition/package/abm/" + n;
    case "ax":
      return "/update/content/ABM/" + n;
  }
  return "";
}

// teruskan file dari origin; url publik tetap di domain utama (tanpa relay apa pun)
async function handleFile(req, srv, name) {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name) || !/\.(tbm|abm)$/i.test(name))
    return new Response("not found", { status: 404 });
  const hosts = UP[srv];
  const path = originPath(srv, name);
  if (!hosts || !path) return new Response("not found", { status: 404 });
  const rg = req.headers.get("Range");
  const probe = rg === "bytes=0-0";
  const hh = new Headers();
  if (rg) hh.set("Range", rg);
  let r;
  try {
    r = await fetch(hosts + path, { headers: hh });
  } catch (e) {
    return new Response("upstream error", { status: 502 });
  }
  if (r.status === 404) return new Response("File not found on the server: " + name, { status: 404 });
  if (!r.ok && r.status !== 206) return new Response("upstream error " + r.status, { status: 502 });
  if (probe) return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
  const out = new Headers();
  out.set("Content-Type", "application/octet-stream");
  out.set("Content-Disposition", 'attachment; filename="' + name + '"');
  out.set("Accept-Ranges", "bytes");
  out.set("X-Content-Type-Options", "nosniff");
  out.set("Cache-Control", rg ? "no-store" : "public, max-age=3600");
  const cr = r.headers.get("Content-Range");
  if (cr) out.set("Content-Range", cr);
  const cl = r.headers.get("Content-Length");
  if (cl) out.set("Content-Length", cl);
  return new Response(r.body, { status: r.status, headers: out });
}

export default {
  async fetch(req, env, ctx) {
    env = env || {};
    const url = new URL(req.url);

    if (url.pathname === "/api/auth/me") return handleMe(req, env, ctx);
    if (url.pathname === "/api/auth/login" && req.method === "POST") return handleLogin(req, env, ctx);
    if (url.pathname === "/api/auth/logout") return handleLogout();
    if (url.pathname === "/api/auth/fb") return handleFbStart(req, env);
    if (url.pathname === "/api/auth/fb/callback") return handleFbCallback(req, env, url, ctx);
    if (url.pathname === "/api/auth/google") return handleGoogleStart(req, env);
    if (url.pathname === "/api/auth/google/callback") return handleGoogleCallback(req, env, url, ctx);
    if (url.pathname === "/api/geo") return handleGeo(req, env);
    if (url.pathname === "/api/admin/users") return adminDownload(req, env, "users.csv");
    if (url.pathname === "/api/admin/fbusers") return adminDownload(req, env, "fb-users.csv");
    if (url.pathname === "/api/admin/googleusers") return adminDownload(req, env, "google-users.csv");
    if (url.pathname === "/api/admin/loginlog") return adminDownload(req, env, "login.log");
    if (url.pathname === "/api/admin/onlinelog") return adminDownload(req, env, "online.log");

    // ---- asset wasm/ffmpeg dari R2 (self-host, bukan CDN pihak ketiga) ----
    const mff = url.pathname.match(/^\/ff\/([A-Za-z0-9_.-]+)$/);
    if (mff) return handleFf(req, env, mff[1]);

    // ---- download mentah (tbm/abm) lewat domain utama ----
    const mfd = url.pathname.match(/^\/api\/([a-z0-9]+)\/f\/([^/]+)$/);
    if (mfd) return handleFile(req, mfd[1], decodeURIComponent(mfd[2]));

    // block sensitive paths
    if (/\/\.(git|env|dev\.vars|wrangler)|(^|\/)\.(gitignore|gitattributes)$/i.test(url.pathname)
        || /(^|\/)(push|js)\.bat$/i.test(url.pathname)
        || /\.(src\.js|py|pyc|map)$/i.test(url.pathname)
        || /(^|\/)_(obf|tools)\//i.test(url.pathname)
        || /(^|\/)data\//i.test(url.pathname)) {
      return new Response("not found", { status: 404 });
    }

    const adminKey = isAdminKey(req, env);
    const sess = await readSession(env, req.headers.get("Cookie"));

    // ---- visitor online (realtime) ----
    if (url.pathname === "/api/online/ping") return handleOnlinePing(req, env, sess);

    // ---- live chat (visitor -> Telegram admin) ----
    if (url.pathname.startsWith("/api/chat/")) return chatRoute(req, env, url, sess);

    // ---- admin panel API (maintenance = MT.js) ----
    if (url.pathname.startsWith("/api/admin/")) {
      // create account = role 4 (dev) only; sisanya admin atau dev
      if (url.pathname === "/api/admin/createuser") {
        if (req.method !== "POST") return json({ ok: false, error: "unknown" }, 404);
        if (!isDevSess(sess)) return json({ ok: false, error: "forbidden" }, 403);
        return handleCreateUser(req, env);
      }
      if (!isPanelSess(sess) && adminKey !== "grant" && adminKey !== "ok")
        return json({ ok: false, error: "forbidden" }, 403);
      if (url.pathname === "/api/admin/state") return json(await adminState(env));
      if (url.pathname === "/api/admin/maintenance" && req.method === "POST") {
        let body = {};
        try { body = await req.json(); } catch (e) {}
        return json(await adminSet(env, !!body.on));
      }
      if (url.pathname === "/api/admin/slk" && req.method === "POST") return handleAdminSlk(req, env, url);
      return json({ ok: false, error: "unknown" }, 404);
    }

    // ---- uploaded SLK from KV overrides the static file ----
    const mslk = url.pathname.match(/^\/script\/([a-z0-9_]+\.slk)$/i);
    if (mslk && env.MT_KV) {
      const v = await env.MT_KV.get(SLK_PREFIX + mslk[1].toLowerCase(), "arrayBuffer");
      if (v) return new Response(v, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }

    // ---- admin key grant ----
    if (adminKey === "grant") {
      const clean = new URL(url);
      clean.searchParams.delete("admin");
      clean.searchParams.delete("key");
      // balikin path .aspx (URL bar jangan nampil .html)
      let p = clean.pathname.replace(/\.html$/i, ".aspx");
      // path tanpa ekstensi (/login) -> /login.aspx kalau halamannya ada
      if (p !== "/" && !/\./.test(p) && env.BINDING_ASSETS) {
        const probe = await env.BINDING_ASSETS.fetch(new Request(new URL(p + ".html", url).toString(), req));
        if (probe && probe.status < 400) p = p + ".aspx";
      }
      return new Response(null, { status: 302, headers: {
        Location: p + clean.search,
        "Set-Cookie": ADMIN_COOKIE + "=" + env.ADMIN_KEY + "; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800",
      } });
    }

    // ---- maintenance gate (MT.js) ----
    // admin/dev boleh login walau MT nyala
    if (await readMT(env)) {
      const bypass = adminKey || isPanelSess(sess) ? "ok" : false;
      const gate = await maintenanceGate(req, env, url, bypass, (r) => serveAssets(env, r));
      if (gate) return gate;
    }

    // pretty URL: file tetap .html, tapi URL di browser selalu .aspx
    if (/\.aspx$/i.test(url.pathname)) {
      const t = new URL(url);
      t.pathname = url.pathname.replace(/\.aspx$/i, ".html");
      const res = await serveAssets(env, new Request(t.toString(), req));
      if (res) return res;
    }
    if (/\.html$/i.test(url.pathname)) {
      const t = new URL(url);
      t.pathname = url.pathname.replace(/\.html$/i, ".aspx");
      return new Response(null, { status: 301, headers: { Location: t.toString() } });
    }
    // halaman tanpa ekstensi -> .aspx
    if (url.pathname !== "/" && !/\./.test(url.pathname) && env.BINDING_ASSETS) {
      const probeUrl = new URL(url);
      probeUrl.pathname = url.pathname + ".html";
      const probe = await env.BINDING_ASSETS.fetch(new Request(probeUrl.toString(), req));
      if (probe && probe.status < 400) {
        const t = new URL(url);
        t.pathname = url.pathname + ".aspx";
        return new Response(null, { status: 301, headers: { Location: t.toString() } });
      }
    }

    const asset = await serveAssets(env, req);
    if (asset) return asset;
    return new Response("not found", { status: 404 });
  },
};
