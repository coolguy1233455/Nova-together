// Browser files for Nova's proxy. server.js serves them straight from node_modules and
// build.mjs copies them into dist/ for Vercel, so both stay in sync from this one list.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const mod = (p) => path.join(root, "node_modules", p);

// [url prefix, directory]. Scramjet 2 is the main engine and Ultraviolet the backup.
// Both reach the Wisp tunnel through epoxy or libcurl, but each engine needs the transport
// generation it was built for: Scramjet 2 the current one, Ultraviolet (via bare-mux) the
// previous one, installed under the -v2/-v1 aliases.
export const proxyDirs = [
  ["/scram/", mod("@mercuryworkshop/scramjet/dist")],
  ["/controller/", mod("@mercuryworkshop/scramjet-controller/dist")],
  ["/sjutils/", mod("@mercuryworkshop/scramjet-utils/dist")],
  ["/epoxy/", mod("@mercuryworkshop/epoxy-transport/dist")],
  ["/libcurl/", mod("@mercuryworkshop/libcurl-transport/dist")],
  ["/uv/", mod("@titaniumnetwork-dev/ultraviolet/dist")],
  ["/baremux/", mod("@mercuryworkshop/bare-mux/dist")],
  ["/uv-epoxy/", mod("epoxy-transport-v2/dist")],
  ["/uv-libcurl/", mod("libcurl-transport-v1/dist")],
];

// Scramjet 2.0.67-alpha.2 turns history.pushState(state, title) (no URL, which is legal)
// into a navigation to /undefined, breaking many single-page sites. Fixed upstream but
// not yet released, so patch the published bundle the same way.
const HISTORY_BUG = "s=(0,n.Qf)(t.args[2]);if(n.xP.canParse(s)";
const HISTORY_FIX = "s=null==t.args[2]?void 0:(0,n.Qf)(t.args[2]);if(n.xP.canParse(s)";

// Scramjet calls URL.canParse (Chrome 120+) without checking for it; school Chromebooks
// often run older Chrome, so supply it there.
const CANPARSE_POLYFILL =
  'typeof URL.canParse!="function"&&(URL.canParse=function(u,b){try{return new URL(u,b),!0}catch(e){return!1}});\n';

export function scramjetBundle() {
  const src = readFileSync(mod("@mercuryworkshop/scramjet/dist/scramjet.js"), "utf8");
  if (!src.includes(HISTORY_BUG)) {
    console.warn("proxy-files: Scramjet's pushState patch no longer applies; check whether upstream fixed it.");
    return CANPARSE_POLYFILL + src;
  }
  return CANPARSE_POLYFILL + src.replace(HISTORY_BUG, HISTORY_FIX);
}
