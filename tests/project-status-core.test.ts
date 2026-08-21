import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, videoProjects } from "@/db";
import { setProjectStatusCore } from "@/lib/video/persist";

const P = "00000000-0000-0000-0000-0000000004b1";

afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, P)); });

test("setProjectStatusCore : enchaîne les transitions permises, refuse le reste", async () => {
  // Le statut par défaut à l'insert est "brouillon", qui n'a aucune transition autorisée — on pose
  // explicitement "en_ecriture" pour pouvoir enchaîner la chaîne réelle du tournage.
  await db.insert(videoProjects).values({ id: P, title: "T", subject: null, status: "en_ecriture" }).onConflictDoNothing();

  await setProjectStatusCore({ projectId: P, to: "pret_a_tourner" });
  let [row] = await db.select({ status: videoProjects.status }).from(videoProjects).where(eq(videoProjects.id, P));
  expect(row.status).toBe("pret_a_tourner");

  await setProjectStatusCore({ projectId: P, to: "tourne" });
  [row] = await db.select({ status: videoProjects.status }).from(videoProjects).where(eq(videoProjects.id, P));
  expect(row.status).toBe("tourne");

  await setProjectStatusCore({ projectId: P, to: "en_montage" });
  [row] = await db.select({ status: videoProjects.status }).from(videoProjects).where(eq(videoProjects.id, P));
  expect(row.status).toBe("en_montage");

  // Transition illégale : en_montage → tourne n'est pas dans la table des transitions.
  await expect(setProjectStatusCore({ projectId: P, to: "tourne" })).rejects.toThrow();

  // Projet inconnu.
  await expect(
    setProjectStatusCore({ projectId: "00000000-0000-0000-0000-000000000000", to: "pret_a_tourner" }),
  ).rejects.toThrow();
});
