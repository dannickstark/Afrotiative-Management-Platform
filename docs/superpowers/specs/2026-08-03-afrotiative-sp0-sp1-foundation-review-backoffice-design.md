# Afrotiative Media — SP0 + SP1 : Fondation & Back-office de revue quotidienne

**Date :** 2026-08-03
**Statut :** Design validé — prêt pour le plan d'implémentation
**Portée :** Premier segment livrable du programme (SP0 + SP1). Les segments SP2–SP6 restent en feuille de route (voir §12).

Documents sources : `afrotiative-uiux-brief.md` (brief UI/UX du back-office), `compass_artifact_…_text_markdown.md` (recherche d'architecture).

---

## 1. Contexte et objectif du segment

Afrotiative Media est un média panafricain business & finance francophone. L'équipe remplace son automatisation externe (RSS → IA → WordPress) par un logiciel interne où l'humain valide chaque article avant publication.

**Principe directeur : l'IA propose, l'humain dispose.** Aucun article n'atteint le site public sans approbation humaine.

Ce segment (SP0 + SP1) livre la **fondation technique** et le **cœur de valeur** : la boucle quotidienne Tableau de bord → File de revue → Éditeur d'article, sur données réelles en base, avec authentification et rôles. Le pipeline qui *produit* les articles et la publication WordPress sont volontairement simulés (voir §9) et branchés dans des segments ultérieurs.

**Langue de l'interface : français.**

### Programme complet (rappel de la feuille de route validée)
- **SP0** — Fondation & scaffold *(ce doc)*
- **SP1** — Back-office de revue quotidienne *(ce doc)*
- **SP2** — Réglages & administration (Sources RSS, Équipe, Taxonomie, Intégrations)
- **SP3** — Pipeline d'ingestion + IA (Trigger.dev, OmniRoute, Jina)
- **SP4** — Observabilité du pipeline (écran Exécutions)
- **SP5** — Publication & distribution (WordPress)
- **SP6** — Extensibilité (canaux WhatsApp/réseaux sociaux, statistiques)

---

## 2. Périmètre de SP0 + SP1

**Inclus :**
- Scaffold du projet (Next.js 16 App Router, TypeScript, Tailwind v4, shadcn/ui).
- **Schéma de base de données complet** de la plateforme (toutes les tables, y compris celles consommées par les segments ultérieurs), pour n'ajouter ensuite que de la logique, pas des migrations.
- Authentification + RBAC (Better-Auth, plugin admin, 3 rôles).
- App shell + design system (sidebar, badge de rôle, mode sombre, jetons de statut, accent chaud, typographie, toasts).
- Écrans P0 : Connexion, Tableau de bord, File de revue, Éditeur d'article, Création manuelle d'article.
- Données de démonstration réalistes en français.

**Simulé volontairement (réel dans un segment ultérieur) :**
- **« Approuver & publier »** change le statut et écrit une ligne `distributions` mais **n'appelle pas WordPress** (SP5).
- Les articles proviennent des **données de seed** et non d'un pipeline en direct (SP3).
- Le bouton **« Améliorer avec IA »** est présent mais désactivé avec une infobulle « bientôt » (SP3).

**Hors périmètre de ce segment :** publication WordPress réelle, pipeline Trigger.dev, appels OmniRoute, et les écrans Exécutions / Calendrier / Articles publiés / Catégories & Tags / Intégrations (le schéma existe, l'UI et la logique non).

---

## 3. Stack technique et arborescence

| Domaine | Choix | Note |
|---|---|---|
| Framework | Next.js 16 (App Router) + TypeScript | RSC par défaut, actions serveur pour les écritures |
| Style | Tailwind v4 + shadcn/ui | Composants standards (Table, Card, Badge, Dialog, Sheet, Select, Command) |
| ORM / DB | Drizzle → NeonDB (Postgres serverless) | Chaîne **poolée** (`-pooler`) partout ; directe pour migrations |
| Vecteurs | pgvector (`CREATE EXTENSION vector`) | Schéma prêt, non utilisé avant SP3 |
| Auth | Better-Auth + plugin admin | Sessions en base Neon |
| Éditeur | Tiptap v3 (contraint) | Barre d'outils limitée + bouton IA (désactivé) |
| Tables | TanStack Table v8 | Recherche/filtre/tri/pagination |
| Divers | `sonner` (toasts), `lucide-react` (icônes), `zod` (validation) | |
| Gestionnaire de paquets | `pnpm` | |

> Les numéros de version exacts sont épinglés à l'installation via `npm view <pkg> version` (les versions dérivent — cf. caveats du doc compass).

**Arborescence cible :**
```
app/
  (auth)/login/
  (app)/
    dashboard/
    queue/
    article/[id]/        # éditeur (revue + lecture seule si publié)
    article/new/         # création manuelle
    published/  runs/  calendar/            # placeholders segments ultérieurs
    settings/{feeds,taxonomy,team,integrations}/  # placeholders SP2
components/{ui, shell, article, queue, dashboard}/
db/{schema.ts, seed.ts, index.ts, migrations/}
lib/{auth.ts, rbac.ts, actions/*.ts}
```

---

## 4. Modèle de données (schéma complet, construit en SP0)

Toutes les tables de la plateforme sont créées maintenant (Stage 1 du doc compass), même celles utilisées plus tard.

- **Auth (Better-Auth) :** `user` (avec colonne `role`), `session`, `account`, `verification`.
- **`feeds`** — `name`, `feed_url`, `site_url`, `active`, `last_fetch_at`, `last_fetch_status`, `items_captured_7d`.
- **`raw_items`** — `feed_id`, `guid`, `url`, `content_hash`, `raw_title`, `raw_body`, `fetched_at` (clés de dédup).
- **`articles`** — `title`, `body_html`, `excerpt`, `status` enum (`draft` / `pending` / `in_review` / `approved` / `published` / `rejected`), `category_id`, `featured_image_url`, `image_credit`, `image_source_url`, `ai_author` (bool), `created_by`, `generated_at`, `published_at`, `scheduled_at`, `confidence_flags` jsonb (`category_uncertain` / `image_missing` / `cluster_uncertain`), `locked_by`, `locked_at`, `reject_reason`, `cluster_id`.
- **`article_sources`** — `article_id`, `media_name`, `url` (affiché dans le panneau et en pied d'article).
- **`article_tags`** — `article_id`, `tag_name`, `is_new` (distinction existant / à créer).
- **`article_revisions`** — `article_id`, `actor_id`, `action`, `at` (panneau statut & historique).
- **`article_embeddings`** — `article_id`, `embedding` vector(1024), index HNSW (pgvector ; inutilisé avant SP3).
- **`clusters`** — regroupement d'articles « même sujet ».
- **`wp_categories` / `wp_tags`** — miroir de la taxonomie WordPress (seedé maintenant, synchronisé en SP5).
- **`pipeline_runs`** — `triggered_by`, `started_at`, `finished_at`, `feeds_read`, `new_items`, `published`, `status`.
- **`pipeline_steps`** — `run_id`, `name`, `status`, `duration_ms`, `error_message`, `error_technical`.
- **`distributions`** — `article_id`, `channel` (`wordpress`, …), `status`, `at` (cibles de publication enfichables).

**Enums partagés :** `article_status`, `feed_fetch_status`, `pipeline_status`, `distribution_status`.

---

## 5. Authentification & RBAC

- **Better-Auth** + plugin admin, sessions stockées en base Neon (adaptateur Drizzle).
- **`createAccessControl`** sur les ressources : `article`, `feed`, `taxonomy`, `team`, `pipeline`.
- **Rôles et permissions :**

| Action | Admin | Éditeur | Journaliste |
|---|:---:|:---:|:---:|
| Créer / éditer un brouillon | ✓ | ✓ | ✓ |
| Approuver & publier | ✓ | ✓ | ✗ |
| Rejeter / renvoyer à l'IA | ✓ | ✓ | ✗ |
| Gérer flux / taxonomie | ✓ | ✓ | ✗ |
| Gérer l'équipe | ✓ | ✗ | ✗ |
| Configurer le pipeline | ✓ | ✗ | ✗ |

- **Pas d'auto-inscription** : les comptes sont créés/invités par un Admin.
- **Connexion** : distinguer *mot de passe erroné* de *compte désactivé*, sans fuite sur l'existence du compte.
- **Application des droits dans les actions serveur** (pas uniquement le middleware — cf. CVE-2025-29927 ; garder Next.js à jour).
- **Boutons masqués, pas désactivés** selon le rôle : un journaliste ne voit jamais « Publier ».
- **Badge de rôle** visible en permanence dans la barre supérieure.

---

## 6. App shell & design system

- **Sidebar** : Tableau de bord · File de revue *(badge = nombre en attente)* · Calendrier · Articles publiés · Exécutions du pipeline · Réglages *(accès selon rôle)*.
- **Barre supérieure** : badge de rôle, utilisateur, bascule mode sombre.
- **Jetons de statut** (une palette, réutilisée partout — dashboard, file, exécutions) :
  - `draft` → ardoise · `pending` → ambre · `in_review` → indigo · `approved`/`published` → vert · `rejected` → rouge · `error` (pipeline) → rouge alt.
- **Accent** : une seule couleur chaude (terracotta/ambre), réservée aux **actions principales et aux éléments d'attention**, jamais en fond de page.
- **Typographie** : Inter pour l'UI (lisible en table dense) + une **serif éditoriale** limitée au corps de l'article dans l'éditeur (pour que l'article « ressemble » au rendu publié).
- **Densité** : moyenne à haute (tables compactes).
- **Mode sombre** dès le design system (pas un extra).
- **Toasts** `sonner` pour succès/échec.
- **Trois états dessinés** (vide / chargement / erreur) sur chaque écran principal, pas seulement le « cas heureux ».
- **Confirmations** : toute action destructrice (rejeter, dépublier, désactiver, supprimer) passe par une modale nommant explicitement la conséquence.

---

## 7. Écrans SP1

### 7.1 Connexion — P0
Email + mot de passe (Better-Auth). État « compte désactivé » distinct d'un mot de passe erroné. Pas d'auto-inscription.

### 7.2 Tableau de bord — P0
- **4 cartes de synthèse** : articles en attente de revue · exécutions en échec (24 h) · publiés aujourd'hui/cette semaine · dernière exécution (heure + statut).
- **Liste courte** des 5 derniers articles en attente (accès direct à l'éditeur).
- **Liste courte** des dernières erreurs de pipeline nécessitant une action.
- **État « aucune activité »** engageant plutôt qu'un tableau vide.

### 7.3 File de revue — P0
- **TanStack Table** : titre, catégorie proposée, nombre de sources, image (miniature), date de génération, statut.
- **Filtres** : catégorie, source, statut, recherche texte.
- **Tri par défaut** : plus ancien en premier.
- **Indicateur de faible confiance** piloté par `confidence_flags` (catégorie incertaine, image absente, regroupement incertain) — à traiter en priorité.
- **Actions rapides au survol** : Ouvrir · Approuver rapidement · Rejeter.

### 7.4 Éditeur d'article — P0 (écran pivot)
Décision de publication en confiance, **en un seul écran**, disposition **deux colonnes**.
- **Colonne principale** : Tiptap v3 **contraint** (titre + corps), barre d'outils limitée à **gras, H2, H3, lien, listes (puces/numérotée)**, corps en serif éditoriale. Bouton **« Améliorer avec IA »** présent mais désactivé (infobulle « bientôt », SP3).
- **Colonne latérale fixe** :
  - **Image à la une** : aperçu + **crédit obligatoire** (nom de la source + lien d'origine en clair) ; bouton changer/uploader.
  - **Catégorie** : select **contraint** aux catégories existantes, pré-rempli.
  - **Tags** : chips pré-remplies, **distinction visuelle existant vs nouveau** (avant validation).
  - **Sources consultées** : liste (média + lien), telle qu'en pied d'article.
  - **Extrait** généré, éditable.
  - **Statut & historique** : qui a généré, qui a modifié, horodatage.
- **Barre d'actions persistante** : Enregistrer le brouillon · Rejeter *(motif requis)* · Renvoyer à l'IA · **Approuver & publier** · Planifier.
- **États** : chargement du contenu, échec de chargement d'image, **article publié** (lecture seule + dépublier/republier), **verrou** si un autre utilisateur a l'article ouvert.
- **Visibilité selon rôle** : le journaliste ne voit ni Approuver/Publier, ni Rejeter, ni Renvoyer à l'IA.

### 7.5 Création manuelle — P0 (Parcours D)
Même éditeur, sans bouton « Publier ». Le journaliste choisit catégorie/tags (avec suggestion), soumet en **`pending`**.

---

## 8. Couche de données, verrouillage & simulation de publication

- **Lectures/écritures** via **actions serveur** + Drizzle (Neon poolé). Validation d'entrée avec Zod.
- **Verrou d'édition (soft lock)** : l'ouverture de l'éditeur pose `locked_by`/`locked_at` ; un *heartbeat* le rafraîchit ; le verrou **expire après ~5 min d'inactivité** ; les autres voient une bannière lecture seule indiquant le détenteur, avec **surcharge possible par un Admin**.
- **Publication (simulée)** : valide les champs requis (crédit image, catégorie), change le statut, écrit une ligne `distributions` `status='stubbed'`, et affiche un toast « publication simulée — WordPress branché en SP5 ». La planification enregistre `scheduled_at` sans job réel.

---

## 9. Données de démonstration (seed)

Newsroom réaliste en **français**, pour que chaque écran affiche du contenu réel et que **chaque état soit atteignable** :
- ~6 flux (ex. Financial Afrik, Jeune Afrique éco…) avec états de santé variés (ok / en erreur).
- ~25 articles couvrant **tous les statuts**, dont des cas **faible confiance** (catégorie incertaine, image absente).
- Catégories/tags miroir seedés.
- 3 utilisateurs (un par rôle).
- Quelques `pipeline_runs` dont **une exécution en échec**.

---

## 10. Gestion des erreurs

- Échecs d'action serveur → toast d'erreur en langage clair, jamais de stack trace brute.
- Chargement d'image en échec → placeholder + message dans le panneau image.
- Conflit de verrou → bannière lecture seule (pas d'écrasement silencieux).
- Validation Zod échouée → messages de champ inline.

---

## 11. Vérification

1. `pnpm typecheck` et `pnpm build` propres.
2. Migrations + seed appliqués sur Neon (chaîne poolée fournie par l'utilisateur).
3. **Exercer l'app réelle** (skills run/verify) :
   - Se connecter avec chaque rôle ; vérifier le masquage des boutons selon le rôle.
   - Parcours A : File de revue → ouvrir → corriger → **Approuver (simulé)**.
   - Vérifier les états vide / chargement / erreur / verrou.
   - Vérifier l'état « compte désactivé » à la connexion.

---

## 12. Dépendances & pré-requis

- **Chaîne de connexion Neon poolée** (`-pooler`) à fournir par l'utilisateur avant migrations/seed.
- pgvector activé sur la base Neon (`CREATE EXTENSION IF NOT EXISTS vector;`).
- Aucun autre credential requis pour ce segment (OmniRoute / WordPress / Jina n'interviennent qu'en SP3/SP5).

---

## 13. Décisions de conception (et alternatives écartées)

- **Schéma complet en SP0** (retenu) plutôt que schéma partiel : évite les migrations répétées ; coût : quelques tables inertes au départ.
- **Éditeur Tiptap v3 contraint** (retenu) plutôt que Novel : colle au « formatage limité au nécessaire » et au contrôle éditorial ; coût : câblage un peu supérieur.
- **Auth mono-newsroom** (plugin admin + access-control) plutôt que plugin organization : plus simple pour une équipe unique.
- **Soft lock avec surcharge Admin** (retenu) plutôt que hard lock : évite le blocage définitif si un onglet reste ouvert.
- **Publication simulée** (retenu) plutôt que d'attendre SP5 : permet de valider tout le parcours de décision dès maintenant.
