"use server";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { runPipeline } from "@/lib/pipeline/run";
import { hasRunningRun } from "@/lib/pipeline/overlap";
import { revalidatePath } from "next/cache";

export async function runPipelineNow() {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");

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
