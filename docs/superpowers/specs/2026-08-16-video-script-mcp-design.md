# Design — Scripts vidéo, sous-projet 1 bis : serveur MCP

Date: 2026-08-16
Status: approved-for-planning (pending user spec review)
Branch: `feat/video-script-mcp`

Le sous-projet 1 a livré le contrat JSON, le brief à coller dans un chat Claude, et l'import de
sa réponse. Ce sous-projet supprime le copier-coller : le chat écrit **directement** dans la
console, par un serveur MCP.

Le gain n'est pas l'économie de deux gestes. Avec le copier-coller, un payload malformé est le
problème de l'utilisateur. Par MCP, les erreurs de validation reviennent **à l'agent**, qui se
corrige et resoumet. Le contrat cesse d'être une documentation et devient une boucle de
rétroaction.

## Décisions verrouillées avec l'utilisateur

1. **Clients visés** : claude.ai web, Claude Code, Claude Desktop, agents tiers.
2. **Authentification par paliers** : jeton d'API personnel maintenant (SP1 bis), OAuth 2.1 + DCR
   ensuite (SP1 ter) pour débloquer claude.ai web. Même serveur, mêmes outils, seule la porte change.
3. **Jetons par utilisateur**, hachés, révocables depuis Réglages. Chaque écriture d'agent est
   attribuée à une personne.
4. **Écriture complète** : l'agent peut soumettre **et appliquer** un import, éditer un beat,
   réordonner, corriger l'URL d'un insert.
5. **`revert` n'est PAS exposé** : l'agent avance, seul un humain revient en arrière.
6. **Portée** : un agent authentifié voit tous les projets vidéo. Équipe de 2 à 5 personnes sur une
   console interne — cloisonner coûterait plus cher que ça ne protège.
7. **Le copier-coller reste** : même schéma, coût nul, et seul chemin disponible tant que le SP1 ter
   n'a pas livré OAuth pour claude.ai web.

## La tension assumée, et ses garde-fous

L'application d'un import par un agent **contourne la revue de diff humaine**, qui est le mécanisme
central empêchant un modèle d'effacer un beat par omission. L'utilisateur l'a décidé en connaissance
de cause. Trois garde-fous, aucun optionnel :

1. **Les défauts de sélection du produit s'appliquent à l'agent comme à l'humain.** `apply_script`
   sans sélection explicite applique les ajouts et les modifications, **jamais** les suppressions ni
   les conflits. Un agent qui veut supprimer un beat doit le demander nommément.
2. **Toute application d'agent est marquée « non relue »** jusqu'à ce qu'un humain ouvre le projet.
   La liste `/video` et l'onglet Importer le signalent.
3. **L'annulation reste humaine.** `revert_journal_entry` n'est pas un outil MCP. Le journal du SP1
   enregistre déjà le payload brut et l'état d'avant : tout ce qu'un agent applique est réversible,
   par une personne.

---

## 1. Transport et route

- **Streamable HTTP**, route handler `app/api/mcp/route.ts`, déployé avec le reste sur Railway.
  Pas de service séparé.
- **`@modelcontextprotocol/sdk` 1.30.0** est déjà présent dans `node_modules` (dépendance
  transitive) mais **n'est pas déclaré** dans `package.json` : à ajouter en dépendance directe.
  S'appuyer sur une transitive est un piège — elle peut disparaître au prochain arbitrage npm.
- Le handler est **sans état** entre requêtes : chaque appel s'authentifie, agit, journalise.
  Aucune session serveur à maintenir, ce qui est aussi ce qui rendra le passage à OAuth indolore.

## 2. Authentification (`api_tokens`)

| Colonne | Type | Note |
|---|---|---|
| `id` | uuid PK | |
| `userId` | text → `user.id` notNull, cascade | l'écriture est attribuée à une personne |
| `name` | text notNull | « Claude Code — portable », choisi à la création |
| `prefix` | text notNull | les 8 premiers caractères, affichés dans la liste pour reconnaître un jeton |
| `tokenHash` | text notNull | SHA-256 du jeton complet |
| `lastUsedAt` | timestamp | pour repérer un jeton oublié |
| `revokedAt` | timestamp | révocation douce : l'historique du journal garde son sens |
| `createdAt` | timestamp notNull | |

