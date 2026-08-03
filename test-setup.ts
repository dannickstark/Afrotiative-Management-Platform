// test-setup.ts — load real DB creds for integration tests from .env.local (single source).
// Bun skips .env.local when NODE_ENV=test; this preload restores it. Best-effort:
// if the file is absent (fresh clone / CI without secrets) leave env as-is.
import { readFileSync } from "node:fs";
try {
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  // .env.local absent — DB-touching tests will fail with a clear connection error; others still run.
}
