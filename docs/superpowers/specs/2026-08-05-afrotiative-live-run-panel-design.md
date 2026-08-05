# Afrotiative Media — Panneau d'exécution en direct (`/runs`)

**Date :** 2026-08-05
**Statut :** Design validé — prêt pour le plan d'implémentation
**Branche :** `feat/live-run-panel` (empilée sur `main`, post-SP4/SP5)
**Portée :** **Sous-projet A** de la refonte de l'observabilité. B (historique + tendances), C (santé des flux) et D (alertes d'échec) feront l'objet de specs distinctes.

Documents sources : spec SP4 (`2026-08-04-afrotiative-sp4-pipeline-observability-design.md`), `afrotiative-uiux-brief.md` §6.5. Mockup validé : `.superpowers/brainstorm/**/panel-layout.html` (option **A · Cockpit**).

---

## 1. Objectif

Aujourd'hui, lancer une exécution depuis `/runs` est une **boîte noire** : le bouton « Lancer une exécution maintenant » **bloque** pendant toute la durée de l'exécution (jusqu'à `maxDuration = 300 s`), n'affiche qu'un spinner, puis un unique toast à la fin. Deux causes racines :

1. **Le déclencheur bloque.** `runPipelineNow()` `await` l'exécution entière avant de rendre la main.
2. **Aucune progression n'est persistée en cours de route.** `runPipeline()` accumule ses étapes en mémoire et ne les insère en base **qu'à la toute fin** (bloc `finally`) — même le rafraîchissement à 4 s ne voit donc que *début → résultat final*.

Objectif du sous-projet A : rendre une exécution **observable en temps quasi réel**, de façon **professionnelle, intuitive et rassurante** — on voit l'exécution se dérouler, étape par étape, et on comprend immédiatement un échec. Le déclenchement devient **non bloquant** et la progression **survit à un rechargement**.

**Principe préservé :** la barrière de revue humaine reste intacte — l'exécution ne fait que déposer des articles `pending`, jamais publier.

---

## 2. Décisions validées (brainstorming)

| Décision | Choix retenu |
|---|---|
| Exécution | **Non bloquante + résistante au rechargement** : le déclencheur rend la main immédiatement, l'exécution continue côté serveur, la progression est persistée à chaque étape. N'importe quel lecteur qui ouvre `/runs` voit la même vue en direct. |
| Transport « temps réel » | **Persistance incrémentale + polling client** (~1,5 s tant que l'exécution est active). Pas de SSE : à la cadence des étapes (1–5 s), le polling est visuellement indiscernable, sans infra nouvelle. Évolutif vers SSE plus tard sans changer le modèle de données ni l'UI. |
| Détail en direct | **Résumé + journal** : en-tête compact (statut, barre, X/Y, écoulé/ETA) + **stepper des 5 étapes** pour l'élément en cours + journal en direct repliable. |
| Objet du panneau | **Réassurance ET diagnostic** à parts égales : progression claire *et* échecs de premier ordre, remontés en ligne. |
| Disposition | **Option A · Cockpit** : le stepper occupe un **emplacement focal fixe** pour l'élément en cours ; les éléments terminés tombent dans le journal en dessous. |
| Structure d'exécution | **Deux phases** : lire d'abord tous les flux, puis traiter les nouveaux éléments collectés (dénominateur exact → barre honnête + ETA réel). |

---

## 3. Périmètre

**Inclus :**
- Migration **additive** : colonnes de progression sur `pipeline_runs` + `at` sur `pipeline_steps` (§4).
- Refactor `runPipeline` → **`startPipelineRun` (ouverture, synchrone) + `executeRun` (exécution, détachée)**, en **deux phases**, avec **écriture incrémentale** des étapes et des compteurs (§5).
- Nouvelle action `getActiveRun()` (contrat de polling, §6).
- **Panneau live** en tête de `/runs` : états *inactif / en cours / terminé*, stepper Cockpit, journal en direct (§7).
- Diagnostic d'échec en ligne, en direct (§8).
- Mise à jour des tests du pipeline pour la nouvelle sémantique deux-phases (§10).

**Hors périmètre (sous-projets suivants) :** historique + tendances (B), matrice de santé des flux (C), alertes d'échec (D). Pas de SSE. Pas de mutation en cours d'exécution (la reprise reste post-exécution via le tiroir SP4 existant). Aucun nouveau moteur/planificateur.

---

## 4. Modèle de données (migration additive, non destructive)

**`pipeline_runs`** — colonnes ajoutées, toutes `NULL`/à défaut pour ne pas toucher les lignes existantes :

| Colonne | Type | Rôle |
|---|---|---|
| `phase` | `text NULL` | `reading_feeds` \| `processing_items` \| `finalizing` — pilote la barre affichée par l'en-tête |
| `feeds_total` | `integer NULL` | nombre de flux actifs, connu à l'ouverture → dénominateur de la phase flux |
| `total_items` | `integer NULL` | nombre de nouveaux éléments à traiter (connu en fin de phase 1) → dénominateur de la phase éléments |
| `processed_items` | `integer NOT NULL DEFAULT 0` | éléments entièrement tentés (produits ou échoués) → numérateur |
| `current_stage` | `text NULL` | libellé de l'étape en cours, ex. `"Génération IA"` |
| `current_item` | `text NULL` | titre de l'élément en cours de traitement |

**`pipeline_steps`** — ajout de `at timestamptz NOT NULL DEFAULT now()` pour un **ordre chronologique stable** du journal en direct.

**Invariant clé :** les `pipeline_steps` restent **« à la complétion uniquement »** (insérées quand une étape se termine, `success`/`failed`). La seule ligne « ▸ en cours » du stepper/journal est **dérivée de `current_stage`/`current_item`** de la ligne `pipeline_runs` — aucun double-écriture, aucune atteinte à la logique de finalisation.

Aucune colonne existante n'est modifiée ou supprimée.

---

## 5. Exécution & déclenchement

On scinde l'actuel `runPipeline` en deux :

### 5.1 `startPipelineRun()` — action serveur, `pipeline:configure` (Admin)
1. `hasRunningRun()` (qui appelle déjà `reclaimStaleRuns()`) → si actif, retour `{ ok:false, message:"Une exécution est déjà en cours." }`.
2. Compter les flux actifs → `feedsTotal`.
3. `INSERT pipeline_runs { triggeredBy:"manual", status:"running", phase:"reading_feeds", feedsTotal }` `RETURNING id` — **occupe le verrou** `pipeline_runs_one_running`. En cas de course perdue (SQLSTATE 23505) → même message « déjà en cours ».
4. Lancer **`executeRun(runId)` sans `await`** (promesse détachée).
5. Retourner `{ ok:true, runId }` **immédiatement**.

La promesse détachée survit sur le process Node persistant de Railway. Une mort de process en cours d'exécution (déploiement/OOM) est déjà couverte par le **récupérateur `RUN_STALE_MINUTES`** (`reclaimStaleRuns` finalise la ligne à `failed`).

### 5.2 `executeRun(runId)` — interne (pas une action serveur), détaché

Conserve la garantie `try/finally` actuelle : la ligne atteint **toujours** un statut terminal.

**Phase 1 — `reading_feeds`** (lire *tous* les flux actifs) :
- Pour chaque flux : `parseFeed`, **insérer immédiatement** l'étape de lecture (`success`/`failed`, `at`, `raw_item_id` NULL), incrémenter `feeds_read`.
- Filtrer les nouveaux éléments : `isSeen(feed.id, item)` **et** déduplication **intra-lot** (par `contentHash`/`guid`, contre les doublons inter-flux). Les candidats retenus s'accumulent (titre, url, flux). **On ne `recordRawItem` PAS encore** — voir invariant ci-dessous.
- On lit **tous** les flux (signal de santé), mais on **arrête d'ajouter des candidats** une fois `maxItemsPerRun` atteint ; on compte les nouveaux éléments **au-delà** de la limite (pour le message « limite atteinte »).
- En fin de phase : `total_items = candidates.length` (≤ cap), `phase = "processing_items"`, `processed_items = 0`.

**Phase 2 — `processing_items`** (traiter les candidats collectés) :
- Pour chaque candidat : poser `current_item = titre`, puis à chaque étape mettre à jour `current_stage` ; **`recordRawItem`** (c'est ici qu'on marque « vu », donc on ne persiste que ce qu'on traite) → `rawItemId` ; `stageItem` ; **insérer chaque étape au fil de l'eau** (`at`, `rawItemId`) ; `processed_items++`.

**Invariant préservé (identique à l'actuel) :** un `raw_item` n'est enregistré (« vu ») **que** s'il est effectivement traité dans cette exécution — les éléments au-delà du cap ne sont jamais enregistrés en phase 1, donc repris à la prochaine exécution. Un élément dont le `stageItem` échoue reste enregistré (comme aujourd'hui).

**Finalisation (`finally`)** : `phase = "finalizing"` puis `UPDATE status`, `feeds_read`, `new_items`, `published = 0`, `finished_at`. La table de statut est inchangée :
- `failed` = tous les flux ont échoué, **ou** des éléments tentés et aucun produit ;
- `partial` = des échecs (flux/éléments) ou cap dépassé, mais au moins un produit ;
- `success` = aucun échec (y compris exécution « calme » où tout était doublon).

**Changement de comportement à couvrir (§10) :** on lit désormais **tous** les flux même si le cap est atteint. `capHit` signifie « plus de nouveaux éléments que le cap » ; `feedsNotRead` disparaît (→ 0). Message « limite atteinte » reformulé : « N nouveaux éléments au-delà de la limite de X n'ont pas été traités ; ils seront repris à la prochaine exécution. » (sans « flux non lus »).

### 5.3 Route cron
`POST /api/pipeline/run` continue d'`await`er (un appelant cron veut un résultat définitif) ; elle appelle simplement `executeRun` derrière l'ouverture. Les deux chemins écrivent donc la progression de façon identique.

### 5.4 Volume d'écritures
Jusqu'à ~20 éléments × 5 étapes ⇒ ~100 insertions d'étapes + mises à jour de `current_stage`/`processed_items` sur une exécution de plusieurs minutes. Négligeable pour Neon/Postgres. Réglable plus tard si besoin (batcher les mises à jour de `current_stage`).

---

## 6. Requêtes

- **`getActiveRun()`** (nouvelle) — action serveur, `pipeline:read`. Appelle `reclaimStaleRuns()`, puis renvoie l'unique exécution `running` : sa ligne (champs de progression inclus) **+** ses étapes triées par `at`, regroupées comme `getRunDetail` (étapes niveau-flux + groupes par élément). Renvoie `null` si aucune n'est active.
- **`getRunDetail(runId)`** (existante SP4) — réutilisée telle quelle pour le **snapshot terminal** après la fin.
- **`getRuns(limit=20)`** (existante) — réutilisée pour la liste et le résumé « inactif ».

---

## 7. UI — le panneau live

Composant client en tête de `RunsView`, au-dessus de la liste. `RunsPage` fournit l'état initial **côté serveur** (`getRuns` + `getActiveRun`) pour un premier rendu correct sans attendre le premier poll. Le stepper suit le mockup **Cockpit** validé.

### 7.1 Trois états (pilotés par `getActiveRun()`)

- **Inactif** (aucune exécution `running`) : une seule ligne — bouton **« Lancer une exécution maintenant »** (Admin, RBAC inchangée) + résumé muet de la dernière exécution (« Dernière exécution : succès · il y a 2 h · 6 articles », depuis `runs[0]`). **Pas de polling.**
- **En cours** : vue Cockpit. Au clic, `startPipelineRun()` rend la main instantanément avec `runId` ; le panneau bascule en direct et démarre le poll ~1,5 s. Tout lecteur (`pipeline:read`) voit la même vue. L'en-tête est **conscient de la phase** : pendant `reading_feeds`, il affiche « Lecture des flux — k/N » (barre sur `feeds_total`) et le **stepper n'apparaît qu'à l'entrée en `processing_items`** (quand `current_item`/`total_items` sont posés) ; le journal en direct, lui, se remplit dès la première lecture de flux.
- **Terminé** (le poll passe à `null`) : carte terminale — pastille de statut (succès/partiel/échec), totaux (X articles en revue, durée, N échecs), lien **« Voir le détail »** (ouvre le tiroir SP4) et, pour l'Admin, **« Relancer »**. Un toast unique. Retour à *Inactif* à la prochaine visite/refresh.

### 7.2 Contrat de polling (client)
Le panneau retient `watchedRunId`. Toutes les ~1,5 s, `getActiveRun()` :
- **renvoie une exécution** → rendre Cockpit ; mémoriser son id ;
- **renvoie `null` avec `watchedRunId` posé** → un `getRunDetail(watchedRunId)` unique → carte terminale + toast + `router.refresh()` (resynchronise la liste) ; effacer `watchedRunId` ; **arrêter le poll** ;
- **renvoie `null` sans `watchedRunId`** → *Inactif*.

Aucun intervalle ouvert : le poll ne tourne que pendant une exécution active. Le `router.refresh()` périodique (4 s) de l'actuel `RunsView` est **remplacé** par ce polling ciblé (plus léger, plus vif) ; la liste ne se rafraîchit qu'une fois, à la complétion.

### 7.3 Mapping du stepper
Les 5 étapes par-élément (Extraction → Embedding → Regroupement → Génération IA → Dépôt en revue). Pour l'élément en cours (`current_item`) : nœuds **terminés** (✓ vert) d'après les `pipeline_steps` déjà persistées de cet élément, nœud **en cours** (anneau indigo + spinner) = `current_stage`, nœuds **à venir** (gris). Un échec met le nœud correspondant en rouge et fige le stepper de l'élément à ce point. « Génération IA » étant le long pôle, le temps de séjour reflète honnêtement où passe le temps.

### 7.4 ETA
Affiché uniquement après ≥ 2 éléments terminés : `moy = écoulé / processed_items`, `eta = moy × (total_items − processed_items)` → « ~mm:ss restant ». Avant cela : « estimation… ». **Volontairement approximatif** et libellé comme tel.

---

## 8. Échecs & diagnostic

- Une étape échouée est **persistée dès qu'elle échoue** → visible dans le journal en un poll (~1,5 s) : ligne rouge + **message français prioritaire** (`error_message`) ; « Voir les détails techniques » révèle `error_technical` (réutilise `FailedStepDetail` de SP4).
- L'en-tête tient un **compteur d'échecs** courant ; le statut final suit la table §5.2.
- **La reprise reste post-exécution** : l'interlock « une seule exécution » interdit tout `reprocess` pendant qu'une exécution tourne. Une fois terminé, les actions existantes du tiroir SP4 (« Relancer cet élément » / « Relancer l'exécution ») s'appliquent. Le panneau n'ajoute **aucune** mutation en cours d'exécution.

---

## 9. Cas limites

| Cas | Comportement |
|---|---|
| Rechargement / arrivée tardive | État en base ; le panneau se réhydrate via `getActiveRun()`. Aucune perte. |
| Mort de process en cours | Promesse détachée perdue, mais `RUN_STALE_MINUTES` finalise à `failed` ; prochain poll → terminal. |
| Deux Admins déclenchent | `hasRunningRun()` + index unique `pipeline_runs_one_running` ; le perdant reçoit « déjà en cours » et **s'attache** au panneau live. |
| Exécution vide (tout doublon / aucun flux actif) | Se termine vite en `success` ; le stepper n'entre jamais en phase éléments ; journal = lectures de flux seules. Honnête, pas une erreur. |
| Lecteur non-Admin | Voit le Cockpit complet, **sans** bouton déclencher/relancer (`RoleGate`). |

---

## 10. Tests (dans la suite `bun test` existante — sans réseau ni clés)

- **Unitaire/pur** : table de statut de `executeRun` deux-phases (lecture flux → collecte → cap → traitement) inchangée dans ses verdicts ; transitions des champs de progression ; maths de l'ETA ; regroupement de `getActiveRun()`.
- **Couverture du changement de comportement** : mettre à jour les tests du pipeline pour « on lit tous les flux même passé le cap » — `capHit` = « plus de nouveaux éléments que le cap », `feedsNotRead` → 0, nouveau message « limite atteinte ». Vérifier l'invariant « on n'enregistre (`recordRawItem`) que ce qu'on traite ».
- **Composant** : le panneau rend *inactif/en cours/terminé* à partir de charges `getActiveRun()` de test ; mapping étape→nœud du stepper ; révélation du motif d'échec sur une ligne échouée.

---

## 11. Sécurité & RBAC (préservé)

- `startPipelineRun()` : `pipeline:configure` (Admin). `getActiveRun()` : `pipeline:read` (tous rôles). Boutons déclencher/relancer sous `RoleGate allow={["admin"]}`, en miroir du contrôle serveur.
- Aucun nouvel endpoint HTTP exposé (actions serveur RBAC-gardées). Route cron inchangée (bearer). Aucun secret côté client.

---

## 12. Fichiers touchés (indicatif)

- `db/schema.ts` + nouvelle migration additive (`pipeline_runs` × 6 colonnes, `pipeline_steps.at`).
- `lib/pipeline/run.ts` → scinder en ouverture + `executeRun` deux-phases, écriture incrémentale.
- `lib/actions/pipeline-actions.ts` → `startPipelineRun` (remplace/complète `runPipelineNow`) ; `getActiveRun`.
- `lib/queries/runs.ts` → `getActiveRun` (réutilise `groupSteps`).
- `app/(app)/runs/page.tsx` → fournir l'état initial (`getRuns` + `getActiveRun`).
- `components/pipeline/runs-view.tsx` → intégrer le panneau ; retirer le refresh 4 s.
- **Nouveau** `components/pipeline/live-run-panel.tsx` (+ stepper + carte terminale + résumé inactif).
- `app/api/pipeline/run/route.ts` → déléguer à `executeRun` (comportement d'`await` conservé).

---

## 13. Suites (specs distinctes)

- **B — Historique + tendances** : liste retravaillée (filtres statut/déclencheur, durée, produits) + bandeau de tendances (exécutions/jour, articles produits, taux d'échec).
- **C — Santé des flux** : matrice par flux (dernière lecture, statut, éléments 7 j, séries d'échecs), liée à `/settings/feeds`.
- **D — Alertes d'échec** : notification sur échec d'exécution / flux muet (décision de canal : bannière in-app vs e-mail).
