import { logClientError } from "../lib/api.js";

export default function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  logClientError(req.body, req.headers["user-agent"]);
  res.status(204).end();
}
