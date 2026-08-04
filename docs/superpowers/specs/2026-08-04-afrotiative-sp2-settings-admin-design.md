# Afrotiative Media — SP2 : Réglages & administration

**Date :** 2026-08-04
**Statut :** Design validé — prêt pour le plan d'implémentation
**Branche :** `feat/sp2-settings-admin` (empilée sur SP5 → SP4 → SP3 → SP0+SP1)
**Portée :** Sous-projet SP2. SP0+SP1 Tasks 14–15 restent en pause.

Documents sources : `afrotiative-uiux-brief.md` §6.8–6.11, §2 (rôles), §7 (motifs transverses).

---

## 1. Objectif

Donner à l'équipe le contrôle **en application** de ce qui est aujourd'hui géré par seed/DB/env : les **flux RSS** (ajout/santé/test), l'**équipe & rôles**, la **taxonomie miroir** (catégories/tags WordPress), et le **statut des intégrations**. Remplace les pages placeholder `/settings/*` posées en SP1. Aucune publication ici — la barrière de revue humaine reste hors sujet pour ces écrans.

**Rôles (rappel §2) :** Admin (tout), Éditeur (gère flux actifs + catégories/tags), Journaliste (aucun accès Réglages).

---

## 2. Périmètre

**Inclus (les 4 écrans) :**
- **Sources RSS** (§6.8, P0) : table + santé, ajout/édition, interrupteur actif, **« Vérifier ce flux »**, suppression confirmée.
- **Équipe & rôles** (§6.10, P0, Admin) : liste, **ajout d'un membre avec mot de passe temporaire affiché une fois**, changement de rôle, désactivation/réactivation (jamais de suppression silencieuse).
- **Catégories & Tags** (§6.9, P1) : tables miroir + **« Synchroniser depuis WordPress »** (via le `WordPressClient` de SP5).
- **Intégrations** (§6.11, P2) : cartes de statut (WordPress / OmniRoute / OpenRouter / Jina / Firecrawl) + bouton **« Tester »** (vérifs *gratuites*), sans édition de secret en UI.

**Hors périmètre :** édition de secrets/clés en UI (nécessite un stockage sécurisé) ; service d'email (l'onboarding utilise un mot de passe temporaire) ; auto-changement de mot de passe forcé au 1er login (petit ajout ultérieur) ; nettoyage automatique des tags orphelins ; canaux WhatsApp/sociaux (SP6) ; SP0+SP1 Tasks 14–15.

---

## 3. Coquille Réglages & RBAC

- `app/(app)/settings/layout.tsx` : sous-navigation (Sources RSS · Catégories & Tags · Équipe · Intégrations), chaque entrée filtrée par rôle. `requireUser()` au niveau layout ; **chaque page ET chaque action serveur** applique `requirePermission` (jamais seulement masquer le lien) :
  - Sources RSS / Catégories & Tags : `feed:manage` / `taxonomy:manage` (Éditeur + Admin).
  - Équipe / Intégrations : Admin (`team:manage` / `pipeline:configure`).
- Le Journaliste n'a aucune entrée Réglages (déjà filtré en SP1 nav) et se voit refuser `/settings/*` côté serveur. L'Éditeur voit Sources RSS + Catégories/Tags, mais pas Équipe/Intégrations.

---

## 4. Sources RSS (§6.8)

- **Requête :** liste `feeds` — `name`, `feedUrl`, `siteUrl`, `active`, `lastFetchAt`, `lastFetchStatus`, `itemsCaptured7d`.
- **UI :** `TanStack`/`Table` compacte : nom, URL, badge santé (`ok`→vert / `error`→rouge / `never`→ardoise), articles captés (7 j), interrupteur **actif**. En-tête : « Ajouter une source ». Édition/ajout dans un `Sheet` (nom, URL du flux, URL du site, actif). Bouton **« Vérifier ce flux »** (dans le Sheet et par ligne).
- **Actions serveur (`feed:manage`) :** `createFeed({name, feedUrl, siteUrl, active})`, `updateFeed(id, {...})`, `toggleFeed(id, active)`, `deleteFeed(id)` (via `ConfirmDialog` nommant la conséquence), `testFeed(url)` → `parseFeed(url)` (SP3) renvoyant `{ok, count}` ou `{ok:false, message}` (valider avant activation ; ne jamais activer une URL cassée). Validation Zod (URL). `revalidatePath("/settings/feeds")`.
- **États :** vide (« Aucune source configurée »), chargement, erreur. Le test d'un flux affiche un toast (n articles trouvés / erreur claire).

---

## 5. Équipe & rôles (§6.10, Admin)

