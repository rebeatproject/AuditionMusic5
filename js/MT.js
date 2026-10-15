// MT.js — Cloudflare Worker (maintenance gate) for AuditionMusic5.
// Static site is served by the assets binding; this script only adds a
// maintenance switch.
//
// Maintenance state:
//   MAINTENANCE = "1" (or "true")  -> non-admin visitors see /maintenance.html
//   ADMIN_KEY   = secret           -> /?admin=KEY sets a cookie that bypasses
//                                     maintenance for 7 days.
//
// Toggle maintenance by editing wrangler.toml [vars] MAINTENANCE then pushing
// (the GitHub-connected build redeploys automatically).

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
  if (admin === "ok") return null;
  if (url.pathname === MAINT_PAGE || url.pathname === "/maintenance") return null;
  // Cloudflare assets may 307 "/x.html" -> "/x" (html_handling). Follow it.
  let res = await serveAssets(env, new Request(new URL(MAINT_PAGE, url).toString(), req));
  if (res && (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308)) {
    const loc = res.headers.get("Location");
    if (loc) res = await serveAssets(env, new Request(new URL(loc, url).toString(), req));
  }
  if (res && res.ok) return new Response(res.body, { status: 503, headers: res.headers });
  return new Response("Under maintenance.", { status: 503, headers: { "Content-Type": "text/plain" } });
}

export default {
  async fetch(req, env) {
    env = env || {};
    const url = new URL(req.url);
    const admin = isAdmin(req, env);

    // never serve git metadata, dotfiles or build tooling as assets
    if (/\/\.(git|env|dev\.vars|wrangler)|(^|\/)\.(gitignore|gitattributes)$/i.test(url.pathname)
        || /(^|\/)(push|js)\.bat$/i.test(url.pathname)
        || /\.(src\.js|py|pyc|map)$/i.test(url.pathname)
        || /(^|\/)_(obf|tools)\//i.test(url.pathname)) {
      return new Response("not found", { status: 404 });
    }

    // grant cookie: /?admin=KEY
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

    if (env.MAINTENANCE === "1" || env.MAINTENANCE === "true") {
      const gate = await handleMaintenance(req, env, url, admin);
      if (gate) return gate;
    }

    const asset = await serveAssets(env, req);
    if (asset) return asset;
    return new Response("not found", { status: 404 });
  },
};
