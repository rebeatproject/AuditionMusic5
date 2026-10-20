// live chat: visitor <-> admin Telegram (D1 + R2 + webhook)

const MAX_LEN = 500;      // panjang pesan visitor
const MIN_GAP_MS = 2000;  // jeda minimal antar pesan
const MAX_PER_HOUR = 60;  // cap per jam per user
const KEEP_DAYS = 30;     // pesan lebih tua dari ini dibersihkan
const MAX_FILE = 10 * 1024 * 1024; // maksimal upload 10 MB
const SCHEMA_KEY = "chat:schema3";
const FILE_COLS = [
  ["file_key", "TEXT"],
  ["file_name", "TEXT"],
  ["file_type", "TEXT"],
  ["file_size", "INTEGER"],
];
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
// id thread: username + id provider
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
    try { if (await kv.get(SCHEMA_KEY)) return; } catch (e) {}
  }
  await d.batch([
    d.prepare("CREATE TABLE IF NOT EXISTS chat_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, file_key TEXT, file_name TEXT, file_type TEXT, file_size INTEGER)"),
    d.prepare("CREATE INDEX IF NOT EXISTS idx_chat_sid ON chat_msgs(sid, id)"),
    d.prepare("CREATE TABLE IF NOT EXISTS chat_reads (sid TEXT PRIMARY KEY, last_id INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL DEFAULT 0)"),
  ]);
  // DB lama: tambahkan kolom attachment kalau belum ada.
  let cols = [];
  try {
    const info = await d.prepare("PRAGMA table_info(chat_msgs)").all();
    cols = (info.results || []).map((r) => String(r.name || ""));
  } catch (e) {}
  for (const c of FILE_COLS) {
    if (cols.indexOf(c[0]) < 0) {
      try { await d.prepare("ALTER TABLE chat_msgs ADD COLUMN " + c[0] + " " + c[1]).run(); } catch (e) {}
    }
  }
  if (kv) { try { await kv.put(SCHEMA_KEY, "1"); } catch (e) {} }
}

function sizeText(n) {
  n = Number(n) || 0;
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(n % (1024 * 1024) ? 1 : 0) + " MB";
  if (n >= 1024) return Math.ceil(n / 1024) + " KB";
  return n + " B";
}

