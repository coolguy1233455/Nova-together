import { createServer } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { proxyDirs, scramjetBundle } from "./lib/proxy-files.js";
import * as api from "./lib/api.js";
import { access, sendHome, siteCookies } from "./lib/gate.js";
import * as unlock from "./lib/unlock.js";
import { members } from "./lib/members.js";
import { mpApi } from "./lib/mp.js";
import { offlineManifest } from "./lib/offline-files.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const mod = (p) => path.join(root, "node_modules", p);

// Wisp tunnels the proxy's TCP traffic over a single WebSocket, so the network
// only ever sees a connection to this server. Family DNS filters malware/adult.
logging.set_level(logging.NONE);
Object.assign(wisp.options, {
  allow_udp_streams: false,
  dns_servers: ["1.1.1.3", "1.0.0.3"],
});

const fastify = Fastify({
  bodyLimit: 4 * 1024 * 1024,
  serverFactory: (handler) =>
    createServer()
      .on("request", (req, res) => {
        // Cross-origin isolation is required by Scramjet's sync XHR support.
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        handler(req, res);
      })
      .on("upgrade", (req, socket, head) => {
        if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
        else socket.end();
      }),
});

// The same gate as middleware.js on Vercel: Nova is only served to a browser that has
// unlocked it, at its secret address (see lib/gate.js).
fastify.addHook("onRequest", async (req, reply) => {
  const { pathname } = new URL(req.url, "http://nova");
  const where = await access(pathname, siteCookies(req.headers));
  if (!where) {
    reply.header("Cache-Control", "no-store");
    if (sendHome(req.headers["sec-fetch-dest"], req.headers.accept, req.headers["sec-fetch-mode"])) return reply.redirect("/");
    return reply.code(404).type("text/plain").send("Not found");
  }
  if (where === "app") {
    const dir = pathname.split("/")[1];
    if (pathname === `/${dir}`) return reply.redirect(`/${dir}/`);
    if (pathname === `/${dir}/` || pathname === `/${dir}/index.html`) return reply.sendFile(`${where}/index.html`);
    return reply.code(404).type("text/plain").send("Not found");
  }
});

// A twin site with the math essay in front (NOVA_ESSAY=math, see build.mjs).
if (process.env.NOVA_ESSAY === "math")
  fastify.addHook("onRequest", async (req, reply) => {
    const { pathname } = new URL(req.url, "http://nova");
    if (pathname === "/" || pathname === "/index.html") return reply.sendFile("essay-math/index.html");
    if (pathname === "/essay/favicon.svg") return reply.sendFile("essay-math/favicon.svg");
  });

const staticDirs = [
  ["/", path.join(root, "public")],
  ...proxyDirs,
  ["/vendor/chart/", mod("chart.js/dist")],
  ["/vendor/marked/", mod("marked/lib")],
  ["/vendor/purify/", mod("dompurify/dist")],
  ["/vendor/katex/", mod("katex/dist")],
  ["/vendor/hljs/", mod("@highlightjs/cdn-assets")],
  ["/vendor/mermaid/", mod("mermaid/dist")],
  ["/vendor/geist/", mod("@fontsource-variable/geist")],
  ["/vendor/inter/", mod("@fontsource-variable/inter")],
  ["/vendor/patrick-hand/", mod("@fontsource/patrick-hand")],
  ["/vendor/transformers/", mod("@huggingface/transformers/dist")],
  ["/vendor/ort/", mod("onnxruntime-web/dist")],
  ["/vendor/tesseract/", mod("tesseract.js/dist")],
  ["/vendor/tesseract-core/", mod("tesseract.js-core")],
  ["/vendor/tesseract-data/", mod("@tesseract.js-data/eng/4.0.0_best_int")],
];
for (const [prefix, dir] of staticDirs) {
  fastify.register(fastifyStatic, {
    root: dir,
    prefix,
    decorateReply: prefix === "/",
    // /games/x → /games/x/, so its index.html is served.
    redirect: prefix === "/",
    setHeaders: (res, file) => {
      if (/(^|[\\/])(sw|uv-sw)\.js$/.test(file)) res.setHeader("Cache-Control", "no-cache");
    },
  });
}

// Served patched (see lib/proxy-files.js) instead of straight from node_modules.
const scramjetJs = scramjetBundle();
fastify.get("/scram/scramjet.js", (req, reply) => reply.type("text/javascript").send(scramjetJs));

// What members' devices save so the games play offline (public/js/offline.js). The gate
// above only lets a browser that has unlocked Nova see it.
fastify.get("/offline.json", (req, reply) => reply.header("Cache-Control", "no-store").send(offlineManifest(path.join(root, "public"))));

fastify.get("/api/suggest", async (req) => api.suggest(req.query.q));

fastify.get("/api/favicon", async (req, reply) => {
  const hit = await api.favicon(req.query.domain);
  if (!hit) return reply.code(400).send();
  reply.header("Cache-Control", "public, max-age=86400");
  if (!hit.body) return reply.code(404).send();
  reply.type(hit.type).send(hit.body);
});

fastify.get("/api/image", async (req, reply) => {
  try {
    const img = await api.image(req.query);
    if (!img) return reply.code(400).send();
    reply.header("Cache-Control", "public, max-age=604800").type(img.type).send(img.body);
  } catch (err) {
    reply.code(502).send({ error: String(err.message || err) });
  }
});

