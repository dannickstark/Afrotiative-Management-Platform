"use server";
import { db, articles, articleRevisions } from "@/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { publishArticle } from "@/lib/wp/publish";
import { z } from "zod";

export async function quickApprove(id: string) {
  const user = await requireUser();
  requirePermission(user.role, "article", "approve");
  // Field validation (category required, image credit required when a featured
  // image is set) is enforced inside publishArticle itself — no need to
  // duplicate it here; a failed check surfaces as res.ok === false below with
  // the same French message.
  const res = await publishArticle(id);
  if (!res.ok) throw new Error(res.message);
  revalidatePath("/queue"); revalidatePath("/dashboard");
  return res;
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
