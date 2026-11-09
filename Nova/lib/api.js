// Shared API logic used by both server.js (Node/Docker hosts) and api/*.js (Vercel functions).
import "./env.js";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { SSE_HEADERS, SYSTEM_PROMPT, chatHistory, streamChat } from "./chat.js";

export { visionKind } from "./chat.js";

export async function suggest(query) {
  const q = String(query || "").slice(0, 200);
  if (!q) return [];
  try {
    const r = await fetch(`https://duckduckgo.com/ac/?type=list&q=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(4000),
    });
    const data = await r.json();
    return Array.isArray(data?.[1]) ? data[1].slice(0, 8) : [];
  } catch {
    return [];
  }
}

// The site's own logo as Google shows it in search results, else DuckDuckGo's copy. Both
// answer 404 (with a stand-in globe or arrow) when they have none, and then there's no icon.
const iconSources = [
  (domain) => `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${domain}&size=64`,
  (domain) => `https://icons.duckduckgo.com/ip3/${domain}.ico`,
];
const iconCache = new Map();

// Returns null for an invalid domain, otherwise { type, body }, with body null when the site has no icon.
export async function favicon(rawDomain) {
  const domain = String(rawDomain || "").toLowerCase();
  if (!/^[a-z0-9.-]{1,253}$/.test(domain)) return null;
  let hit = iconCache.get(domain);
  if (!hit) {
    hit = { type: "", body: null };
    for (const source of iconSources) {
      try {
        const r = await fetch(source(domain), { signal: AbortSignal.timeout(5000) });
        if (!r.ok) continue;
        hit = { type: r.headers.get("content-type") || "image/x-icon", body: Buffer.from(await r.arrayBuffer()) };
        break;
      } catch {}
    }
    if (iconCache.size > 500) iconCache.clear();
    iconCache.set(domain, hit);
  }
  return hit;
}

// Browser-side failures worth fixing (e.g. the photo reader); they show up in the host's logs.
export function logClientError(body, userAgent) {
  const b = body && typeof body === "object" ? body : {};
  // The AI chat also reports how long each reply took on the device (see respond() in public/js/ai.js).
  console.log(b.where === "ai-timing" ? "[ai-timing]" : "[client-error]", JSON.stringify({ where: String(b.where || "").slice(0, 40), error: String(b.error || "").slice(0, 500), ua: String(userAgent || "").slice(0, 200) }));
}

// Returns null for a missing prompt, otherwise { type, body }. Throws on upstream failure.
export async function image(query) {
  const prompt = String(query.prompt || "").slice(0, 800);
  if (!prompt) return null;
  const w = Math.min(1280, Math.max(256, parseInt(query.w) || 768));
  const h = Math.min(1280, Math.max(256, parseInt(query.h) || 768));
  const seed = parseInt(query.seed) || 42;
  const r = await fetch(
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&seed=${seed}&nologo=true&safe=true`,
    { signal: AbortSignal.timeout(90000) },
  );
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return { type: r.headers.get("content-type") || "image/jpeg", body: Buffer.from(await r.arrayBuffer()) };
}

/* ------------------------------------------------------------------ */
/* AI chat on Node hosts (server.js): lib/chat.js writes the reply,   */
/* falling back to Claude when ANTHROPIC_API_KEY is set (or an        */
/* `ant auth login` profile exists), otherwise to a free model.       */
/* ------------------------------------------------------------------ */

// An empty key would shadow the login profile, so drop it.
if (!process.env.ANTHROPIC_API_KEY) delete process.env.ANTHROPIC_API_KEY;
const anthropicConfigDir = process.env.ANTHROPIC_CONFIG_DIR || path.join(homedir(), ".config", "anthropic");
const hasClaude = Boolean(
  process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    existsSync(path.join(anthropicConfigDir, "credentials")),
);
// The SDK only loads when Claude is used, so servers without it (Vercel) start faster.
let anthropic = null;
const claude = async () => (anthropic ??= new (await import("@anthropic-ai/sdk")).default());
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
export const aiKind = hasClaude ? "claude" : "free";

async function streamClaude(messages, send, signal, { effort = "medium", system = SYSTEM_PROMPT } = {}) {
  const stream = (await claude()).beta.messages.stream(
    {
      model: CLAUDE_MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort },
      system,
      messages,
    },
    { signal },
  );
  for await (const event of stream) {
    if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") send({ type: "text", text: event.delta.text });
      else if (event.delta.type === "thinking_delta") send({ type: "reasoning", text: event.delta.thinking });
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") send({ type: "text", text: "\n\n_I can't help with that one._" });
}

// Streams a chat reply as SSE onto a raw Node response.
export async function chat(body, res) {
  const messages = chatHistory(body);
  if (!messages.length) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "No message" }));
  }
  res.writeHead(200, { ...SSE_HEADERS, Connection: "keep-alive" });
  res.flushHeaders?.();
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  await streamChat(messages, body?.speed, (text) => res.writableEnded || res.write(text), controller.signal, hasClaude ? streamClaude : null);
  res.end();
}
