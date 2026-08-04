# Afrotiative Media — SP4 : Observabilité du pipeline (écran Exécutions complet)

**Date :** 2026-08-04
**Statut :** Design validé — prêt pour le plan d'implémentation
**Branche :** `feat/sp4-pipeline-observability` (empilée sur SP3, qui est empilée sur SP0+SP1)
**Portée :** Sous-projet SP4. SP0+SP1 Tasks 14–15 restent en pause.

Documents sources : `afrotiative-uiux-brief.md` §6.5 (Exécutions du pipeline), spec SP3.

---

## 1. Objectif

Rendre le pipeline **diagnosticable par un non-développeur**. SP3 a produit une surface minimale (bouton « Lancer maintenant » + table des dernières exécutions) et peuple déjà `pipeline_runs` / `pipeline_steps`. SP4 transforme cette table en outil d'observabilité : un **tiroir latéral** de détail par exécution avec la **trace des étapes**, des erreurs **reformulées en français** (détail technique en repli), et des actions de **reprise** ciblées. « La boîte noire du pipeline doit devenir lisible. »

Principe préservé : la barrière de revue humaine reste intacte — toute reprise ne fait que déposer un article `pending`, jamais publier.

---

## 2. Périmètre

**Inclus :**
- Une migration **additive** : `pipeline_steps.raw_item_id` (uuid, nullable, FK → `raw_items`) — pour attribuer chaque étape par-élément à son item source (regroupement + reprise ciblée). Petit ajustement dans `run.ts` (SP3) pour l'estampiller.
- **Tiroir de détail d'exécution** (shadcn `Sheet`) : résumé de l'exécution + **trace des étapes regroupée** (étapes niveau-flux, puis un groupe repliable par élément titré depuis `raw_items`), avec message d'erreur français prioritaire + disclosure « Voir les détails techniques » (`error_technical`).
- **Actions de reprise** (RBAC `pipeline:configure` = Admin) : « Relancer l'exécution » (réutilise `runPipelineNow`) et « Relancer cet élément » (nouvelle action `reprocessRawItem` qui rejoue la chaîne pour un `raw_item` en **contournant la déduplication**, sous une exécution `triggered_by:"reprocess"`).
- **Rafraîchissement auto léger** : `router.refresh()` toutes ~4 s **tant qu'une exécution est `running`**, arrêt sinon.

**Hors périmètre :** publication WordPress (SP5), SP0+SP1 Tasks 14–15, tout nouveau moteur/planificateur. Pas de streaming temps-réel intra-étape (l'orchestration in-app écrit les étapes au fil de l'eau ; le rafraîchissement auto suffit).

---

## 3. Modèle de données

**Une seule migration additive :** ajouter `raw_item_id uuid NULL REFERENCES raw_items(id) ON DELETE SET NULL` à `pipeline_steps`. Jamais destructif. Les étapes niveau-flux/exécution (ex. « Lecture du flux ») gardent `raw_item_id` NULL ; les étapes par-élément (Extraction / Embedding / Regroupement / Génération IA / Dépôt en revue) portent l'id du `raw_item`.

Aucune autre table modifiée : `pipeline_runs` et `pipeline_steps` (SP3) portent déjà `triggered_by`, `status`, `feeds_read`, `new_items`, `published`, `started_at`, `finished_at` / `name`, `status`, `duration_ms`, `error_message`, `error_technical`.

---

## 4. Ajustement SP3 (attribution des étapes)

Dans `lib/pipeline/run.ts`, lors de l'écriture des `pipeline_steps` d'un élément, renseigner `raw_item_id` = l'id retourné par `recordRawItem` (déjà disponible dans la boucle par-élément). `stageItem` continue de retourner ses `StepRec` ; `run.ts` les persiste en y joignant `runId` **et** `rawItemId`. Les étapes de flux (lecture RSS, échec de flux, limite atteinte) restent `raw_item_id` NULL. Changement minime, sans impact sur la barrière de revue.

---

## 5. Requêtes

- `getRuns(limit=20)` — existe déjà (page `/runs`, tri `started_at desc` + compte d'étapes en échec). Réutilisée.
- **`getRunDetail(runId)`** (nouvelle) → `{ run, feedSteps: Step[], items: { rawItemId, title, url, steps: Step[], hasFailure }[] }` : la run, ses étapes niveau-flux (raw_item_id NULL) triées, et les étapes par-élément regroupées par `raw_item_id` avec le titre/url joint depuis `raw_items` (via `raw_title`). Chaque groupe expose `hasFailure` pour l'affichage + le bouton de reprise.

---

## 6. UI

### 6.1 Liste des exécutions (`app/(app)/runs/page.tsx` — évolution)
Garder la table SP3 (horodatage, déclencheur, flux lus, nouveaux, statut + nb étapes en échec) ; rendre chaque **ligne cliquable** → ouvre le tiroir de détail. Conserver le bouton « Lancer une exécution maintenant » (Admin) et la garde `pipeline:read` de la page. Enrober la liste dans un composant client gérant le tiroir + le rafraîchissement auto.

### 6.2 Tiroir de détail (`components/pipeline/run-detail-sheet.tsx`, client)
- **Résumé** : `StatusBadge` pipeline (Succès / Succès partiel / Échec / En cours), déclencheur, horodatage + durée (`finished_at − started_at`), flux lus / nouveaux, mention « fournisseur dégradé » si un élément porte `confidence.aiDegraded`.
- **Trace regroupée** : d'abord les étapes niveau-flux ; puis un `Collapsible`/accordéon **par élément** (titre depuis `raw_items`, badge d'état agrégé), listant ses étapes ordonnées : nom, `StatusBadge`, durée. Pour une étape **en échec** : `error_message` (français) en évidence + disclosure « Voir les détails techniques » révélant `error_technical`.
- **Actions** (dans `RoleGate allow={["admin"]}`) : « Relancer l'exécution » (haut du tiroir) ; « Relancer cet élément » sur chaque groupe d'élément **en échec**.

