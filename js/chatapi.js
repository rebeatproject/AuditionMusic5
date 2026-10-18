// chatapi.js — live chat visitor <-> admin lewat Telegram.
//
// Alur:
//   visitor (login wajib) -> POST /api/chat/send -> simpan di D1 + notif ke Telegram admin
//   admin reply pesan notif di Telegram -> POST /api/chat/tg (webhook) -> simpan ke thread
//   visitor -> GET /api/chat/poll?since=<id> -> balasan muncul (instan)
//
// Kenapa D1, bukan KV: KV eventual consistent (bisa telat ~60 dtk antar-colo,
// webhook Telegram masuk di colo lain -> balasan terasa ngadat). D1 baca dari
// primary, jadi read-after-write langsung kelihatan.
//
// Env yang dibutuhkan (dashboard, tipe Secret):
//   TG_TOKEN    token bot dari @BotFather
//   TG_CHAT_ID  chat id admin (angka, atau "-100..." kalau grup)
//   TG_SECRET   string acak; dipakai sebagai secret_token webhook Telegram
// Binding: CHAT_DB (D1). Kalau belum ada -> route chat balas 503, sisa situs normal.

const MAX_LEN = 500;      // panjang pesan visitor
const MIN_GAP_MS = 2000;  // jeda minimal antar pesan
const MAX_PER_HOUR = 60;  // cap per jam per user
const KEEP_DAYS = 30;     // pesan lebih tua dari ini dibersihkan
const enc = new TextEncoder();

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(extra || {}) },
  });
}
function sec(env) { return env.SESSION_SECRET || env.ADMIN_KEY || "am5-fallback-secret"; }
function b64url(buf) {
  const b = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function constEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function hmacBytes(env, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(sec(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
// identitas thread: username (atau nama tampilan) + id provider biar dua akun
// dengan nama sama (FB/Google) gak nyampur ke satu thread
function identOf(sess) {
  return String(sess.n || "") + "|" + String(sess.id || "");
}
async function sidOf(env, ident) {
  const s = await hmacBytes(env, "chat|" + String(ident || "").toLowerCase());
  return Array.from(s.slice(0, 5)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function db(env) { return env.CHAT_DB || null; }

// Tabel dibuat sekali (ditandai di KV), bukan tiap request.
async function ensure(env) {
  const d = db(env);
  const kv = env.MT_KV;
  if (kv) {
    try { if (await kv.get("chat:schema")) return; } catch (e) {}
  }
  await d.batch([
    d.prepare("CREATE TABLE IF NOT EXISTS chat_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL)"),
    d.prepare("CREATE INDEX IF NOT EXISTS idx_chat_sid ON chat_msgs(sid, id)"),
  ]);
  if (kv) { try { await kv.put("chat:schema", "1"); } catch (e) {} }
}

async function tgSend(env, text) {
  if (!env.TG_TOKEN || !env.TG_CHAT_ID) return false;
  try {
    const r = await fetch("https://api.telegram.org/bot" + env.TG_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text, disable_web_page_preview: true }),
    });
    return r.ok;
  } catch (e) { return false; }
}

// rate limit: jeda antar pesan + cap per jam (counter di KV, TTL 1 jam)
async function rateOk(env, sid) {
  const kv = env.MT_KV;
  if (!kv) return true;
  const k = "chatrl:" + sid;
  const now = Date.now();
  let rec = null;
  try { rec = await kv.get(k, "json"); } catch (e) {}
  if (rec && now - (rec.last || 0) < MIN_GAP_MS) return false;
  const sameHour = rec && now - (rec.hour || 0) < 3600e3;
  const cnt = sameHour ? rec.cnt || 0 : 0;
  if (cnt >= MAX_PER_HOUR) return false;
  try {
    await kv.put(k, JSON.stringify({ last: now, hour: sameHour ? rec.hour : now, cnt: cnt + 1 }), { expirationTtl: 3600 });
  } catch (e) {}
  return true;
}

async function addMsg(env, sid, role, body) {
  const d = db(env);
  const r = await d.prepare("INSERT INTO chat_msgs (sid, role, body, at) VALUES (?, ?, ?, ?)")
    .bind(sid, role, body, Date.now()).run();
  return (r.meta && r.meta.last_row_id) || 0;
}

// ---------- webhook Telegram ----------
async function handleWebhook(req, env) {
  if (!env.TG_SECRET) return json({ ok: false, error: "webhook disabled" }, 503);
  const tok = req.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!constEq(tok, env.TG_SECRET)) return json({ ok: false }, 403);
  if (!db(env)) return json({ ok: false, error: "chat not configured" }, 503);

  let upd = {};
  try { upd = await req.json(); } catch (e) { return json({ ok: true }); }
  const m = upd.message || upd.edited_message;
  if (!m || !m.text) return json({ ok: true });
  // cuma admin (chat id yang dikonfigurasi) yang boleh bales
  if (String((m.chat && m.chat.id) || "") !== String(env.TG_CHAT_ID || "")) return json({ ok: true });

  const text = String(m.text).trim();
  const quoted = (m.reply_to_message && m.reply_to_message.text) || "";
  let sid = (quoted.match(/\[#([0-9a-f]{10})\]/i) || [])[1] || "";
  let body = text;

  if (!sid) {
    const cmd = text.match(/^\/say\s+#?([0-9a-f]{10})\s+([\s\S]+)$/i);
    if (cmd) { sid = cmd[1]; body = cmd[2]; }
  }
  if (!sid) {
    await tgSend(env, "Reply pesan visitor (yang ada [#id]) buat bales ke dia.\nAtau ketik: /say <id> <teks>");
    return json({ ok: true });
  }

  sid = sid.toLowerCase();
  await ensure(env);
  const chk = await db(env).prepare("SELECT COUNT(*) AS c FROM chat_msgs WHERE sid = ?").bind(sid).first();
  if (!chk || !chk.c) {
    await tgSend(env, "Thread #" + sid + " kosong / gak ada.");
    return json({ ok: true });
  }
  await addMsg(env, sid, "a", body.slice(0, MAX_LEN));
  return json({ ok: true });
}

// ---------- route utama ----------
export async function chatRoute(req, env, url, sess) {
  const path = url.pathname;

  if (path === "/api/chat/tg" && req.method === "POST") return handleWebhook(req, env);

  if (!db(env)) return json({ ok: false, error: "chat not configured" }, 503);

  // siapa yang lagi buka widget
  if (path === "/api/chat/me") {
    if (!sess) return json({ ok: true, logged: false });
    const name = String(sess.n || "").slice(0, 40) || "User";
    return json({ ok: true, logged: true, name, sid: await sidOf(env, identOf(sess)) });
  }

  if (path === "/api/chat/poll") {
    if (!sess) return json({ ok: false, error: "login required" }, 401);
    await ensure(env);
    const sid = await sidOf(env, identOf(sess));
    let since = parseInt(url.searchParams.get("since") || "0", 10);
    if (!(since >= 0)) since = 0;
    const rs = await db(env)
      .prepare("SELECT id, role, body, at FROM chat_msgs WHERE sid = ? AND id > ? ORDER BY id ASC LIMIT 200")
      .bind(sid, since).all();
    const rows = (rs.results || []).map((r) => ({ id: r.id, r: r.role, t: r.body, at: r.at }));
    const last = rows.length ? rows[rows.length - 1].id : since;
    return json({ ok: true, msgs: rows, n: last });
  }

  if (path === "/api/chat/send" && req.method === "POST") {
    if (!sess) return json({ ok: false, error: "login required" }, 401);
    let body = {};
    try { body = await req.json(); } catch (e) {}
    const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
    if (!text) return json({ ok: false, error: "empty" }, 400);

    const name = String(sess.n || "").slice(0, 40) || "User";
    const sid = await sidOf(env, identOf(sess));
    if (!(await rateOk(env, sid))) return json({ ok: false, error: "slow down" }, 429);

    await ensure(env);
    const id = await addMsg(env, sid, "u", text);

    // notif ke admin: prefix [#sid] dipakai buat routing balasan
    const sent = await tgSend(env, "[#" + sid + "] " + name + ": " + text);

    // housekeeping: 1% request, buang pesan lama
    if (Math.random() < 0.01) {
      try {
        await db(env).prepare("DELETE FROM chat_msgs WHERE at < ?").bind(Date.now() - KEEP_DAYS * 864e5).run();
      } catch (e) {}
    }
    return json({ ok: true, id, n: id, delivered: sent });
  }

  return json({ ok: false, error: "unknown" }, 404);
}
