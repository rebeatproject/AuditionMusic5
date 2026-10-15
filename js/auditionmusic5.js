// auditionmusic5.js — single entry point. loads all deps then boots the app.
// view-source shows only this file's src, not the individual .js files.
const V = "?v=163";
const JS_FILES = ["js/tbm-crypto.js" + V, "js/tbm.js" + V, "js/app.js" + V];

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

// Load sequentially to preserve dependency order (tbm-crypto → tbm → app).
JS_FILES.reduce((p, f) => p.then(() => loadScript(f)), Promise.resolve()).catch(
  (e) => console.error("Load failed:", e)
);