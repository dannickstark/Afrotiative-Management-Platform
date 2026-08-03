import { defineConfig } from "drizzle-kit";

try { process.loadEnvFile(".env.local"); } catch {}

if (!process.env.DIRECT_URL) throw new Error("DIRECT_URL manquant : renseignez .env.local (voir .env.example).");

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DIRECT_URL! },
});
