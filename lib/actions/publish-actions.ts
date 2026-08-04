"use server";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { revalidatePath } from "next/cache";
import { unpublishArticle, republishArticle } from "@/lib/wp/publish";

export async function unpublishArticleAction(id: string) {
  const u = await requireUser();
  requirePermission(u.role, "article", "publish");
  const res = await unpublishArticle(id);
  revalidatePath(`/article/${id}`);
  revalidatePath("/queue");
  revalidatePath("/published");
  revalidatePath("/dashboard");
  return res;
}

export async function republishArticleAction(id: string) {
  const u = await requireUser();
  requirePermission(u.role, "article", "publish");
  const res = await republishArticle(id);
  revalidatePath(`/article/${id}`);
  revalidatePath("/dashboard");
  return res;
}
