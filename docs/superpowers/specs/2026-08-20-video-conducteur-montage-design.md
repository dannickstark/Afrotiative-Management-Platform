# Conducteur de montage & accès monteur (sous-projet 2) — design

Donne au **monteur** un conducteur exploitable au lieu d'un document Word périmé. Trois
volets cohérents autour d'un même objectif : (a) **projeter** les beats du script en un
conducteur de montage, (b) le **rendre accessible** au monteur — en interne (rôle
`Monteur`) et en externe (lien signé), (c) l'**exporter** (PDF, liste de plans CSV/JSON,
manifeste des médias) et permettre de **légères annotations** en retour.

Construit sur SP1 : les beats portent déjà tout ce qu'il faut (texte, notes de réalisation,
transitions, inserts avec tc in/out + crédit + droits + `r2Key`), les durées sont
**stockées** (rien à recalculer, cf. `lib/video/duration.ts:2`), le statut `en_montage` et
la sémantique « côté monteur » de `linkStatus` étaient déjà réservés.

## Objectif et périmètre

- **But** : un monteur (interne connecté OU externe via lien signé) ouvre un conducteur en
  lecture, l'exporte dans un format utilisable au montage, et peut cocher les beats faits
  et signaler un lien d'insert mort.
- **Hors périmètre** : pas de moteur PDF lourd (on imprime du HTML optimisé) ; pas de zip
  réel des médias (on fournit un manifeste) ; pas de journal de prises (SP4) ; pas de
  variantes dérivées (SP6). L'écriture du script reste dans le chat (SP1), inchangée.

## Décisions verrouillées (ne pas rouvrir)

1. **Accès double** : rôle `Monteur` connecté ET lien signé externe. Les deux résolvent la
   même capacité (lecture + annotations), l'un par le rôle, l'autre par le jeton.
2. **Trois exports** : PDF (via HTML imprimable, sans dépendance), liste de plans CSV/JSON,
   manifeste des médias d'insert (liste, pas un zip).
3. **Annotations légères** : cocher un beat comme monté, signaler un lien d'insert mort.
   Journalisées. Depuis l'app et depuis le lien signé (portée limitée au projet du jeton).
4. **Lien signé révocable + expiration optionnelle** ; jeton haché (jamais en clair), sur
   le motif de `api_tokens`.
5. **Un seul spec/plan** pour l'ensemble (choix utilisateur, pas de découpage en
   sous-projets).

## 1. Projection du conducteur (le pivot)

Nouveau module pur `lib/video/rundown.ts` (sans `@/db`) :

`buildConducteur(beats: BeatRow[], insertsByBeat: Map<string, InsertRow[]>, wpm: number): Conducteur`

où `Conducteur = { beats: ConducteurBeat[]; totals: { beatCount, totalDurationSec, insertCount, deadLinkCount } }` et

`ConducteurBeat = { position, kind, kindLabel, spokenText, directionNote, screenText, transitionIn, transitionOut, durationSec, breathRisk, speakerName, inserts: ConducteurInsert[] }`

`ConducteurInsert = { kind, kindLabel, mediaUrl, tcIn, tcOut, displayDurationSec, credit, rightsNote, linkStatus, linkLabel }`

- `durationSec = durationOverrideSec ?? estimatedDurationSec` (durée stockée, pas recalculée).
- `breathRisk` via `isBreathRisk` (existant).
- `mediaUrl` = `publicUrlFor(cfg, r2Key)` si `r2Key` présent, sinon `url` externe. La
  résolution R2 se fait dans le cœur DB (accès config), pas dans le pur — le pur reçoit
  `mediaUrl` déjà résolu OU reçoit `{ url, r2Key }` + une fonction de résolution injectée.
  **Décision** : le pur reçoit `url` et `r2Key` bruts et une `resolveMedia(url, r2Key)`
  injectée (garde `rundown.ts` pur et testable sans R2).
- `linkLabel` : libellés monteur pour `linkStatus` — `non_verifie`→« à vérifier »,
  `ok`→« ok », `mort`→« mort », `interdit`→« interdit ».
- `totals.deadLinkCount` = inserts dont `linkStatus ∈ {mort, interdit}`.

Cœur DB `readConducteurCore(variantId): Promise<{ projectId, variantId, conducteur: Conducteur }>`
dans `lib/video/persist.ts` (seule exception `@/db`), calquant `readScriptCore` : charge les
beats ordonnés + inserts, résout les URLs R2, appelle `buildConducteur`.

Libellés de kind d'insert à ajouter dans `lib/video/labels.ts` si absents.

## 2. Vue Montage dans l'app

- 4ᵉ onglet `?tab=montage` sur `app/(app)/video/[id]/page.tsx`, à côté de Brief / Écriture /
  Importer.
