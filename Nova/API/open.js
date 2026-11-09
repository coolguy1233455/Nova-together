import { openDoor } from "../lib/unlock.js";
import { siteCookies } from "../lib/gate.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const r = await openDoor({
    word: req.body?.word,
    at: req.body?.at,
    check: req.body?.check,
    claimed: req.body?.claimed,
    passkey: req.body?.passkey,
    ip: req.headers["x-forwarded-for"],
    cookieHeader: siteCookies(req.headers),
    origin: `https://${req.headers["x-forwarded-host"] || req.headers.host}`,
  });
  if (r.cookies) res.setHeader("Set-Cookie", r.cookies);
  res.setHeader("Cache-Control", "no-store");
  res.status(r.status).json(r.body);
}
