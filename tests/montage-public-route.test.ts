import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db, montageShares, scriptVariants, user, videoProjects } from "@/db";
import { createShareCore } from "@/lib/montage/access";
import MontagePublicPage from "@/app/(public)/montage/[token]/page";

const PROJECT_ID = "00000000-0000-0000-0000-0000000b0537";
const USER_ID = "test-montage-public-route-user";

afterAll(async () => {
  await db.delete(montageShares).where(eq(montageShares.projectId, PROJECT_ID));
  await db.delete(videoProjects).where(eq(videoProjects.id, PROJECT_ID));
  await db.delete(user).where(eq(user.id, USER_ID));
});

test("jeton invalide ou révoqué → message neutre, sans fuite", async () => {
  const el = await MontagePublicPage({ params: Promise.resolve({ token: "afro_montage_" + "z".repeat(40) }) });
  const html = renderToStaticMarkup(el);
  expect(html).toContain("Lien invalide ou expiré");
});

test("jeton valide → affiche le titre du projet via le conducteur", async () => {
  await db.insert(user).values({ id: USER_ID, name: "Test Monteur Route", email: "test-montage-public-route@example.com" }).onConflictDoNothing();
  await db.insert(videoProjects).values({ id: PROJECT_ID, title: "Projet Route Publique", subject: null }).onConflictDoNothing();
  await db.insert(scriptVariants).values({ projectId: PROJECT_ID, platform: "youtube_long", position: 0 });

  const { token } = await createShareCore({ projectId: PROJECT_ID, userId: USER_ID, expiresAt: null });

  const el = await MontagePublicPage({ params: Promise.resolve({ token }) });
  const html = renderToStaticMarkup(el);
  expect(html).toContain("Projet Route Publique");
});
