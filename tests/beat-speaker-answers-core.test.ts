import { afterAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db, videoProjects, scriptVariants, scriptBeats, interviewSpeakers } from "@/db";
import { updateBeatCore, RefusalError } from "@/lib/video/persist";

const P1 = "00000000-0000-0000-0000-0000000005b1";
const P2 = "00000000-0000-0000-0000-0000000005b2";

// script_beats.speaker_id → interview_speakers.id n'a pas de ON DELETE CASCADE (voir
// deleteSpeakerCore, qui dénoue explicitement avant de supprimer) : une suppression en cascade de
// videoProjects viole donc cette FK tant que des beats référencent encore un intervenant du même
// projet. On dénoue d'abord.
async function purgeProject(id: string): Promise<void> {
  const variants = await db.select({ id: scriptVariants.id }).from(scriptVariants).where(eq(scriptVariants.projectId, id));
  const variantIds = variants.map((v) => v.id);
  if (variantIds.length > 0) {
    await db.update(scriptBeats).set({ speakerId: null }).where(inArray(scriptBeats.variantId, variantIds));
  }
  await db.delete(videoProjects).where(eq(videoProjects.id, id));
}

afterAll(async () => {
  await purgeProject(P1);
  await purgeProject(P2);
});

async function setup() {
  // Chaque test rappelle setup() : purge d'abord pour repartir d'un état propre — sinon la
  // contrainte d'unicité (project_id, position) sur script_variants entre en conflit d'un test à
  // l'autre.
  await purgeProject(P1);
  await purgeProject(P2);
  await db.insert(videoProjects).values({ id: P1, title: "Projet 1", subject: null });
  await db.insert(videoProjects).values({ id: P2, title: "Projet 2", subject: null });

  const [v1] = await db.insert(scriptVariants).values({ projectId: P1, platform: "interview", position: 0 }).returning();
  const [v1b] = await db.insert(scriptVariants).values({ projectId: P1, platform: "youtube_long", position: 1 }).returning();
  const [v2] = await db.insert(scriptVariants).values({ projectId: P2, platform: "interview", position: 0 }).returning();

  const [q] = await db.insert(scriptBeats).values({
    variantId: v1.id, externalId: "q1", position: 0, kind: "question", spokenText: "Question ?",
  }).returning();
  const [r] = await db.insert(scriptBeats).values({
    variantId: v1.id, externalId: "r1", position: 1, kind: "reponse", spokenText: "Réponse.",
  }).returning();
  const [otherKind] = await db.insert(scriptBeats).values({
    variantId: v1.id, externalId: "n1", position: 2, kind: "narration", spokenText: "Narration.",
  }).returning();
  const [qOtherVariant] = await db.insert(scriptBeats).values({
    variantId: v1b.id, externalId: "q2", position: 0, kind: "question", spokenText: "Autre variante ?",
  }).returning();

  const [speakerP1] = await db.insert(interviewSpeakers).values({ projectId: P1, name: "Awa" }).returning();
  const [speakerP2] = await db.insert(interviewSpeakers).values({ projectId: P2, name: "Kofi" }).returning();

  return { v1, v1b, v2, q, r, otherKind, qOtherVariant, speakerP1, speakerP2 };
}

test("assigner un intervenant du projet réussit", async () => {
  const { r, speakerP1 } = await setup();
  await updateBeatCore({ beatId: r.id, speakerId: speakerP1.id });
  const [row] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, r.id));
  expect(row.speakerId).toBe(speakerP1.id);
});

test("assigner un intervenant d'un autre projet est refusé", async () => {
  const { r, speakerP2 } = await setup();
  await expect(updateBeatCore({ beatId: r.id, speakerId: speakerP2.id })).rejects.toBeInstanceOf(RefusalError);
});

test("answersBeatId : réponse vers question de la même variante réussit", async () => {
  const { q, r } = await setup();
  await updateBeatCore({ beatId: r.id, answersBeatId: q.id });
  const [row] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, r.id));
  expect(row.answersBeatId).toBe(q.id);
});

test("answersBeatId : source non-réponse est refusée", async () => {
  const { q, otherKind } = await setup();
  await expect(updateBeatCore({ beatId: otherKind.id, answersBeatId: q.id })).rejects.toBeInstanceOf(RefusalError);
});

test("answersBeatId : cible non-question est refusée", async () => {
  const { r, otherKind } = await setup();
  await expect(updateBeatCore({ beatId: r.id, answersBeatId: otherKind.id })).rejects.toBeInstanceOf(RefusalError);
});

test("answersBeatId : cible d'une autre variante est refusée", async () => {
  const { r, qOtherVariant } = await setup();
  await expect(updateBeatCore({ beatId: r.id, answersBeatId: qOtherVariant.id })).rejects.toBeInstanceOf(RefusalError);
});

test("answersBeatId : répondre à soi-même est refusé", async () => {
  const { r } = await setup();
  await expect(updateBeatCore({ beatId: r.id, answersBeatId: r.id })).rejects.toBeInstanceOf(RefusalError);
});

test("answersBeatId pendant (question supprimée) : une édition qui ne le touche pas réussit et le laisse tel quel", async () => {
  const { q, r, otherKind } = await setup();
  await updateBeatCore({ beatId: r.id, answersBeatId: q.id });

  // La question ciblée est supprimée (ex. fusion d'import) : answersBeatId devient pendant.
  await db.delete(scriptBeats).where(eq(scriptBeats.id, q.id));

  // Une édition qui ne touche PAS answersBeatId ne doit pas re-valider la cible pendante — elle
  // ne doit donc pas être refusée, et la valeur pendante reste inchangée.
  const result = await updateBeatCore({ beatId: r.id, spokenText: "édité" });
  expect(result.spokenText).toBe("édité");
  const [row] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, r.id));
  expect(row.answersBeatId).toBe(q.id);

  // Poser une NOUVELLE valeur invalide (différente de la valeur pendante actuelle) doit en
  // revanche toujours être refusé — seule la valeur INCHANGÉE échappe à la re-validation.
  await expect(updateBeatCore({ beatId: r.id, answersBeatId: otherKind.id })).rejects.toBeInstanceOf(RefusalError);
});
