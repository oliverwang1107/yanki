// 讓網頁離線也能開：程式檔用「先網路、失敗用快取」，音檔用「先快取」。
// iOS Safari 播音檔會送 Range 請求，快取的完整檔案要自己切成 206 回應，否則無法播放。
const APP = "app-v15";
const MEDIA = "media-v1";
const TTS = "tts-v1"; // 雲端發音的快取（由 tts.js 管理）
const SHELL = [
  "/", "/style.css", "/ui.css", "/sched.wasm", "/fsrs_opt.wasm", "/js/fsrs.worker.js", "/manifest.webmanifest", "/icon.svg",
  ...["app", "apkg", "backup", "cards", "core", "db", "engine", "fsrsopt", "importer", "ink", "media", "notetypes", "ops", "plan", "prefs", "progress", "pw", "quizgen", "render", "sched", "search", "sync", "tts", "ui", "zip"].map((n) => `/js/${n}.js`),
  ...["admin", "browse", "custom", "decks", "editor", "fsrs", "import", "io_editor", "ink_layer", "info", "more", "options", "quiz", "stats", "study", "types"].map((n) => `/js/views/${n}.js`),
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== APP && k !== MEDIA && k !== TTS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function rangeResponse(full, rangeHeader) {
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  const buf = await full.arrayBuffer();
  const start = m[1] ? Number(m[1]) : Math.max(0, buf.byteLength - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), buf.byteLength - 1) : buf.byteLength - 1;
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": full.headers.get("Content-Type") || "audio/mpeg",
      "Content-Range": `bytes ${start}-${end}/${buf.byteLength}`,
      "Content-Length": String(end - start + 1),
    },
  });
}

async function media(request) {
  const cache = await caches.open(MEDIA);
  const key = new Request(request.url);
  let full = await cache.match(key);
  if (!full) {
    const res = await fetch(key); // 一律抓完整檔案再快取，Range 由本地切
    if (!res.ok) return res;
    await cache.put(key, res.clone());
    full = res;
  }
  const range = request.headers.get("Range");
  return range ? rangeResponse(full, range) : full;
}

self.addEventListener("fetch", (e) => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/media/")) {
    e.respondWith(media(request).catch(() => new Response("", { status: 504 })));
    return;
  }
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) caches.open(APP).then((c) => c.put(request, res.clone()));
        return res;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((r) => r || caches.match("/")))
  );
});
