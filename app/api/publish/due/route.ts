import { NextRequest, NextResponse } from "next/server";
import { publishDueArticles } from "@/lib/wp/publish-due";
import { safeEqual } from "@/lib/timing-safe";

// Cron trigger for scheduled auto-publish. Bearer-secret gated: with no PUBLISH_TRIGGER_SECRET
// configured OR a non-matching Authorization header this is ALWAYS 401 — never a silent open
// endpoint (same pattern as /api/pipeline/run).
export async function POST(req: NextRequest) {
  const secret = process.env.PUBLISH_TRIGGER_SECRET;
  const auth = req.headers.get("authorization");
  // Constant-time compare: !== short-circuits on the first differing byte, a timing side-channel.
  if (!secret || !auth || !safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const res = await publishDueArticles();
  return NextResponse.json(res);
}

export const maxDuration = 300;
