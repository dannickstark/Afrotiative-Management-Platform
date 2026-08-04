import { NextRequest, NextResponse } from "next/server";
import { publishDueArticles } from "@/lib/wp/publish-due";

// Cron trigger for scheduled auto-publish. Bearer-secret gated: with no PUBLISH_TRIGGER_SECRET
// configured OR a non-matching Authorization header this is ALWAYS 401 — never a silent open
// endpoint (same pattern as /api/pipeline/run).
export async function POST(req: NextRequest) {
  const secret = process.env.PUBLISH_TRIGGER_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const res = await publishDueArticles();
  return NextResponse.json(res);
}

export const maxDuration = 300;
