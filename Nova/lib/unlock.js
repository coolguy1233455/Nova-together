// The checks in front of Nova, all done here on the server: the essay's secret word (which
// starts a Google sign-in) and the Google account (which must be on the allowed list, and
// opens Nova). The word has a fixed number of tries; running out locks it for a while,
// and the lock doubles each time it happens again within a day. After Nova hides itself
// (panic key or sign-out), the return word typed into the essay's search box
// reopens it for a few minutes, on that browser only. Used by api/{open,google,lock,find}.js
// and server.js.
import { SESSION, SESSION_SECONDS, RETURN, DEVICE, sign, verify, readCookies, cookie, appDir, b64url, unb64url } from "./gate.js";
import { allowedEmails, idFor, emailOf, signedInAt, blocked, refreshApproved, requestAccess, requestReply, entrance } from "./members.js";
import { rpIdOf, pkDb, checkRegistration, checkAssertion } from "./passkey.js";

const RULES = {
  word: { tries: 10, lockSeconds: 15 * 60 },
};
const MAX_LOCK = 24 * 60 * 60;
const PASS_SECONDS = 10 * 60;
const RETURN_SECONDS = 5 * 60;
const DEVICE_SECONDS = 365 * 24 * 60 * 60;

// Tries are counted in Vercel's Runtime Cache, shared by every copy of the function, or
// in memory when running server.js.
let storePromise = null;
function store() {
  return (storePromise ??= (async () => {
    if (process.env.VERCEL) {
      try {
        const { getCache } = await import("@vercel/functions");
        const cache = getCache({ namespace: "nova-unlock" });
        return {
          get: async (k) => (await cache.get(k)) ?? null,
          set: (k, v, ttl) => cache.set(k, v, { ttl }),
          delete: (k) => cache.delete(k),
        };
      } catch (err) {
        console.error("unlock: Runtime Cache unavailable, counting tries in memory", err);
      }
    }
    const mem = new Map();
    return {
      get: async (k) => {
        const e = mem.get(k);
        return e && e.expires > Date.now() ? e.value : null;
      },
      set: async (k, value, ttl) => void mem.set(k, { value, expires: Date.now() + ttl * 1000 }),
      delete: async (k) => void mem.delete(k),
    };
  })());
}

// Requests for the same counter take turns within this instance, so a burst can't all
// read the count before any of them updates it.
const queues = new Map();
function inTurn(key, fn) {
  const run = (queues.get(key) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => queues.get(key) === tail && queues.delete(key));
  return run;
}

// { ok } on the right answer, { left } on a wrong one, { retryAfter } while locked.
function attempt(step, who, isRight) {
  const key = `${step}:${who}`;
  return inTurn(key, async () => {
    const { tries, lockSeconds } = RULES[step];
    const db = await store();
    const now = Date.now();
    const rec = (await db.get(key)) || { wrong: 0, until: 0, locks: 0 };
    if (rec.until > now) return { retryAfter: Math.ceil((rec.until - now) / 1000) };
    if (isRight()) {
      if (rec.wrong || rec.locks) await db.delete(key);
      return { ok: true };
    }
    rec.wrong++;
    if (rec.wrong >= tries) {
      rec.wrong = 0;
      rec.locks++;
      rec.until = now + Math.min(lockSeconds * 2 ** (rec.locks - 1), MAX_LOCK) * 1000;
    }
    await db.set(key, rec, Math.max(24 * 60 * 60, Math.ceil((rec.until - now) / 1000)));
    return rec.until > now ? { retryAfter: Math.ceil((rec.until - now) / 1000) } : { left: tries - rec.wrong };
  });
}

// Compares every character, so the time taken doesn't hint at how much was right.
function same(given, secret) {
  let diff = given.length ^ secret.length;
  for (let i = 0; i < Math.max(given.length, secret.length); i++) diff |= (given.charCodeAt(i) || 0) ^ (secret.charCodeAt(i) || 0);
  return diff === 0 && secret.length > 0;
}

// Tries are counted per IP address. A browser that has unlocked Nova before counts on its
// own instead, so someone guessing on a shared school network can't lock its owner out.
async function whoIs(jar, ip) {
  const device = await verify(jar[DEVICE], "d");
  return device ? `d:${device}` : `ip:${String(ip || "unknown").split(",")[0].trim()}`;
}

// Google sign-in (OpenID Connect): Google sends the browser back to /api/google with a
// signed ID token naming the account, which is checked here against Google's public keys.
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const googleReturn = (origin) => `${origin}/api/google`;
let googleKeys = { fetched: 0, keys: [] };

