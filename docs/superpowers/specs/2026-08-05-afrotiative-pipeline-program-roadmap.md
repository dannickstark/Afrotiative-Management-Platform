# Afrotiative — Programme « Pipeline & Observabilité v2 » — Feuille de route

**Date :** 2026-08-05
**Statut :** Décisions validées — exécution autonome sous-projet par sous-projet
**Portée :** Un programme décomposé en 9 sous-projets, chacun avec son propre spec → plan → exécution (subagent-driven). Fait suite au sous-projet **A** (panneau d'exécution en direct, déjà livré — PR #1).

Ce document est le registre durable des décisions. Chaque sous-projet aura son spec dédié.

---

## Décisions produit (validées par l'utilisateur)

| Sujet | Décision |
|---|---|
| **Publication automatique** | **Contrôlée + désactivée par défaut.** Un article se publie automatiquement uniquement si `score ≥ seuil` ET conditions de sûreté (aucun drapeau de faible confiance, image présente, ≥ N sources corroborantes), derrière un réglage global **OFF par défaut**, avec **journal d'audit**. La barrière de revue humaine reste la règle ; l'auto-publication est une exception **explicitement configurée** — la doc (README, spec SP5) sera mise à jour pour acter ce changement de politique. |
| **Cross-check (sources)** | **Les deux.** D'abord le corpus interne (mêmes sujets across nos flux, via pgvector/clustering existant), puis **augmentation par recherche web** (fournisseur enfichable, Brave par défaut, clé via env, ignoré proprement si absent). Un article synthétise N sources → liste de références en fin (déjà rendue par `buildPostBody`). |
| **Contrôle d'exécution** | **Stop + Pause/Reprise.** Stop annule le run (statut `cancelled`) ; Pause fige et permet de **reprendre le même run** plus tard (checkpoint des candidats restants). |
| **Planification** | **Pilotée dans l'app.** La page de réglages définit l'horaire (cron) ; un **planificateur in-app** (via `instrumentation.ts`) déclenche les runs, sûr en mono-instance grâce à l'interlock « une seule exécution ». |

## Faits d'ancrage (issus de l'exploration du code)

- **Config = env-only aujourd'hui**, aucune table de settings. → nouvelle table `pipeline_settings` + `getPipelineConfig()` fusionne DB (override) sur env (défauts) ; les secrets restent en env.
- **Synthèse multi-sources déjà câblée** au niveau IA : `generateArticle({sources: [...]})` accepte un tableau et son prompt dit déjà « à partir des sources ci-dessous couvrant le même sujet, rédige UN article ». **Lacune : `stageItem` ne passe qu'une source.** `buildPostBody` (`lib/wp/publish.ts`) **ajoute déjà** une liste `<h3>Sources</h3>` depuis `article_sources`. Les sous-titres = simple instruction de prompt (`bodyHtml` non contraint).
- **pgvector prêt** : `decideCluster` fait déjà le plus proche voisin ; généraliser à top-N est trivial (même index HNSW). Les **raw items ne sont pas embeddés** (seulement les articles) → embedder tôt dans `stageItem`. Le **runner deux-phases collecte tous les candidats avant traitement** → endroit naturel pour regrouper par sujet et fusionner.
- **Barrière humaine** appliquée par : `publishDueArticles()` ne sélectionne que `status='approved'` (+ test `publish-due.test.ts` qui l'asserte) ; `publishArticle()` lui-même ne vérifie aucun statut. `articles` n'a **aucun** champ de score numérique aujourd'hui.
- **Shell/sidebar** : nav custom (`components/shell/{sidebar,nav-items,topbar}.tsx`). shadcn en preset **base-nova (Base UI)** ; variables `--sidebar-*` déjà définies ; `sidebar-08` devrait s'installer proprement (vérifier le diff post-install : risque variante Radix). `SessionUser` n'a pas `image` (à ajouter pour l'avatar).
- **Sécurité à noter** : aucun assainissement du `bodyHtml` produit par le LLM aujourd'hui. À traiter (DOMPurify côté serveur avant persistance) dans le sous-projet Qualité.

---

## Sous-projets (ordre de construction)

Dépendances → cet ordre. Chaque case = un cycle spec → plan → exécution, commit par sous-projet.

### SP1 — Fondation Réglages (`pipeline_settings` + `/settings/pipeline`)
Table typée `pipeline_settings` (ligne unique) : `maxItemsPerRun, perOperationTimeoutMs, clusterThreshold, scoreThreshold, autoPublishEnabled(bool,false), autoPublishMinScore, autoPublishMinSources, scheduleCron(text), webSearchEnabled(bool)`, etc. Page `/settings/pipeline` (admin, `pipeline:configure`), entrée dans `settings-nav.tsx`. `getPipelineConfig()` fusionne DB > env. Actions server (guard + Zod + upsert + revalidate) + `getPipelineSettings()`. **Fournit les leviers config** de SP2/4/5/6.

### SP2 — Planificateur in-app
`instrumentation.ts` `register()` démarre (runtime only, mono-instance) une boucle qui lit `scheduleCron` depuis les settings et déclenche `runPipeline({triggeredBy:"scheduled"})` quand c'est dû, en respectant l'interlock « une seule exécution » et en persistant le dernier déclenchement. La route bearer existante reste (déclenchement externe possible). Dépend de SP1.

### SP3 — Sidebar-08
`npx shadcn@latest add sidebar-08` (preset base-nova) ; **diff-check** que `sheet/tooltip/separator/skeleton` ne sont pas repassés en Radix. Remplacer `components/shell/sidebar.tsx` par la composition `SidebarProvider/Sidebar/SidebarInset` ; re-mapper `NAV_ITEMS` (filtrage par rôle conservé, badge `pendingCount`) ; footer `NavUser` depuis `requireUser()` (+ `image` ajouté à `SessionUser`) ; intégrer `ThemeToggle`. Ajouter `/settings/pipeline` et les nouvelles surfaces au nav. Indépendant.

### SP4 — Qualité du pipeline (cross-check + références + sous-titres + scoring)
Le plus gros. (a) **Regroupement de lot** : en phase 1 du runner deux-phases, embedder chaque candidat et regrouper les candidats du même sujet (pgvector top-N + `clusterThreshold`) → **une synthèse par sujet** à partir de toutes ses sources (corpus). (b) **Augmentation web** : fournisseur de recherche enfichable (Brave par défaut, optionnel) pour ajouter des sources externes, fetch SSRF-safe + extraction. (c) **Références** : une ligne `article_sources` par source (le rendu existe déjà). (d) **Prompt** : instruire des **sous-titres `<h2>/<h3>`** + écriture sourcée. (e) **Assainir** `bodyHtml` (DOMPurify serveur). (f) **Scoring** : nouveau `articles.score` (0-100) calculé depuis corroboration/nb sources, drapeaux de confiance, cohésion de cluster (`bestScore`), complétude du contenu, certitude catégorie, présence image. Gère la **tension dedup** : les items fusionnés ne redeviennent pas des articles séparés (marquer `raw_items.merged_into_article_id` ou traiter par cluster). Dépend de SP1.

### SP5 — Contrôle d'exécution (timeout par opération + stop + pause/reprise)
(a) **Timeout par opération** (configurable) : envelopper chaque étape (`timed()`) dans un `Promise.race` timeout → étape `failed` « délai dépassé », l'item passe, jamais de run qui traîne des heures. (b) **Stop** : drapeau `cancel_requested` sur le run, vérifié entre items/étapes → finalisation `cancelled`. (c) **Pause/Reprise** : `paused` + **checkpoint** (liste des candidats restants en jsonb sur le run) ; action Reprendre relance `executeRun` depuis le checkpoint. Boutons Stop/Pause/Reprendre dans le panneau live. Dépend de SP1 (timeout config) ; étend `executeRun` + `LiveRunPanel`.

### SP6 — Auto-publication (contrôlée) — ✅ Livré (2026-08-05)
`autoPublishEnabled` (OFF défaut). Après scoring (SP4), si `score ≥ scoreThreshold` ET conditions de sûreté (aucun drapeau faible confiance, image présente, `sources ≥ autoPublishMinSources`) → auto-approuver (statut `approved` + `scheduledAt=now`) au lieu de publier directement, avec **entrée `article_revisions`** d'audit (« publié automatiquement »). C'est le cron `publishDueArticles` existant — **inchangé**, il ne sélectionne toujours que `status='approved'` — qui publie ensuite l'article ; le point d'application de la barrière de revue humaine n'est donc jamais touché, seule une seconde voie contrôlée vers `approved` est ajoutée. Implémenté dans `lib/pipeline/auto-publish.ts` (gate pur `shouldAutoPublish`) + `lib/pipeline/stages.ts` (`persistArticle`). README + spec SP5 mis à jour pour acter la politique. Dépendait de SP1 + SP4.

### SP7 — Historique + tendances (B)
Liste des runs retravaillée : filtres (statut/déclencheur), durée, produits ; bandeau de tendances (runs/jour, articles produits, taux d'échec) sur une fenêtre. Dépend des données de run.

### SP8 — Santé des flux (C)
Matrice par flux : dernière lecture, statut, éléments 7 j, séries d'échecs (données surtout déjà sur `feeds`). Lié à `/settings/feeds`.

### SP9 — Alertes d'échec (D)
Notification sur échec de run / flux muet. **Canal à décider au démarrage de SP9** (bannière in-app vs e-mail vs les deux) — question différée. Dépend des données run/flux.

---

## Suivi

Exécution autonome, un sous-projet à la fois, commit par sous-projet, revue par tâche + revue finale (subagent-driven). Progression rapportée entre sous-projets. Question à l'utilisateur seulement si un nouveau point bloquant apparaît (ex. canal d'alerte SP9, fournisseur de recherche web si préférence).
