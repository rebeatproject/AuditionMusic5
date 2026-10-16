// MT.js — Cloudflare Worker for AuditionMusic5.
// Maintenance gate + auth (Facebook + admin) + admin panel API.
//
// Env / secrets (dashboard or wrangler):
//   MAINTENANCE    "1"|"0"          maintenance switch (KV overrides if bound)
//   ADMIN_KEY      secret           maintenance bypass key
//   ADMIN_USER     secret           admin username (account login)
//   ADMIN_PASS     secret           admin password
//   SESSION_SECRET secret           HMAC key for session cookies
//   FB_APP_ID      secret           Facebook app id
//   FB_APP_SECRET  secret           Facebook app secret
//   MT_KV          KV binding       maintenance flag + uploaded SLKs
//
// Routes:
//   GET  /api/auth/me                 -> { fb, admin, name }
//   GET  /api/auth/fb                 -> redirect to Facebook
//   GET  /api/auth/fb/callback        -> exchange code, set cookie
//   POST /api/auth/login   {u,p}      -> admin login
//   POST /api/auth/logout
//   GET  /api/admin/state             -> { maintenance } (admin)
//   POST /api/admin/maintenance {on}  -> toggle (admin)
//   POST /api/admin/slk  (raw body)   -> save <name>.slk to KV (admin)
//   GET  /api/dl/<srv>/<ogg|mp3>/<n>  -> download gate (requires login)

const enc = new TextEncoder();
const ADMIN_COOKIE = "am5admin";
const SESS_COOKIE = "am5sess";
const MAINT_PAGE = "/maintenance.html";
const MT_KEY = "maintenance";
const SLK_PREFIX = "slk:";

const ASSETS = (env) => (env && env.BINDING_ASSETS) ? env.BINDING_ASSETS : null;

// ---------- tiny crypto helpers ----------
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

// ---------- maintenance state ----------
async function readMT(env) {
  const kv = env.MT_KV;
  if (kv) { const v = await kv.get(MT_KEY); if (v === "0") return false; if (v === "1") return true; }
  return env.MAINTENANCE === "1" || env.MAINTENANCE === "true";
}
async function writeMT(env, on) {
  if (!env.MT_KV) return false;
  await env.MT_KV.put(MT_KEY, on ? "1" : "0");
  return true;
}

// ---------- admin key bypass (existing behaviour) ----------
function isAdminKey(req, env) {
  const url = new URL(req.url);
  const key = env.ADMIN_KEY || "";
  if (!key) return false;
  const given = url.searchParams.get("admin") || url.searchParams.get("key");
  if (given && constEq(given, key)) return "grant";
  const m = (req.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + ADMIN_COOKIE + "=" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:;|$)"));
  return m ? "ok" : false;
}

async function serveAssets(env, req) {
  const a = ASSETS(env);
  return a ? a.fetch(req) : null;
}
function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(extra || {}) },
  });
}

// ---------- auth handlers ----------
async function handleMe(req, env) {
  const s = await readSession(env, req.headers.get("Cookie"));
  if (!s) return json({ fb: false, admin: false });
  return json({ fb: s.t === "fb", admin: s.t === "adm", name: s.n || "" });
}

async function handleFbStart(req, env) {
  if (!env.FB_APP_ID) return json({ ok: false, error: "FB_APP_ID not set" }, 500);
  const url = new URL(req.url);
  const redirect = url.origin + "/api/auth/fb/callback";
  const state = b64url(enc.encode(JSON.stringify({ n: Math.random().toString(36).slice(2), exp: Date.now() + 600000 })));
  const st = state + "." + (await hmac(secret(env), state));
  const fb = "https://www.facebook.com/v19.0/dialog/oauth" +
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
  const tokUrl = "https://graph.facebook.com/v19.0/oauth/access_token" +
    "?client_id=" + encodeURIComponent(env.FB_APP_ID) +
    "&client_secret=" + encodeURIComponent(env.FB_APP_SECRET || "") +
    "&redirect_uri=" + encodeURIComponent(redirect) +
    "&code=" + encodeURIComponent(code);
  const tr = await fetch(tokUrl);
  if (!tr.ok) return new Response("fb token error", { status: 502 });
  const tok = await tr.json();
  const ur = await fetch("https://graph.facebook.com/me?fields=id,name,email&access_token=" + encodeURIComponent(tok.access_token));
  const u = ur.ok ? await ur.json() : {};
  const sess = await makeSession(env, { t: "fb", n: u.name || "Facebook user", id: u.id || "", exp: Date.now() + 7 * 864e5 });
  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Set-Cookie": setCookie(SESS_COOKIE, sess, 604800) },
  });
}

