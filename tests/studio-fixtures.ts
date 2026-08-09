// tests/studio-fixtures.ts — règle partagée pour les portées render_templates statiques utilisées
// par les suites tests/studio-*.test.ts.
//
// render_templates_scope (db/schema.ts, db/migrations/0015_slow_selene.sql) est un index UNIQUE
// PARTIEL sur (context, channel, category_id) WHERE archived = false, NULLS NOT DISTINCT. Toute
// suite qui insère une ligne ACTIVE (non archivée) à une portée STATIQUE (des littéraux fixes, pas
// un category_id fraîchement généré à chaque exécution) doit respecter ces trois règles :
//
//   1. DELETE-THEN-INSERT, pas insert-and-hope : appeler deleteTemplateScope() (ci-dessous) dans le
//      beforeAll de la suite, AVANT d'insérer quoi que ce soit à cette portée. Sans ça, un afterAll
//      qui n'a jamais tourné (Ctrl-C, OOM, un beforeAll qui lève avant d'avoir capturé l'id créé)
//      laisse une ligne poison qui fait échouer TOUTES les exécutions suivantes avec SQLSTATE
//      23505 — pour toujours, jusqu'à suppression manuelle. deleteTemplateScope() rend chaque
//      exécution capable de se réparer elle-même.
//   2. Portée DISTINCTE des autres fichiers de test. Ne jamais réutiliser une portée déjà possédée
//      par un autre fichier (voir le registre ci-dessous) : trois fichiers ont un jour réutilisé
//      indépendamment (quote_card, null, null) en pensant chacun être seul à le faire, et n'ont
//      coexisté que parce que Bun exécute les fichiers séquentiellement et que chaque afterAll
//      nettoyait avant que le suivant en ait besoin — une coïncidence temporelle, pas une garantie.
//   3. Canal SYNTHÉTIQUE, jamais un vrai membre de CHANNELS ("whatsapp", "x", "tiktok", "facebook",
//      "instagram") comme "case connue vide" : ce sont de VRAIS canaux, et un gabarit de départ
//      pourrait un jour y être semé (db/studio-templates.ts). Préférer un préfixe `test-` explicite
//      (ex. "test-priorite-canal", déjà en usage) — UNIQUEMENT pour du texte inséré/interrogé
//      directement en base (db.insert(renderTemplates), resolveTemplate() : channel y reste typé
//      `string | null`, texte libre). renderForArticle, lui, type désormais son option `channel` en
//      `Channel | null` (Important 6, revue de branche) — un littéral synthétique ne passerait PAS
//      la compilation à cet appel précis. Un test qui a besoin d'une portée DISTINCTE pour un appel
//      renderForArticle doit donc varier categoryId (UUID frais par exécution), pas channel.
//
// Registre des portées STATIQUES possédées (à tenir à jour au prochain fichier qui en ajoute une) :
//   tests/studio-schema.test.ts   → (social_post, "test-schema-scope-defaut", null)
//                                    (quote_card, "test-schema-archive-scope", null)
//                                    (newsletter_header, null, null)
//   tests/studio-resolve.test.ts  → (social_post, "test-repli-jamais-publie", null)
//                                    (social_post, "test-repli-instantane-publie", null)
//                                    (social_post, "test-priorite-canal", null)
//                                    (social_post, null, null)
//                                    (quote_card, null, null)               ← SEUL propriétaire ;
//                                    channel DOIT rester null, c'est le repli de contexte sans
//                                    canal que ce fichier teste spécifiquement.
//   tests/studio-bindings.test.ts → aucune portée statique : distingue ses gabarits par un
//                                    categoryId frais (UUID généré à chaque exécution), comme
//                                    (article_image, null, <categoryId>) ci-dessous.
//   tests/studio-rbac.test.ts     → (recap_card, "test-studio-fondations-identique", null)
//                                    (recap_card, "test-studio-fondations-jamais-publie", null)
//                                    (recap_card, "test-studio-fondations-cles-reordonnees", null)
//                                    "test-studio-fondations-modifie" n'y figure PAS : ce canal est
//                                    toujours utilisé avec un categoryId frais (UUID généré à
//                                    chaque exécution), donc structurellement sans risque de
//                                    collision, comme (article_image, null, <categoryId>)
//                                    ci-dessous.
//   tests/studio-template-actions.test.ts → (recap_card, "test-template-actions-create-happy", null)
//                                    (recap_card, "test-template-actions-create-conflict", null)
//                                    (recap_card, "test-template-actions-rename", null)
//                                    (recap_card, "test-template-actions-archive", null)
//                                    (recap_card, "test-template-actions-duplicate-source", null)
//                                    (recap_card, "test-template-actions-duplicate-archived", null)
//                                    (recap_card, "test-template-actions-save", null)
//                                    (recap_card, "test-template-actions-publish-invalid", null)
//                                    (recap_card, "test-template-actions-publish-flow", null)
//                                    (recap_card, "test-template-actions-publish-snapshot", null)
//                                    (recap_card, null, null) ← portée d'atterrissage du repli
//                                    "portée libre" de duplicateTemplate ; libre par construction
//                                    puisque recap_card n'a aucun gabarit de départ semé
//                                    (db/studio-templates.ts) — voir aussi la remarque de
//                                    tests/studio-rbac.test.ts et tests/studio-resolve.test.ts sur ce
//                                    même contexte. Nettoyée dans le beforeAll (deleteTemplateScope)
//                                    ET dans l'afterAll, exactement comme les portées à canal fixe
//                                    ci-dessus, pour ne jamais laisser une ligne active qui casserait
//                                    l'hypothèse "recap_card n'a pas de gabarit par défaut" des
//                                    fichiers voisins. Un DEUXIÈME test (« duplique une source déjà à
//                                    la portée par défaut ») insère aussi, temporairement, sa PROPRE
//                                    ligne active directement à cette portée (Important 1, revue lot
//                                    1) — il s'exécute en premier dans son describe et libère la
//                                    portée dans un `finally` avant que le test du repli n'en ait
//                                    besoin.
//   tests/studio-autosave.test.ts → (recap_card, "test-autosave-publish-refuse", null)
//   tests/studio-preview.test.ts  → (recap_card, "test-preview-actions", null)
//                                    (social_post, "test-preview-fail", null)
//
// (article_image, null, <categoryId>) et (social_post, "test-priorite-canal", <categoryId>) ne
// figurent PAS dans le registre ci-dessus : leur categoryId est un UUID généré à chaque exécution
// (db.insert wpCategories dans un beforeAll), donc structurellement sans risque de collision
// inter-exécutions.
import { db, renderTemplates } from "@/db";
import { and, eq, isNull } from "drizzle-orm";

export async function deleteTemplateScope(
  context: string,
  channel: string | null,
  categoryId: string | null,
): Promise<void> {
  await db.delete(renderTemplates).where(and(
    eq(renderTemplates.context, context),
    channel === null ? isNull(renderTemplates.channel) : eq(renderTemplates.channel, channel),
    categoryId === null ? isNull(renderTemplates.categoryId) : eq(renderTemplates.categoryId, categoryId),
  ));
}
