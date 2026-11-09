// The site's multiplayer key. Nova's multiplayer games run on a separate server (the
// nova-wisp service on Render, mp/ in its repo), which has no secrets: members prove who they
// are there with a token this site signs (Ed25519), and the game server checks it with this
// site's public key (GET /api/mp?op=key). The key is worked out from NOVA_SECRET, so it needs
// no setting of its own and changes with it.
import { createHmac, createPrivateKey, createPublicKey, sign } from "node:crypto";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
let cache = null;
function keys() {
  const secret = process.env.NOVA_SECRET || "";
  if (cache?.secret !== secret) {
    const seed = createHmac("sha256", secret).update("nova multiplayer key").digest();
    const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
    const pub = createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(12).toString("base64url");
    cache = { secret, priv, pub };
  }
  return cache;
}

export const mpPublicKey = () => keys().pub;

// Which Nova this is, to the game server: people from different sites never play together.
export const mpSite = () => process.env.NOVA_MP_SITE || (process.env.NOVA_DB_FN === "mf" ? "mf" : "brez");

// Where the game server is, for the page (wss) and for checking what it sends (https).
export const mpUrl = () => (process.env.NOVA_MP_URL || "https://nova-wisp.onrender.com").replace(/\/+$/, "");

// A member's ticket to the game server, good for 12 hours: who they are, as everyone else sees them.
export function mpToken(person) {
  const payload = { v: 1, site: mpSite(), uid: person.id, name: person.name, photo: person.photo, adm: !!person.adm, exp: Math.floor(Date.now() / 1000) + 12 * 3600 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(null, Buffer.from(body), keys().priv).toString("base64url")}`;
}
