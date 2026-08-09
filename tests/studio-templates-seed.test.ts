import { describe, it, expect, afterAll } from "bun:test";
import { db, renderTemplates } from "@/db";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { seedStudioTemplates } from "@/db/studio-templates";

// Ce test travaille directement sur les TROIS portées réelles de db/studio-templates.ts :
// `seedStudioTemplates()` n'accepte aucune liste alternative de gabarits (STARTERS est un module-
// privé fixe), donc c'est la seule façon de couvrir sa convergence réelle dans le dev DB partagé où
// ces trois gabarits sont censés rester en place en permanence (§9 de la spec — « point de départ
// à l'éditeur V2 »). Toute mutation faite ici (archivage) est restaurée dans afterAll.
async function findActiveAt(context: string, channel: string | null) {
  const [row] = await db.select().from(renderTemplates).where(and(
    eq(renderTemplates.context, context),
    channel === null ? isNull(renderTemplates.channel) : eq(renderTemplates.channel, channel),
    isNull(renderTemplates.categoryId),
    eq(renderTemplates.archived, false),
  )).limit(1);
  return row ?? null;
}

const createdByThisTest: string[] = [];
let archivedOriginalId: string | null = null;

afterAll(async () => {
  // Restaure l'état d'origine : supprime D'ABORD le remplaçant créé pendant le test, PUIS
  // dé-archive le gabarit d'origine — dans cet ordre précis, sinon la dé-archivation retomberait
  // sur la même portée (article_image, null, null) que le remplaçant encore actif et violerait
  // l'index unique (constaté à l'exécution, cf. l'incident décrit dans le rapport de tâche).
  //
  // Les deux restaurations sont dans des try/catch SÉPARÉS, à l'image de afterAll dans
  // tests/studio-e2e.test.ts : sans ça, une erreur transitoire (connexion coupée, timeout de pool…)
  // sur la suppression ferait sauter la dé-archivation qui suit, et le gabarit de départ
  // article_image resterait DÉFINITIVEMENT archivé dans le dev DB partagé — plus grave qu'une simple
  // fuite de ligne de test, puisque resolveTemplate exclut les lignes archivées : plus aucun
  // gabarit par défaut pour ce contexte tant que quelqu'un ne relance pas `db:studio-templates` à la
  // main. Chaque étape tente donc de restaurer ce qu'elle peut, inconditionnellement, et avale ce
  // qu'elle ne peut pas (en le signalant) plutôt que de laisser une erreur bloquer la suite.
  if (createdByThisTest.length) {
    try {
      await db.delete(renderTemplates).where(inArray(renderTemplates.id, createdByThisTest));
    } catch (e) {
      console.error("Nettoyage seedStudioTemplates — échec de suppression du remplaçant :", e);
    }
  }
  if (archivedOriginalId) {
    try {
      await db.update(renderTemplates).set({ archived: false }).where(eq(renderTemplates.id, archivedOriginalId));
    } catch (e) {
      console.error("Nettoyage seedStudioTemplates — échec de dé-archivage de l'original :", e);
    }
  }
});

describe("seedStudioTemplates", () => {
  it("sème (ou retrouve) les trois gabarits, puis un second passage ne crée rien", async () => {
    const first = await seedStudioTemplates();
    // Ne présume PAS que ce premier appel du fichier est le tout premier appel jamais fait dans ce
    // dev DB (db:studio-templates a déjà pu tourner avant cette suite) : l'invariant vrai dans les
    // deux cas est que les trois portées existent APRÈS l'appel, créées ou déjà là.
    expect(first.created + first.skipped).toBe(3);

    const rows = await Promise.all([
      findActiveAt("article_image", null),
      findActiveAt("social_post", "facebook"),
      findActiveAt("social_post", "instagram"),
    ]);
    for (const row of rows) expect(row).not.toBeNull();

    // Deuxième passage : maintenant que les trois existent forcément (ci-dessus), le résultat est
    // déterministe.
    const second = await seedStudioTemplates();
    expect(second).toEqual({ created: 0, skipped: 3 });
  });

  it("un gabarit archivé est réinstallé au passage suivant — convergence, pas seulement idempotence", async () => {
    const before = await findActiveAt("article_image", null);
    if (!before) throw new Error("gabarit de départ article_image introuvable — le test précédent aurait dû le garantir");

    await db.update(renderTemplates).set({ archived: true }).where(eq(renderTemplates.id, before.id));
    archivedOriginalId = before.id;

    // Le gabarit "article_image" par défaut n'a plus AUCUNE ligne active à sa portée : le SELECT
    // d'existence (avec eq(archived, false), corrigé en revue) doit donc le considérer absent et le
    // réinstaller — created: 1 pour lui, skipped: 2 pour les deux autres, inchangés.
    const r = await seedStudioTemplates();
    expect(r.created).toBe(1);
    expect(r.skipped).toBe(2);

    const after = await findActiveAt("article_image", null);
    expect(after).not.toBeNull();
    expect(after!.id).not.toBe(before.id); // une NOUVELLE ligne, pas l'ancienne réactivée
    if (after) createdByThisTest.push(after.id);

    // Un troisième passage retrouve maintenant les trois (le remplaçant + les deux jamais touchés) :
    // plus rien à créer.
    const third = await seedStudioTemplates();
    expect(third).toEqual({ created: 0, skipped: 3 });
  });
});
