// The AI chat, shared by server.js (through lib/api.js) and the Vercel Edge function api/chat.js,
// so it uses only web APIs (fetch, streams, timers) and no Node built-ins.

// Sharp photo reading: with a free Google AI Studio key (GEMINI_API_KEY), chats with photos are
// answered by Gemini looking at the photos (see streamChat()); describeImage writes a photo out for
// the free model when Gemini can't answer.
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
export const visionKind = GEMINI_KEY ? "gemini" : "";
const VISION_PROMPT = `Describe this photo for someone who can't see it, in enough detail to answer any question about it: the main subject, people (what they look like, wear and are doing, without naming or identifying anyone), animals, objects, colors, setting, lighting and anything unusual. Then copy all the writing in it exactly, line by line, including any math. Reply in exactly this format:
DESCRIPTION: <one detailed paragraph>
TEXT:
<the writing, or "none">`;

// Resolves to { caption, text } for a { image: data URL } body. Errors carry an HTTP status.
async function describeImage(body) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!GEMINI_KEY) throw fail(501, "No vision key is set");
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body?.image || ""));
  if (!m || m[2].length > 6_000_000) throw fail(400, "Not a usable image");
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: m[1], data: m[2] } }, { text: VISION_PROMPT }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw fail(502, `Gemini returned ${r.status}`);
  const out = ((await r.json()).candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  const caption = (out.match(/DESCRIPTION:\s*([\s\S]*?)(?:\n\s*TEXT:|$)/i)?.[1] || out).trim();
  const text = (out.match(/\n\s*TEXT:\s*([\s\S]*)$/i)?.[1] || "").trim().replace(/^none\.?$/i, "");
  if (!caption) throw fail(502, "Gemini gave no description");
  return { caption, text };
}

// Tells the model about the visuals the chat UI renders from fenced code blocks (see public/js/ai.js).
export const SYSTEM_PROMPT = `You are the AI assistant inside Nova. Reply in Markdown. Write math as LaTeX: $...$ inline, $$...$$ for display.

The chat turns these fenced code blocks into live visuals. Use them whenever a picture, chart, graph or diagram is asked for or would help, and never tell the user to paste a prompt into another tool.

- \`\`\`image: you CAN make images. Put JSON {"prompt": "...", "width": 1024, "height": 1024} in the block; the app generates the picture from the prompt. Write the prompt as one short English description (15-35 words) of the subject first, then what it's doing, the setting and the art style; the image model follows short, concrete prompts much better than long ones. Width and height are optional (256-1280).
- \`\`\`video: you CAN make short videos. Put JSON {"title": "...", "scenes": [{"prompt": "...", "caption": "..."}, ...], "seconds": 4} in the block. The app paints each scene from its prompt and plays them in order with slow camera moves and crossfades, and the user can replay or download it. Use 3 scenes that show the action step by step from start to finish (for "climbing a tree": at the bottom looking up, halfway up the trunk, sitting at the top); every scene is a new picture and the free picture service is slow, so don't use more. Every scene prompt is drawn on its own, so start each one with the main character's description, keep it short (15-35 words), and end each with the same art style so the scenes match. Captions are optional short on-screen lines. "seconds" is per scene (2-8). Default size is 1024x576; "width"/"height" are optional.
- \`\`\`chart: a Chart.js config as JSON, e.g. {"type": "bar", "data": {"labels": [...], "datasets": [{"label": "...", "data": [...]}]}, "options": {"plugins": {"title": {"display": true, "text": "..."}}}}. Types: bar, line, pie, doughnut, radar, polarArea, scatter, bubble.
- \`\`\`plot: graphs of functions of x, as JSON {"title": "...", "functions": ["sin(x)", "x^2/4"], "x": [-6.28, 6.28]}. Optional "y": [min, max], "points": [[x, y], ...]. Use ^ for powers and pi for π.
- \`\`\`mermaid: a Mermaid diagram (flowchart, sequence, class, state, gantt, pie, mindmap, timeline).

You can see photos the user attaches. They come as images, or, when that isn't possible, the app's image reader writes what you see at the end of their message as "[Photo attached. What it shows: ... Text in the photo: ...]". Either way it is your own view of the photo: talk about it as something you are looking at ("I can see...", "In your photo..."). Never say you can't see images, can't view or open the photo, or are going by a description, and never mention the note, add bracketed asides about it, or write one yourself. If they ask about something that isn't in your view, say that part isn't clear in the photo and ask them to tell you. To make a picture or video based on their photo, describe its subject in your prompts.

Images and videos are for the user's personal, non-commercial fun, so fan art is fine: when asked for a well-known cartoon, storybook or game character (for example Curious George), make the image or video. Name the character and their creator in the prompt and describe their real signature look and classic art style so the picture resembles them (for example Curious George by H. A. Rey: a small brown monkey with a round tan face, big dark eyes and no tail, drawn in soft watercolor storybook style). Keep images and videos family-friendly.`;