- Le jeton est **affiché une seule fois**, à la création. Ensuite, seul son haché existe.
- Format : `afro_vid_` + 32 octets aléatoires en base64url. Le préfixe rend une fuite identifiable
  dans un journal ou un dépôt.
- Vérification : recherche par `prefix`, puis comparaison du haché avec `safeEqual`
  (`lib/timing-safe.ts`) — comparaison à temps constant, comme les deux secrets de cron déjà en place.
- Un jeton révoqué ou dont le porteur est banni est refusé. Le contrôle de bannissement réutilise
  `isSessionUsable` (`lib/session.ts`) plutôt que d'en réinventer un.
- **Les droits du porteur s'appliquent** : le serveur MCP appelle `requirePermission(role, "video", "manage")`
  exactement comme les server actions. Un jeton appartenant à un journaliste peut écrire des scripts ;
  aucun jeton ne donne accès aux réglages (`configure`).

## 3. Surface d'outils

Chaque outil dérive son schéma d'entrée du même Zod que le reste du module — cinquième dérivation
de la source unique, jamais une redéclaration.

**Lecture**

| Outil | Rôle |
|---|---|
| `list_video_projects` | retrouver un espace existant (titre, statut, plateformes, durée) |
| `get_script` | l'état actuel des beats d'une variante — indispensable pour **réviser** au lieu de tout réécrire |
| `get_video_brief` | le brief d'un projet : style maison + contrat. L'agent connaît ainsi les contraintes maison sans qu'on les lui répète |
| `list_articles` / `get_article` | partir d'un article approuvé, avec ses sources et ses chiffres |

**Écriture**

| Outil | Rôle |
|---|---|
| `create_video_project` | crée l'espace **et renvoie le brief** dans la même réponse |
| `submit_script` | valide et prépare un import ; renvoie le **diff** ou le **rapport d'erreurs** |
| `apply_script` | applique une entrée préparée, avec sélection explicite ou défauts du produit |
| `update_beat` | retoucher un beat (texte, note de réalisation, texte à l'écran, transitions) |
| `reorder_beats` | déplacer un beat sans réécrire le script |
| `update_insert` | corriger l'URL d'un insert — l'agent est celui qui refait la recherche |

**Non exposé** : `revert_journal_entry`, et tout ce qui touche aux réglages du module.

### Le rapport d'erreurs est la pièce maîtresse

`submit_script` renvoie à l'agent les `Issue` du SP1 telles quelles — `path`, `message`, `received` —
plus la version de schéma attendue. C'est ce qui permet à l'agent de corriger `variantes[0].beats[6].type`
sans deviner. Une erreur résumée en prose serait un retour en arrière : elle rendrait la boucle de
rétroaction inutilisable.

## 4. Réutilisation, sans duplication

Le handler MCP appelle **exactement** les fonctions du cœur livrées au SP1 :
`parseIncoming`, `computeMerge`, `applyMerge` (`lib/video/import.ts`, purs) et
`createVideoProjectCore`, `prepareImportCore`, `applyImportCore`, `updateBeatCore`,
`reorderBeatsCore`, `updateBeatInsertCore` (`lib/video/persist.ts`).

C'est la raison pour laquelle `persist.ts` n'a jamais reçu de directive `"use server"`. Aucune
logique de contrat, de fusion ou de persistance ne doit apparaître dans `app/api/mcp/`.

**L'ordre de verrouillage du SP1 s'applique intégralement** :
`video_projects < script_variants < script_journal < script_beats < beat_inserts`, `FOR UPDATE`
sur la variante en tête de toute transaction. Le serveur MCP n'ouvre aucune transaction propre ;
il délègue au cœur, qui les tient déjà.

## 5. Journalisation

Chaque écriture d'agent écrit dans `script_journal` (table du SP1, déjà prévue pour ça) :
`source: "mcp"`, `toolName`, `actorUserId` résolu depuis le jeton, arguments, diff, `applied`.

Deux colonnes s'ajoutent à `script_journal` :

| Colonne | Rôle |
|---|---|
| `toolArgs` | jsonb — les arguments exacts reçus par l'outil, pour diagnostiquer un comportement d'agent |
| `reviewedAt` | timestamp — posé quand un humain ouvre le projet après une application d'agent ; `null` = non relue |

`reviewedAt` est ce qui matérialise le garde-fou 2. Sans lui, « non relue » serait une intention,
pas un état.

## 6. Interface

- **Réglages → Jetons d'API** (`/settings/tokens`) : créer (le jeton s'affiche une fois), lister
  (nom, préfixe, dernière utilisation, propriétaire), révoquer. Un membre voit ses propres jetons ;
  un admin les voit tous. Instructions de branchement copiables pour Claude Code et Claude Desktop.
