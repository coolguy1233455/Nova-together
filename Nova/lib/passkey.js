// Passkeys: the way into Nova without Google. After the essay's right word, a phone or computer can
// ask to come in with a passkey (Face ID, Touch ID, Windows Hello or the device PIN). The private
// key never leaves that device, so there's nothing anyone could pass on to a friend: every new
// device is a new request, and nothing opens Nova until the admin approves that one device in the
// admin panel (with the PIN). The whole thing happens inside the essay's page, so the address bar
// never changes. lib/unlock.js wires these checks to /api/open; lib/members.js has the admin side.
// Web-standard APIs only (WebCrypto), like lib/gate.js.
import { b64url, unb64url } from "./gate.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

// The passkey belongs to the site's domain without "www.", so it works on both addresses.
export const rpIdOf = (origin) => {
  try {
    return new URL(origin).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

// The device table lives in Supabase behind public.nova_passkey() (db/passkeys.sql), which only
// answers this server (it checks NOVA_DB_KEY, like public.nova()).
export async function pkDb(op, a = {}) {
  const url = process.env.NOVA_DB_URL;
  const anon = process.env.NOVA_DB_ANON;
  const k = process.env.NOVA_DB_KEY;
  if (!url || !anon || !k) throw new Error("passkey: NOVA_DB_URL, NOVA_DB_ANON and NOVA_DB_KEY must be set");
  const r = await fetch(`${url}/rest/v1/rpc/${process.env.NOVA_DB_FN || "nova"}_passkey`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ k, op, a }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`passkey: ${op} failed (${r.status}) ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const bytes = (s) => {
  try {
    return unb64url(String(s || ""));
  } catch {
    return null;
  }
};
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));

// The browser's clientDataJSON: what kind of ceremony, the challenge (a signed token from
// lib/unlock.js, as text) and the page's origin. Null unless it is this site's own page.
export function clientData(b64, type, origin) {
  const raw = bytes(b64);
  if (!raw) return null;
  try {
    const cd = JSON.parse(dec.decode(raw));
    if (cd.type !== type || cd.origin !== origin) return null;
    // Inside the essay's about:blank tab the page is a frame of its own site; a frame on some
    // other site's page is turned away.
    if (cd.topOrigin && cd.topOrigin !== origin) return null;
    return { raw, challenge: dec.decode(unb64url(cd.challenge)) };
  } catch {
    return null;
  }
}

// authenticatorData: the site it was made for, and the flags: the person was there (UP) and
// proved it's them with Face ID, a fingerprint or the device PIN (UV). Both are required.
async function authData(b64, rpId) {
  const raw = bytes(b64);
  if (!raw || raw.length < 37) return null;
  if (!sameBytes(raw.slice(0, 32), await sha256(enc.encode(rpId)))) return null;
  const flags = raw[32];
  if (!(flags & 0x01) || !(flags & 0x04)) return null;
  const count = new DataView(raw.buffer, raw.byteOffset + 33, 4).getUint32(0);
  return { raw, flags, count };
}

const ALGS = {
  [-7]: { importAs: { name: "ECDSA", namedCurve: "P-256" }, verifyAs: { name: "ECDSA", hash: "SHA-256" } },
  [-8]: { importAs: { name: "Ed25519" }, verifyAs: { name: "Ed25519" } },
  [-257]: { importAs: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verifyAs: { name: "RSASSA-PKCS1-v1_5" } },
};
const importKey = (spki, alg) => crypto.subtle.importKey("spki", spki, ALGS[alg].importAs, false, ["verify"]);

// ECDSA signatures come from authenticators in DER; WebCrypto wants r and s side by side.
function derToRaw(der) {
  if (der[0] !== 0x30) return null;
  let i = 2;
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const part = () => {
    if (der[i] !== 0x02) return null;
    const len = der[i + 1];
    let v = der.slice(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) return null;
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = part();
  const s = part();
  if (!r || !s) return null;
  const out = new Uint8Array(64);
  out.set(r);
  out.set(s, 32);
  return out;
}

const cleanEmail = (v) => String(v || "").trim().toLowerCase();
export const okEmail = (e) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e) && e.length <= 120;
const oneLine = (v, max) => String(v || "").normalize("NFC").replace(/[\p{C}\s]+/gu, " ").trim().slice(0, max);

// A new passkey made on the essay (navigator.credentials.create). Returns what to store, or
// { error }. challengeOk(token) checks and uses up the signed challenge (lib/unlock.js).
export async function checkRegistration({ cred, origin, challengeOk }) {
  const rpId = rpIdOf(origin);
  const cd = clientData(cred?.clientDataJSON, "webauthn.create", origin);
  if (!cd || !(await challengeOk(cd.challenge))) return { error: "expired" };
  const ad = await authData(cred.authenticatorData, rpId);
  if (!ad || !(ad.flags & 0x40) || ad.raw.length < 55) return { error: "bad" };
  // The credential id inside authenticatorData must be the one the browser reported.
  const idLen = (ad.raw[53] << 8) | ad.raw[54];
  const id = bytes(cred.id);
  if (!id || id.length !== idLen || id.length > 1023 || !sameBytes(ad.raw.slice(55, 55 + idLen), id)) return { error: "bad" };
  const alg = Number(cred.alg);
  const spki = bytes(cred.publicKey);
  if (!ALGS[alg] || !spki || spki.length > 2048) return { error: "unsupported" };
  try {
    await importKey(spki, alg);
  } catch {
    return { error: "unsupported" };
  }
  const email = cleanEmail(cred.email);
  const name = oneLine(cred.name, 40);
  if (!okEmail(email)) return { error: "email" };
  if (!name) return { error: "name" };
  return { row: { id: b64url(id), email, name, device: oneLine(cred.device, 60), alg, spki: b64url(spki) } };
}

// A sign-in with a passkey (navigator.credentials.get), against the stored device row.
// Returns { count } when the signature is good, else null.
export async function checkAssertion({ cred, row, origin, challengeOk }) {
  const cd = clientData(cred?.clientDataJSON, "webauthn.get", origin);
  if (!cd || !(await challengeOk(cd.challenge))) return null;
  const ad = await authData(cred.authenticatorData, rpIdOf(origin));
  const sig = bytes(cred.signature);
  const spki = bytes(row?.spki);
  const alg = Number(row?.alg);
  if (!ad || !sig || !spki || !ALGS[alg]) return null;
  // A copied authenticator would show a count that went backwards (synced passkeys stay at 0).
  if (ad.count && Number(row.sign_count) && ad.count <= Number(row.sign_count)) return null;
  const signed = new Uint8Array(ad.raw.length + 32);
  signed.set(ad.raw);
  signed.set(await sha256(cd.raw), ad.raw.length);
  try {
    const key = await importKey(spki, alg);
    const s = alg === -7 ? derToRaw(sig) : sig;
    if (!s || !(await crypto.subtle.verify(ALGS[alg].verifyAs, key, s, signed))) return null;
  } catch {
    return null;
  }
  return { count: ad.count };
}
