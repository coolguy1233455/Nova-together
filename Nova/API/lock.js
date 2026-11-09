import { lock } from "../lib/unlock.js";
import { siteCookies } from "../lib/gate.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const r = await lock({ cookieHeader: siteCookies(req.headers) });
  res.setHeader("Set-Cookie", r.cookies);
  res.status(r.status).end();
}