// Fast mode also asks for short replies, which finish sooner.
const BRIEF = `

Answer fast: get straight to the point and keep replies short (a few sentences or a short list) unless the user asks for more detail or the task needs it, like code, an essay or step-by-step math.`;

const IMAGE_DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

// Every Gemini model has its own free daily and per-minute limit, so each speed lists several
// to fall through before the slow free model. Gemma (open models on the same key) has the
// biggest free limit, so it comes last.
const GEMMA = ["gemma-3-27b-it", "gemma-3-12b-it"];

// The chat's speed setting (see the speed menu in public/js/ai.js): which Gemini models to try,
// in order, and how hard the other models think.
// "thinking" lists Gemini thinking settings to try in order: newer models take thinkingLevel,
// older ones thinkingBudget, and a model that rejects both gets its default (null).
// A model that hasn't started answering after "startMs" is skipped for the next one.
const SPEEDS = {
  fast: {
    gemini: [process.env.GEMINI_FAST_MODEL || "gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-flash-latest", "gemini-2.5-flash", ...GEMMA],
    thinking: [{ thinkingLevel: "minimal" }, { thinkingBudget: 0 }, null],
    startMs: 8000,
    effort: "low",
    system: SYSTEM_PROMPT + BRIEF,
  },
  balanced: {
    gemini: [process.env.GEMINI_MODEL_BALANCED || "gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite", ...GEMMA],
    thinking: [{ thinkingLevel: "low" }, { thinkingBudget: 1024 }, null],
    startMs: 15000,
    effort: "medium",
    system: SYSTEM_PROMPT,
  },
  smart: {
    gemini: [process.env.GEMINI_SMART_MODEL || "gemini-pro-latest", "gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", ...GEMMA],
    thinking: [null],
    startMs: 45000,
    effort: "high",
    system: SYSTEM_PROMPT,
  },
};

// What this server has learned about the Gemini models, so later chats skip the dead ends
// instead of waiting on them again: models this key can't use, thinking settings a model
// turned down, and models resting (until when) after hitting their free limit.
const geminiSkip = { missing: new Set(), rejected: new Set(), resting: new Map() };

