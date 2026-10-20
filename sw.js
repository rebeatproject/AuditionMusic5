// service worker: cache shell + daftar lagu (SLK) saja
// aset server (heads.au5, tbm*.js, decode API) TIDAK pernah disentuh
const VER = new URL(self.location.href).searchParams.get("v") || "0";
const V = "?v=" + VER;
const SHELL = "am5-shell-v" + VER;
const DATA = "am5-data-v1";
const SHELL_FILES = [
    "/",
    "/index.html",
    "/manifest.webmanifest",
    "/js/guard.js" + V,
    "/js/tip.js" + V,
    "/js/auditionmusic5.js" + V,
    "/js/app.js" + V,
    "/js/chat.js" + V,
    "/js/online-now.js" + V,
    "/image/favicon.ico",
    "/image/apple-touch-icon-57x57.png",
    "/image/apple-touch-icon-60x60.png",
    "/image/apple-touch-icon-72x72.png",
    "/image/apple-touch-icon-76x76.png",
    "/image/apple-touch-icon-114x114.png",
    "/image/apple-touch-icon-120x120.png",
    "/image/apple-touch-icon-144x144.png",
    "/image/apple-touch-icon-152x152.png",
    "/image/apple-touch-icon-180x180.png",
    "/image/icon-192.png",
    "/image/icon-512.png",
    "/image/new.png"
];
const DENY = [
    /^\/api\//i,
    /^\/__am5cache\//i,
    /^\/ff\//i,
    /^\/data\//i,
    /^\/_obf\//i,
    /^\/js\/(?:heads\.au5|tbm(?:-crypto)?\.js|server-vps\.js|ayo-decode-queue\.js|drive-cache\.js|main\.js|worker\.js|MT\.js)$/i,
    /^\/js\/[^/]+\.src\.js$/i
];
const deny = (path) => DENY.some((r) => r.test(path));
const staticFile = (path) =>
    path === "/manifest.webmanifest" ||
    /^\/js\/[^/]+\.js$/i.test(path) ||
    /^\/image\//i.test(path) ||
    /^\/css\//i.test(path) ||
    /^\/fonts\//i.test(path);

async function nav(req) {
    const cache = await caches.open(SHELL);
    try {
        const res = await fetch(req);
        if (res && res.ok) {
            const u = new URL(req.url);
            if (u.pathname === "/" || u.pathname === "/index.html" || u.pathname === "/index.aspx") {
                try { await cache.put(req, res.clone()); } catch (e) {}
            }
        }
        return res;
    } catch (e) {
        const hit = (await cache.match(req)) || (await cache.match("/")) || (await cache.match("/index.html"));
        if (hit) return hit;
        throw e;
    }
}

async function asset(req) {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res && res.ok) {
        try { await cache.put(req, res.clone()); } catch (e) {}
    }
    return res;
}

async function slk(req) {
    const cache = await caches.open(DATA);
    const u = new URL(req.url);
    u.search = "";
    const key = u.href;
    try {
        const res = await fetch(req, { cache: "no-cache" });
        if (res && res.ok) {
            try { await cache.put(key, res.clone()); } catch (e) {}
        }
        return res;
    } catch (e) {
        const hit = (await cache.match(key)) || (await cache.match(req, { ignoreSearch: true }));
        if (hit) return hit;
        throw e;
    }
}

self.addEventListener("install", (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL);
        await Promise.all(SHELL_FILES.map(async (u) => {
            try {
                const res = await fetch(u, { cache: "reload" });
                if (res && res.ok) await cache.put(u, res);
            } catch (e) {}
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.map((n) => (n.startsWith("am5-shell-") && n !== SHELL ? caches.delete(n) : null)));
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (deny(url.pathname)) return;
    if (req.mode === "navigate") {
        event.respondWith(nav(req));
        return;
    }
    if (url.pathname.startsWith("/script/") && /\.slk$/i.test(url.pathname)) {
        event.respondWith(slk(req));
        return;
    }
    if (staticFile(url.pathname)) event.respondWith(asset(req));
});
