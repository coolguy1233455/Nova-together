import { favicon } from "../lib/api.js";

export default async function handler(req, res) {
  const hit = await favicon(req.query.domain);
  if (!hit) return res.status(400).end();
  res.setHeader("Cache-Control", "public, max-age=86400");
  if (!hit.body) return res.status(404).end();
  res.setHeader("Content-Type", hit.type);
  res.end(hit.body);
}