async function noteGeminiFailure(model, res) {
  const text = await res.text().catch(() => "");
  if (res.status === 404 || res.status === 403) geminiSkip.missing.add(model);
  else if (res.status === 429 || res.status >= 500) {
    const retry = +(text.match(/"retryDelay":\s*"(\d+)/)?.[1] || 0) * 1000;
    const wait = res.status === 429 && /PerDay/i.test(text) ? 30 * 60_000 : Math.max(retry, res.status === 429 ? 20_000 : 10_000);
    geminiSkip.resting.set(model, Date.now() + wait);
  }
  return text.slice(0, 160).replace(/\s+/g, " ");
}

function trimHistory(messages) {
  const clean = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => {
      const out = { role: m.role, content: m.content.slice(0, 24000) };
      // Photos (sent only when Gemini can look at them; see respond() in public/js/ai.js).
      if (m.role === "user" && typeof m.image === "string" && m.image.length < 3_000_000 && IMAGE_DATA_URL.test(m.image)) out.image = m.image;
      return out;
    });
  // Only the last few photos travel with the conversation.
  let photos = 0;
  for (let i = clean.length - 1; i >= 0; i--) if (clean[i].image && ++photos > 4) delete clean[i].image;
  // Keep the most recent ~40k chars of conversation.
  let total = 0;
  const out = [];
  for (let i = clean.length - 1; i >= 0; i--) {
    total += clean[i].content.length;
    if (total > 40000 && out.length) break;
    out.unshift(clean[i]);
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

// Chats with photos go to Gemini, which looks at the images themselves (see chat()).
async function streamGemini(messages, send, signal, { gemini: models, thinking, startMs, system }) {
  // Turns must alternate, so back-to-back messages from one side (e.g. after a delete) are joined.
  const contents = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts = [];
    const img = m.image && IMAGE_DATA_URL.exec(m.image);
    if (img) parts.push({ inline_data: { mime_type: img[1], data: img[2] } });
    parts.push({ text: m.content });
    if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts);
    else contents.push({ role, parts });
  }
  // Gemma takes no system instruction or thinking setting; it gets the instructions as the
  // start of the first message.
  const gemmaContents = [{ role: "user", parts: [{ text: `${system}\n\n---\n\n` }, ...contents[0].parts] }, ...contents.slice(1)];
  // A model the free tier doesn't include (or that's over its limit, or slow to start) falls
  // through to the next; a thinking setting a model doesn't accept (400) falls through to the
  // next setting. Both are remembered (geminiSkip) so the next chat goes straight to one that works.
  const started = Date.now();
  let res = null;
  const tried = [];
  attempts: for (const model of models) {
    if (geminiSkip.missing.has(model) || (geminiSkip.resting.get(model) || 0) > Date.now()) continue;
    const gemma = model.startsWith("gemma");
    for (const thinkingConfig of gemma ? [null] : thinking) {
      const key = `${model} ${JSON.stringify(thinkingConfig)}`;
      if (geminiSkip.rejected.has(key)) continue;
      const attempt = new AbortController();
      const stop = () => attempt.abort();
      signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, startMs);
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
          body: JSON.stringify({
            ...(!gemma && { system_instruction: { parts: [{ text: system }] } }),
            contents: gemma ? gemmaContents : contents,
            generationConfig: { maxOutputTokens: 8192, ...(thinkingConfig && { thinkingConfig }) },
          }),
          signal: attempt.signal,
        });
      } catch (err) {
        if (signal.aborted) throw err;
        res = null;
        tried.push(`${key} -> no answer in ${startMs}ms`);
        geminiSkip.resting.set(model, Date.now() + 60_000);
        continue attempts;
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        tried.push(`${key} -> ${res.status}`);
        break attempts;
      }
      tried.push(`${key} -> ${res.status} ${await noteGeminiFailure(model, res)}`);
      if (res.status !== 400) continue attempts;
      if (thinkingConfig) geminiSkip.rejected.add(key);
    }
  }
  console.log("[gemini]", tried.join(" | ") || "every model is resting", `${Date.now() - started}ms to headers`);
  if (!res?.ok) throw new Error(`Gemini returned ${res?.status ?? "nothing"}`);
  const decoder = new TextDecoder();
  let buf = "";
  const reader = res.body.getReader();
  for (let chunk; !(chunk = await reader.read()).done; ) {
    buf += decoder.decode(chunk.value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      try {
        for (const part of JSON.parse(line.slice(5)).candidates?.[0]?.content?.parts || []) if (part.text && !part.thought) send({ type: "text", text: part.text });
      } catch {
        /* partial frame */
      }
    }
  }
}

// When Gemini can't answer, the free model gets each photo written out instead.
async function writeOutPhotos(messages) {
  return Promise.all(
    messages.map(async ({ role, content, image }) => {
      if (!image) return { role, content };
      try {
        const { caption, text } = await describeImage({ image });
        return { role, content: `${content}\n\n[Photo attached. What it shows: ${caption}${text ? ` Text in the photo:\n${text}\n` : ""}]` };
      } catch {
        return { role, content: `${content}\n\n[Photo attached, but it came through too blurry to make anything out.]` };
      }
    }),
  );
}

async function streamFree(messages, send, signal, { effort = "low", system = SYSTEM_PROMPT } = {}) {
  const body = JSON.stringify({
    model: "openai",
    stream: true,
    reasoning_effort: effort,
    messages: [{ role: "system", content: system }, ...messages],
  });
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch("https://text.pollinations.ai/openai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal,
    });
    if (res.ok) break;
    // 402 is its free limit (one reply per 30 s per IP); wait it out like a busy server.
    if (res.status !== 402 && res.status !== 429 && res.status < 500) break;
    const wait = res.status === 402 ? Math.min(30, +res.headers.get("retry-after") || 30) * 1000 + 500 : 1500 * (attempt + 1);
    await new Promise((r) => setTimeout(r, wait));
  }
  if (!res.ok) throw new Error(`The AI service returned ${res.status}. Try again in a moment.`);

  const decoder = new TextDecoder();
  let buf = "";
  const reader = res.body.getReader();
  for (let chunk; !(chunk = await reader.read()).done; ) {
    buf += decoder.decode(chunk.value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return reader.cancel();
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta;
        if (delta?.reasoning) send({ type: "reasoning", text: delta.reasoning });
        if (delta?.content) send({ type: "text", text: delta.content });
      } catch {
        /* ignore keep-alives / partial frames */
      }
    }
  }
}

