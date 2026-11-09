// Request preferences added to every proxied request, shared by both proxy engines.
// Proxied requests carry no Accept-Language of their own, so sites guess a language from
// the tunnel server's location (YouTube picks Russian for it). Ask for English everywhere,
// and pin YouTube's own preference cookie to English / United States.
const LANGUAGE = "en-US,en;q=0.9";
const isYouTube = (host) => /(^|\.)youtube(-nocookie)?\.com$/i.test(host);

// Set hl=en and gl=US inside YouTube's PREF cookie, keeping its other settings.
function youtubeCookie(cookie) {
  const parts = cookie ? cookie.split(/;\s*/).filter(Boolean) : [];
  const i = parts.findIndex((p) => p.startsWith("PREF="));
  const prefs = new URLSearchParams(i < 0 ? "" : parts[i].slice(5));
  prefs.set("hl", "en");
  prefs.set("gl", "US");
  const pref = "PREF=" + prefs.toString();
  if (i < 0) parts.push(pref);
  else parts[i] = pref;
  return parts.join("; ");
}

// headers: [[name, value]] (Scramjet 2) or { name: value } (Ultraviolet / bare-mux).
export function withPreferences(remote, headers) {
  const youtube = isYouTube(new URL(remote).hostname);
  if (Array.isArray(headers)) {
    const out = headers.filter(([name]) => !(youtube && String(name).toLowerCase() === "cookie"));
    if (!out.some(([name]) => String(name).toLowerCase() === "accept-language")) out.push(["Accept-Language", LANGUAGE]);
    if (youtube) {
      const cookies = headers.filter(([name]) => String(name).toLowerCase() === "cookie").map(([, v]) => v);
      out.push(["Cookie", youtubeCookie(cookies.join("; "))]);
    }
    return out;
  }
  const out = { ...(headers || {}) };
  const key = (n) => Object.keys(out).find((k) => k.toLowerCase() === n);
  if (!key("accept-language")) out["Accept-Language"] = LANGUAGE;
  if (youtube) {
    const k = key("cookie");
    const current = k ? [].concat(out[k]).join("; ") : "";
    if (k) delete out[k];
    out.Cookie = youtubeCookie(current);
  }
  return out;
}
