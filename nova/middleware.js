// Vercel Routing Middleware: runs before every request except the essay's and the proxy
// libraries' files, and turns away anything the visitor hasn't unlocked (see lib/gate.js).
import { next } from "@vercel/functions/middleware";
import { access, sendHome, siteCookies } from "./lib/gate.js";

export const config = {
  matcher: ["/((?!essay/|vendor/|scram/|controller/|sjutils/|epoxy/|libcurl/|uv/|baremux/|uv-epoxy/|uv-libcurl/|~/).*)"],
};

// vercel.json hands these to Pizza Edition's game host. Its copy of the request leaves out
// Nova's cookies, the referrer (which would show Nova's secret address) and Vercel's
// deployment-protection bypass.
const PIZZA_EDITION = /^\/(?:pe|scripts|reelleague)\//;

export default async function middleware(request) {
  const { pathname } = new URL(request.url);
  if (await access(pathname, siteCookies(request.headers))) {
    if (!PIZZA_EDITION.test(pathname)) return;
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    headers.delete("referer");
    headers.delete("x-vercel-protection-bypass");
    return next({ request: { headers } });
  }
  if (sendHome(request.headers.get("sec-fetch-dest"), request.headers.get("accept"), request.headers.get("sec-fetch-mode")))
    return new Response(null, { status: 302, headers: { Location: "/", "Cache-Control": "no-store" } });
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}
