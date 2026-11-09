import { suggest } from "../lib/api.js";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(await suggest(req.query.q)));
}
