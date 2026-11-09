// The files Nova saves on each member's device so the games play without internet (see
// public/js/offline.js): everything under js/, css/ and games/, each with a fingerprint of
// its contents so a later visit only downloads what changed. Nova's scripts and the games'
// pictures come first, then the games from smallest to largest, so most of them are ready
// soonest. Pizza Edition's games (played through /pe/, see vercel.json) come after those,
// also smallest first: lib/pe-offline.json lists the files each one loads (recorded by
// opening every game in a headless browser), and they never change at the same address.
// Nova's own page, the essay and the libraries they load are saved as they load
// (public/sw.js).
// Used by build.mjs (dist/offline.json) and server.js (/offline.json).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// { slug: [[url, bytes], ...] } for the Pizza Edition games.
let peFiles = null;
function peOffline() {
  if (!peFiles)
    try {
      peFiles = JSON.parse(readFileSync(fileURLToPath(new URL("./pe-offline.json", import.meta.url)), "utf8"));
    } catch {
      peFiles = {};
    }
  return peFiles;
}

function filesUnder(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name.endsWith(".map")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// Hashing ~300 MB takes a moment, so server.js only re-hashes files that changed.
const prints = new Map();
function fingerprint(file) {
  const { size, mtimeMs } = statSync(file);
  const seen = prints.get(file);
  if (seen?.size === size && seen.mtimeMs === mtimeMs) return seen.hash;
  const hash = createHash("md5").update(readFileSync(file)).digest("hex").slice(0, 12);
  prints.set(file, { size, mtimeMs, hash });
  return hash;
}

// The path the way the browser asks for it: "%", "#" and "?" would otherwise change its meaning.
const urlOf = (root, file) =>
  "/" + path.relative(root, file).split(path.sep).map((s) => s.replace(/[%#?]/g, encodeURIComponent)).join("/");

export function offlineManifest(root) {
  const games = path.join(root, "games");
  const first = [...filesUnder(path.join(root, "js")), ...filesUnder(path.join(root, "css"))];
  const folders = [];
  for (const e of readdirSync(games, { withFileTypes: true })) {
    const p = path.join(games, e.name);
    if (e.isDirectory()) folders.push(filesUnder(p));
    else if (e.isFile() && !e.name.startsWith(".")) first.push(p);
  }
  const size = (files) => files.reduce((n, f) => n + statSync(f).size, 0);
  const thumb = (f) => /^thumb\./.test(path.basename(f)) && path.dirname(path.dirname(f)) === games;
  first.push(...folders.flat().filter(thumb));
  const sized = folders.map((files) => files.filter((f) => !thumb(f))).map((files) => ({ files, size: size(files) })).sort((a, b) => a.size - b.size);
  const files = [first, ...sized.map((g) => g.files)].flat();
  const seen = new Set();
  const pe = Object.values(peOffline())
    .map((list) => list.filter(([url]) => !seen.has(url) && seen.add(url)))
    .sort((a, b) => a.reduce((n, [, s]) => n + s, 0) - b.reduce((n, [, s]) => n + s, 0))
    .flat();
  return {
    files: [...files.map((f) => [urlOf(root, f), fingerprint(f)]), ...pe.map(([url]) => [url, "pe"])],
    bytes: size(files) + pe.reduce((n, [, s]) => n + s, 0),
  };
}
