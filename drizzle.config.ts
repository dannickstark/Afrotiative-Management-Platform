import { defineConfig } from "drizzle-kit";

try { process.loadEnvFile(".env.local"); } catch {}

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DIRECT_URL! },
});