### 6.3 États
Tiroir : chargement (skeleton pendant fetch du détail), vide (« Aucune étape enregistrée »), erreur. Liste : état vide existant conservé (« Aucune exécution pour l'instant. »).

---

## 7. Actions de reprise

- **`runPipelineNow()`** — réutilisée telle quelle pour « Relancer l'exécution ».
- **`reprocessRawItem(rawItemId)`** (nouvelle action serveur, `"use server"`, imports dynamiques comme les actions pipeline existantes) :
  1. `requireUser()` + `requirePermission(role,"pipeline","configure")` (Admin).
  2. Garde anti-chevauchement (`hasRunningRun()`), sinon `{ok:false, "Une exécution est déjà en cours."}`.
  3. Ouvre une `pipeline_runs` `triggered_by:"reprocess"`, charge le `raw_item` + son `feed` (mediaName) + la liste `wpCategories.name`.
  4. Rejoue `stageItem(rawItem→RawItem, mediaName, categoryNames)` **en contournant la déduplication** (on opère directement sur le `raw_item` stocké, on n'appelle pas `isSeen`/`recordRawItem`), persiste ses `pipeline_steps` (avec `raw_item_id`), met la run à `success`/`partial`/`failed`, `finished_at`.
  5. `revalidatePath("/runs")`, `/queue`, `/dashboard`. Retourne l'issue (article déposé `pending` ou échec avec message).
  - Barrière de revue préservée : `stageItem` ne produit qu'un `pending`.

---

## 8. Rafraîchissement auto

Composant client enveloppant la liste : si une run affichée est `running`, `setInterval(() => router.refresh(), 4000)` ; nettoyage à la disparition de tout `running` et au démontage. Aucune requête quand tout est terminé. (L'orchestration in-app écrit les étapes au fil de l'eau, donc une run déclenchée par cron/onglet tiers voit sa progression apparaître.)

---

## 9. RBAC & sécurité

- **Voir** l'écran + les détails : `pipeline:read` (Admin, Éditeur) — garde de page déjà posée en SP3 ; le Journaliste ne voit pas l'entrée sidebar ni la page.
- **Reprises** (`runPipelineNow`, `reprocessRawItem`) : `pipeline:configure` (Admin) — boutons sous `RoleGate allow={["admin"]}` **et** application serveur `requirePermission`.
- Reprise gardée par `hasRunningRun()` + l'interlock d'index partiel de SP3.

---

## 10. Tests & vérification

- **Unitaires / intégration (auto-nettoyants)** : forme de `getRunDetail` (regroupement par `raw_item_id`, étapes flux vs éléments) ; garde RBAC de `reprocessRawItem` ; `reprocessRawItem` **contourne la déduplication** et dépose un `pending` (test DB auto-nettoyant + reseed). Regroupement pur testable si extrait en fonction.
- **Vérification applicative** : ouvrir le tiroir d'une vraie run, déplier un élément en échec, révéler les détails techniques, « Relancer cet élément » → l'article apparaît en file de revue ; vérifier le rafraîchissement auto sur une run `running` ; confirmer que le Journaliste n'accède pas à `/runs`.

---

## 11. Structure de fichiers

```
db/migrations/…                          # migration additive: pipeline_steps.raw_item_id
db/schema.ts                             # + rawItemId sur pipelineSteps
lib/pipeline/run.ts                      # estampille raw_item_id sur les étapes par-élément
lib/queries/runs.ts                      # getRunDetail(runId) (+ éventuel getRuns partagé)
lib/actions/pipeline-actions.ts          # + reprocessRawItem(rawItemId)
app/(app)/runs/page.tsx                  # liste → lignes cliquables + wrapper client
components/pipeline/runs-view.tsx        # client: liste + tiroir + auto-refresh
components/pipeline/run-detail-sheet.tsx # tiroir: résumé + trace regroupée + reprises
tests/{run-detail,reprocess}.test.ts
```

---

## 12. Décisions & alternatives écartées

- **Tiroir (Sheet)** plutôt que page dédiée : inspection rapide de plusieurs runs sans navigation (1er choix du brief).
- **Reprise par élément** (retenu) en plus de la reprise d'exécution : la déduplication empêche une simple relance de rejouer les éléments déjà vus ; `reprocessRawItem` est la vraie valeur de récupération demandée par le brief.
- **`raw_item_id` sur `pipeline_steps`** (retenu) plutôt qu'un regroupement heuristique : attribution fiable des étapes → regroupement + reprise ciblée, via une migration additive.
- **Rafraîchissement auto léger** (retenu) plutôt que statique : colle à l'objectif d'observabilité, sans coût quand tout est terminé, sans streaming complexe.
