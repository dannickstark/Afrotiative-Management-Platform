import { describe, it, expect, afterAll } from "bun:test";
import { db, renderTemplates, renderTemplateVersions } from "@/db";
import { inArray } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// render_templates_scope (db/schema.ts) — a partial unique index on
// (context, channel, category_id) WHERE archived = false, with NULLS NOT DISTINCT (hand-edited
// into db/migrations/0015_slow_selene.sql — drizzle 0.45 cannot express this modifier on
// uniqueIndex()). Without NULLS NOT DISTINCT, Postgres treats NULL category_id (the common case —
// "default for this channel") as distinct from itself, and two templates scoped identically would
// both insert. That is the exact failure this suite guards against.
// render_template_versions_unique — a plain unique index on (template_id, version), guarding the
// immutable-snapshot invariant documented on renderTemplateVersions in db/schema.ts.
// Network-free: real Neon (dev branch) DB only, no external HTTP.
describe("render_templates — unicité de la portée", () => {
  const created: string[] = [];
  const scene = { schemaVersion: 1, canvas: { width: 1, height: 1, background: "#000000" }, layers: [] };

  async function insertTemplate(over: Partial<typeof renderTemplates.$inferInsert> = {}) {
    const [row] = await db.insert(renderTemplates).values({
      name: "test", context: "social_post", channel: "facebook", categoryId: null,
      format: "fb_link", width: 1200, height: 630, scene, ...over,
    }).returning();
    created.push(row.id);
    return row;
  }

  afterAll(async () => {
    if (created.length) await db.delete(renderTemplates).where(inArray(renderTemplates.id, created));
  });

  it("refuse deux gabarits de même portée avec category_id NULL (SQLSTATE 23505)", async () => {
    await insertTemplate();

    // Drizzle wraps the pg error in DrizzleQueryError, so the SQLSTATE is on `.cause`.
    let code: string | undefined;
    try {
      await insertTemplate();
    } catch (e) {
      code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    }
    expect(code).toBe("23505");

    // Rejected insert left no trace: still exactly one row for this scope.
    const rows = await db.select().from(renderTemplates)
      .where(inArray(renderTemplates.id, created));
    expect(rows).toHaveLength(1);
  });

  it("autorise la même portée si l'un est archivé", async () => {
    const a = await insertTemplate({ context: "quote_card", channel: null });
    await db.update(renderTemplates).set({ archived: true }).where(inArray(renderTemplates.id, [a.id]));
    await expect(insertTemplate({ context: "quote_card", channel: null })).resolves.toBeDefined();
  });

  it("refuse deux versions de même numéro pour un gabarit (SQLSTATE 23505)", async () => {
    const t = await insertTemplate({ context: "newsletter_header", channel: null });
    await db.insert(renderTemplateVersions).values({ templateId: t.id, version: 1, scene });

    // Wrapped in an async function: db.insert(...).values(...) is a thenable query builder, not a
    // real Promise instance — bun's expect(...).rejects requires the latter (a bare query builder
    // fails the assertion immediately, without ever running the query, if passed directly).
    async function insertVersionOne() {
      return db.insert(renderTemplateVersions).values({ templateId: t.id, version: 1, scene });
    }

    let code: string | undefined;
    try {
      await insertVersionOne();
    } catch (e) {
      code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    }
    expect(code).toBe("23505");
  });
});
