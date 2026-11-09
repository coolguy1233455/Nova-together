/* global UVServiceWorker */
// Ultraviolet's service worker, scoped to /uv/service/. It reaches the Wisp tunnel
// through bare-mux, which the Nova page points at the same transport Scramjet uses.
importScripts("/uv/uv.bundle.js", "/uv-config.js", "/uv/uv.sw.js");

const uv = new UVServiceWorker();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Nova is cross-origin isolated, so a page framed inside it must opt in too. Ultraviolet
// strips the site's own isolation headers, so add Nova's back.
const ISOLATION = [
  ["Cross-Origin-Embedder-Policy", "require-corp"],
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Cross-Origin-Resource-Policy", "same-origin"],
];

async function handle(event) {
  const res = await uv.fetch(event);
  if (!res || res.type === "opaque" || res.type === "opaqueredirect") return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of ISOLATION) headers.set(k, v);
  const nullBody = [101, 204, 205, 304].includes(res.status);
  try {
    return new Response(nullBody ? null : res.body, { status: res.status, statusText: res.statusText, headers });
  } catch {
    return res;
  }
}

self.addEventListener("fetch", (event) => {
  if (uv.route(event)) event.respondWith(handle(event));
});