// "image" or "video" when the message plainly asks for one to be made, else null.
function mediaIntent(text) {
  const t = String(text).toLowerCase().trim();
  if (/^(how|what|why|where|when|who|which|should|is|are|does|do)\b/.test(t)) return null;
  const m = t.match(
    /\b(make|create|generate|draw|paint|render|design|produce|animate|give|show)\b(?:\s+[\w'-]+){0,5}?\s+(video|animation|clip|movie|cartoon|film|image|picture|pic|photo|drawing|painting|illustration|wallpaper|portrait)s?\b(?!\s+(game|games|ideas?|script|titles?|editor|player|tips))/,
  );
  if (m) return /^(video|animation|clip|movie|cartoon|film)$/.test(m[2]) ? "video" : "image";
  if (/^animate\b/.test(t)) return "video";
  if (/^(draw|paint|sketch)\b/.test(t)) return "image";
  return null;
}

// Characters the image model draws poorly from the name alone. "plain" is what the chat model
// sees instead of the name (it often refuses well-known characters); "look" and "style" go into
// every picture, so all of a video's scenes show the same character drawn the same way.
const CHARACTERS = [
  {
    name: /curious george/gi,
    plain: "George, a small brown cartoon monkey",
    look: "2D cartoon drawing of Curious George the little brown monkey with a round tan face and big dark eyes",
    style: "classic children's book art, soft watercolor, simple background",
  },
];

const charactersIn = (text) => CHARACTERS.filter((c) => text.search(c.name) >= 0);

// Keeps prompts short (the free image model loses the subject in long ones) and puts each
// character's full look and style into every image/video prompt in a reply.
function polishMedia(text, characters) {
  // Models sometimes start the JSON on the fence line ("```video{").
  text = text.replace(/```(image|video)[ \t]*(?=[{[])/g, "```$1\n");
  return text.replace(/```(image|video)[ \t]*\n([\s\S]*?)\n```/g, (block, kind, body) => {
    let spec;
    try {
      spec = JSON.parse(body);
    } catch {
      return block;
    }
    const fix = (prompt) => {
      let p = String(prompt || "").trim().split(/\s+/).slice(0, 45).join(" ").replace(/[,.;:]+$/, "");
      for (const c of characters) {
        if (!p.includes(c.look)) p = `${c.look}, ${p}`;
        if (!p.includes(c.style)) p = `${p}, ${c.style}`;
      }
      return p;
    };
    if (kind === "image") spec = { ...spec, prompt: fix(spec.prompt ?? spec.description) };
    else if (Array.isArray(spec.scenes))
      spec.scenes = spec.scenes.map((sc) => (typeof sc === "string" ? { prompt: fix(sc) } : { ...sc, prompt: fix(sc.prompt ?? sc.description) }));
    return "```" + kind + "\n" + JSON.stringify(spec, null, 1) + "\n```";
  });
}

// A ```image or ```video reply built straight from the user's own words.
function directMedia(kind, text, photo = "") {
  let subject = String(text)
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(/^(please\s+)?((can|could|would|will) you\s+)?(please\s+)?/i, "")
    .replace(/^(make|create|generate|draw|paint|render|design|produce|animate|sketch|give|show)\s+(me\s+)?/i, "")
    .replace(/^(an?|the|some)\s+/i, "")
    .replace(/\b(short|quick|little|cool|funny)\s+(?=(video|animation|clip|movie|cartoon|film)s?\b)/gi, "")
    .replace(/\b(video|animation|clip|movie|film|image|picture|pic|photo|drawing|painting|illustration|wallpaper|portrait)s?\b\s*(of|about|showing|where)?\s*/gi, "")
    .replace(/^(of|about|showing|with|where)\s+/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!subject) subject = String(text).trim();
  // "make a cartoon of this photo": swap the reference for what the photo reader saw.
  if (photo && /\b(this|it|that|my|me)\b/i.test(subject)) subject = `${subject.replace(/\b(this|that|my)\s+(photo|picture|pic|image)\b/i, "the scene")}, the scene being: ${photo}`;
  const title = subject.charAt(0).toUpperCase() + subject.slice(1, 70);
  const characters = charactersIn(subject);
  for (const c of characters) subject = subject.replace(c.name, "").replace(/^\s*,?\s*/, "");
  // Characters bring their own style; otherwise keep any style the user named.
  const style = characters.length || /\b(photo|realistic|anime|cartoon|pixel|3d|watercolor|sketch|painting|drawing|lego|clay)\b/i.test(text) ? "" : ", detailed digital illustration, vivid colors";
  if (kind === "image") return polishMedia(`Here's your picture:\n\n\`\`\`image\n${JSON.stringify({ prompt: subject + style })}\n\`\`\``, characters);
  // Without the chat model to plan a story, show the action from start to finish.
  const stages = ["just starting", "halfway there", "finished and celebrating"];
  const scenes = stages.map((stage) => ({ prompt: `${subject}, ${stage}${style}` }));
  return polishMedia(`Here's your video:\n\n\`\`\`video\n${JSON.stringify({ title, scenes, seconds: 3 })}\n\`\`\``, characters);
}

// Headers for a chat reply's Server-Sent Events.
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

// The conversation in a chat request, trimmed to what goes on to the model (empty: nothing to answer).
export const chatHistory = (body) => trimHistory(body?.messages);

// Streams a reply to `messages` (from chatHistory) as Server-Sent Events of {type, text}
// through write(). `claude` streams a reply from Claude where the server has it (see
// lib/api.js); otherwise the free model is the fallback.
export async function streamChat(messages, speedName, write, signal, claude = null) {
  // A 2 KB comment goes out at once, so nothing on the way waits for a full buffer before
  // passing the reply on; the browser shows the words as they're written.
  write(`:${" ".repeat(2048)}\n\n`);
  const started = Date.now();
  let firstText = 0;
  let chars = 0;
  const send = (obj) => {
    if (obj.type === "text") {
      firstText ||= Date.now() - started;
      chars += obj.text.length;
    }
    write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const speed = SPEEDS[speedName] || SPEEDS.fast;
  // With a Gemini key every chat goes to Gemini (fast, and it can look at photos); the free
  // model (or Claude, locally) is the fallback.
  const useGemini = Boolean(GEMINI_KEY);
  send({ type: "meta", model: useGemini ? "Gemini" : claude ? "Claude" : "Nova Free AI" });
  // For a clear picture/video request, hold the reply until it shows a code fence; if it
  // ends without one (usually a refusal over a well-known character), make it directly.
  // The photo note (see withPhoto in public/js/ai.js) isn't part of what the user typed.
  const [lastUser, photoNote = ""] = messages[messages.length - 1].content.split(/\n\n(?=\[Photo attached)/);
  const photo = photoNote.match(/What it shows: (.*?)(?: Text in the photo:|\]$)/)?.[1] || "";
  const intent = mediaIntent(lastUser);
  const characters = intent ? charactersIn(lastUser) : [];
  if (characters.length) {
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = { ...last, content: characters.reduce((t, c) => t.replace(c.name, c.plain), last.content) };
  }
  // A picture or video request is held to the end so its prompts can be polished; a reply
  // without one (usually a refusal over a well-known character) is replaced by a direct one.
  let held = "";
  let gotText = false;
  const relay = (obj) => {
    if (obj.type === "text") gotText = true;
    if (!intent || obj.type !== "text") return send(obj);
    held += obj.text;
  };
  try {
    let fallback = !useGemini;
    if (useGemini) {
      try {
        await streamGemini(messages, relay, signal, speed);
        fallback = !gotText;
      } catch (err) {
        if (gotText || signal.aborted) throw err;
        fallback = true;
      }
    }
    if (fallback) {
      if (useGemini) send({ type: "meta", model: claude ? "Claude" : "Nova Free AI" });
      const plain = messages.some((m) => m.image) ? await writeOutPhotos(messages) : messages.map(({ role, content }) => ({ role, content }));
      if (claude) await claude(plain, relay, signal, speed);
      else await streamFree(plain, relay, signal, speed);
    }
    // The free model sometimes imitates the photo note at the end of its reply.
    held = held.replace(/\n*\[Photo attached[^\]]*\]\s*$/, "");
    if (intent) send({ type: "text", text: /```(image|video)/.test(held) ? polishMedia(held, characters) : directMedia(intent, lastUser, photo) });
    send({ type: "done" });
  } catch (err) {
    if (!signal.aborted) send({ type: "error", message: String(err?.message || err) });
  }
  console.log("[chat]", JSON.stringify({ speed: speedName || "fast", firstText, total: Date.now() - started, chars, history: messages.length, intent }));
}
