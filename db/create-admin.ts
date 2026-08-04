// Production first-admin bootstrap. Creates ONE admin user without seeding any demo
// data. Unlike db/seed.ts (which wipes app tables and uses a shared demo password),
// this is idempotent-safe: it refuses if the email already exists.
//
// Usage (password is read from env only — never a CLI arg, so it can't land in shell
// history or `ps` output):
//   ADMIN_EMAIL=you@afrotiative.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='...' bun run db:create-admin
//
// The password is never printed or logged.
import { db, user } from "@/db";
import { createCredentialUser } from "@/lib/create-user";
import { eq } from "drizzle-orm";

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim();
  const name = process.env.ADMIN_NAME?.trim();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !name || !password) {
    console.error(
      "Manque une variable. Requis : ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD.\n" +
        "Ex : ADMIN_EMAIL=you@afrotiative.com ADMIN_NAME=\"Votre Nom\" ADMIN_PASSWORD='...' bun run db:create-admin",
    );
    process.exit(1);
  }
  if (password.length < 12) {
    console.error("ADMIN_PASSWORD doit faire au moins 12 caractères.");
    process.exit(1);
  }

  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (existing) {
    console.error(`Un compte existe déjà pour ${email}. Aucune modification.`);
    process.exit(1);
  }

  await createCredentialUser({ email, name, role: "admin", password });
  console.log(`Admin créé : ${name} <${email}>. Connectez-vous puis changez le mot de passe.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Échec de création de l'admin :", err instanceof Error ? err.message : err);
  process.exit(1);
});
