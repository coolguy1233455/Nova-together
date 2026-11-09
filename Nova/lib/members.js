// Who is signed in, and what members share: the admin panel (names, bans, kicks, mutes,
// approved emails, stats), who is online, the chat and private chats. The data lives in Supabase
// behind one function, public.nova() (db/nova.sql), which only answers the site's server (it
// checks NOVA_DB_KEY). Used by api/members.js, lib/unlock.js and server.js.
import { createHmac } from "node:crypto";
import { SESSION, SESSION_SECONDS, OLD_SESSION_SECONDS, OLD_SESSIONS_END, verify, readCookies, cookie, b64url, unb64url } from "./gate.js";
import { mpToken, mpUrl } from "./mp-key.js";
import { pkDb } from "./passkey.js";

const list = (value) =>
  String(value || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
export const isAdmin = (email) => list(process.env.NOVA_ADMINS).includes(email);

// The allowed accounts: NOVA_EMAILS, plus the emails the admin approved in the admin panel,
// minus the ones removed there (nova_approved). The admins are always in. The panel's list
// is read again at most once a minute (refreshApproved).
// Until the list has been read once (a new server copy), an email that isn't in NOVA_EMAILS
// can't be told apart from a removed one, so members() answers "try again" instead of
// signing it out: one slow database answer used to throw panel-approved people out of Nova.
let approved = { at: 0, rows: [], loaded: false };
export function allowedEmails() {
  const added = approved.rows.filter((p) => !p.removed).map((p) => p.email);
  const removed = new Set(approved.rows.filter((p) => p.removed).map((p) => p.email));
  const admins = list(process.env.NOVA_ADMINS);
  return [...new Set([...admins, ...list(process.env.NOVA_EMAILS).filter((e) => !removed.has(e)), ...added])];
}
export async function refreshApproved(force = false) {
  if (!force && Date.now() - approved.at < 60000) return;
  try {
    approved = { at: Date.now(), rows: await db("approved"), loaded: true };
  } catch (err) {
    console.error(err);
    approved.at = Date.now() - 50000; // try again in 10 seconds
  }
}

// The session cookie's id is the account's email (base64url), so every request knows who
// it is. Anything else, or an account no longer allowed, counts as signed out.
export const idFor = (email) => b64url(new TextEncoder().encode(email));
export function emailOf(id) {
  try {
    const email = new TextDecoder("utf-8", { fatal: true }).decode(unb64url(String(id || "")));
    return allowedEmails().includes(email) ? email : null;
  } catch {
    return null;
  }
}
// When the session signed in, in Unix seconds: its token holds when it ends (lib/gate.js).
export const signedInAt = (token) => {
  const end = Number(String(token || "").split(".")[1]) || 0;
  return end ? end - (end * 1000 < OLD_SESSIONS_END ? OLD_SESSION_SECONDS : SESSION_SECONDS) : 0;
};

// Emails only ever reach the admin panel. Everywhere else a person is a made-up id (worked out
// from the email with NOVA_SECRET, so it can't be turned back), their username and their photo.
// Who the admin is stays there too: outside the panel the admin shows as a member like anyone,
// so only this account's own ping says it's an admin.
const uids = new Map();
export function uidOf(email) {
  if (!uids.has(email)) uids.set(email, createHmac("sha256", process.env.NOVA_SECRET || "").update(`nova member\n${email}`).digest("base64url").slice(0, 12));
  return uids.get(email);
}
export const emailOfUid = (id) => allowedEmails().find((email) => uidOf(email) === id) || null;

// What the admin panel calls an account without a username.
const displayName = (name, email) => name || String(email).split("@")[0];
// What everyone else sees: the username, or "Unknown user". An admin without one stays "bacon"
// (the name the chat always signed them with).
const UNKNOWN = "Unknown user";
const chatName = (name, email) => name || (isAdmin(email) ? "bacon" : UNKNOWN);
const photoOf = (email, version) => (Number(version) ? `/api/members?op=avatar&id=${uidOf(email)}&v=${version}` : null);
const person = (email, p) => ({ id: uidOf(email), name: chatName(p?.name, email), photo: photoOf(email, p?.avatar) });

// Usernames: one line, no @ (nobody can pose as an email), and not a name that means someone else.
const NAME_MAX = 20;
const RESERVED = ["unknown user", "admin", "bacon"];
const cleanName = (value) => String(value ?? "").normalize("NFC").replace(/[\p{C}\s]+/gu, " ").trim().slice(0, NAME_MAX);
const nameProblem = (name, viewerIsAdmin) =>
  name.includes("@") ? "a username can't have an @ in it" : RESERVED.includes(name.toLowerCase()) && !(viewerIsAdmin && name.toLowerCase() === "bacon") ? "that username is taken" : "";

// Every account's username and photo, for people who aren't online (leaderboards, chats).
let profiles = { at: 0, map: {} };
async function profileMap() {
  if (Date.now() - profiles.at > 30000) profiles = { at: Date.now(), map: await db("profiles") };
  return profiles.map;
}

export async function db(op, a = {}) {
  const url = process.env.NOVA_DB_URL;
  const anon = process.env.NOVA_DB_ANON;
  const k = process.env.NOVA_DB_KEY;
  if (!url || !anon || !k) throw new Error("members: NOVA_DB_URL, NOVA_DB_ANON and NOVA_DB_KEY must be set");
  const r = await fetch(`${url}/rest/v1/rpc/${process.env.NOVA_DB_FN || "nova"}`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ k, op, a }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`members: ${op} failed (${r.status}) ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// The essay word that starts the Google sign-in: { word, section }. Any time that word appears
// in that section of the essay, it works (lib/unlock.js openDoor). The admin sets it in the admin
// panel (Entrance word, with the PIN), which replaces the old one at once; until it's ever set,
// it's the word and section of NOVA_WORD ("word@section/paragraph/n"). Kept in its own small
// database function (db/settings.sql), read again at most every 20 seconds.
const cleanWord = (v) => String(v || "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 40);
const cleanSection = (v) => (/^[a-z0-9-]{1,40}$/.test(String(v || "")) ? String(v) : "");
function envEntrance() {
  const [word, at = ""] = String(process.env.NOVA_WORD || "").toLowerCase().split("@");
  return { word: cleanWord(word), section: cleanSection(at.split("/")[0]), from: "env" };
}
async function setting(key, val, by) {
  const url = process.env.NOVA_DB_URL;
  const anon = process.env.NOVA_DB_ANON;
  const k = process.env.NOVA_DB_KEY;
  if (!url || !anon || !k) throw new Error("members: NOVA_DB_URL, NOVA_DB_ANON and NOVA_DB_KEY must be set");
  const r = await fetch(`${url}/rest/v1/rpc/${process.env.NOVA_DB_FN || "nova"}_setting`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ k, key, val: val ?? null, by: by ?? null }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`members: setting ${key} failed (${r.status}) ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
let entranceCache = { at: 0, value: null };
export async function entrance() {
  if (!process.env.NOVA_DB_URL) return envEntrance();
  if (entranceCache.value && Date.now() - entranceCache.at < 20000) return entranceCache.value;
  try {
    const r = await setting("entrance");
    const v = r?.value?.word && r.value.section ? { word: cleanWord(r.value.word), section: cleanSection(r.value.section), from: "panel", at: r.at } : envEntrance();
    entranceCache = { at: Date.now(), value: v };
    return v;
  } catch (err) {
    console.error(err);
    // The database can't be reached: the last known word, or none at all (never the old one).
    return entranceCache.value || { word: "", section: "", from: "none" };
  }
}

// Why the account is shut out, or null: { banned } until the admin unbans it, { kickedUntil }
// while a kick for some days lasts, or { kicked } when the admin kicked it after this
// session signed in (signing in again lets it back).
// The admin's note on why, when they wrote one, comes along as reason.
function blockOf(s, iat = 0) {
  const why = (r) => (r ? { reason: r } : {});
  if (s?.banned) return { banned: true, ...why(s.banReason) };
  if (s?.until && Date.parse(s.until) > Date.now()) return { kickedUntil: s.until, ...why(s.kickReason) };
  if (iat && s?.kickedAt && Date.parse(s.kickedAt) > iat * 1000) return { kicked: true, ...why(s.kickReason) };
  return null;
}

// Someone the sign-in turned away asking to be let in (lib/unlock.js), with their note.
export async function requestAccess(email, message, reason) {
  await db("request", { email, message: String(message || "").slice(0, 500), reason });
}
// Their last request's answer, if the admin denied it: { denied, reply, at } or {}.
export async function requestReply(email) {
  try {
    return await db("request-reply", { email });
  } catch (err) {
    console.error(err);
    return {};
  }
}

// For the sign-in and the return word. If the database can't be reached the account is let
// in: Nova's ping checks again within seconds and shuts it out then.
export async function blocked(email, iat = 0) {
  try {
    return blockOf(await db("status", { email }), iat);
  } catch (err) {
    console.error(err);
    return null;
  }
}

const VIEWS = ["browser", "games", "multiplayer", "ai", "chat", "leaderboard", "admin"];

function onlineSummary(rows) {
  const online = (rows || []).filter((u) => allowedEmails().includes(u.email));
  const byView = {};
  for (const u of online) {
    const v = VIEWS.includes(u.view) ? u.view : "browser";
    byView[v] = (byView[v] || 0) + 1;
  }
  return { count: online.length, byView, people: online.map((u) => ({ ...person(u.email, u), view: u.view })) };
}

// An anonymous message (members chat only) carries nobody's name, id or photo, except for the
// person who sent it (mine). Only the admin can look up who sent one (op anon-who).
const ANON = "Anonymous";
function chatMessage(m, me) {
  const hide = !!m.anon && m.email !== me;
  return {
    id: m.id,
    rev: m.rev,
    room: m.room,
    anon: !!m.anon,
    from: hide ? ANON : chatName(m.name, m.email),
    uid: hide ? "anon" : uidOf(m.email),
    photo: hide ? null : photoOf(m.email, m.avatar),
    mine: m.email === me,
    body: m.deleted ? "" : m.body,
    deleted: m.deleted,
    image: m.deleted ? null : m.image || null,
    reply: m.reply ? { id: m.reply.id, from: m.reply.anon && m.reply.email !== me ? ANON : chatName(m.reply.name, m.reply.email), body: m.reply.body, image: !!m.reply.image } : null,
    likes: Number(m.likes) || 0,
    liked: !!m.liked,
    at: m.created_at,
  };
}

// A private chat as its members see it: who is in it, by username, who its host is, and what
// each member may do (the host may do everything; see nova() in db/nova.sql).
const PERMS = ["rename", "add", "remove", "priv"];
const roomOut = (r, map) => ({
  id: r.id,
  name: r.name,
  members: (r.members || []).map((email) => ({
    ...person(email, map[email]),
    host: email === r.owner,
    perms: email === r.owner ? [...PERMS, "delete"] : (Array.isArray(r.perms?.[email]) ? r.perms[email] : []).filter((p) => PERMS.includes(p)),
  })),
});

const SHARED = /^members$/;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"];
const BOARD_SECTIONS = ["games", "multiplayer", "ai", "browser", "chat", "leaderboard"];
const PRIVATE = /^p:\d{1,12}$/;

async function usersList() {
  const rows = new Map((await db("users")).map((u) => [u.email, u]));
  return allowedEmails().map((email) => {
    const u = rows.get(email) || {};
    const kicked = !!u.until && Date.parse(u.until) > Date.now();
    const muted = !!u.mutedUntil && Date.parse(u.mutedUntil) > Date.now();
    return {
      email,
      name: u.name || "",
      uid: uidOf(email),
      photo: photoOf(email, u.avatar),
      admin: isAdmin(email),
      online: !!u.online && !u.banned,
      lastSeen: u.lastSeen || null,
      joined: u.joined || null,
      banned: !!u.banned,
      kicked,
      kickedAt: u.kickedAt || null,
      until: kicked ? u.until : null,
      muted,
      mutedUntil: muted ? u.mutedUntil : null,
      mutedAll: muted && !!u.mutedAll,
      banReason: u.banned ? u.banReason || "" : "",
      kickReason: kicked ? u.kickReason || "" : "",
      muteReason: muted ? u.muteReason || "" : "",
    };
  });
}

const out = (status, body) => ({ status, body, cookies: [cookie(SESSION, "", 0)] });

// What a device keeps so that, without internet, the essay can still check the word and the
// email itself (public/js/offline.js, public/essay/essay.js): slow, salted hashes of the
// word's place and of this account's email, never the values. The salt comes from
// NOVA_SECRET, so changing either secret changes the hashes. Each is worked out once.
const OFFLINE_ROUNDS = 200000;
const offlineHashes = new Map();
function offlineHash(text) {
  const secret = process.env.NOVA_SECRET || "";
  const key = `${secret}\n${text}`;
  if (!offlineHashes.has(key))
    offlineHashes.set(
      key,
      (async () => {
        const enc = new TextEncoder();
        const mac = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const salt = new Uint8Array(await crypto.subtle.sign("HMAC", mac, enc.encode("nova offline salt"))).slice(0, 16);
        const base = await crypto.subtle.importKey("raw", enc.encode(text), "PBKDF2", false, ["deriveBits"]);
        const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: OFFLINE_ROUNDS }, base, 256);
        return { salt: b64url(salt), hash: b64url(bits) };
      })(),
    );
  return offlineHashes.get(key);
}

