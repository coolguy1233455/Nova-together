import { mpApi } from "../lib/mp.js";

// Nova's game server keeping ratings, results and worlds here (see lib/mp.js). Public: every
// write is checked against the game server's own signature, not a cookie.
export default async function handler(req, res) {
  const r = await mpApi({ method: req.method, query: req.query, body: req.body || {} });
  res.setHeader("Cache-Control", r.cache || "no-store");
  res.status(r.status).json(r.body);
}
