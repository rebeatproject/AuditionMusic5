// MT.js — Cloudflare Worker (maintenance gate) for AuditionMusic5.
// Static site is served by the assets binding; this script only adds a
// maintenance switch. All the old /api/* proxy routes were dead (the app
// uses the decode server on the VPS), so they are gone.
//
// Config (Worker vars / secrets, then redeploy):
//   MAINTENANCE = "1"      -> non-admin visitors get /maintenance.html (503)
//   ADMIN_KEY   = secret   -> /?admin=KEY (or ?key=KEY) sets a cookie that
//                             bypasses maintenance for 7 days.
// Set ADMIN_KEY via `wrangler secret put ADMIN_KEY` (never plaintext in git).
//
// wrangler.toml:
//   name = "auditionmusic5"
//   main = "js/MT.js"
//   compatibility_date = "2024-01-01"
//   [assets]
//   directory = "."
//   binding = "BINDING_ASSETS"
//   [vars]
//   MAINTENANCE = "0"

const ADMIN_COOKIE = "am5admin";
const MAINT_PAGE = "/maintenance.html";

const ASSETS = (env) => (env && env.BINDING_ASSETS) ? env.BINDING_ASSETS : null;

function isAdmin(req, env) {
  const url = new URL(req.url);
  const key = (env && env.ADMIN_KEY) || "";
  if (!key) return false;
  const given = url.searchParams.get("admin") || url.searchParams.get("key");
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

async function handleMaintenance(req, env, url, admin) {
  if (admin === "grant") {
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
  if (admin === "ok") return null;
  if (url.pathname === MAINT_PAGE) return null;
  const body = await serveAssets(env, new Request(new URL(MAINT_PAGE, url).toString(), req));
  if (body && body.ok) return new Response(body.body, { status: 503, headers: body.headers });
  return new Response("Under maintenance.", { status: 503, headers: { "Content-Type": "text/plain" } });
}

export default {
  async fetch(req, env) {
    env = env || {};
    const url = new URL(req.url);

    // never serve git metadata, dotfiles or build tooling as assets
    if (/\/\.(git|env|dev\.vars|wrangler)|(^|\/)\.(gitignore|gitattributes)$/i.test(url.pathname)
        || /(^|\/)(push|js)\.bat$/i.test(url.pathname)
        || /\.(src\.js|py|pyc|map)$/i.test(url.pathname)
        || /(^|\/)_(obf|tools)\//i.test(url.pathname)) {
      return new Response("not found", { status: 404 });
    }

    if (env.MAINTENANCE === "1" || env.MAINTENANCE === "true") {
      const gate = await handleMaintenance(req, env, url, isAdmin(req, env));
      if (gate) return gate;
    }

    const asset = await serveAssets(env, req);
    if (asset) return asset;
    return new Response("not found", { status: 404 });
  },
};