async function googleKey(kid) {
  const stale = Date.now() - googleKeys.fetched > 60 * 60 * 1000;
  if (stale || !googleKeys.keys.some((k) => k.kid === kid)) {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/certs", { signal: AbortSignal.timeout(5000) });
    googleKeys = { fetched: Date.now(), keys: (await r.json()).keys || [] };
  }
  return googleKeys.keys.find((k) => k.kid === kid) || null;
}

// The token's claims if Google signed it for this site and it hasn't expired, else null.
async function googleClaims(idToken) {
  const [head, body, sig] = String(idToken || "").split(".");
  if (!sig) return null;
  try {
    const dec = new TextDecoder();
    const header = JSON.parse(dec.decode(unb64url(head)));
    const jwk = header.alg === "RS256" && (await googleKey(header.kid));
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64url(sig), new TextEncoder().encode(`${head}.${body}`)))) return null;
    const claims = JSON.parse(dec.decode(unb64url(body)));
    const ok =
      GOOGLE_ISSUERS.includes(claims.iss) &&
      claims.aud === process.env.NOVA_GOOGLE_CLIENT_ID &&
      claims.exp > Date.now() / 1000 - 60 &&
      (claims.email_verified === true || claims.email_verified === "true");
    return ok ? claims : null;
  } catch {
    return null;
  }
}

// Each handler returns { status, body, cookies } for the caller to send.

// A click on a word in the essay: the word, and where it is ("section/paragraph/n", the
// nth time that word appears in that paragraph). The right word is the admin's entrance word
// (lib/members.js entrance) anywhere in its section; it starts a Google sign-in, every time:
// nobody gets into Nova without signing in to an allowed Google account. A wrong word and a
// locked-out click get the same answer, so guessing one word after another gives nothing away.
// What the right word earns travels in the sign-in's own `state`, signed, not in cookies:
// the essay often runs inside an about:blank tab (public/essay/cloak.js), where Safari
// ignores the cookies a page is sent.
// The answer carries both ways to sign in: Google's own sign-in box inside the essay (nonce +
// client: public/essay/essay.js, which keeps the tab on about:blank and puts no address in
// the history), or Google's page in a small window (path) where that box can't work.
export async function openDoor({ word, at, ip, cookieHeader, origin, check, claimed, passkey }) {
  // The essay asking whether the sign-in it started is done (see signedInDone below).
  if (check || claimed) return signInCheck(check || claimed, !!check);
  if (passkey) return passkeyDoor(passkey, cookieHeader, origin);
  const w = String(word || "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 40);
  const where = /^[a-z0-9-]{1,40}\/\d{1,3}\/\d{1,3}$/.test(String(at || "")) ? at : "";
  const jar = readCookies(cookieHeader);
  const e = await entrance();
  const r = await attempt("word", await whoIs(jar, ip), () => same(w, e.word) && same(where.split("/")[0], e.section));
  const clientId = process.env.NOVA_GOOGLE_CLIENT_ID;
  if (!r.ok) return { status: 200, body: { ok: false } };

  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const state = await sign("o", PASS_SECONDS, nonce);
  if (!state) return { status: 200, body: { ok: false } };
  // The passkey way in (passkeyDoor): one signed challenge, good for one passkey sign-in or one
  // device request in the next 10 minutes.
  const pk = { challenge: await sign("k", PASS_SECONDS, nonce), rp: rpIdOf(origin) };
  if (!clientId) return { status: 200, body: { ok: true, pk } };
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: googleReturn(origin),
    response_type: "id_token",
    scope: "openid email",
    nonce,
    state,
    prompt: "select_account",
  });
  return {
    status: 200,
    body: { ok: true, path: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, check: state, nonce, client: clientId, pk },
  };
}

// Google's sign-in opens in a window of its own (public/essay/essay.js). When it's done, that
// window tells the essay where Nova is over a BroadcastChannel; as a backup that doesn't depend
// on the browser letting the two talk, the essay also asks here about once a second ({check}:
// the sign-in's state), and the window asks whether the essay has heard ({claimed}): then it
// just closes, instead of opening Nova itself at its real address.
async function signInCheck(state, essayAsking) {
  const nonce = await verify(state, "o");
  if (!nonce) return { status: 200, body: {} };
  const db = await store();
  if (!essayAsking) return { status: 200, body: { claimed: !!(await db.get(`signin-claimed:${nonce}`)) } };
  const path = await db.get(`signin-done:${nonce}`);
  if (!path) return { status: 200, body: {} };
  await db.set(`signin-claimed:${nonce}`, 1, PASS_SECONDS);
  return { status: 200, body: { ok: true, path } };
}

