// worker.js — Cloudflare Worker for AuditionMusic5.
// Deploy: npx wrangler deploy (or paste in the Workers dashboard).
// Routes:
//   GET /api/list        -> server TBM/ABM file list (JSON, 1h cache)
//   GET /api/f/<name>    -> raw file proxy (CORS + cache + Range)
//   GET /*               -> static assets (assets binding, if configured)
// Maintenance mode (env var, set in the dashboard/wrangler, then redeploy):
//   MAINTENANCE = "1"    -> every visitor is redirected to /maintenance.html
//   ADMIN_KEY   = secret -> /?admin=KEY (or ?key=KEY) sets a cookie that
//                           bypasses maintenance until the cookie expires.
// Everything static (index.html, js/, css, slk, images) is served by the
// assets binding when BINDING_ASSETS is set; otherwise / falls through to
// the fallback text below (API-only worker).
//
// Deploy as gateway (wrangler.toml):
//   name = "auditionmusic5"
//   main = "js/worker.js"
//   compatibility_date = "2024-01-01"
//   [assets]
//   directory = "."
//   binding = "BINDING_ASSETS"
//   [vars]
//   MAINTENANCE = "0"        # set "1" + redeploy to enable
//   ADMIN_KEY = "ganti-ini"  # set via `wrangler secret put ADMIN_KEY` (jangan plaintext)

const UPSTREAM = "http://122.102.49.131/audition/ABM";
const UPSTREAM_PKG = "http://122.102.49.131/audition/package/ABM";
const VTC_BASE = "http://aumusic.vtcgame.vn/abm";
const NEXT_BASE = "http://auto-audiph.playpark.net/live/audition/package/abm";
const TH_BASE = "https://auto-au.playpark.com/package/abm";
const CN_BASE = "http://au.patch1.9you.com/ABM";
const KR_BASE = "http://au-patch.hanbiton.com/adtpatch/audition/package/ABM";
const TW_BASE = "http://patch-au.mangot5.com.tw/audition_patch/patch/live/audition/package/abm";
const AX_BASE = "http://audl.axeso5.com/update/content/ABM";
const LIST_TTL = 3600;          // detik
const FILE_TTL = 31536000;      // files never change

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
  };
}

async function handleList(req) {
  const cache = caches.default;
  const key = new Request(new URL(req.url).origin + "/api/list");
  let hit = await cache.match(key);
  if (hit) {
    const h = new Headers(hit.headers);
    for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v);
    return new Response(hit.body, { status: hit.status, headers: h });
  }
  const up = await fetch(UPSTREAM + "/", {
    headers: { "User-Agent": "AuditionMusic5/1.0" },
  });
  if (!up.ok) {
    return new Response(JSON.stringify({ ok: false, error: "upstream " + up.status }),
      { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders() } });
  }
  const html = await up.text();
  const files = [];
  const re = /(\d+)\s+<A HREF="([^"]+)">([^<]+)<\/A>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const name = m[3];
    if (/\.tbm$/i.test(name) || /\.abm$/i.test(name))
      files.push({ f: name, s: parseInt(m[1], 10) });
  }
  files.sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));
  const body = JSON.stringify({ ok: true, n: files.length, files });
  const res = new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=" + LIST_TTL,
      ...corsHeaders(),
    },
  });
  await cache.put(key, res.clone());
  return res;
}

async function fetchUp(bases, name, headers) {
  const cands = [name];
  if (/\.tbm$/i.test(name)) cands.push(name.slice(0, -4) + ".abm");
  else if (/\.abm$/i.test(name)) cands.push(name.slice(0, -4) + ".tbm");
  for (const base of bases) {
    for (const cand of cands) {
      const up = await fetch(base + "/" + cand, {
        headers,
        cf: { cacheTtl: FILE_TTL, cacheEverything: true },
      });
      if (up.ok || up.status === 206) return up;
    }
  }
  return null;
}

async function handleFile(req, name, bases) {
  // validasi ketat: nama file datar, ekstensi tbm/abm (anti traversal/SSRF)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.\-]*\.(tbm|abm)$/i.test(name))
    return new Response("bad filename", { status: 400, headers: corsHeaders() });
  const headers = { "User-Agent": "AuditionMusic5/1.0" };
  const range = req.headers.get("Range");
  if (range) headers["Range"] = range;
  const up = await fetchUp(bases, name, headers);
  if (!up)
    return new Response("upstream fail", { status: 502, headers: corsHeaders() });
  const h = new Headers(up.headers);
  for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v);
  h.set("Cache-Control", "public, max-age=" + FILE_TTL + ", immutable");
  h.delete("Content-Security-Policy");
  return new Response(up.body, { status: up.status, headers: h });
}

