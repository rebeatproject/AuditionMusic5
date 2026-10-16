// main.js — entry Worker for AuditionMusic5 (Cloudflare).
//
// Owns the login system + user store (plain CSV files in a GitHub repo):
//   data/users.csv         username,password,poweruser   (accounts, manual)
//   data/fb-users.csv      Nama,Username,url             (Facebook login history)
//   data/google-users.csv  Nama,Email,Id                 (Google login history)
//
// Routes handled here:
//   GET  /api/auth/me              -> session info (fb/google/admin/special/user)
//   POST /api/auth/login {u,p}     -> check data/user.csv, set cookie
//   POST /api/auth/logout
//   GET  /api/auth/fb              -> redirect to Facebook
//   GET  /api/auth/fb/callback     -> log to fb-user.csv, set cookie
//   GET  /api/auth/google          -> redirect to Google
//   GET  /api/auth/google/callback -> log to google-users.csv, set cookie
//   GET  /api/admin/users          -> download user.csv (admin only)
//   GET  /api/admin/fbusers        -> download fb-user.csv (admin only)
//   GET  /api/admin/googleusers    -> download google-users.csv (admin only)
//
// Everything else (maintenance gate, static assets, admin panel API, SLK from
// KV) is delegated to MT.js (library).
//
// Secrets / vars (dashboard):
//   GH_TOKEN    secret        GitHub PAT with "Contents: read & write"
//   GH_REPO     var/secret    "owner/repo"   <-- MUST be a PRIVATE repo!
//   GH_BRANCH   var/secret    branch (default "main")
//   GH_DIR      var/secret    csv folder (default "data")
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET            (Google OAuth, production)
//   FB_APP_ID / FB_APP_SECRET / SESSION_SECRET / ADMIN_KEY are read via MT.js.

import MT, {
  b64url,
  constEq,
  hmac,
  makeSession,
  readSession,
  setCookie,
  json,
  secret,
  isAdminKey,
  SESS_COOKIE,
} from "./MT.js";

const enc = new TextEncoder();

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
    // file too large for the JSON payload -> fetch raw (keeps big files intact)
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

// Read a store file: GitHub in production, local assets when GH is unset (wrangler dev).
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
// tolerates ";", "|" or "," separated tables; drops a header row if present
function parseTable(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  const delim = detectDelim(lines[0]);
  const rows = lines.map((l) => splitLine(l, delim));
  const h = (rows[0][0] || "").trim().toLowerCase();
  if (["username", "user", "nama", "name", "time", "fb_id"].includes(h)) rows.shift();
  return rows;
}
// poweruser column: 1=admin, 2=special, 3=user (text names also accepted)
function roleOf(power) {
  const v = String(power == null ? "" : power).trim().toLowerCase();
  if (v === "1" || v === "admin" || v === "a") return "admin";
  if (v === "2" || v === "special" || v === "s") return "special";
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

async function appendGoogleUser(env, u) {
  if (!env.GH_TOKEN || !env.GH_REPO) return false;
  const path = googlePath(env);
  const header = "Nama,Email,Id\n";
  const row = csvRow([u.name || "", u.email || "", u.id || ""]);
  for (let i = 0; i < 3; i++) {
    const cur = await ghReadFile(env, path);
    if (!cur) return false;
    const text = (cur.text || header) + row;
    if (await ghWriteFile(env, path, text, cur.sha, "log: google " + (u.name || u.email || ""))) return true;
    await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }
  return false;
}

// ---------- helpers ----------
function isAdmSess(s) { return !!(s && (s.t === "adm" || s.r === "admin")); }
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
async function handleMe(req, env) {
  const s = await readSession(env, req.headers.get("Cookie"));
  if (!s) return json({ logged: false, fb: false, google: false, admin: false, special: false, user: false, name: "", role: "" });
  const fb = s.t === "fb" || s.fb === true;
  const google = s.t === "goo" || s.g === true;
  const admin = s.t === "adm" || s.r === "admin";
  const special = s.r === "special";
  const user = s.t === "usr" || admin || fb || google;
  return json({ logged: true, fb, google, admin, special, user, name: s.n || "", role: s.r || (fb || google ? "user" : "") });
}

async function handleLogin(req, env) {
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const u = String(body.u || "").trim();
  const p = String(body.p || "");
  if (!u) return json({ ok: false, error: "invalid credentials" }, 401);

  let role = null;
  const rec = await findUser(env, u);
  if (rec && rec.password === p) {
    role = roleOf(rec.poweruser);
  } else if (env.ADMIN_USER && constEq(u, env.ADMIN_USER) && constEq(p, env.ADMIN_PASS || "")) {
    // env fallback admin (used only if the CSV store has no match)
    role = "admin";
  }
  if (role === null) return json({ ok: false, error: "invalid credentials" }, 401);

  const t = role === "admin" ? "adm" : "usr";
  const sess = await makeSession(env, { t, n: u, r: role, exp: Date.now() + 7 * 864e5 });
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

async function handleFbCallback(req, env, url) {
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

async function handleGoogleCallback(req, env, url) {
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
  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Set-Cookie": setCookie(SESS_COOKIE, sess, 604800) },
  });
}

// ---------- admin: download a csv ----------
async function adminDownload(req, env, filename) {
  const s = await readSession(env, req.headers.get("Cookie"));
  const ak = isAdminKey(req, env);
  if (!isAdmSess(s) && ak !== "grant" && ak !== "ok") return json({ ok: false, error: "forbidden" }, 403);
  const cur = await readStore(env, filename);
  if (!cur) return json({ ok: false, error: "store not available" }, 502);
  return new Response(cur.text || "", {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="' + filename + '"',
    },
  });
}

export default {
  async fetch(req, env) {
    env = env || {};
    const url = new URL(req.url);

    if (url.pathname === "/api/auth/me") return handleMe(req, env);
    if (url.pathname === "/api/auth/login" && req.method === "POST") return handleLogin(req, env);
    if (url.pathname === "/api/auth/logout") return handleLogout();
    if (url.pathname === "/api/auth/fb") return handleFbStart(req, env);
    if (url.pathname === "/api/auth/fb/callback") return handleFbCallback(req, env, url);
    if (url.pathname === "/api/auth/google") return handleGoogleStart(req, env);
    if (url.pathname === "/api/auth/google/callback") return handleGoogleCallback(req, env, url);
    if (url.pathname === "/api/admin/users") return adminDownload(req, env, "users.csv");
    if (url.pathname === "/api/admin/fbusers") return adminDownload(req, env, "fb-users.csv");
    if (url.pathname === "/api/admin/googleusers") return adminDownload(req, env, "google-users.csv");

    // pretty URL: file tetap .html, tapi URL di browser selalu .aspx
    if (/\.aspx$/i.test(url.pathname)) {
      const t = new URL(url);
      t.pathname = url.pathname.replace(/\.aspx$/i, ".html");
      return MT.fetch(new Request(t.toString(), req), env);
    }
    if (/\.html$/i.test(url.pathname)) {
      const t = new URL(url);
      t.pathname = url.pathname.replace(/\.html$/i, ".aspx");
      return new Response(null, { status: 301, headers: { Location: t.toString() } });
    }

    // everything else -> MT.js (maintenance gate, assets, panel API, SLK)
    return MT.fetch(req, env);
  },
};
