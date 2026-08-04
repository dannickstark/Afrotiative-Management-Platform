// One-time baseline for a database whose schema ALREADY exists but has NO drizzle
// migration journal — i.e. it was set up with `db:push` (which applies schema directly
// and records nothing). Without this, `db:migrate:deploy` sees an empty journal and tries
// to recreate every object, failing on "type/table already exists".
//
// This records the current migration files as already-applied (in drizzle.__drizzle_migrations),
// so `db:migrate:deploy` afterwards applies only FUTURE migrations. Idempotent — re-running
// inserts nothing. Uses drizzle's own readMigrationFiles so the recorded hashes match exactly.
//
// Run ONCE per existing-schema branch:
//   bun run db:baseline                 # local dev (.env.local → dev branch)
//   railway run bun run db:baseline     # production (Railway injects the production env)
//
// SAFETY: refuses on an empty database (no `articles` table). A truly empty branch must NOT
// be baselined — run `db:migrate:deploy` there instead, which applies the whole schema.
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Pool } from "pg";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DIRECT_URL (ou DATABASE_URL) manquant.");
  process.exit(1);
}

async function main() {
  let host = "(inconnu)";
  try { host = new URL(url!).host; } catch { /* leave as unknown */ }
  console.log(`baseline → cible : ${host}`);

  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  const migrations = readMigrationFiles({ migrationsFolder });
  const pool = new Pool({ connectionString: url });
  try {
    const { rows: [check] } = await pool.query("SELECT to_regclass('public.articles') IS NOT NULL AS present");
    if (!check?.present) {
      console.error(
        "Base vide (table 'articles' absente) : ne PAS baseline.\n" +
          "Lancez plutôt : bun run db:migrate:deploy (applique tout le schéma).",
      );
      process.exit(1);
    }

    await pool.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await pool.query(
      'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)',
    );
    const { rows } = await pool.query('SELECT hash FROM "drizzle"."__drizzle_migrations"');
    const existing = new Set(rows.map((r) => r.hash as string));

    let inserted = 0;
    for (const m of migrations) {
      if (existing.has(m.hash)) continue;
      await pool.query(
        'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
        [m.hash, m.folderMillis],
      );
      inserted++;
    }
    console.log(
      `Baseline terminé : ${inserted} migration(s) marquée(s) appliquée(s), ${migrations.length - inserted} déjà présente(s).`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Échec du baseline :", err instanceof Error ? err.message : err);
  process.exit(1);
});