// Passkeys (lib/passkey.js), from the essay's card after the right word: {register} asks the
// admin to let this device in; {login} opens Nova with a device the admin approved. Either one
// spends the word's challenge, so each takes a fresh click on the word.
const challengeOk = async (token) => {
  const nonce = await verify(token, "k");
  if (!nonce) return false;
  const db = await store();
  if (await db.get(`pk-used:${nonce}`)) return false;
  await db.set(`pk-used:${nonce}`, 1, PASS_SECONDS);
  return true;
};
async function passkeyDoor(passkey, cookieHeader, origin) {
  const p = passkey && typeof passkey === "object" ? passkey : {};
  try {
    if (p.action === "register") {
      const r = await checkRegistration({ cred: p, origin, challengeOk });
      if (r.error) return { status: 400, body: { error: r.error } };
      const added = await pkDb("add", r.row);
      if (added.full) return { status: 429, body: { error: "full" } };
      // Someone already approved (an approved email from before passkeys) doesn't wait for the
      // admin: the device is approved now and Nova opens, unless they're banned or kicked.
      await refreshApproved();
      if (added.ok && allowedEmails().includes(r.row.email)) {
        await pkDb("answer", { id: r.row.id, status: "approved", by: "auto (already approved)" });
        const block = await blocked(r.row.email);
        if (block) return { status: 200, body: { requested: true, approved: true, ...block } };
        return openNova(readCookies(cookieHeader), r.row.email, []);
      }
      return { status: 200, body: { requested: true } };
    }
    if (p.action !== "login") return { status: 400, body: { error: "bad" } };
    await refreshApproved();
    const row = typeof p.id === "string" && p.id.length < 1400 ? await pkDb("get", { id: p.id }) : {};
    if (!row?.id) {
      await challengeOk(String(p.challenge || ""));
      return { status: 200, body: { ok: false, unknown: true } };
    }
    const good = await checkAssertion({ cred: p, row, origin, challengeOk });
    if (!good) return { status: 200, body: { ok: false, failed: true } };
    // Waiting, but its email was approved since (or before): approved now.
    if (row.status === "pending" && allowedEmails().includes(row.email)) {
      await pkDb("answer", { id: row.id, status: "approved", by: "auto (already approved)" });
      row.status = "approved";
    }
    if (row.status === "pending") return { status: 200, body: { ok: false, pending: true } };
    if (row.status !== "approved") return { status: 200, body: { ok: false, denied: true } };
    if (!allowedEmails().includes(row.email)) return { status: 200, body: { ok: false, removed: true } };
    const block = await blocked(row.email);
    if (block) return { status: 200, body: { ok: false, ...block } };
    await pkDb("used", { id: row.id, count: good.count });
    return openNova(readCookies(cookieHeader), row.email, []);
  } catch (err) {
    console.error(err);
    return { status: 502, body: { error: "unavailable" } };
  }
}

// Nova's unlock: the session cookie, which names the account (and the device cookie, first
// time on this browser).
async function openNova(jar, email, extra) {
  const session = await sign("s", SESSION_SECONDS, idFor(email));
  if (!session || !appDir()) return { status: 500, body: { error: "not configured" } };
  const cookies = [cookie(SESSION, session, SESSION_SECONDS), ...extra];
  if (!(await verify(jar[DEVICE], "d"))) cookies.push(cookie(DEVICE, await sign("d", DEVICE_SECONDS), DEVICE_SECONDS));
  return { status: 200, body: { ok: true, path: `/${appDir()}/` }, cookies };
}

