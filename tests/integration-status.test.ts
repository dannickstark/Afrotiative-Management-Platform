import { readFileSync } from "node:fs";
import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";
import { getIntegrationStatus } from "@/lib/queries/settings";

describe("integration test guard", () => {
  it("only admin can test integrations", () => {
    expect(can("admin", "pipeline", "configure")).toBe(true);
    expect(can("editor", "pipeline", "configure")).toBe(false);
  });
});

describe("getIntegrationStatus", () => {
  it("returns the expected shape: 5 integrations with configured booleans + lastRun", async () => {
    const status = await getIntegrationStatus();
    expect(typeof status.wordpress.configured).toBe("boolean");
    expect(typeof status.omniroute.configured).toBe("boolean");
    expect(typeof status.openrouter.configured).toBe("boolean");
    expect(typeof status.jina.configured).toBe("boolean");
    expect(typeof status.firecrawl.configured).toBe("boolean");
    expect("lastSuccessAt" in status.wordpress).toBe(true);
    expect("lastRun" in status).toBe(true);
  });

  // test-setup.ts deliberately keeps provider keys OUT of process.env by default — Bun skips
  // .env.local under NODE_ENV=test and test-setup.ts only restores DATABASE_URL/auth vars, then
  // explicitly strips any *_API_KEY that leaked from the ambient shell — so no test accidentally
  // fires a real network/LLM call. This test opts back IN, the mirror image of how
  // tests/pipeline-run.test.ts opts OUT (deletes PROVIDER_KEYS for the duration of a call): it
  // loads the real values straight from .env.local for one call only, then restores whatever was
  // there before. getIntegrationStatus() itself never makes a network call — getWpConfig() and
  // getPipelineConfig() only read process.env, plus one DB select for lastRun/lastSuccessAt — so
  // this is a zero-cost, no-token-spend check of the "keys present" wiring per the task brief.
  it("reports configured: true for all five against the real .env.local keys", async () => {
    const KEYS = [
      "WP_BASE_URL", "WP_USER", "WP_APP_PASSWORD",
      "OMNIROUTE_API_KEY", "OMNIROUTE_BASE_URL", "OPENROUTER_API_KEY",
      "JINA_API_KEY", "FIRECRAWL_API_KEY",
    ] as const;
    const snapshot = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

    let raw: string;
    try {
      raw = readFileSync(".env.local", "utf8");
    } catch {
      return; // .env.local absent (e.g. CI without secrets) — the shape test above already covers structure
    }
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
      if (!m || !(KEYS as readonly string[]).includes(m[1])) continue;
      // WP_BASE_URL carries a trailing "# e.g. ..." inline comment in .env.local — a quoted
      // value stops at its closing quote; an unquoted value stops at the first " #".
      const quoted = m[2].match(/^"([^"]*)"/) ?? m[2].match(/^'([^']*)'/);
      process.env[m[1]] = quoted ? quoted[1] : m[2].split(/\s+#/)[0].trim();
    }

    try {
      const status = await getIntegrationStatus();
      expect(status.wordpress.configured).toBe(true);
      expect(status.omniroute.configured).toBe(true);
      expect(status.openrouter.configured).toBe(true);
      expect(status.jina.configured).toBe(true);
      expect(status.firecrawl.configured).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(snapshot)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
