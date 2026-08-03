"use server";
import { db, articles, articleRevisions, distributions } from "@/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { z } from "zod";

export async function quickApprove(id: string) {
  const user = await requireUser();
  requirePermission(user.role, "article", "approve");
  await db.update(articles).set({ status: "published", publishedAt: new Date(), updatedAt: new Date() }).where(eq(articles.id, id));
  await db.insert(distributions).values({ articleId: id, channel: "wordpress", status: "stubbed" });
  await db.insert(articleRevisions).values({ articleId: id, actorId: user.id, action: "approuvé (publication simulée)" });
  revalidatePath("/queue"); revalidatePath("/dashboard");
}

const rejectSchema = z.object({ id: z.string().uuid(), reason: z.string().min(3, "Motif requis") });
export async function quickReject(input: { id: string; reason: string }) {
  const user = await requireUser();
  requirePermission(user.role, "article", "reject");
  const { id, reason } = rejectSchema.parse(input);
  await db.update(articles).set({ status: "rejected", rejectReason: reason, updatedAt: new Date() }).where(eq(articles.id, id));
  await db.insert(articleRevisions).values({ articleId: id, actorId: user.id, action: "rejeté", detail: reason });
  revalidatePath("/queue"); revalidatePath("/dashboard");
}
