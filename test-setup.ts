// test-setup.ts — preload for `bun test`.
//
// Loads ONLY the DB creds + auth config tests actually need from .env.local — Bun skips
// .env.local when NODE_ENV=test, so this restores just enough to hit the real Neon DB and
// exercise auth-touching tests. It deliberately does NOT load provider keys (JINA_API_KEY,
// OPENROUTER_API_KEY, etc.): any test that calls extract()/embed()/generateArticle() without
// explicitly setting its own credentials must run credential-free, on the mock/readability
// fallback path, so the suite can never spend real API money by accident. A test that WANTS
// real keys must opt in by setting them itself (see the PROVIDER_KEYS patterns already used in
// tests/extract-chain.test.ts, tests/ai-fallback.test.ts, tests/pipeline-run.test.ts).
import { readFileSync } from "node:fs";

const NEEDED_KEYS = ["DATABASE_URL", "DIRECT_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"];

try {
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && NEEDED_KEYS.includes(m[1]) && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  // .env.local absent — DB-touching tests will fail with a clear connection error; others still run.
}

// Belt-and-suspenders: explicitly strip provider credentials from process.env, in case one is
// already set in the ambient shell/CI environment (not just .env.local, which we never loaded
// these from above). Named keys per the SP3 review, plus a generic `*_API_KEY` sweep to also
// catch ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY and any future ones.
const EXPLICIT_PROVIDER_KEYS = [
  "JINA_API_KEY", "FIRECRAWL_API_KEY", "OPENROUTER_API_KEY",
  "OMNIROUTE_API_KEY", "OMNIROUTE_BASE_URL", "EMBED_API_KEY",
];
for (const k of EXPLICIT_PROVIDER_KEYS) delete process.env[k];
for (const k of Object.keys(process.env)) {
  if (/_API_KEY$/i.test(k)) delete process.env[k];
}