- Composant `components/video/conducteur-view.tsx` (lecture seule) : en-tête de totaux
  (nb beats, durée totale formatée, nb inserts, nb liens morts), puis chaque beat avec
  position, libellé de kind, durée, texte, note de réalisation, texte écran, transitions,
  et ses inserts (tc in/out, crédit, droits, badge `linkStatus`, marqueur risque de
  souffle). Réutilise le formatage de durée existant.
- Accessible aux rôles ayant `video:read` (journaliste, éditeur, admin) **et** au rôle
  `monteur`.

## 3. Rôle Monteur

- Ajouter la valeur `monteur` à l'enum `user_role` via une **migration autonome** ne
  faisant que `ALTER TYPE "user_role" ADD VALUE 'monteur'`, sans qu'aucune colonne ne
  référence la valeur dans la même transaction (évite 55P04 ; Neon = PG15+ autorise l'ADD
  en transaction tant que la valeur n'est pas consommée avant commit).
- `lib/permissions.ts` : nouvelle action `annotate` sur la ressource `video`
  (`video: ["read", "manage", "configure", "annotate"]`) ; nouveau rôle `monteur` =
  `video: ["read", "annotate"]` uniquement.
- `lib/rbac.ts` : refléter dans `MATRIX` — `monteur: { video: ["read", "annotate"] }` ;
  ajouter `annotate` aux rôles éditeur/admin (et journaliste ? **non** — journaliste garde
  read+manage sans annotate ; l'annotation montage est une capacité monteur/éditeur).
  Ajouter `ROLE_LABEL.monteur = "Monteur"`.
- `Role` type (`lib/auth.ts`) : ajouter `"monteur"`.
- Le rôle est attribuable via l'admin better-auth existant (gestion d'équipe) — pas de
  nouvel écran d'attribution dans ce SP.

## 4. Accès par lien signé

- **Table `montage_shares`** : `{ id uuid pk, projectId → video_projects.id (cascade),
  tokenPrefix text, tokenHash text, createdBy → user.id, expiresAt timestamp null,
  revokedAt timestamp null, lastAccessedAt timestamp null, createdAt timestamp default now }`.
  Index unique sur `tokenPrefix`, index sur `projectId`. Stocke **seulement** préfixe +
  hash SHA-256, jamais le jeton en clair.
- **`lib/montage/token.ts`** (pur) : calque `lib/mcp/token.ts` avec un namespace distinct
  `mtg_` — `generateShareToken()`, `hashShareToken`, `sharePrefixOf`, `shareTokenMatches`
  (via `safeEqual`).
- **`lib/montage/access.ts`** (cœur DB) : `resolveShare(rawToken): Promise<ShareOutcome>`
  où `ShareOutcome = { ok: true; share: { id, projectId } } | { ok: false; reason }`.
  Vérifie préfixe → lookup → hash constant-time → non révoqué → non expiré ; met à jour
  `lastAccessedAt`. Ne divulgue pas la raison au public (message opaque).
- **Route publique** hors `(app)` : nouveau groupe `app/(public)/` avec
  `app/(public)/layout.tsx` (sans chrome d'app, sans `requireUser`) et
  `app/(public)/montage/[token]/page.tsx` — résout le jeton, charge la variante du projet,
  rend `conducteur-view` en lecture + les actions d'annotation limitées à ce projet. Jeton
  invalide/expiré/révoqué → page 404/erreur neutre.
- **Gestion dans l'app** : sur la page projet (onglet Montage ou une section dédiée), un
  panneau « Accès monteur » réservé à `video:manage` : créer un lien (URL complète affichée
  **une seule fois**, comme les jetons API), voir statut/expiration/dernier accès, révoquer
  (`ConfirmDialog`, motif de `token-list.tsx`). Server actions dans
  `lib/actions/montage-actions.ts` (`createShareLink`, `revokeShareLink`), gardées par
  `requireUser()` + `requirePermission(role, "video", "manage")`.

## 5. Exports

Tous lisent la projection `readConducteurCore` et sont disponibles **en interne** (app,
`video:read`) **et** via le lien signé (portée jeton). Trois routes/handlers :

- **PDF conducteur** — pas de moteur PDF : une **vue HTML imprimable** (`?print=1` sur la
  page montage, ou `app/(public)/montage/[token]/print/page.tsx`) avec CSS `@media print`
  (masque la navigation, saut de page par beat si utile). L'utilisateur imprime → « Enregistrer
  en PDF ». Zéro dépendance ajoutée.
- **Liste de plans CSV/JSON** — route handler renvoyant `text/csv` (et une variante JSON)
  avec `Content-Disposition: attachment`. Colonnes : `beat_position, beat_kind,
  duration_sec, insert_kind, tc_in, tc_out, media_url, credit, rights, link_status`. Une
  ligne par insert (beats sans insert : une ligne beat avec colonnes insert vides).
- **Manifeste des médias** — route handler renvoyant la liste (CSV ou JSON) de tous les
  médias d'insert : `media_url` (R2 public résolu ou externe), `insert_kind`, `credit`,
  `rights`, `tc_in`, `tc_out`, `link_status`. Pas de zip (déféré).

Les handlers d'export vivent sous `app/api/montage/...` (interne, garde `requireUser`) et
sont réutilisés/reflétés par le lien signé (garde jeton). **Décision** : un seul handler
paramétré qui accepte soit une session (`requireUser` + projet demandé) soit un jeton de
partage (résolu, projet imposé), pour ne pas dupliquer la génération.

## 6. Annotations légères (retour monteur)

Deux actions, journalisées, appelables depuis l'app (monteur/éditeur connecté) et depuis le
lien signé (limité au projet du jeton) :

- **Cocher un beat monté** — nouvelle colonne `montageCheckedAt timestamp null` sur
  `script_beats`. Bascule (coché/décoché).
- **Signaler un lien d'insert mort** — passe `beat_inserts.linkStatus = 'mort'`.

- **Journalisation** : chaque annotation écrit une entrée `script_journal` avec un nouveau
  `scriptJournalSource` = `monteur` (ajouté par migration enum autonome, même précaution
  55P04). `actorUserId` = l'utilisateur connecté si rôle monteur/éditeur, sinon `null` avec
  un marqueur « lien signé » dans le payload (le partage identifie qui a créé le lien, pas
  qui l'utilise).
- **Autorisation** :
  - App : `requirePermission(role, "video", "annotate")` (monteur, éditeur, admin).
  - Lien signé : le jeton résout un `projectId` ; l'action vérifie que le beat/insert visé
    appartient bien à ce projet (jointure beat→variant→projet) avant d'écrire — jamais une
    écriture hors périmètre. Pas d'accès aux articles, au brief, ni à d'autres projets.
- Server actions dans `lib/actions/montage-actions.ts` ; cœurs DB dans `lib/montage/*`
  (purs sauf accès `@/db` regroupé, comme `persist.ts`).

## Modèle de données (récap migrations)

1. Colonne `script_beats.montage_checked_at` (additive).
2. Table `montage_shares`.
3. `ALTER TYPE user_role ADD VALUE 'monteur'` — **migration autonome**.
4. `ALTER TYPE script_journal_source ADD VALUE 'monteur'` — **migration autonome**.

Les deux `ADD VALUE` doivent être des migrations séparées de toute utilisation de la valeur
(colonnes/insertions), sinon 55P04. Générées via `bun run db:generate` ; si drizzle-kit les
regroupe dans un même fichier avec une consommation, scinder à la main.

## Gestion des erreurs & sécurité

- Lien signé : jeton absent/mal formé/inconnu/révoqué/expiré → page neutre (pas d'oracle
  sur la raison). Comparaison de hash constante (`safeEqual`).
- Écriture depuis lien signé strictement limitée au `projectId` du partage (vérification de
  parenté beat/insert obligatoire avant tout `UPDATE`).
- Exports depuis lien signé : mêmes données que la vue, rien de plus (pas d'articles, pas
  d'autres projets).
- La route publique ne passe jamais par `requireUser` ; toutes ses lectures/écritures sont
  paramétrées par le partage résolu.

## Tests

- **Purs** : `buildConducteur` (ordre, durées stockées, totaux, deadLinkCount, breathRisk,
  résolution média injectée) ; `lib/montage/token.ts` (génération, préfixe, hash, match
  constant) ; sérialisation CSV/manifeste ; libellés `linkStatus`.
- **DB** : création/vérification/révocation/expiration d'un partage ; annotation (checkoff +
  flag lien) écrit la ligne + le journal ; `readConducteurCore`.
- **Intégration** : route publique refuse jeton révoqué/expiré (page neutre) ; annotation
  via jeton limitée à son projet (rejet d'un beat d'un autre projet) ; export CSV via jeton
  ne renvoie que le projet du jeton ; le chemin app (rôle monteur) fonctionne.
- Nouveaux tests purs inscrits dans `PURE_FILES` (`scripts/test-fast.ts`).

## Contraintes héritées

- `lib/video/rundown.ts` et `lib/montage/token.ts` restent purs (pas de `@/db`) ; les cœurs
  DB regroupent l'accès dans `persist.ts`/`lib/montage/*` sur le modèle existant.
- Durées **stockées**, jamais recalculées côté conducteur/export.
- Ordre de verrouillage SP1 respecté pour toute transaction touchant les beats.
- Copie UI en français ; shadcn/ui + Tailwind v4 ; server actions débutent par
  `requireUser()` + `requirePermission()`.

Voir [[video-module-roadmap]] pour le découpage et [[execution-mode-subagent-driven]] pour
l'exécution. Contexte amont : `2026-08-16-video-script-contrat-import-design.md` (SP1).
