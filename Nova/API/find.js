import { findReturn } from "../lib/unlock.js";
import { siteCookies } from "../lib/gate.js";

// The essay's search box (see lib/unlock.js findReturn).
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const r = await findReturn({ q: req.body?.q, cookieHeader: siteCookies(req.headers) });
  if (r.cookies) res.setHeader("Set-Cookie", r.cookies);
  res.setHeader("Cache-Control", "no-store");
  res.status(r.status).json(r.body);
}
