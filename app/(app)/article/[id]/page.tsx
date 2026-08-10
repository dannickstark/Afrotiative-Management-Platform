import { notFound } from "next/navigation";
import { getArticle } from "@/lib/queries/article";
import { getEnabledChannelsForArticle } from "@/lib/queries/diffusion";
import { requireUser } from "@/lib/session";
import { isLockActive } from "@/lib/lock";
import { can } from "@/lib/rbac";
import { getStudioConfig } from "@/lib/studio/config";
import { EditorShell } from "@/components/article/editor-shell";
import { db, wpTags } from "@/db";

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const article = await getArticle(id);
  if (!article) notFound();
  const lockedByOther = !!article.lockedBy && article.lockedBy !== user.id && isLockActive(article.lockedAt) && user.role !== "admin";
  // Mirrored WordPress tags, used by TagsInput to decide whether a typed tag
  // name already exists (isNew=false) or would create a new WP term (isNew=true).
  const wpTagRows = await db.select().from(wpTags);
  const wpTagNames = wpTagRows.map((t) => t.name);
  // D1 §4 — Diffusion panel data. Read here (not inside a client component/action) for the same
  // reason article/tags already are: a plain server-side read, no RBAC check of its own
  // (lib/queries/diffusion.ts documents this — access to VIEW is ungated, same as every other
  // lib/queries/*.ts read; only the SEND/GENERATE actions are RBAC-guarded).
  const diffusionChannels = await getEnabledChannelsForArticle(id);
  const canSendDiffusion = can(user.role, "social", "send");
  const r2Configured = getStudioConfig() !== null;
  return (
    <EditorShell
      article={article}
      role={user.role}
      lockedByOther={lockedByOther}
      wpTagNames={wpTagNames}
      diffusionChannels={diffusionChannels}
      canSendDiffusion={canSendDiffusion}
      r2Configured={r2Configured}
    />
  );
}
