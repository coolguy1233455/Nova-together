// What Nova's game server keeps on this site (see lib/mp-key.js): ratings, ranked results and
// the public World Empire world. The game server signs each call with a key it makes at every
// start; this file checks the signature against the key the game server itself publishes
// (GET <game server>/mp/key, over https), so only that server can write here. Used by
// api/mp.js and server.js. Players are named by their made-up ids (lib/members.js uidOf),
// turned back into emails here, since every table is keyed by email.
import { createPublicKey, verify } from "node:crypto";
import { mpPublicKey, mpSite, mpUrl } from "./mp-key.js";
import { db, emailOfUid, uidOf, refreshApproved } from "./members.js";

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
let serverKey = { at: 0, raw: "", key: null };
async function gameServerKey(fresh) {
  if (!fresh && serverKey.key && Date.now() - serverKey.at < 600_000) return serverKey.key;
  const r = await fetch(`${mpUrl()}/mp/key`, { signal: AbortSignal.timeout(8000) });
  const { key } = await r.json();
  if (key !== serverKey.raw) serverKey = { at: Date.now(), raw: key, key: createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(key, "base64url")]), format: "der", type: "spki" }) };
  else serverKey.at = Date.now();
  return serverKey.key;
}

async function signedByGameServer({ op, ts, data, sig }) {
  if (typeof data !== "string" || typeof sig !== "string" || Math.abs(Date.now() - Number(ts)) > 5 * 60_000) return false;
  const msg = Buffer.from(`${op}.${ts}.${data}`);
  for (const fresh of [false, true]) {
    try {
      if (verify(null, msg, await gameServerKey(fresh), Buffer.from(sig, "base64url"))) return true;
    } catch {
      return false;
    }
  }
  return false;
}

const GAME_KEY = /^[a-z0-9-]{1,30}(?::[a-z0-9-]{1,30})?$/;
const WORLD_ID = /^[a-z0-9-]{1,40}$/;

// GET ?op=key: this site's public key. POST {op, ts, data, sig}: the game server's calls:
// ratings, result {match, game, players: [{uid, elo, games, wins}]}, world-get {id},
// world-put {id, data}.
export async function mpApi({ method, query = {}, body = {} }) {
  if (method === "GET" && query.op === "key") return { status: 200, body: { site: mpSite(), key: mpPublicKey() }, cache: "public, max-age=300" };
  if (method !== "POST" || !(await signedByGameServer(body))) return { status: 403, body: { error: "denied" } };
  let data;
  try {
    data = JSON.parse(body.data);
  } catch {
    return { status: 400, body: { error: "bad data" } };
  }
  await refreshApproved();
  try {
    if (body.op === "ratings") {
      const rows = await db("mp-ratings");
      return { status: 200, body: { ratings: rows.map((r) => ({ uid: uidOf(r.email), game: r.game, elo: r.elo, games: r.games, wins: r.wins })) } };
    }
    if (body.op === "result") {
      if (!GAME_KEY.test(String(data.game)) || !Array.isArray(data.players)) return { status: 400, body: { error: "bad result" } };
      const players = data.players
        .slice(0, 40)
        .map((p) => ({ email: emailOfUid(String(p.uid)), elo: Math.max(0, Math.round(Number(p.elo) || 0)), games: Math.round(Number(p.games) || 0), wins: Math.round(Number(p.wins) || 0), won: !!p.won, delta: Math.round(Number(p.delta) || 0) }))
        .filter((p) => p.email);
      await db("mp-result", { match: String(data.match || "").slice(0, 60), game: data.game, players });
      return { status: 200, body: { ok: true } };
    }
    if (body.op === "world-get") {
      if (!WORLD_ID.test(String(data.id))) return { status: 400, body: { error: "bad id" } };
      return { status: 200, body: await db("mp-world-get", { id: data.id }) };
    }
    if (body.op === "world-put") {
      if (!WORLD_ID.test(String(data.id)) || typeof data.data !== "string" || data.data.length > 6_000_000) return { status: 400, body: { error: "bad world" } };
      await db("mp-world-put", { id: data.id, data: data.data });
      return { status: 200, body: { ok: true } };
    }
  } catch (err) {
    console.error(err);
    return { status: 502, body: { error: "database unavailable" } };
  }
  return { status: 404, body: { error: "unknown op" } };
}
