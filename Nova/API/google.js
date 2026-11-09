import { googleDone, googleReturnPage, requestDone } from "../lib/unlock.js";
import { siteCookies } from "../lib/gate.js";

// GET: the page Google sends the browser back to. POST: that page handing over the sign-in,
// or a turned-away account asking to be let in.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return res.setHeader("Content-Type", "text/html; charset=utf-8").status(200).send(googleReturnPage);
  if (req.method !== "POST") return res.status(405).end();
  const r = req.body?.request
    ? await requestDone({ request: req.body.request, message: req.body.message })
    : await googleDone({ idToken: req.body?.idToken, state: req.body?.state, cookieHeader: siteCookies(req.headers) });
  if (r.cookies) res.setHeader("Set-Cookie", r.cookies);
  res.status(r.status).json(r.body);
}
