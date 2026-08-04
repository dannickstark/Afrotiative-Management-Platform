import { notFound } from "next/navigation";
import { getArticle } from "@/lib/queries/article";
import { requireUser } from "@/lib/session";
import { isLockActive } from "@/lib/lock";
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
  return <EditorShell article={article} role={user.role} lockedByOther={lockedByOther} wpTagNames={wpTagNames} />;
}
