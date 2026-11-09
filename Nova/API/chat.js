import { SSE_HEADERS, chatHistory, streamChat } from "../lib/chat.js";

// Runs on Vercel's Edge runtime, which is always ready: a Node function that had gone to sleep
// (after a publish, or a few idle minutes) took 2-5 seconds to start before it could answer.
export const config = { runtime: "edge" };

export default async function handler(req) {
  // A GET only opens the connection early (see warmChat in public/js/ai.js).
  if (req.method === "GET") return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const body = await req.json().catch(() => null);
  const messages = chatHistory(body);
  if (!messages.length) return new Response(JSON.stringify({ error: "No message" }), { status: 400, headers: { "Content-Type": "application/json" } });

  const encoder = new TextEncoder();
  const stop = new AbortController();
  let open = true;
  const stream = new ReadableStream({
    start(out) {
      const write = (text) => open && out.enqueue(encoder.encode(text));
      streamChat(messages, body.speed, write, stop.signal)
        .catch((err) => console.error("[chat]", err))
        .finally(() => open && ((open = false), out.close()));
    },
    // The browser went away (Stop, or a closed tab): stop asking the model.
    cancel() {
      open = false;
      stop.abort();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
