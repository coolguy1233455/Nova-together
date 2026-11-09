import { image } from "../lib/api.js";

export default async function handler(req, res) {
  try {
    const img = await image(req.query);
    if (!img) return res.status(400).end();
    res.setHeader("Cache-Control", "public, max-age=604800");
    res.setHeader("Content-Type", img.type);
    res.end(img.body);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
}