async function handleLogin(req, env) {
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const u = String(body.u || ""), p = String(body.p || "");
  const okUser = env.ADMIN_USER && constEq(u, env.ADMIN_USER);
  const okPass = env.ADMIN_PASS && constEq(p, env.ADMIN_PASS);
  if (!okUser || !okPass) return json({ ok: false, error: "invalid credentials" }, 401);
  const sess = await makeSession(env, { t: "adm", n: u, exp: Date.now() + 7 * 864e5 });
  return json({ ok: true, admin: true }, 200, { "Set-Cookie": setCookie(SESS_COOKIE, sess, 604800) });
}

async function handleLogout() {
  return json({ ok: true }, 200, { "Set-Cookie": SESS_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0" });
}

// ---------- admin handlers ----------
async function handleAdminState(env) {
  return json({ maintenance: await readMT(env), kv: !!env.MT_KV });
}
async function handleAdminMT(req, env) {
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const on = !!body.on;
  const saved = await writeMT(env, on);
  return json({ ok: true, maintenance: on, saved });
}
async function handleAdminSlk(req, env, url) {
  const name = (url.searchParams.get("name") || "").toLowerCase();
  if (!/^[a-z0-9_]+\.slk$/.test(name)) return json({ ok: false, error: "bad name" }, 400);
  if (!env.MT_KV) return json({ ok: false, error: "no MT_KV binding" }, 500);
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > 20 * 1024 * 1024) return json({ ok: false, error: "bad size" }, 400);
  await env.MT_KV.put(SLK_PREFIX + name, buf);
  return json({ ok: true, name, size: buf.byteLength });
}

// ---------- maintenance gate ----------
async function handleMaintenance(req, env, url, adminKey) {
  if (adminKey === "ok") return null;
  if (url.pathname === MAINT_PAGE || url.pathname === "/maintenance") return null;
  let res = await serveAssets(env, new Request(new URL(MAINT_PAGE, url).toString(), req));
  if (res && [301, 302, 307, 308].includes(res.status)) {
    const loc = res.headers.get("Location");
    if (loc) res = await serveAssets(env, new Request(new URL(loc, url).toString(), req));
  }
  if (res && res.ok) return new Response(res.body, { status: 503, headers: res.headers });
  return new Response("Under maintenance.", { status: 503, headers: { "Content-Type": "text/plain" } });
}

// ---- exports for the entry worker (js/main.js) ----
export { b64url, constEq, hmac, makeSession, readSession, setCookie, json, secret, isAdminKey, SESS_COOKIE };

export default {
  async fetch(req, env) {
    env = env || {};
    const url = new URL(req.url);
    const adminKey = isAdminKey(req, env);
    const sess = await readSession(env, req.headers.get("Cookie"));
    const isAdm = !!(sess && sess.t === "adm");
    const isFb = !!(sess && sess.t === "fb");

    // block sensitive paths
    if (/\/\.(git|env|dev\.vars|wrangler)|(^|\/)\.(gitignore|gitattributes)$/i.test(url.pathname)
        || /(^|\/)(push|js)\.bat$/i.test(url.pathname)
        || /\.(src\.js|py|pyc|map)$/i.test(url.pathname)
        || /(^|\/)_(obf|tools)\//i.test(url.pathname)
        || /(^|\/)data\//i.test(url.pathname)) {
      return new Response("not found", { status: 404 });
    }

    // ---- auth API ----
    if (url.pathname === "/api/auth/me") return handleMe(req, env);
    if (url.pathname === "/api/auth/fb") return handleFbStart(req, env);
    if (url.pathname === "/api/auth/fb/callback") return handleFbCallback(req, env, url);
    if (url.pathname === "/api/auth/login" && req.method === "POST") return handleLogin(req, env);
    if (url.pathname === "/api/auth/logout") return handleLogout();

    // ---- admin API ----
    if (url.pathname.startsWith("/api/admin/")) {
      if (!isAdm && adminKey !== "grant" && adminKey !== "ok")
        return json({ ok: false, error: "forbidden" }, 403);
      if (url.pathname === "/api/admin/state") return handleAdminState(env);
      if (url.pathname === "/api/admin/maintenance" && req.method === "POST") return handleAdminMT(req, env);
      if (url.pathname === "/api/admin/slk" && req.method === "POST") return handleAdminSlk(req, env, url);
      return json({ ok: false, error: "unknown" }, 404);
    }

    // ---- serve uploaded SLK from KV (overrides static asset) ----
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
      return new Response(null, { status: 302, headers: {
        Location: clean.pathname + clean.search,
        "Set-Cookie": ADMIN_COOKIE + "=" + env.ADMIN_KEY + "; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800",
      } });
    }

    // ---- maintenance gate ----
    if (await readMT(env)) {
      const gate = await handleMaintenance(req, env, url, adminKey);
      if (gate) return gate;
    }

    const asset = await serveAssets(env, req);
    if (asset) return asset;
    return new Response("not found", { status: 404 });
  },
};
