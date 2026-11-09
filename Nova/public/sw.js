// Scramjet 2's service worker: it hands every proxied request (/~/sj/...) to the Nova
// page, which fetches it through the Wisp tunnel. It also keeps Nova's offline copy: every
// other request still goes to the network first, and only when the network can't be
// reached is the copy saved on this device used.
importScripts("/controller/controller.sw.js");

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The browser stops an idle worker, and Scramjet's forgets which frames it routes when
// that happens. The Nova page re-registers them as soon as the worker starts again, so a
// page opened in that gap waits a moment and reloads instead of showing a 404.
const RETRY_PAGE = `<!doctype html><meta charset="utf-8"><title>Loading…</title>
<body style="margin:0;background:#0a0b10;color:#8b90a5;font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">
<p id="m">Reconnecting…</p><script>
let s = {};
try { s = JSON.parse(sessionStorage.getItem("nova-sj-retry")) || {}; } catch {}
const n = Date.now() - (s.t || 0) < 20000 ? (s.n || 0) + 1 : 1;
try { sessionStorage.setItem("nova-sj-retry", JSON.stringify({ n, t: Date.now() })); } catch {}
if (n <= 8) setTimeout(() => location.reload(), 300 * n);
else document.getElementById("m").textContent = "Couldn't reconnect to the page. Press reload in Nova's toolbar.";
</script>`;

// Nova's offline copy. Pages, frames, scripts, styles, pictures and fonts are saved here as
// they load; public/js/offline.js saves every game on top. Online, the server answers as
// always (lib/gate.js), so this changes nothing until the network is gone.
const OFFLINE = "nova-offline";
// The essay's fonts.
const FONT_HOSTS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];

function savable(req, url) {
  if (req.method !== "GET" || req.headers.has("range")) return false;
  if (url.origin !== location.origin) return FONT_HOSTS.includes(url.origin);
  return !/^\/(?:api|~|wisp)\//.test(url.pathname);
}

async function savedCopy(req, url) {
  const cache = await caches.open(OFFLINE);
  const opts = { ignoreVary: true };
  return (
    (await cache.match(req, opts)) ||
    (await cache.match(req, { ...opts, ignoreSearch: true })) ||
    (url.pathname.endsWith("/") && (await cache.match(url.pathname + "index.html", opts))) ||
    // A page that was never saved gets the essay, as when the server turns a visitor away.
    (req.mode === "navigate" && (await cache.match("/", opts))) ||
    null
  );
}

async function networkFirst(event, url) {
  const req = event.request;
  try {
    const res = await fetch(req);
    // Redirects and refusals (a visitor the gate turned away) are never saved.
    if (req.destination && res.status === 200 && !res.redirected && (res.type === "basic" || res.type === "cors")) {
      const copy = res.clone();
      event.waitUntil(caches.open(OFFLINE).then((c) => c.put(req, copy)).catch(() => {}));
    }
    return res;
  } catch (err) {
    const saved = await savedCopy(req, url);
    if (saved) return saved;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  if ($scramjetController.shouldRoute(event)) return event.respondWith($scramjetController.route(event));
  const url = new URL(event.request.url);
  if (event.request.mode === "navigate" && url.origin === location.origin && url.pathname.startsWith("/~/sj/")) {
    return event.respondWith(
      new Response(RETRY_PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "cross-origin-embedder-policy": "require-corp",
          "cross-origin-resource-policy": "same-origin",
        },
      }),
    );
  }
  if (savable(event.request, url)) event.respondWith(networkFirst(event, url));
});
