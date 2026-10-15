// auditionmusic5.js — single entry point. loads all deps then boots the app.
// view-source shows only this file's src, not the individual .js files.
//
// tbm-crypto.js + tbm.js are the TBM decoder. In production they live on the
// decode server only (never here). On localhost we load them (full local
// decode); on a real domain they are skipped entirely (no 404s).
const V = "?v=171";
const DECODE_SERVER = !(location.hostname === "localhost" || location.hostname === "127.0.0.1");
const DECODER = ["js/tbm-crypto.js" + V, "js/tbm.js" + V];
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

// Decoder first (only in browser-decode mode), then the app.
const chain = DECODE_SERVER ? REQUIRED : DECODER.concat(REQUIRED);
chain
  .reduce((p, f) => p.then(() => loadScript(f)), Promise.resolve())
  .catch((e) => console.error("Load failed:", e));
