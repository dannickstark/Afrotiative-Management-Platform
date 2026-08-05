// Next.js instrumentation hook (SP2) — `register()` runs once when a new server instance starts,
// before it accepts requests (stable since Next 15.0.0, no config flag needed — confirmed against
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md and
// .../02-guides/instrumentation.md). Must live at the repo root (no `src` folder here).
//
// Next calls `register()` in every runtime (nodejs AND edge) — the docs' own
// "Importing runtime-specific code" example gates on NEXT_RUNTIME for exactly this reason. The
// in-app cron scheduler touches the DB (Neon) and Node timers, neither available on the edge
// runtime, and must never run twice at build time — so it's dynamically imported only when
// NEXT_RUNTIME === "nodejs".
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { initScheduler } = await import("@/lib/pipeline/scheduler");
  await initScheduler();
}