- **Requête :** liste `user` (Better-Auth) — `name`, `email`, `role`, `banned` (→ statut actif/désactivé), `lastLoginAt`.
- **UI :** table : nom, email, badge rôle (Admin/Éditeur/Journaliste via `ROLE_LABEL`), statut, dernière connexion. En-tête : « Ajouter un membre ».
- **Actions serveur (`team:manage`, Admin) :**
  - `addMember({email, name, role})` → génère un **mot de passe temporaire** aléatoire, crée le compte via `createCredentialUser`, renvoie le mot de passe **une seule fois** pour affichage (l'admin le communique). Statut = actif.
  - `setMemberRole(userId, role)` (admin/éditeur/journaliste).
  - `disableMember(userId)` / `enableMember(userId)` → bascule `user.banned` (jamais de suppression) via `ConfirmDialog` nommant la conséquence + trace.
  - Garde-fous : un admin ne peut pas se désactiver lui-même ni retirer son propre dernier rôle admin (éviter le verrouillage).
- **Sécurité :** ces actions sont RBAC-gardées côté serveur ; le mot de passe temporaire n'est jamais journalisé/committé.

---

## 6. Catégories & Tags (§6.9)

- **Requêtes :** `wpCategories` / `wpTags` — `name`, `wpId`, `articleCount`.
- **UI :** deux tables (catégories / tags) lecture seule + compte d'articles ; en-tête bouton **« Synchroniser depuis WordPress »**.
- **Action serveur (`taxonomy:manage`) :** `syncTaxonomyFromWordPress()` → si WordPress configuré, `WordPressClient.getCategories()/getTags()` → **upsert** dans `wpCategories`/`wpTags` (par `name`, renseigne le vrai `wpId` + `count`), sans doublon ; renvoie `{categories, tags}` synchronisés (ou « WordPress non configuré »). Toast récap. `revalidatePath`.
- Objectif : comprendre pourquoi l'IA choisit telle catégorie (le miroir contraint le choix IA en SP3) et voir la taxonomie réelle plutôt que les placeholders seedés.

---

## 7. Intégrations (§6.11)

- **UI :** cartes de statut par intégration : **WordPress · OmniRoute · OpenRouter · Jina · Firecrawl** — chacune : configuré / non configuré (jamais la valeur de la clé), une info « dernier succès » quand disponible (WordPress : dernière `distributions` `sent` ; pipeline : dernière `pipeline_runs`), et un bouton **« Tester »**.
- **Action serveur (Admin) :** `testIntegration(name)` — vérifs **gratuites** : WordPress = `WordPressClient.testConnection()` (`/users/me`) ; OmniRoute/OpenRouter = `GET /models` (gratuit) ; Jina/Firecrawl = un ping léger/HEAD (pas d'appel facturé) ; renvoie `{ok, detail}` en français. Jamais d'appel consommant des tokens.
- **Config :** lue depuis `getWpConfig()` / `getPipelineConfig()`. Clés en `.env` uniquement (pas d'édition UI). Liste extensible (emplacements réservés WhatsApp/sociaux — SP6).

---

## 8. Modèle de données

Aucune nouvelle table. `feeds`, `user` (Better-Auth), `wpCategories`/`wpTags`, `distributions`, `pipeline_runs` existent. L'ajout d'une source n'exige aucun changement de schéma. Si un champ manque vraiment à la marge, migration **additive** uniquement (peu probable).

---

## 9. Motifs transverses (rappel §7)

Badges de statut cohérents (santé flux, statut membre) ; tables avec recherche/tri quand > ~15 lignes ; **confirmations** pour toute action destructrice (supprimer une source, désactiver un compte) nommant la conséquence ; toasts succès/échec ; trois états (vide/chargement/erreur) par écran ; mode sombre ; français.

---

## 10. Tests & vérification

- **Unitaires / intégration (auto-nettoyants) :** validation + effet de `createFeed`/`updateFeed`/`toggleFeed`/`deleteFeed` ; `testFeed` (flux valide → count ; URL cassée → erreur) ; `addMember` (temp password + compte créé + connexion possible) ; `setMemberRole`/`disableMember` gardes (dont l'anti-auto-verrouillage) ; `syncTaxonomyFromWordPress` upsert (via fake WP) ; gardes RBAC de chaque action (Journaliste refusé partout ; Éditeur refusé sur Équipe/Intégrations) ; `testIntegration` gratuit + non-configuré.
- **Vérification applicative (navigateur) :** en Admin, ajouter/basculer/tester un flux ; ajouter un membre (mot de passe temporaire affiché une fois) ; changer un rôle ; désactiver puis réactiver ; synchroniser la taxonomie depuis WordPress ; voir les statuts d'intégration + tester WordPress ; confirmer qu'un Journaliste n'accède pas à `/settings/*` et qu'un Éditeur n'accède ni à Équipe ni à Intégrations.

---

## 11. Structure de fichiers

```
app/(app)/settings/layout.tsx                 # sous-nav + gardes
app/(app)/settings/feeds/page.tsx             # remplace le placeholder
app/(app)/settings/taxonomy/page.tsx          # remplace le placeholder
app/(app)/settings/team/page.tsx              # remplace le placeholder
app/(app)/settings/integrations/page.tsx      # remplace le placeholder
lib/queries/settings.ts                       # getFeeds/getMembers/getTaxonomy/getIntegrationStatus
lib/actions/feed-actions.ts                   # create/update/toggle/delete/testFeed
lib/actions/team-actions.ts                   # addMember/setMemberRole/disable/enableMember
lib/actions/taxonomy-actions.ts               # syncTaxonomyFromWordPress
lib/actions/integration-actions.ts            # testIntegration
components/settings/{feeds-table.tsx, feed-sheet.tsx, members-table.tsx, add-member-dialog.tsx,
                     taxonomy-tables.tsx, integration-cards.tsx, settings-nav.tsx}
tests/{feed-actions, team-actions, taxonomy-sync, integration-status}.test.ts
```

---

## 12. Décisions & alternatives écartées

- **Les 4 écrans dans ce segment** (retenu, per user) : section Réglages complète ; chaque écran est borné et réutilise l'infra existante.
- **Onboarding par mot de passe temporaire** (retenu, per user) plutôt qu'email : pas de dépendance email ; affiché une fois, communiqué manuellement.
- **Sync taxonomie depuis WordPress** (retenu) : remplace le miroir seedé par la vraie taxonomie via le client SP5 — connecte SP2 à SP5.
- **Intégrations = statut + test gratuit** (retenu) plutôt qu'édition de clés en UI : l'édition de secrets exige un stockage sécurisé (hors périmètre) ; les clés restent en `.env`.
- **Anti-auto-verrouillage** (retenu) : un admin ne peut pas se désactiver / se retirer le dernier rôle admin.
