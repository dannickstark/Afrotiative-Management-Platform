import { readFileSync } from "node:fs";
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { can } from "@/lib/rbac";
import { getIntegrationStatus } from "@/lib/queries/settings";
import { db, articles, distributions } from "@/db";
import { computeIntegrationConfigured, INTEGRATION_META, type IntegrationName } from "@/lib/config/integration-config";
import type { PipelineConfig } from "@/lib/config/pipeline-config";

const ALL_INTEGRATIONS = Object.keys(INTEGRATION_META) as IntegrationName[];

describe("integration test guard", () => {
  it("only admin can test integrations", () => {
    expect(can("admin", "pipeline", "configure")).toBe(true);
    expect(can("editor", "pipeline", "configure")).toBe(false);
  });
});

// Task 8 — PURE unit coverage for computeIntegrationConfigured() (lib/config/integration-config.ts),
// deliberately kept separate from the DB-backed describe block below: no env mutation, no DB
// access, no network — a fake PipelineConfig + fake extras in, a plain boolean map out. This is
// what keeps the mapping testable even though getIntegrationStatus() itself (DB reads for
// lastRun/lastSuccessAt + the openrouter token-pool summary) cannot be pure. Not added to
// scripts/test-fast.ts's PURE_FILES allowlist because this FILE also contains DB-touching tests
// below — the allowlist is per-file, not per-`it`.
describe("computeIntegrationConfigured (pure)", () => {
  const emptyCfg = {
    openrouter: undefined, omniroute: undefined, anthropic: undefined, openai: undefined, google: undefined,
    jina: undefined, firecrawl: undefined, embed: { apiKey: "", baseUrl: "", model: "", dimensions: 1024 },
  } as unknown as PipelineConfig;
  const emptyExtra = { braveApiKey: undefined, exaApiKey: undefined, resendApiKey: undefined, wordpressConfigured: false, r2Configured: false };

  it("is false across the board for an empty config", () => {
    const result = computeIntegrationConfigured(emptyCfg, emptyExtra);
    for (const name of ALL_INTEGRATIONS) expect(result[name]).toBe(false);
  });

  it("flags only the providers present in cfg as configured, leaves the rest false", () => {
    const cfg = {
      ...emptyCfg,
      openrouter: { apiKey: "k", model: "m", baseUrl: "https://openrouter.ai/api/v1" },
      anthropic: { apiKey: "k", model: "m" },
      embed: { apiKey: "embed-key", baseUrl: "https://api.jina.ai/v1", model: "m", dimensions: 1024 },
    } as unknown as PipelineConfig;
    const result = computeIntegrationConfigured(cfg, emptyExtra);
    expect(result.openrouter).toBe(true);
    expect(result.anthropic).toBe(true);
    expect(result.embeddings).toBe(true);
    expect(result.omniroute).toBe(false);
    expect(result.openai).toBe(false);
    expect(result.google).toBe(false);
    expect(result.jina).toBe(false);
    expect(result.firecrawl).toBe(false);
    expect(result.brave).toBe(false);
    expect(result.exa).toBe(false);
    expect(result.r2).toBe(false);
    expect(result.resend).toBe(false);
    expect(result.wordpress).toBe(false);
  });

  it("resolves the extra (non-PipelineConfig) signals: brave/exa/resend keys, wordpress/r2 presence", () => {
    const result = computeIntegrationConfigured(emptyCfg, {
      braveApiKey: "b", exaApiKey: "e", resendApiKey: "r",
      wordpressConfigured: true, r2Configured: true,
    });
    expect(result.brave).toBe(true);
    expect(result.exa).toBe(true);
    expect(result.resend).toBe(true);
    expect(result.wordpress).toBe(true);
    expect(result.r2).toBe(true);
    // Untouched by the extras — still false.
    expect(result.openrouter).toBe(false);
    expect(result.embeddings).toBe(false);
  });

  it("has kind+management metadata for exactly the 13-integration registry, no crawl4ai", () => {
    const expected: IntegrationName[] = [
      "anthropic", "brave", "embeddings", "exa", "firecrawl", "google", "jina", "omniroute",
      "openai", "openrouter", "r2", "resend", "wordpress",
    ];
    expect([...ALL_INTEGRATIONS].sort()).toEqual(expected.sort());
    expect(INTEGRATION_META.openrouter.management).toBe("tokens");
    for (const name of ALL_INTEGRATIONS) {
      if (name === "openrouter") continue;
      expect(INTEGRATION_META[name].management).toBe("env");
    }
  });
});

describe("getIntegrationStatus", () => {
  it("returns the expected shape: every registry integration with configured/kind/management + lastRun", async () => {
    const status = await getIntegrationStatus();
    for (const name of ALL_INTEGRATIONS) {
      expect(typeof status[name].configured).toBe("boolean");
      expect(status[name].kind).toBe(INTEGRATION_META[name].kind);
      expect(status[name].management).toBe(INTEGRATION_META[name].management);
    }
    expect("lastSuccessAt" in status.wordpress).toBe(true);
    expect("tokenSummary" in status.openrouter).toBe(true);
    expect(typeof status.openrouter.tokenSummary.active).toBe("number");
    expect(typeof status.openrouter.tokenSummary.cooldown).toBe("number");
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

  // Fix 2: wordpress.lastSuccessAt must be channel-scoped. Before SP6 adds other distribution
  // channels, `channel` is always "wordpress" in practice, so this regression was latent — this
  // proves it directly by inserting a 'sent' row on a DIFFERENT channel, timestamped in the far
  // future so it would win any unscoped "most recent sent" query, and asserting the WordPress
  // card's lastSuccessAt is completely unaffected by it. Self-cleaning: only touches a temp
  // article + its own temp distribution row, never a seeded one.
  it("wordpress.lastSuccessAt ignores a 'sent' row on a non-wordpress channel, even the most recent one", async () => {
    const [tempArticle] = await db.insert(articles).values({
      title: "Article temporaire (test channel-scope lastSuccessAt)", bodyHtml: "<p>x</p>", status: "approved",
    }).returning();
    let distId: string | null = null;
    try {
      const before = await getIntegrationStatus();

      const [inserted] = await db.insert(distributions).values({
        articleId: tempArticle.id,
        channel: "some-other-channel",
        status: "sent",
        at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365), // 1 year out — would win any unscoped query
      }).returning();
      distId = inserted.id;

      const after = await getIntegrationStatus();
      expect(after.wordpress.lastSuccessAt?.getTime() ?? null).toEqual(before.wordpress.lastSuccessAt?.getTime() ?? null);
    } finally {
      if (distId) await db.delete(distributions).where(eq(distributions.id, distId));
      await db.delete(articles).where(eq(articles.id, tempArticle.id));
    }
  });
});
