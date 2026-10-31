const CACHE = "chatroom-{{ ASSET_V }}";
const SHELL = ["/static/style.css", "/static/theme.js", "/static/pwa.js", "/static/chat.js", "/offline"];
const CDN = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.socket.io"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.pathname.startsWith("/socket.io") || url.pathname.startsWith("/api")) return;
  if (req.mode === "navigate") {  // pages: always live, offline fallback only
    e.respondWith(fetch(req).catch(() => caches.match("/offline")));
    return;
  }
  const same = url.origin === location.origin && (url.pathname.startsWith("/static/") || url.pathname.startsWith("/media/"));
  if (same || CDN.includes(url.hostname)) {  // assets: stale-while-revalidate
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});