- **Marqueur « non relue »** sur la liste `/video` et dans l'historique du journal, effacé quand un
  humain ouvre le projet.
- Copie en français, comme le reste de la console.

## 7. Fichiers

| Fichier | Rôle |
|---|---|
| `app/api/mcp/route.ts` | transport Streamable HTTP, authentification, enregistrement des outils |
| `lib/mcp/auth.ts` | génération, hachage, vérification des jetons (pur, testable) |
| `lib/mcp/tools.ts` | définition des outils : schéma d'entrée dérivé, délégation au cœur |
| `lib/actions/token-actions.ts` | création et révocation, gardées |
| `app/(app)/settings/tokens/page.tsx`, `components/settings/token-list.tsx` | écran |
| `db/schema.ts` | `api_tokens`, plus `toolArgs` et `reviewedAt` sur `script_journal` |

## 8. Cas limites décidés

- **Jeton absent, malformé, révoqué, ou porteur banni** → 401, message neutre. Ne jamais distinguer
  « jeton inconnu » de « jeton révoqué » dans la réponse : c'est un oracle.
- **Droits insuffisants** → 403, avec le nom de la permission manquante (l'agent peut le rapporter à
  son utilisateur, qui agira).
- **`apply_script` sur une entrée déjà appliquée ou périmée** → le refus du SP1 remonte tel quel à
  l'agent, message compris. Il saura qu'il doit resoumettre.
- **Deux agents concurrents** → les gardes du SP1 (verrou de variante, mise à jour conditionnelle de
  l'`outcome`) s'appliquent sans modification.
- **Payload dépassant les bornes du contrat** (500 beats, 10 variantes) → erreur de validation
  ordinaire, renvoyée à l'agent.

## 9. Tests

**Purs** (`bun run test:pure`) — génération de jeton (préfixe, longueur, unicité) ; hachage et
vérification, y compris le refus d'un jeton révoqué ; comparaison à temps constant ; dérivation des
schémas d'entrée des outils depuis le contrat ; forme du rapport d'erreurs renvoyé à l'agent.

**Base** — un jeton valide obtient une réponse et une seule ; un jeton révoqué est refusé ; un jeton
de journaliste peut écrire un script mais pas atteindre les réglages ; une écriture d'agent est
journalisée avec `source: "mcp"`, le bon `toolName` et le bon `actorUserId` ; `apply_script` sans
sélection n'applique ni suppression ni conflit ; `reviewedAt` reste `null` jusqu'à ouverture humaine.

## 10. Hors périmètre

OAuth 2.1 + DCR et le connecteur claude.ai web (**SP1 ter**) — conducteur de montage et accès
monteur (**SP2**) — vérification des liens et R2 (**SP3**) — prompteur et prises (**SP4**) —
interview (**SP5**) — variantes dérivées (**SP6**). Aucune limitation de débit par jeton dans ce
sous-projet : la console est interne et l'usage est humain-déclenché ; à reconsidérer si un agent
autonome tourne en continu.

## 11. Hypothèses vérifiées

- `@modelcontextprotocol/sdk` **1.30.0** présent dans `node_modules`, **non déclaré** dans
  `package.json` — à déclarer.
- `lib/timing-safe.ts` fournit déjà `safeEqual`, utilisé par les deux secrets de cron.
- `lib/session.ts` fournit `isSessionUsable` pour le contrôle de bannissement.
- Le cœur du SP1 (`lib/video/persist.ts`, sans `"use server"`) est appelable directement, ce qui
  était sa raison d'être.
- Non vérifié, à confirmer au SP1 ter : la disponibilité des connecteurs personnalisés sur le plan
  claude.ai de l'utilisateur.
