import { aiKind, visionKind } from "../lib/api.js";

export default function handler(req, res) {
  res.json({ ok: true, ai: visionKind === "gemini" ? "gemini" : aiKind, vision: visionKind || "browser", wisp: process.env.WISP_URL ? "external" : "none" });
}
