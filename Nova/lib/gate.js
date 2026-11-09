// Who may see what. The essay is public; Nova (the app page, games, scripts, AI) only
// opens for a browser that has clicked the essay's secret word and then signed in with an
// allowed Google account. Each pass is a signed cookie, so nothing in the browser can fake
// them.
//
// The word, the allowed emails, Nova's address and the signing key come from the server's
// environment (see README) and never reach the browser. Used by middleware.js on Vercel
// and by server.js, so this file sticks to web-standard APIs that work in both.

export const SESSION = "lp_s"; // signed in with an allowed Google account: Nova opens (30 days on that browser)
export const RETURN = "lp_r"; // Nova was just hidden on this browser: the return word reopens it (5 minutes)
export const DEVICE = "lp_d"; // a browser that has unlocked Nova before (see lib/unlock.js)
// How long a session lasts (its token says when it ends). 30 days since 2026-11-05, so the
// essay's word opens Nova straight away on a browser that signed in before: Google's page
// (a real address in the browser's history) only comes up the first time on each browser.
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
// Sessions made before that lasted 12 hours. Any token ending before this moment is one.
export const OLD_SESSION_SECONDS = 12 * 60 * 60;
export const OLD_SESSIONS_END = Date.UTC(2026, 10, 7); // ms

// Static references (not process.env[name]) so Vercel's edge bundler picks them up.
export const appDir = () => process.env.NOVA_APP_PATH || "";

// Open to everyone: the essay, the 404 page, the unlock endpoints, the multiplayer game
// server's door (lib/mp.js, which checks that server's signature) and the proxy's library
// files (open-source code, of no use without Nova's own page).
const PUBLIC =
  /^\/(?:$|index\.html$|404\.html$|favicon\.svg$|essay\/|vendor\/|scram\/|controller\/|sjutils\/|epoxy\/|libcurl\/|uv\/|baremux\/|uv-epoxy\/|uv-libcurl\/|~\/|(?:sw|uv-sw|uv-config|config)\.js$|(?:request-prefs|uv-transport)\.mjs$|api\/(?:open|google|lock|find|mp)$)/;

const enc = new TextEncoder();
export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

let keyFor = "";
let keyPromise = null;
function hmacKey() {
  const secret = process.env.NOVA_SECRET || "";
  if (secret.length < 32) return null;
  if (secret !== keyFor) {
    keyFor = secret;
    keyPromise = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }
  return keyPromise;
}

// A token is "kind.expiry.id.signature". Returns null when the signing key isn't set.
export async function sign(kind, seconds, id = b64url(crypto.getRandomValues(new Uint8Array(9)))) {
  const key = await hmacKey();
  if (!key) return null;
  const body = `${kind}.${Math.floor(Date.now() / 1000) + seconds}.${id}`;
  return `${body}.${b64url(await crypto.subtle.sign("HMAC", key, enc.encode(body)))}`;
}

// The token's id if it is a valid, unexpired token of this kind, otherwise null.
export async function verify(token, kind) {
  const key = await hmacKey();
  const parts = String(token || "").split(".");
  if (!key || parts.length !== 4 || parts[0] !== kind || !(Number(parts[1]) > Date.now() / 1000)) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", key, unb64url(parts[3]), enc.encode(parts.slice(0, 3).join(".")));
    return ok ? parts[2] : null;
  } catch {
    return null;
  }
}

export function readCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// maxAge undefined: a session cookie, gone when the browser closes. 0 deletes it.
// SameSite=None, not Strict: Safari counts every page inside an about:blank tab
// (public/essay/cloak.js) as another site's and holds Strict and Lax cookies back there, so
// Nova's own styles and scripts were turned away. siteCookies does Strict's job instead.
export const cookie = (name, value, maxAge) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=None${maxAge === undefined ? "" : `; Max-Age=${maxAge}`}`;

// The request's cookies, or none when another site started it. Browsers say who started a
// request in Sec-Fetch-Site, which pages can't set; the few too old to send it still send
// Origin with every POST. Takes a Headers object or Node's plain headers.
export function siteCookies(headers) {
  const get = (name) => String((typeof headers.get === "function" ? headers.get(name) : headers[name]) || "");
  const site = get("sec-fetch-site");
  if (site) return site === "cross-site" ? "" : get("cookie");
  const origin = get("origin");
  if (!origin) return get("cookie");
  try {
    return new URL(origin).host === (get("x-forwarded-host") || get("host")) ? get("cookie") : "";
  } catch {
    return "";
  }
}

// What a request for this path may see: "public", "app" (Nova's page), "private" (any
// other Nova file), or null when it must be turned away.
export async function access(rawPath, cookieHeader) {
  let path;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (/(^|\/)\.\.(\/|$)|\\|\0/.test(path)) return null;
  if (PUBLIC.test(path)) return "public";

  const jar = readCookies(cookieHeader);
  const unlocked = !!(await verify(jar[SESSION], "s"));
  const under = (dir) => dir.length >= 20 && (path === `/${dir}` || path.startsWith(`/${dir}/`));
  if (under(appDir())) return unlocked ? "app" : null;
  // Nova's page in public/ is only ever served under its secret address.
  if (/^\/app(\/|$)/.test(path)) return null;
  return unlocked ? "private" : null;
}

// A turned-away page load lands on the essay, as if nothing were there; anything else
// (scripts, images, API calls) just gets a 404. A page load that Nova's service worker
// passes on (public/sw.js) arrives as mode "navigate" with dest "empty".
export const sendHome = (dest, accept, mode) =>
  dest === "document" || (mode === "navigate" && dest === "empty") || (!dest && String(accept || "").includes("text/html"));
