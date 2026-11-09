// Local secrets (e.g. ANTHROPIC_API_KEY) live in .env, which is git-, docker- and vercel-ignored.
// lib/api.js imports this first, so they're loaded before the modules that read them.
import path from "node:path";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"));
} catch {
  /* no .env file: rely on the real environment */
}