// The time, counts and PolyTrack records a ping carries (public/js/usage.js), trimmed to what
// the database keeps: seconds per section (and game), counts per kind, frames per track.
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const usageOf = (b) => ({
  usage: arr(b.usage, 40).map((x) => ({ s: String(x?.s || ""), i: String(x?.i || ""), sec: String(Math.round(Number(x?.sec) || 0)) })),
  counts: arr(b.counts, 40).map((x) => ({ k: String(x?.k || ""), i: String(x?.i || ""), n: String(Math.round(Number(x?.n) || 0)) })),
  poly: arr(b.poly, 80).map((x) => ({ t: String(x?.t || ""), f: String(Math.round(Number(x?.f) || 0)) })),
});

// Everyone:
// POST ?op=ping {view, since, usage, counts, poly}  presence, status, time and counts
//                                  (+ chat changes after rev, private chats)
// GET  ?op=offline                 the hashes this device keeps for opening Nova offline
// POST ?op=say {room, body, image, reply}  post ("p:<id>": its members only), with a photo
//                                  ({mime, data}) and the id it answers; refused while muted
// POST ?op=like {id}               like or unlike a message (not your own)
// GET  ?op=img&id=                 a photo from a chat you're in
// GET  ?op=history&room=           the last 300 messages of a room you're in
// GET  ?op=directory&q=            members whose username matches, for private chats
// POST ?op=room-new {name, members} · room-add {room, add} · room-leave {room}
// POST ?op=room-rename {room, name} · room-remove {room, who} · room-delete {room}
//      · room-perm {room, who, perm, on}  as the host, or with that power (people by id)
// GET  ?op=board                   the leaderboards: time on Nova, PolyTrack best times, multiplayer ratings
// POST ?op=del {id}                delete your own message (the admin: any in a chat they can read)
// POST ?op=del-mine                delete every message you ever sent (Settings › Chat messages)
// POST ?op=typing {room, stop, anon}  "is typing" in a chat
// GET  ?op=my-suggestions          your update requests and the admin's answers
// POST ?op=suggest {text}          an update request for the admin (the chat's Update requests box)
// GET  ?op=mp-token                a ticket for the multiplayer game server (lib/mp-key.js)
// POST ?op=profile {name, photo}   this account's username and photo (either can be left out)
// GET  ?op=avatar&id=&v=           someone's photo, as the picture itself
// POST ?op=favorites {list}        this account's favorite games
// Admins only (checked here, whatever the page shows):
// GET  ?op=users                   every allowed account
// POST ?op=set {email, field, value, all, reason}  name / banned / kick and mute (value = days;
//                                  all: mute in private chats too; reason: the admin's note,
//                                  shown to them) / unkick / unmute
// GET  ?op=approved · POST ?op=unapprove {email}  the approved emails
// POST ?op=approve {email, pin}    approve one, with the admin's PIN (NOVA_APPROVE_PIN)
// GET  ?op=entrance · POST ?op=entrance {section, word, pin}  the essay word that starts the
//                                  sign-in; changing it takes the PIN
// GET  ?op=requests · POST ?op=request-answer {who, approve, reply}  people asking to be let
//                                  in; a denial can carry a message they see next time
// GET  ?op=devices · POST ?op=device-answer {id, approve, pin} · POST ?op=device-remove {id}
//                                  passkey devices waiting for approval, approved or denied
// GET  ?op=suggestions · POST ?op=suggestion-del {id} · POST ?op=suggestion-answer {id, status}
//                                  members' update requests; approve / deny / back to waiting
// GET  ?op=anon-who&id=            who sent an anonymous members-chat message
// GET  ?op=stats&from=&who=        time and counts, everyone or one email
// GET  ?op=member&who=&from=       one member's totals and PolyTrack times
export async function members({ method, query = {}, body = {}, cookieHeader, origin }) {
  await refreshApproved();
  const jar = readCookies(cookieHeader);
  const token = jar[SESSION];
  const id = await verify(token, "s");
  const me = emailOf(id);
  if (!me) {
    // Not sure yet (the approved list never loaded on this server copy): ask again soon.
    if (id && !approved.loaded) return { status: 503, body: { error: "try again" } };
    return out(401, { out: "signin" });
  }
  const iat = signedInAt(token);
  const admin = isAdmin(me);
  const op = String(query.op || "");
  const post = method === "POST";
  const ok = (b) => ({ status: 200, body: b });
  const bad = (error) => ({ status: 400, body: { error } });
  const deny = { status: 403, body: { error: "admins only" } };
  const shutOut = () => out(403, { out: "kicked" });
  const who = String(query.who || body.who || "").toLowerCase();
  const as = (a = {}) => ({ email: me, iat, ...a });

  try {
    if (op === "ping") {
      const src = post ? body : query;
      const a = as({ view: VIEWS.includes(src.view) ? src.view : "browser", ...(post ? usageOf(body) : {}) });
      if (src.since !== undefined && src.since !== null) a.since = Math.max(0, parseInt(src.since, 10) || 0);
      const r = await db("ping", a);
      const block = blockOf(r, iat);
      if (block) return out(403, { out: block.banned ? "banned" : "kicked", ...block });
      const map = r.rooms?.length ? await profileMap() : {};
      const res = {
        me: {
          ...person(me, r),
          admin,
          email: me,
          named: !!r.name,
          done: !!r.done,
          favorites: r.favorites || [],
          muted: r.mutedUntil ? { until: r.mutedUntil, all: !!r.mutedAll, reason: r.muteReason || "" } : null,
        },
        online: onlineSummary(r.online),
        rooms: (r.rooms || []).map((x) => roomOut(x, map)),
        // Who is writing right now in a chat this account can read (anonymous ones by no name).
        typing: (r.typing || [])
          .filter((t) => allowedEmails().includes(t.email))
          .map((t) => (t.anon ? { room: t.room, anon: true, name: "Someone" } : { room: t.room, ...person(t.email, t) })),
      };
      if (r.chat) res.chat = { rev: r.chat.rev, messages: r.chat.messages.map((m) => chatMessage(m, me)) };
      return ok(res);
    }

    if (op === "offline") {
      const block = blockOf(await db("status", { email: me }), iat);
      if (block) return out(403, { out: block.banned ? "banned" : "kicked", ...block });
      const e = await entrance();
      const word = await offlineHash(`${e.word}@${e.section}`);
      const email = await offlineHash(me);
      return ok({ salt: word.salt, rounds: OFFLINE_ROUNDS, word: word.hash, email: email.hash, admin });
    }

    if (op === "say" && post) {
      const room = String(body.room || "members");
      if (!SHARED.test(room) && !PRIVATE.test(room)) return bad("unknown room");
      const text = String(body.body || "").trim().slice(0, 1000);
      const img = body.image && typeof body.image === "object" ? body.image : null;
      const image =
        img && IMAGE_TYPES.includes(img.mime) && typeof img.data === "string" && /^[A-Za-z0-9+/]+=*$/.test(img.data) && img.data.length <= 1500000
          ? { mime: img.mime, data: img.data }
          : null;
      if (img && !image) return bad("that photo is too big or not a picture");
      if (!text && !image) return bad("empty");
      const reply = parseInt(body.reply, 10) || 0;
      const anon = !!body.anon && room === "members";
      const m = await db("say", as({ room, body: text, ...(image ? { image } : {}), ...(reply ? { reply: String(reply) } : {}), ...(anon ? { anon: "true" } : {}) }));
      if (m.blocked) return shutOut();
      if (m.muted) return { status: 403, body: { error: "you're muted", muted: { until: m.until, all: !!m.all, reason: m.reason || "" } } };
      if (m.empty) return bad("empty");
      if (m.denied) return { status: 403, body: { error: "not in that chat" } };
      return ok({ message: chatMessage(m, me) });
    }

    if (op === "like" && post) {
      const m = await db("like", as({ id: parseInt(body.id, 10) || 0 }));
      if (m.ok === false) return bad("you can't like your own message");
      return ok({ message: chatMessage(m, me) });
    }

    if (op === "img") {
      const r = await db("img", as({ id: String(parseInt(query.id, 10) || 0) }));
      if (r.denied) return { status: 404, body: { error: "no such photo" } };
      return { status: 200, body: r, cache: "private, max-age=31536000, immutable" };
    }

    if (op === "history") {
      const room = String(query.room || "");
      if (!SHARED.test(room) && !PRIVATE.test(room)) return bad("unknown room");
      const rows = await db("history", as({ room }));
      if (rows.denied) return { status: 403, body: { error: "not in that chat" } };
      return ok({ messages: rows.map((m) => chatMessage(m, me)) });
    }

    if (op === "directory") {
      const q = String(query.q || "").trim().toLowerCase().slice(0, 60);
      const map = await profileMap();
      const people = allowedEmails()
        .filter((email) => email !== me)
        .map((email) => person(email, map[email]))
        .filter((p) => q && p.name.toLowerCase().includes(q))
        .slice(0, 8);
      return ok({ people });
    }

    if (op === "room-new" && post) {
      const people = arr(body.members, 50).map((id) => emailOfUid(String(id))).filter((e) => e && e !== me);
      if (!people.length) return bad("add at least one member");
      const name = String(body.name || "").trim().slice(0, 40) || "Private chat";
      const r = await db("room-new", as({ name, members: people }));
      if (r.blocked) return shutOut();
      return ok({ room: r.id });
    }

    if (op === "room-add" && post) {
      const room = String(body.room || "");
      if (!PRIVATE.test(room)) return bad("unknown room");
      const add = arr(body.add, 50).map((id) => emailOfUid(String(id))).filter(Boolean);
      const r = await db("room-add", as({ room, add }));
      if (r.blocked) return shutOut();
      return r.ok ? ok({ ok: true }) : { status: 403, body: { error: "not in that chat" } };
    }

    if (op === "room-leave" && post) {
      const room = String(body.room || "");
      if (!PRIVATE.test(room)) return bad("unknown room");
      await db("room-leave", as({ room }));
      return ok({ ok: true });
    }

    if (["room-rename", "room-remove", "room-delete", "room-perm"].includes(op) && post) {
      const room = String(body.room || "");
      if (!PRIVATE.test(room)) return bad("unknown room");
      const a = { room, who: emailOfUid(String(body.who)) || "" };
      if (op === "room-rename") a.name = String(body.name || "").trim().slice(0, 40);
      if (op === "room-perm") {
        if (!PERMS.includes(body.perm)) return bad("unknown power");
        a.perm = body.perm;
        a.on = String(!!body.on);
      }
      const r = await db(op, as(a));
      if (r.blocked) return shutOut();
      return r.ok ? ok({ ok: true }) : { status: 403, body: { error: "only the host (or someone they gave that power) can do that" } };
    }

    // The leaderboards (public/js/leaderboard.js): everyone's time on Nova, all time, and best
    // PolyTrack times, by username and photo.
    if (op === "board") {
      const [stats, poly, rated, map] = await Promise.all([db("stats", { from: "" }), db("poly"), db("mp-ratings"), profileMap()]);
      const allowed = allowedEmails();
      const who = (email) => ({ ...person(email, map[email]), me: email === me });
      const time = new Map(allowed.map((email) => [email, { ...who(email), games: 0, multiplayer: 0, ai: 0, browser: 0, chat: 0, leaderboard: 0, total: 0 }]));
      for (const p of stats.people) {
        const r = time.get(p.email);
        if (!r || !BOARD_SECTIONS.includes(p.section)) continue;
        r[p.section] += Number(p.seconds) || 0;
        r.total += Number(p.seconds) || 0;
      }
      return ok({
        time: [...time.values()],
        poly: poly.filter((p) => allowed.includes(p.email)).map((p) => ({ ...who(p.email), track: p.track, frames: p.frames, at: p.at })),
        mp: rated.filter((r) => allowed.includes(r.email)).map((r) => ({ ...who(r.email), game: r.game, elo: r.elo, games: r.games, wins: r.wins })),
      });
    }

    // The profile box (public/js/profile.js). Leaving the name out keeps it, so skipping the
    // first-time popup only marks it as seen.
    if (op === "profile" && post) {
      const a = as();
      if (body.name !== undefined) {
        a.name = cleanName(body.name);
        const problem = nameProblem(a.name, admin);
        if (problem) return bad(problem);
      }
      if (body.photo === null) a.photo = null;
      else if (body.photo !== undefined) {
        const p = body.photo;
        if (!AVATAR_TYPES.includes(p?.mime) || typeof p?.data !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(p.data) || p.data.length > 400000) return bad("that photo is too big or not a picture");
        a.photo = { mime: p.mime, data: p.data };
      }
      const r = await db("profile", a);
      if (r.blocked) return shutOut();
      if (r.taken) return { status: 409, body: { error: "that username is taken" } };
      profiles.at = 0;
      return ok({ me: { ...person(me, r), admin, named: !!r.name, done: true } });
    }

    if (op === "avatar") {
      const email = emailOfUid(String(query.id || ""));
      const r = email ? await db("avatar", { who: email }) : {};
      if (!AVATAR_TYPES.includes(r.mime)) return { status: 404, body: { error: "no such photo" } };
      return { status: 200, raw: Buffer.from(r.data, "base64"), type: r.mime, cache: "private, max-age=31536000, immutable" };
    }

    if (op === "favorites" && post) {
      const slugs = arr(body.list, 500).map(String).filter((slug) => /^[a-z0-9-]{1,40}$/.test(slug));
      const r = await db("favorites", as({ list: [...new Set(slugs)] }));
      if (r.blocked) return shutOut();
      return ok({ ok: true });
    }

    // "Is typing": the page says so while someone writes (every few seconds), and stop: true
    // when they send or empty the box.
    if (op === "typing" && post) {
      const room = String(body.room || "");
      if (!SHARED.test(room) && !PRIVATE.test(room)) return bad("unknown room");
      await db("typing", as({ room, stop: String(!!body.stop), anon: String(!!body.anon && room === "members") }));
      return ok({ ok: true });
    }

    // This account's own update requests, with the admin's answer (approved / denied / new).
    if (op === "my-suggestions") {
      const rows = await db("my-suggestions", as());
      return ok({ suggestions: rows });
    }

    // Deleting a message: anyone their own, in any chat they're in; the admin anyone's there too.
    if (op === "del" && post) {
      const r = await db("del", as({ id: parseInt(body.id, 10) || 0, admin: String(admin) }));
      return r.ok ? ok({ ok: true }) : { status: 404, body: { error: "message not found" } };
    }

    // Settings › Chat messages: every message this account ever sent goes, in every chat.
    if (op === "del-mine" && post) {
      const r = await db("del-mine", as());
      return ok({ ok: true, deleted: r.deleted || 0 });
    }

    // The chat's Update requests box: a suggestion only the admin reads.
    if (op === "suggest" && post) {
      const text = String(body.text || "").trim().slice(0, 2000);
      if (!text) return bad("Write your request first.");
      const r = await db("suggest", as({ body: text }));
      if (r.denied) return shutOut();
      if (r.tooMany) return { status: 429, body: { error: "That's a lot of requests for one day. Try again tomorrow." } };
      return ok({ ok: true });
    }

    // A ticket to Nova's multiplayer games (lib/mp-key.js), and where to use it.
    if (op === "mp-token") {
      const block = blockOf(await db("status", { email: me }), iat);
      if (block) return out(403, { out: block.banned ? "banned" : "kicked", ...block });
      const p = person(me, (await profileMap())[me]);
      return ok({ token: mpToken({ ...p, adm: admin }), url: `${mpUrl().replace(/^http/, "ws")}/mp` });
    }

    /* ---------------- admins only from here */
    if (!admin) return op ? deny : { status: 404, body: { error: "unknown op" } };

    if (op === "users") return ok({ count: allowedEmails().length, users: await usersList() });

    if (op === "set" && post) {
      const email = String(body.email || "").toLowerCase();
      const field = String(body.field || "");
      if (!allowedEmails().includes(email)) return { status: 404, body: { error: "unknown account" } };
      if (!["name", "banned", "kick", "unkick", "mute", "unmute"].includes(field)) return bad("unknown field");
      if (isAdmin(email) && ["banned", "kick", "mute"].includes(field)) return bad("the admin can't be banned, kicked or muted");
      let value = body.value;
      if (field === "banned") value = !!value;
      if (field === "kick" || field === "mute") {
        value = Number(value);
        if (!Number.isInteger(value) || value < 1 || value > 3650) return bad("enter a number of days from 1 to 3650");
      }
      if (field === "name") {
        value = cleanName(value);
        const problem = nameProblem(value, isAdmin(email));
        if (problem) return bad(problem);
      }
      const reason = ["banned", "kick", "mute"].includes(field) && value ? String(body.reason || "").replace(/\s+/g, " ").trim().slice(0, 300) : "";
      const r = await db("set", { email, field, value, reason, ...(field === "mute" ? { all: !!body.all } : {}) });
      if (r.taken) return { status: 409, body: { error: "that username is taken" } };
      profiles.at = 0;
      return ok({ users: await usersList() });
    }

    if (op === "approved") {
      const env = list(process.env.NOVA_EMAILS);
      const rows = new Map(approved.rows.map((p) => [p.email, p]));
      const emails = allowedEmails()
        .map((email) => {
          const p = rows.get(email);
          return { email, admin: isAdmin(email), from: p && !p.removed ? "panel" : env.includes(email) ? "env" : "admin", at: p && !p.removed ? p.at : null };
        })
        .sort((x, y) => x.email.localeCompare(y.email));
      return ok({ emails });
    }

    if (op === "unapprove" && post) {
      const email = String(body.email || "").toLowerCase();
      if (isAdmin(email)) return bad("the admin can't be removed");
      if (!allowedEmails().includes(email)) return { status: 404, body: { error: "that email isn't approved" } };
      await db("unapprove", { email: me, remove: email });
      await refreshApproved(true);
      return ok({ ok: true });
    }

    // Approving an email takes the admin's PIN (NOVA_APPROVE_PIN), checked here, never in the page.
    if (op === "approve" && post) {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email) || email.length > 120) return bad("enter a full email address");
      if (allowedEmails().includes(email)) return bad("that email is already approved");
      const pin = String(process.env.NOVA_APPROVE_PIN || "");
      if (!pin || String(body.pin || "") !== pin) return { status: 403, body: { error: "wrong PIN" } };
      await approveEmail(email, me);
      await db("request-done", { who: email }).catch(() => {});
      return ok({ ok: true });
    }

    // The entrance word (see entrance above). Changing it takes the same PIN as approving.
    if (op === "entrance") {
      if (!post) return ok(await entrance());
      const pin = String(process.env.NOVA_APPROVE_PIN || "");
      if (!pin || String(body.pin || "") !== pin) return { status: 403, body: { error: "wrong PIN" } };
      const word = cleanWord(body.word);
      const section = cleanSection(body.section);
      if (word.length < 2) return bad("enter a word of at least 2 letters");
      if (!section) return bad("pick a section");
      const r = await setting("entrance", { word, section }, me);
      entranceCache = { at: Date.now(), value: { word, section, from: "panel", at: r?.at } };
      return ok(entranceCache.value);
    }

    if (op === "requests") {
      const rows = await db("requests");
      return ok({ requests: rows.map((q) => ({ ...q, approved: allowedEmails().includes(q.email) })) });
    }

    // Approving a request lets that email in: added to the approved emails if it isn't, and
    // unbanned and let back in if it was banned or kicked. Denying takes it off the list and
    // keeps the admin's message (if any), which that person sees the next time the sign-in
    // turns them away (lib/unlock.js), until they ask again.
    if (op === "request-answer" && post) {
      if (!who) return bad("unknown request");
      if (body.approve) {
        if (!allowedEmails().includes(who)) await approveEmail(who, me);
        const s = await db("status", { email: who });
        if (s.banned) await db("set", { email: who, field: "banned", value: false });
        if (s.kickedAt) await db("set", { email: who, field: "unkick" });
        await db("request-done", { who });
      } else await db("request-deny", { who, reply: String(body.reply || "").trim().slice(0, 500) });
      return ok({ ok: true });
    }

    // Passkey devices (lib/passkey.js): phones and computers that asked to come in with a passkey
    // from the essay. Approving one takes the PIN, and also approves its email if it isn't yet.
    // Removing one locks that device out for good (it would have to ask again).
    if (op === "devices") return ok({ devices: (await pkDb("list")).map((d) => ({ ...d, member: allowedEmails().includes(d.email), admin: isAdmin(d.email) })) });
    if (op === "device-answer" && post) {
      const id = String(body.id || "");
      if (!id) return bad("unknown device");
      if (!body.approve && isAdmin((await pkDb("get", { id }))?.email)) return bad("the admin's own devices can't be denied");
      if (body.approve) {
        const pin = String(process.env.NOVA_APPROVE_PIN || "");
        if (!pin || String(body.pin || "") !== pin) return { status: 403, body: { error: "wrong PIN" } };
        const d = await pkDb("get", { id });
        if (!d?.id) return { status: 404, body: { error: "that device is gone" } };
        if (!allowedEmails().includes(d.email)) await approveEmail(d.email, me);
      }
      const r = await pkDb("answer", { id, status: body.approve ? "approved" : "denied", by: me });
      return r.ok ? ok({ ok: true }) : { status: 404, body: { error: "that device is gone" } };
    }
    if (op === "device-remove" && post) {
      if (isAdmin((await pkDb("get", { id: String(body.id || "") }))?.email)) return bad("the admin's own devices can't be removed");
      const r = await pkDb("remove", { id: String(body.id || "") });
      return r.ok ? ok({ ok: true }) : { status: 404, body: { error: "that device is gone" } };
    }

    // Update requests from the members (the chat's Update requests box).
    if (op === "suggestions") {
      const [rows, map] = await Promise.all([db("suggestions"), profileMap()]);
      return ok({ suggestions: rows.map((s) => ({ id: s.id, email: s.email, name: displayName(s.name, s.email), uid: uidOf(s.email), photo: photoOf(s.email, map[s.email]?.avatar), body: s.body, at: s.at, status: s.status || "new" })) });
    }
    if (op === "suggestion-answer" && post) {
      const status = String(body.status || "");
      if (!["approved", "denied", "new"].includes(status)) return bad("unknown answer");
      const r = await db("suggestion-answer", { id: String(parseInt(body.id, 10) || ""), status });
      return r.ok ? ok({ ok: true }) : { status: 404, body: { error: "Already gone." } };
    }

    // Who sent an anonymous message in the members chat: the admin only (the page asks while
    // the admin panel is open).
    if (op === "anon-who") {
      const r = await db("msg-who", { id: String(parseInt(query.id || body.id, 10) || "") });
      if (!r.email) return { status: 404, body: { error: "not an anonymous message" } };
      const map = await profileMap();
      return ok({ name: displayName(r.name, r.email), email: r.email, photo: photoOf(r.email, map[r.email]?.avatar), uid: uidOf(r.email) });
    }

    if (op === "suggestion-del" && post) {
      const r = await db("suggestion-del", { id: String(parseInt(body.id, 10) || "") });
      return r.ok ? ok({ ok: true }) : { status: 404, body: { error: "Already gone." } };
    }

    if (op === "stats") {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(query.from || "")) ? query.from : "";
      const [stats, map] = await Promise.all([db("stats", { from, who }), profileMap()]);
      return ok({ stats, people: peopleList(map) });
    }

    if (op === "member") {
      if (!allowedEmails().includes(who)) return { status: 404, body: { error: "unknown account" } };
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(query.from || "")) ? query.from : "";
      const [m, users] = await Promise.all([db("member", { who, from }), usersList()]);
      return ok({ user: users.find((u) => u.email === who), poly: m.poly, stats: m.stats });
    }

  } catch (err) {
    console.error(err);
    return { status: 502, body: { error: "members database unavailable" } };
  }
  return { status: 404, body: { error: "unknown op" } };
}

// Every allowed account with the name the admin panel shows for it.
const peopleList = (map) => allowedEmails().map((email) => ({ email, name: displayName(map[email]?.name, email), admin: isAdmin(email) }));

// Add an email to the allowed accounts (the admin panel, with the PIN, or a request).
export async function approveEmail(email, by) {
  await db("approve", { email: by, add: email });
  await refreshApproved(true);
}
