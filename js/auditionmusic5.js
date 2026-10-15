// auditionmusic5.js — single entry point. loads all deps then boots the app.
// view-source shows only this file's src, not the individual .js files.
//
// tbm-crypto.js + tbm.js are the TBM decoder. In production they live on the
// decode server only (never here); this loader tries them and silently skips
// if absent, so the same page works with browser-decode (files present) or
// server-decode (files absent, app.js DECODE_BASE set).
const V = "?v=164";
const OPTIONAL = ["js/tbm-crypto.js" + V, "js/tbm.js" + V];
const REQUIRED = ["js/app.js" + V];

function loadScript(file) {
  return fetch(file)
    .then((r) => {
      if (!r.ok) throw new Error(file + " " + r.status);
      return r.text();
    })
    .then((code) => {
      // Inject as <script>: runs in GLOBAL scope, so tbm-crypto.js
      // globals (setupTail, decodeTbm, ...) are visible to tbm.js/app.js.
      // (Direct eval() here would trap them inside this callback's scope.)
      const s = document.createElement("script");
      s.textContent = code;
      document.head.appendChild(s);
    });
}

// Optional decoder files: ignore if missing (server-decode mode).
const pre = OPTIONAL.reduce(
  (p, f) => p.then(() => loadScript(f).catch(() => {})),
  Promise.resolve()
);
// Required app, loaded after the (optional) decoder.
pre
  .then(() => REQUIRED.reduce((p, f) => p.then(() => loadScript(f)), Promise.resolve()))
  .catch((e) => console.error("Load failed:", e));
