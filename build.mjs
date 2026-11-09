// Builds a static copy of Nova for Vercel: public/ plus the vendor files server.js serves from node_modules.
import { cpSync, rmSync, mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { proxyDirs, scramjetBundle } from "./lib/proxy-files.js";
import { offlineManifest } from "./lib/offline-files.js";

// Local builds read the secret entrance settings from .env; Vercel supplies them itself.
try {
  process.loadEnvFile(".env");
} catch {}

const out = "dist";
rmSync(out, { recursive: true, force: true });
cpSync("public", out, { recursive: true });

// Nova's page only exists at its secret address (see lib/gate.js).
const appPath = process.env.NOVA_APP_PATH || "";
if (!/^[A-Za-z0-9]{20,}$/.test(appPath)) throw new Error("NOVA_APP_PATH must be set to 20+ letters and digits");
renameSync(`${out}/app`, `${out}/${appPath}`);
for (const name of ["NOVA_WORD", "NOVA_SECRET", "NOVA_GOOGLE_CLIENT_ID", "NOVA_EMAILS", "NOVA_RETURN_WORD", "NOVA_ADMINS", "NOVA_DB_URL", "NOVA_DB_ANON", "NOVA_DB_KEY"])
  if (!process.env[name]) throw new Error(`${name} must be set: Nova's unlock can't work without it`);

// A twin site can front a different essay: NOVA_ESSAY=math puts public/essay-math/ (a math
// essay) at / and swaps every place the disguise tab title is hardcoded. The default build
// is untouched except that the unused public/essay-math/ isn't shipped.
if (process.env.NOVA_ESSAY === "math") {
  const MATH_TITLE = "Understanding Algebra 2";
  const edit = (file, pairs) => {
    let text = readFileSync(`${out}/${file}`, "utf8");
    for (const [from, to] of pairs) {
      if (!text.includes(from)) throw new Error(`NOVA_ESSAY=math: "${from}" not found in ${file}`);
      text = text.replaceAll(from, to);
    }
    writeFileSync(`${out}/${file}`, text);
  };
  cpSync(`${out}/essay-math/index.html`, `${out}/index.html`);
  cpSync(`${out}/essay-math/favicon.svg`, `${out}/essay/favicon.svg`);
  edit("404.html", [
    ["Saint Ambrose", MATH_TITLE],
    ["LUX PATRUM", "ALGEBRA 2"],
    ["#4a1117", "#17181b"],
    ["#6e1d24", "#1f5fa8"],
    ["#b0873a", "#5d5d5d"],
  ]);
  edit(`${appPath}/index.html`, [
    ["Saint Ambrose", MATH_TITLE],
  ]);
  edit("essay/cloak.js", [
    ["Saint Ambrose", MATH_TITLE],
  ]);
}
rmSync(`${out}/essay-math`, { recursive: true, force: true });

const copies = [
  ...proxyDirs.map(([prefix, dir]) => [prefix.slice(1, -1), dir]),
  ["vendor/chart", "node_modules/chart.js/dist"],
  ["vendor/marked", "node_modules/marked/lib"],
  ["vendor/purify", "node_modules/dompurify/dist"],
  ["vendor/katex", "node_modules/katex/dist"],
  ["vendor/hljs", "node_modules/@highlightjs/cdn-assets"],
  ["vendor/inter", "node_modules/@fontsource-variable/inter"],
  ["vendor/geist", "node_modules/@fontsource-variable/geist"],
  ["vendor/patrick-hand", "node_modules/@fontsource/patrick-hand"],
];
for (const [dest, src] of copies)
  cpSync(src, `${out}/${dest}`, { recursive: true, filter: (f) => !f.endsWith(".map") && !f.includes("temp-types-build") && !/[\\/]types$/.test(f) });
writeFileSync(`${out}/scram/scramjet.js`, scramjetBundle());
// mermaid/dist is ~80 MB; only the self-contained bundle is used.
mkdirSync(`${out}/vendor/mermaid`, { recursive: true });
cpSync("node_modules/mermaid/dist/mermaid.min.js", `${out}/vendor/mermaid/mermaid.min.js`);
// The photo reader (public/js/vision-worker.js): the browser bundle plus the one ONNX runtime build it loads.
mkdirSync(`${out}/vendor/transformers`, { recursive: true });
cpSync("node_modules/@huggingface/transformers/dist/transformers.min.js", `${out}/vendor/transformers/transformers.min.js`);
mkdirSync(`${out}/vendor/ort`, { recursive: true });
for (const f of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"])
  cpSync(`node_modules/onnxruntime-web/dist/${f}`, `${out}/vendor/ort/${f}`);
// The light photo reader's text recognition: Tesseract, its LSTM cores and compact English data.
mkdirSync(`${out}/vendor/tesseract`, { recursive: true });
for (const f of ["tesseract.min.js", "worker.min.js"]) cpSync(`node_modules/tesseract.js/dist/${f}`, `${out}/vendor/tesseract/${f}`);
mkdirSync(`${out}/vendor/tesseract-core`, { recursive: true });
for (const f of ["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"])
  cpSync(`node_modules/tesseract.js-core/${f}`, `${out}/vendor/tesseract-core/${f}`);
mkdirSync(`${out}/vendor/tesseract-data`, { recursive: true });
cpSync("node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", `${out}/vendor/tesseract-data/eng.traineddata.gz`);

// What members' devices save so the games play offline (public/js/offline.js). Only served
// to a browser that has unlocked Nova, like every Nova file (middleware.js).
writeFileSync(`${out}/offline.json`, JSON.stringify(offlineManifest(out)));

// Vercel can't hold WebSockets, so the proxy tunnel must come from an external Wisp server.
writeFileSync(`${out}/config.js`, `window.NOVA_WISP = ${JSON.stringify(process.env.WISP_URL || "")};\n`);
console.log(`Built ${out}/ (wisp: ${process.env.WISP_URL || "same origin"})`);