fastify.get("/api/chat", async (req, reply) => reply.header("Cache-Control", "no-store").code(204).send());
fastify.post("/api/chat", async (req, reply) => {
  reply.hijack();
  await api.chat(req.body, reply.raw);
});

fastify.post("/api/log", async (req, reply) => {
  api.logClientError(req.body, req.headers["user-agent"]);
  reply.code(204).send();
});

const send = (reply, r) => {
  if (r.cookies) reply.header("Set-Cookie", r.cookies);
  reply.header("Cache-Control", r.cache || "no-store").code(r.status);
  if (r.raw) return reply.type(r.type).header("X-Content-Type-Options", "nosniff").send(r.raw);
  reply.send(r.body ?? undefined);
};
fastify.post("/api/open", async (req, reply) =>
  send(reply, await unlock.openDoor({ word: req.body?.word, at: req.body?.at, check: req.body?.check, claimed: req.body?.claimed, passkey: req.body?.passkey, ip: req.ip, cookieHeader: siteCookies(req.headers), origin: `${req.protocol}://${req.headers.host}` })),
);
fastify.get("/api/google", (req, reply) => reply.header("Cache-Control", "no-store").type("text/html").send(unlock.googleReturnPage));
fastify.post("/api/google", async (req, reply) =>
  send(
    reply,
    req.body?.request
      ? await unlock.requestDone({ request: req.body.request, message: req.body.message })
      : await unlock.googleDone({ idToken: req.body?.idToken, state: req.body?.state, cookieHeader: siteCookies(req.headers) }),
  ),
);
fastify.post("/api/lock", async (req, reply) => send(reply, await unlock.lock({ cookieHeader: siteCookies(req.headers) })));
fastify.post("/api/find", async (req, reply) => send(reply, await unlock.findReturn({ q: req.body?.q, cookieHeader: siteCookies(req.headers) })));
fastify.route({
  method: ["GET", "POST"],
  url: "/api/members",
  handler: async (req, reply) => send(reply, await members({ method: req.method, query: req.query, body: req.body || {}, cookieHeader: siteCookies(req.headers), origin: `${req.protocol}://${req.headers.host}` })),
});

fastify.route({
  method: ["GET", "POST"],
  url: "/api/mp",
  handler: async (req, reply) => send(reply, await mpApi({ method: req.method, query: req.query, body: req.body || {} })),
});

fastify.get("/api/health", async () => ({ ok: true, ai: api.visionKind === "gemini" ? "gemini" : api.aiKind, vision: api.visionKind || "browser" }));

// Pizza Edition's games, as vercel.json serves them on Vercel: its shared scripts come from
// public/scripts/ (ad-free stand-ins), everything else under /pe/ and /scripts/ from its game
// host as it's played (plus Reel League, which loads its files from /reelleague/). Nova's
// cookies and the referrer stay here. Their pages are credentialless rather than require-corp
// so the images, SDKs and level data some games load from other sites still arrive.
const PE_STUB = /^\/(?:pe\/)?scripts\/((?:v2\/|crazy\/)?sdk\.js|save-sync\.js|save-migrate\.js)$/;
const PE_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "last-modified", "etag"];
async function fromPizzaEdition(req, reply, pathname) {
  const stub = PE_STUB.exec(pathname)?.[1];
  if (stub) return reply.type("text/javascript").sendFile(`scripts/${stub === "v2/sdk.js" ? "sdk.js" : stub}`);
  const headers = { "accept-encoding": "identity" };
  for (const name of ["range", "accept", "user-agent"]) if (req.headers[name]) headers[name] = req.headers[name];
  const res = await fetch("https://games.pizzaedition.com" + req.url.replace(/^\/pe(?=\/)/, ""), { method: req.method, headers });
  reply.code(res.status);
  reply.header("Cross-Origin-Embedder-Policy", "credentialless");
  for (const name of PE_HEADERS) if (res.headers.has(name)) reply.header(name, res.headers.get(name));
  return reply.send(res.body ? Readable.fromWeb(res.body) : "");
}

fastify.setNotFoundHandler((req, reply) => {
  const { pathname } = new URL(req.url, "http://nova");
  if ((req.method === "GET" || req.method === "HEAD") && /^\/(?:pe|scripts|reelleague)\//.test(pathname)) return fromPizzaEdition(req, reply, pathname);
  return reply.code(404).type("text/html").sendFile("404.html");
});

fastify.server.on("listening", () => {
  const { port } = fastify.server.address();
  console.log(`Nova is running:\n\thttp://localhost:${port}\n\thttp://${hostname()}:${port}`);
  console.log(`AI: ${api.aiKind === "claude" ? `Claude (${api.CLAUDE_MODEL})` : "free model (set ANTHROPIC_API_KEY to use Claude)"}`);
});

function shutdown() {
  fastify.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Default to 8090 locally; if that's taken, try the next few ports.
const basePort = parseInt(process.env.PORT || "") || 8090;
async function start(port, triesLeft) {
  try {
    await fastify.listen({ port, host: "0.0.0.0" });
  } catch (err) {
    if (err.code === "EADDRINUSE" && triesLeft > 0 && !process.env.PORT) return start(port + 1, triesLeft - 1);
    console.error(err.message);
    process.exit(1);
  }
}
start(basePort, 10);