function safeName(name) {
  return String(name || "file").replace(/[\\/\r\n"]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "file";
}

function fileOf(row) {
  if (!row || !row.file_key) return null;
  return {
    name: row.file_name || "file",
    type: row.file_type || "application/octet-stream",
    size: Number(row.file_size) || 0,
  };
}

function outMsg(row) {
  const m = { id: row.id, r: row.role, t: row.body || "", at: row.at };
  const f = fileOf(row);
  if (f) m.file = f;
  return m;
}

async function readOf(env, sid) {
  const r = await db(env).prepare("SELECT last_id FROM chat_reads WHERE sid = ?").bind(sid).first();
  return (r && r.last_id) || 0;
}

async function unreadOf(env, sid) {
  const last = await readOf(env, sid);
  const r = await db(env)
    .prepare("SELECT COUNT(*) AS c FROM chat_msgs WHERE sid = ? AND role = 'a' AND id > ?")
    .bind(sid, last).first();
  return (r && r.c) || 0;
}

async function markRead(env, sid, id) {
  id = Number(id) || 0;
  if (id <= 0) return;
  if (id <= (await readOf(env, sid))) return;
  await db(env)
    .prepare("INSERT INTO chat_reads (sid, last_id, at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET last_id = CASE WHEN excluded.last_id > chat_reads.last_id THEN excluded.last_id ELSE chat_reads.last_id END, at = excluded.at")
    .bind(sid, id, Date.now()).run();
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

async function tgSendFile(env, sid, buf, name, type, size, who) {
  if (!env.TG_TOKEN || !env.TG_CHAT_ID) return null;
  try {
    const fd = new FormData();
    fd.append("chat_id", String(env.TG_CHAT_ID));
    fd.append("caption", "[#" + sid + "] " + (who ? who + ": " : "") + name + " (" + sizeText(size) + ")");
    fd.append("document", new Blob([buf], { type: type || "application/octet-stream" }), name);
    const r = await fetch("https://api.telegram.org/bot" + env.TG_TOKEN + "/sendDocument", {
      method: "POST",
      body: fd,
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const doc = j && j.result && j.result.document;
    return doc && doc.file_id ? { file_id: String(doc.file_id), message_id: j.result.message_id } : null;
  } catch (e) { return null; }
}

async function tgFileUrl(env, fileId) {
  if (!env.TG_TOKEN) return "";
  try {
    const r = await fetch("https://api.telegram.org/bot" + env.TG_TOKEN + "/getFile?file_id=" + encodeURIComponent(fileId));
    if (!r.ok) return "";
    const j = await r.json().catch(() => null);
    const p = j && j.result && j.result.file_path;
    if (!p) return "";
    return "https://api.telegram.org/file/bot" + env.TG_TOKEN + "/" + String(p).split("/").map(encodeURIComponent).join("/");
  } catch (e) { return ""; }
}

// rate limit: jeda antar pesan + cap per jam
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

async function addMsg(env, sid, role, body, file) {
  const d = db(env);
  const r = await d.prepare("INSERT INTO chat_msgs (sid, role, body, at, file_key, file_name, file_type, file_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(
      sid, role, body || "", Date.now(),
      file ? file.key : null,
      file ? file.name : null,
      file ? file.type : null,
      file ? file.size : null
    ).run();
  return (r.meta && r.meta.last_row_id) || 0;
}

async function purgeOld(env) {
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const d = db(env);
  const old = await d.prepare("SELECT file_key FROM chat_msgs WHERE at < ? AND file_key IS NOT NULL").bind(cutoff).all();
  const keys = (old.results || []).map((r) => r.file_key).filter((k) => k && !String(k).startsWith("tg:"));
  await d.prepare("DELETE FROM chat_msgs WHERE at < ?").bind(cutoff).run();
  if (env.AM5_ASSETS && keys.length) {
    await Promise.all(keys.map((k) => env.AM5_ASSETS.delete(k).catch(() => {})));
  }
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
  const quoted = (m.reply_to_message && (m.reply_to_message.text || m.reply_to_message.caption)) || "";
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
    await ensure(env);
    const name = String(sess.n || "").slice(0, 40) || "User";
    const sid = await sidOf(env, identOf(sess));
    return json({ ok: true, logged: true, name, sid, unread: await unreadOf(env, sid) });
  }

  if (path.startsWith("/api/chat/file/") && req.method === "GET") {
    if (!sess) return json({ ok: false, error: "login required" }, 401);
    const id = parseInt(path.slice("/api/chat/file/".length), 10);
    if (!(id > 0)) return json({ ok: false, error: "bad file" }, 400);
    await ensure(env);
    const sid = await sidOf(env, identOf(sess));
    const r = await db(env)
      .prepare("SELECT file_key, file_name, file_type, file_size FROM chat_msgs WHERE id = ? AND sid = ?")
      .bind(id, sid).first();
    if (!r || !r.file_key) return json({ ok: false, error: "not found" }, 404);

    const key = String(r.file_key);
    let source = null;
    if (key.startsWith("tg:")) {
      const url = await tgFileUrl(env, key.slice(3));
      if (!url) return json({ ok: false, error: "not found" }, 404);
      try { source = await fetch(url); } catch (e) { source = null; }
      if (!source || !source.ok) return json({ ok: false, error: "not found" }, 404);
    } else {
      // file lama dari versi yang masih menyimpan byte di R2
      if (!env.AM5_ASSETS) return json({ ok: false, error: "storage not configured" }, 503);
      source = await env.AM5_ASSETS.get(key);
      if (!source) return json({ ok: false, error: "not found" }, 404);
    }

    const type = String(r.file_type || "application/octet-stream");
    const name = safeName(r.file_name);
    const inline = /^image\/(?:jpeg|png|gif|webp|avif)$/i.test(type);
    const len = source.size != null ? source.size : (r.file_size != null ? r.file_size : (source.headers && source.headers.get("content-length")));
    const h = new Headers();
    h.set("Content-Type", type);
    if (len != null) h.set("Content-Length", String(len));
    h.set("Cache-Control", "private, max-age=3600");
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Content-Disposition", (inline ? "inline" : "attachment") + "; filename*=UTF-8''" + encodeURIComponent(name));
    if (!inline) h.set("Content-Security-Policy", "default-src 'none'; sandbox");
    return new Response(source.body, { headers: h });
  }

  if (path === "/api/chat/poll") {
    if (!sess) return json({ ok: false, error: "login required" }, 401);
    await ensure(env);
    const sid = await sidOf(env, identOf(sess));
    const read = url.searchParams.get("read") === "1";
    let since = parseInt(url.searchParams.get("since") || "0", 10);
    if (!(since >= 0)) since = 0;
    const rs = await db(env)
      .prepare("SELECT id, role, body, at, file_key, file_name, file_type, file_size FROM chat_msgs WHERE sid = ? AND id > ? ORDER BY id ASC LIMIT 200")
      .bind(sid, since).all();
    const rows = (rs.results || []).map(outMsg);
    const last = rows.length ? rows[rows.length - 1].id : since;
    if (read) await markRead(env, sid, last);
    return json({ ok: true, msgs: rows, n: last, unread: await unreadOf(env, sid) });
  }

  if (path === "/api/chat/clear" && req.method === "POST") {
    if (!sess) return json({ ok: false, error: "login required" }, 401);
    await ensure(env);
    const sid = await sidOf(env, identOf(sess));
    const d = db(env);
    const old = await d.prepare("SELECT file_key FROM chat_msgs WHERE sid = ? AND file_key IS NOT NULL").bind(sid).all();
    const keys = (old.results || []).map((r) => r.file_key).filter((k) => k && !String(k).startsWith("tg:"));
    await d.batch([
      d.prepare("DELETE FROM chat_msgs WHERE sid = ?").bind(sid),
      d.prepare("DELETE FROM chat_reads WHERE sid = ?").bind(sid),
    ]);
    if (env.AM5_ASSETS && keys.length) {
      await Promise.all(keys.map((k) => env.AM5_ASSETS.delete(k).catch(() => {})));
    }
    return json({ ok: true });
  }

  if (path === "/api/chat/upload" && req.method === "POST") {
    if (!sess) return json({ ok: false, error: "login required" }, 401);
    if (!env.TG_TOKEN || !env.TG_CHAT_ID) return json({ ok: false, error: "telegram not configured" }, 503);
    let form;
    try { form = await req.formData(); } catch (e) { return json({ ok: false, error: "bad upload" }, 400); }
    const file = form.get("file");
    if (!file || typeof file === "string" || typeof file.size !== "number" || !file.size) {
      return json({ ok: false, error: "empty file" }, 400);
    }
    if (file.size > MAX_FILE) {
      return json({ ok: false, error: "too large", max: MAX_FILE }, 413);
    }

    await ensure(env);
    const sid = await sidOf(env, identOf(sess));
    const who = String(sess.n || "").slice(0, 40);
    const name = safeName(file.name);
    const type = String(file.type || "application/octet-stream").replace(/[^\w.+\/-]/g, "").slice(0, 100) || "application/octet-stream";
    let buf;
    try { buf = await file.arrayBuffer(); } catch (e) { return json({ ok: false, error: "bad upload" }, 400); }

    // Simpan byte cuma di Telegram (unlimited); D1 cuma simpan file_id + metadata.
    const sent = await tgSendFile(env, sid, buf, name, type, file.size, who);
    if (!sent) return json({ ok: false, error: "telegram" }, 502);

    const at = Date.now();
    let id;
    try {
      id = await addMsg(env, sid, "u", "", { key: "tg:" + sent.file_id, name, type, size: file.size });
    } catch (e) {
      return json({ ok: false, error: "db" }, 500);
    }
    return json({
      ok: true, id, n: id, delivered: true,
      msg: { id, r: "u", t: "", at, file: { name, type, size: file.size } },
    });
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
      try { await purgeOld(env); } catch (e) {}
    }
    return json({ ok: true, id, n: id, delivered: sent });
  }

  return json({ ok: false, error: "unknown" }, 404);
}
