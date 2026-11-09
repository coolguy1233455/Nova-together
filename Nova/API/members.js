import { members } from "../lib/members.js";
import { siteCookies } from "../lib/gate.js";

// Presence, the members' chat and the admin panel (see lib/members.js).
export default async function handler(req, res) {
  const r = await members({ method: req.method, query: req.query, body: req.body || {}, cookieHeader: siteCookies(req.headers), origin: `https://${req.headers["x-forwarded-host"] || req.headers.host}` });
  if (r.cookies) res.setHeader("Set-Cookie", r.cookies);
  res.setHeader("Cache-Control", r.cache || "no-store");
  if (r.raw) {
    res.setHeader("Content-Type", r.type);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(r.status).end(r.raw);
  }
  res.status(r.status).json(r.body);
}
