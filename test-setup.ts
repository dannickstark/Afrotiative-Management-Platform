// test-setup.ts — load real DB creds for integration tests (single source: .env.local)
// Bun skips .env.local when NODE_ENV=test, so preload it explicitly here.
import { readFileSync } from "node:fs";

try {
  (process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile(".env.local");
} catch {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
