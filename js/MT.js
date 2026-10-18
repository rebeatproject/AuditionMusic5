// MT.js - maintenance mode only (dipakai js/main.js)

export const MT_KEY = "maintenance";
export const MAINT_PAGE = "/maintenance.html";

// ---------- maintenance state ----------
export async function readMT(env) {
  const kv = env && env.MT_KV;
  if (kv) {
    const v = await kv.get(MT_KEY);
    if (v === "0") return false;
    if (v === "1") return true;
  }
  return !!(env && (env.MAINTENANCE === "1" || env.MAINTENANCE === "true"));
}

export async function writeMT(env, on) {
  if (!env || !env.MT_KV) return false;
  await env.MT_KV.put(MT_KEY, on ? "1" : "0");
  return true;
}

// ---------- admin panel: maintenance ----------
export async function adminState(env) {
  return { maintenance: await readMT(env), kv: !!(env && env.MT_KV) };
}

export async function adminSet(env, on) {
  const saved = await writeMT(env, on);
  return { ok: true, maintenance: !!on, saved };
}

// ---------- gate ----------
// 503 kalau diblok, null kalau lolos
export async function maintenanceGate(req, env, url, adminKey, assetFetch) {
  if (adminKey === "ok") return null;
  if (url.pathname === MAINT_PAGE || url.pathname === "/maintenance" || url.pathname === "/maintenance.aspx") return null;
  // login/API auth tetap terbuka
  if (url.pathname === "/login" || url.pathname === "/login.aspx" || url.pathname === "/login.html") return null;
  if (url.pathname.startsWith("/api/auth/")) return null;
  let res = await assetFetch(new Request(new URL(MAINT_PAGE, url).toString(), req));
  if (res && [301, 302, 307, 308].includes(res.status)) {
    const loc = res.headers.get("Location");
    if (loc) res = await assetFetch(new Request(new URL(loc, url).toString(), req));
  }
  if (res && res.ok) return new Response(res.body, { status: 503, headers: res.headers });
  return new Response("Under maintenance.", { status: 503, headers: { "Content-Type": "text/plain" } });
}