// Back from Google: `state` must be one the right word handed out (openDoor) in the last 10
// minutes, used once, and the account must be one of NOVA_EMAILS, and not banned or kicked
// from the admin panel. Then Nova opens. Turned away, the answer carries a signed ticket naming
// the account (15 minutes), which lets this page ask the admin to let it in (requestDone).
const REQUEST_SECONDS = 15 * 60;
const ticket = (email, reason) => sign("q", REQUEST_SECONDS, b64url(new TextEncoder().encode(JSON.stringify({ email, reason }))));
export async function googleDone({ idToken, state, cookieHeader }) {
  await refreshApproved();
  const jar = readCookies(cookieHeader);
  const nonce = await verify(state, "o");
  const db = await store();
  if (!nonce || (await db.get(`signin:${nonce}`))) return { status: 401, body: { expired: true } };
  await db.set(`signin:${nonce}`, 1, PASS_SECONDS);
  const claims = await googleClaims(idToken);
  const email = String(claims?.email || "").toLowerCase();
  if (!claims || claims.nonce !== nonce) return { status: 403, body: { ok: false } };
  // Turned away: with the admin's answer, if they asked before and were denied.
  const answer = async () => {
    const r = await requestReply(email);
    return r?.denied ? { denied: true, reply: r.reply || "" } : {};
  };
  if (!allowedEmails().includes(email)) return { status: 403, body: { ok: false, email, request: await ticket(email, "not-member"), ...(await answer()) } };
  const block = await blocked(email);
  if (block) return { status: 403, body: { ok: false, ...block, email, request: await ticket(email, block.banned ? "banned" : "kicked"), ...(await answer()) } };
  const res = await openNova(jar, email, []);
  if (res.body?.path) await db.set(`signin-done:${nonce}`, res.body.path, PASS_SECONDS);
  return res;
}

// The turned-away account's note to the admin: it shows under Requests in the admin panel.
export async function requestDone({ request, message }) {
  let q = null;
  try {
    q = JSON.parse(new TextDecoder().decode(unb64url((await verify(request, "q")) || "")));
  } catch {}
  if (!q?.email) return { status: 401, body: { expired: true } };
  try {
    await requestAccess(q.email, String(message || "").trim().slice(0, 500), q.reason);
  } catch (err) {
    console.error(err);
    return { status: 502, body: { error: "unavailable" } };
  }
  return { status: 200, body: { requested: true } };
}

// The page Google sends the browser back to. The ID token arrives in the address's #part,
// which never reaches a server, so this page hands it to googleDone and moves on.
export const googleReturnPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${process.env.NOVA_ESSAY === "math" ? "Understanding Algebra 2" : "Saint Ambrose"}</title>
<link rel="icon" href="/essay/favicon.svg" type="image/svg+xml" />
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; text-align: center; background: #f3ead6; color: #54473c; font: 17px/1.6 "EB Garamond", Garamond, Georgia, serif; }
  a { color: #6e1d24; }
  main { width: min(440px, 100%); }
  #ask { margin-top: 18px; text-align: left; }
  #ask textarea { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #c9b48f; border-radius: 10px; background: #fffaf0; color: #3b3026; font: inherit; font-size: 16px; resize: vertical; }
  #ask button { margin-top: 10px; padding: 9px 18px; border: 0; border-radius: 999px; background: #6e1d24; color: #fff; font: inherit; cursor: pointer; }
  #ask button:disabled { opacity: 0.6; }
  #ask-msg { color: #8a2a2a; font-size: 15px; }
  #denied { margin: 14px 0 0; padding: 12px 14px; border-radius: 10px; background: #fbe9e4; color: #6e1d24; font-size: 16px; }
  #denied .reply { display: inline-block; margin-top: 6px; color: #3b3026; font-style: italic; }
</style>
</head>
<body>
<main>
<p id="m">One moment…</p>
<form id="ask" hidden>
  <p>Ask to be let in as <strong id="ask-who"></strong>:</p>
  <textarea id="ask-note" maxlength="500" rows="4" placeholder="Write a short message (who you are, why you'd like in)"></textarea>
  <button type="submit">Send request</button>
  <p id="ask-msg"></p>
</form>
</main>
<script>
  (async () => {
    const q = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, "", location.pathname);
    if (!q.get("id_token")) return location.replace("/");
    let res = {};
    try {
      const r = await fetch("/api/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: q.get("id_token"), state: q.get("state") }),
      });
      res = await r.json();
    } catch {}
    if (res.path) {
      try {
        sessionStorage.setItem("lp-unlocked", "1");
      } catch {}
      // Usually this is the small sign-in window the essay opened (public/essay/essay.js): the
      // essay, in its about:blank tab, opens Nova itself once it hears where (from here, or
      // from the server, which it asks about once a second), says so, and this window closes.
      // With no answer in 4 seconds, this page was opened in the tab itself: go on to Nova.
      let heard = false;
      const done = () => {
        if (heard) return;
        heard = true;
        window.close();
        document.getElementById("m").textContent = "You're in. You can close this window.";
      };
      try {
        const ch = new BroadcastChannel("lp-signin");
        ch.onmessage = (e) => e.data?.ack && done();
        ch.postMessage({ path: res.path });
      } catch {}
      addEventListener("storage", (e) => e.key === "lp-signin-ack" && e.newValue && done());
      try {
        localStorage.setItem("lp-signin", JSON.stringify({ path: res.path, t: Date.now() }));
        localStorage.removeItem("lp-signin");
      } catch {}
      const started = Date.now();
      const claimed = () =>
        fetch("/api/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claimed: q.get("state") }) })
          .then((r) => r.json())
          .then((d) => d && d.claimed && done())
          .catch(() => {})
          .then(() => {
            if (heard) return;
            if (Date.now() - started < 4000) return setTimeout(claimed, 400);
            location.replace(res.path);
          });
      return setTimeout(claimed, 300);
    }
    const until = res.kickedUntil && new Date(res.kickedUntil).toLocaleString([], { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
    const why = res.reason ? '<br><small>Reason: ' + res.reason.replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";") + "</small>" : "";
    document.getElementById("m").innerHTML = res.expired
      ? 'That took too long. <a href="/">Return to the essay</a> to start again.'
      : res.banned
        ? 'That account has been banned from the library.' + why + ' <a href="/">Return to the essay</a>'
        : until
          ? 'That account is away from the library until ' + until + '.' + why + ' <a href="/">Return to the essay</a>'
          : 'That Google account isn\\'t a member of the library. <a href="/">Return to the essay</a>';
    // Asked before and the admin said no: that answer, with the admin's message if any.
    if (res.denied) {
      const p = document.createElement("p");
      p.id = "denied";
      p.innerHTML = "Your last request to join was denied." + (res.reply ? '<br><span class="reply">Message from the admin: \u201c' + res.reply.replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";") + '\u201d</span>' : "");
      document.getElementById("m").after(p);
    }
    // Turned away: a box to ask the admin to be let in (requestDone).
    if (!res.request) return;
    const box = document.getElementById("ask");
    box.hidden = false;
    document.getElementById("ask-who").textContent = res.email;
    const note = document.getElementById("ask-note");
    note.focus();
    box.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = box.querySelector("button");
      btn.disabled = true;
      let ok = false;
      try {
        const r = await fetch("/api/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request: res.request, message: note.value }) });
        ok = (await r.json()).requested;
      } catch {}
      btn.disabled = false;
      if (!ok) return void (document.getElementById("ask-msg").textContent = "Couldn't send that. Try again.");
      box.innerHTML = '<p>Your request was sent. You can come back once it\\'s approved. <a href="/">Return to the essay</a></p>';
    });
  })();
