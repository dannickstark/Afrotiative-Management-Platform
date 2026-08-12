import { NextRequest, NextResponse } from "next/server";
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { safeEqual } from "@/lib/timing-safe";

export async function POST(req: NextRequest) {
  const secret = getPipelineConfig().triggerSecret;
  const auth = req.headers.get("authorization");
  // No secret configured => never an open endpoint: always 401, not a silent bypass.
  // Constant-time compare: !== short-circuits on the first differing byte, a timing side-channel.
  if (!secret || !auth || !safeEqual(auth, `Bearer ${secret}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Dynamic import: runPipeline() transitively pulls in the extraction chain (jsdom, via
  // @mozilla/readability). Statically importing that at module top-level breaks Turbopack's
  // build-time route-config collection ("Cannot find module '../data/patch.json'" — jsdom's
  // internal css-tree dependency doesn't resolve its relative data file when the module is
  // evaluated in that isolated build worker). A dynamic import keeps jsdom out of this route's
  // static module graph at build time while behaving identically at request time.
  const { runPipeline } = await import("@/lib/pipeline/run");
  const { hasRunningRun } = await import("@/lib/pipeline/overlap");

  // Fast path: avoid opening a run when one is already in flight. runPipeline() re-checks
  // this itself and returns status:"skipped" too, so this is belt-and-suspenders only.
  if (await hasRunningRun()) return NextResponse.json({ error: "already running" }, { status: 409 });

  const res = await runPipeline({ triggeredBy: "scheduled" });
  if (res.status === "skipped") return NextResponse.json({ error: "already running" }, { status: 409 });

  return NextResponse.json(res);
}

export const maxDuration = 300;
