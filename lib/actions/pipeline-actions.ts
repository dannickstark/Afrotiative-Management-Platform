"use server";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { revalidatePath } from "next/cache";

export async function runPipelineNow() {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");

  // Dynamic import (kept AFTER the RBAC check above): runPipeline() transitively pulls in the
  // extraction chain (jsdom, via @mozilla/readability), whose internal css-tree dependency does
  // a relative require('../data/patch.json') that Turbopack can't statically resolve when this
  // "use server" module is analyzed at build time. Once Task 9 wires this action into a page, a
  // top-level static import would break `bun run build` exactly as it did for the route handler;
  // deferring the load sidesteps that while behaving identically at request time.
  const { runPipeline } = await import("@/lib/pipeline/run");
  const { hasRunningRun } = await import("@/lib/pipeline/overlap");

  // Fast path: avoid opening a run (and its DB round-trips) when one is already in flight.
  // runPipeline() re-checks this itself, so this is a belt-and-suspenders early exit only.
  if (await hasRunningRun()) return { ok: false as const, message: "Une exécution est déjà en cours." };

  const res = await runPipeline({ triggeredBy: "manual" });
  if (res.status === "skipped") return { ok: false as const, message: "Une exécution est déjà en cours." };

  revalidatePath("/runs");
  revalidatePath("/dashboard");
  revalidatePath("/queue");
  return { ok: true as const, ...res };
}