</script>
</body>
</html>
`;

// Nova hiding itself (panic key or sign-out): the return word works for 5 minutes after.
export async function lock({ cookieHeader }) {
  const jar = readCookies(cookieHeader);
  const id = await verify(jar[SESSION], "s");
  const cookies = id ? [cookie(RETURN, await sign("r", RETURN_SECONDS, id), RETURN_SECONDS)] : [];
  // Remembered here too, for Safari's about:blank tab, which ignores the cookie above.
  if (id) await (await store()).set(`hid:${id}`, 1, RETURN_SECONDS);
  return { status: 204, body: null, cookies };
}

// Every search in the essay's search box comes here. Within 5 minutes of Nova hiding on
// this browser, the return word reopens it; anything else, or any other time, gets the
// same empty answer. Inside an about:blank tab (public/essay/cloak.js) Safari ignores the
// 5-minute cookie, so there the session counts if Nova hid on that account in the last 5
// minutes (lock above). A session alone never opens Nova: that takes the word and Google.
export async function findReturn({ q, cookieHeader }) {
  await refreshApproved();
  const jar = readCookies(cookieHeader);
  const word = (process.env.NOVA_RETURN_WORD || "").trim().toLowerCase();
  const given = String(q || "").trim().toLowerCase().slice(0, 80);
  if (!same(given, word)) return { status: 200, body: {} };
  const live = await verify(jar[SESSION], "s");
  const db = await store();
  const id = (await verify(jar[RETURN], "r")) || (live && (await db.get(`hid:${live}`)) ? live : null);
  const email = emailOf(id);
  if (!email || (await blocked(email, live ? signedInAt(jar[SESSION]) : 0))) return { status: 200, body: {} };
  await db.delete(`hid:${id}`);
  return openNova(jar, email, [cookie(RETURN, "", 0)]);
}
