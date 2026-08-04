// Production migration runner. Applies the committed SQL files in db/migrations/ using
// ONLY runtime deps (drizzle-orm + pg) — no drizzle-kit — so it works in a deploy image
// where devDependencies have been pruned. Railway runs this as the Pre-deploy Command:
// once per deployment, before traffic shifts to the new version. Idempotent — migrations
// already recorded in the drizzle journal are skipped, so it is safe to run every deploy.
//
// Uses DIRECT_URL (non-pooled) for DDL, falling back to DATABASE_URL. The target host is
// printed (creds never are) so the deploy log shows which branch was migrated.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DIRECT_URL (ou DATABASE_URL) manquant : impossible de migrer.");
  process.exit(1);
}

async function main() {
  let host = "(inconnu)";
  try { host = new URL(url!).host; } catch { /* leave as unknown */ }
  console.log(`db:migrate → cible : ${host}`);

  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder });
  await pool.end();
  console.log("Migrations appliquées (celles déjà présentes sont ignorées).");
}

main().catch((err) => {
  console.error("Échec de migration :", err instanceof Error ? err.message : err);
  process.exit(1);
});