const ASSETS = (env) => (env && env.BINDING_ASSETS) ? env.BINDING_ASSETS : null;

// ---- maintenance mode -------------------------------------------------
const ADMIN_COOKIE = "am5admin";
const MAINT_PAGE = "/maintenance.html";

function isAdmin(req, env) {
  const url = new URL(req.url);
  const key = (env && env.ADMIN_KEY) || "";
  if (!key) return false;
  const given = url.searchParams.get("admin") || url.searchParams.get("key");
  // constant-time-ish compare: length check then XOR fold
  if (given && given.length === key.length) {
    let d = 0;
    for (let i = 0; i < key.length; i++) d |= given.charCodeAt(i) ^ key.charCodeAt(i);
    if (d === 0) return "grant";
  }
  const ck = req.headers.get("Cookie") || "";
  const m = ck.match(new RegExp("(?:^|;\\s*)" + ADMIN_COOKIE + "=" + key + "(?:;|$)"));
  return m ? "ok" : false;
}

async function serveAssets(env, req) {
  const a = ASSETS(env);
  return a ? a.fetch(req) : null;
}

// Session cookie proves the visitor typed the admin key once.
async function handleMaintenance(req, env, url, admin) {
  if (admin === "grant") {
    // key was just supplied: set cookie, then land on the requested page
    const clean = new URL(url);
    clean.searchParams.delete("admin");
    clean.searchParams.delete("key");
    return new Response(null, {
      status: 302,
      headers: {
        Location: clean.pathname + clean.search,
        "Set-Cookie": ADMIN_COOKIE + "=" + env.ADMIN_KEY + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800",
      },
    });
  }
  if (admin === "ok") return null;   // bypass: serve normally
  if (url.pathname === MAINT_PAGE) return null;   // don't loop
  const body = await serveAssets(env, new Request(new URL(MAINT_PAGE, url).toString(), req));
  if (body && body.ok) return new Response(body.body, { status: 503, headers: body.headers });
  return new Response("Under maintenance.", { status: 503, headers: { "Content-Type": "text/plain" } });
}

export default {
  async fetch(req, env) {
    env = env || {};
    const url = new URL(req.url);
    if (req.method === "OPTIONS")
      return new Response(null, { headers: corsHeaders() });
    if (url.pathname === "/api/list" || url.pathname === "/api/list/")
      return handleList(req);
    const m = url.pathname.match(/^\/api\/f\/(.+)$/);
    if (m) return handleFile(req, decodeURIComponent(m[1]), [UPSTREAM, UPSTREAM_PKG]);
    const mv = url.pathname.match(/^\/api\/vtc\/f\/(.+)$/);
    if (mv) return handleFile(req, decodeURIComponent(mv[1]), [VTC_BASE]);
    const mn = url.pathname.match(/^\/api\/next\/f\/(.+)$/);
    if (mn) return handleFile(req, decodeURIComponent(mn[1]), [NEXT_BASE]);
    const mth = url.pathname.match(/^\/api\/th\/f\/(.+)$/);
    if (mth) return handleFile(req, decodeURIComponent(mth[1]), [TH_BASE]);
    const mcn = url.pathname.match(/^\/api\/cn\/f\/(.+)$/);
    if (mcn) return handleFile(req, decodeURIComponent(mcn[1]), [CN_BASE]);
    const mkr = url.pathname.match(/^\/api\/kr\/f\/(.+)$/);
    if (mkr) return handleFile(req, decodeURIComponent(mkr[1]), [KR_BASE]);
    const mtw = url.pathname.match(/^\/api\/tw\/f\/(.+)$/);
    if (mtw) return handleFile(req, decodeURIComponent(mtw[1]), [TW_BASE]);
    const max = url.pathname.match(/^\/api\/ax\/f\/(.+)$/);
    if (max) return handleFile(req, decodeURIComponent(max[1]), [AX_BASE]);

    // ---- maintenance gate (only for the static site) ----
    if (env.MAINTENANCE === "1" || env.MAINTENANCE === "true") {
      const admin = isAdmin(req, env);
      const gate = await handleMaintenance(req, env, url, admin);
      if (gate) return gate;
    }

    // ---- static assets ----
    const asset = await serveAssets(env, req);
    if (asset) return asset;
    if (url.pathname === "/" || url.pathname === "/api")
      return new Response("AuditionMusic5 worker OK. GET /api/list | /api/f/<name.tbm>",
        { headers: { "Content-Type": "text/plain", ...corsHeaders() } });
    return new Response("not found", { status: 404, headers: corsHeaders() });
  },
};
