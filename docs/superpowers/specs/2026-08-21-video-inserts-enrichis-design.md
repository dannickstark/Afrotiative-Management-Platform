# Inserts enrichis (sous-projet 3) — design

Rend les **inserts** d'un beat pleinement exploitables au montage : édition complète des
métadonnées et timecodes, **vérification des liens** (ok / mort / interdit), et **upload
des médias images/graphiques** vers R2. SP1 a importé les inserts ; SP2 lit `linkStatus`
dans le conducteur et permet au monteur de signaler un lien mort. SP3 comble ce qui a été
délibérément laissé de côté : `updateBeatInsertCore` n'édite aujourd'hui que `url`, et rien
n'écrit jamais `ok` ni `interdit` automatiquement.

## Objectif et périmètre

- **But** : un éditeur peut éditer tous les champs d'un insert (kind, tc in/out, durée
  d'affichage, crédit, droits, url), **vérifier** qu'un lien est vivant, et **téléverser**
  une image/un graphique hébergé sur R2.
- **Hors périmètre** : upload de fichiers **vidéo** (nouveau validateur mime/taille + gros
  cap + streaming — reporté) ; re-vérification **planifiée**/cron des liens (reportée) ;
  toute IA. Les inserts video/extrait restent basés sur une URL externe.

## Décisions verrouillées (ne pas rouvrir)

1. **Déclencheurs de vérification** : à la demande par insert, en lot par projet, et
   automatiquement après l'enregistrement d'une URL. Pas de cron.
2. **Statut inféré** : le vérificateur écrit `ok` (2xx), `interdit` (401/403), `mort` (autre
   4xx/5xx, timeout, DNS, URL non sûre). `interdit` peut aussi rester posé à la main.
3. **Upload images/graphiques uniquement** : réutilise le validateur studio (`sharp`,
   5 Mio, png/jpeg/webp/svg). Les inserts video/extrait/fichier gardent une URL externe.
4. **Un seul spec/plan** pour les trois volets (choix utilisateur).
5. **GET par plage** (`Range: bytes=0-0`) plutôt que HEAD (beaucoup de serveurs renvoient
   405 sur HEAD) ; le corps n'est jamais lu.
6. **Pas de journalisation** de la vérification : `linkCheckedAt` est l'horodatage
   d'audit ; on évite ainsi une nouvelle valeur d'enum `script_journal_source`.

## 1. Édition complète de l'insert

Étendre `updateBeatInsertCore` (`lib/video/persist.ts:209`) de `{ insertId, url }` à :

`updateBeatInsertCore(input: { insertId: string; url?: string | null; kind?: InsertKind; tcIn?: string | null; tcOut?: string | null; displayDurationSec?: number | null; credit?: string | null; rightsNote?: string | null }): Promise<void>`

- **Conserver l'ordre de verrou** `script_variants → script_beats → beat_inserts` (walk
  `insertId → beatId → variantId`, `FOR UPDATE` sur la variante, re-read de l'insert) et
  le bump de `scriptBeats.locallyEditedAt`/`updatedAt` + `scriptVariants.updatedAt`.
- **Règle de reset inchangée et resserrée** : `linkStatus`/`linkCheckedAt` ne sont remis à
  `non_verifie`/`null` **que** si `url` est fourni ET change. Éditer crédit/droits/tc/kind
  ne touche PAS le statut de lien (un lien vérifié reste vérifié).
- **Champs non fournis = inchangés** (sémantique de patch partiel ; distinguer « absent »
  de « null » pour les champs nullable).

Étendre `updateInsertSchema` (`lib/validation.ts:392`) : `tcIn`/`tcOut` via `TC_RE`
(`lib/video/schema.ts:17`), `displayDurationSec` entier 1–600, `credit` ≤200,
`rightsNote` ≤500, `kind` ∈ enum `insert_kind`, `url` garde le refine http/https ≤2048
nullable. **Refinement** : si `tcIn` et `tcOut` sont tous deux présents et valides,
`insertSpanSeconds(tcIn, tcOut) > 0` (sinon message « Le point de sortie doit suivre le
point d'entrée »).

Nouveau module PUR `lib/video/timecode.ts` (aucun n'existe) :
- `parseTimecode(tc: string | null): number | null` — `HH:MM:SS(.mmm)` → secondes (ms
  incluses), `null` si non conforme à `TC_RE`.
- `insertSpanSeconds(tcIn: string | null, tcOut: string | null): number | null` — durée en
  secondes si les deux sont valides et `out > in`, sinon `null`.

UI — `components/video/beat-inspector.tsx` `InsertRow` : passer de « URL éditable + spans
lecture seule » à un formulaire complet — select `kind`, inputs tc in/out (placeholder
`HH:MM:SS`), durée d'affichage, crédit, droits, url — un seul bouton Enregistrer appelant
`updateInsert`. Afficher la portée calculée (`insertSpanSeconds`) à titre indicatif.
Surfacer `rightsNote`, `r2Key`, `linkCheckedAt` au client (aujourd'hui absents du mapping
`page.tsx:92-101`).

## 2. Vérification des liens

Nouveau module `lib/video/link-check.ts` (cœur pur à `fetch` injectable) :

`verifyUrl(url: string | null, opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<{ status: "ok" | "mort" | "interdit"; httpStatus?: number }>`

- `url` absent/vide → `{ status: "mort" }` (rien à vérifier).
- `isSafePublicHttpUrl(url)` faux → `{ status: "mort" }` (jamais de fetch vers une cible
  privée/non http).
- Sinon `GET` avec `headers: { Range: "bytes=0-0" }`, `signal: AbortSignal.timeout(timeoutMs
  ?? 10000)`, `redirect: "follow"`. **Ne jamais lire `res.body`.**
- Mapping : `res.status` 200–299 → `ok` ; 401/403 → `interdit` ; autre → `mort`. Toute
  exception (timeout, DNS, réseau) → `mort`.
- Injectable `fetchImpl` pour les tests (pas de réseau).

Cœur DB `setInsertLinkStatusCore(input: { insertId: string; status: "ok" | "mort" | "interdit" }): Promise<void>` :
- Prend le verrou de variante (ordre habituel) puis met `beat_inserts.linkStatus` +
  `linkCheckedAt = new Date()`. **Ne bump PAS** `locallyEditedAt` (rafraîchissement de
  statut, pas une édition de contenu). Pas de `script_journal`.

Server actions (`lib/actions/video-actions.ts`, garde `guard()` = `video:manage`) :
- `verifyInsertLink(insertId: string): Promise<{ ok: true; status: LinkStatus } | { ok: false; message: string }>` — charge l'url de l'insert, `verifyUrl`, `setInsertLinkStatusCore`, `revalidateVideo`, renvoie le nouveau statut.
- `verifyProjectLinks(projectId: string): Promise<{ ok: true; counts: { ok: number; mort: number; interdit: number } } | { ok: false; message: string }>` — charge tous les inserts du projet ayant une url, vérifie en **concurrence limitée (≈5)**, met à jour chacun, renvoie les totaux.

**Auto à l'enregistrement** (côté client) : dans `InsertRow`, après un `updateInsert`
réussi où l'url a changé et n'est pas nulle, appeler immédiatement `verifyInsertLink` et
mettre à jour le badge. La transaction d'édition reste rapide et sans réseau ; la
vérification est automatique mais découplée.

## 3. Upload R2 (images/graphiques)

Cœur `lib/video/insert-upload-core.ts` (sans `"use server"`) :
`uploadInsertMediaCore(input: { insertId: string; file: File }): Promise<{ url: string; r2Key: string }>` :
- `validateImageAsset(bytes)` (`lib/studio/asset-validate.ts:39` — `sharp`, 5 Mio, formats
  png/jpeg/webp/svg ; ne fait jamais confiance au MIME du navigateur).
- Clé `video/inserts/{yyyy}/{mm}/{randomUUID}.{ext}` (nouveau préfixe `video/inserts/`,
  même forme UTC que `assetKey`).
- `putObject(cfg, key, bytes, mime)` (`getStudioConfig()` ; si `null`, refuser proprement
  « stockage non configuré »).
- Met à jour l'insert (ordre de verrou) : `r2Key` = clé, `url` = URL publique, `linkStatus`
  = `ok`, `linkCheckedAt` = `new Date()` (asset hébergé par nous).

Server action `uploadInsertMedia(formData: FormData): Promise<{ ok: true; url: string } | { ok: false; message: string }>` — calque `uploadAsset` (`lib/actions/asset-actions.ts:28`) : `guard()` (video:manage), extrait `insertId` + `file`, `refusable(() => uploadInsertMediaCore(...))`, `revalidateVideo`.

UI — `InsertRow` : quand `kind ∈ {image, graphique}`, afficher un input fichier
« Téléverser » (accept image/*) + une vignette du média résolu (`r2Key`→URL publique, sinon
`url`). video/extrait/fichier restent URL uniquement.

## Modèle de données

**Aucune migration.** Toutes les colonnes cibles existent déjà sur `beat_inserts` (kind,
url, r2Key, tcIn, tcOut, displayDurationSec, credit, rightsNote, linkStatus, linkCheckedAt).
Aucune nouvelle valeur d'enum (ok/mort/interdit existent ; pas de journalisation).

## Sécurité & gestion des erreurs

- **SSRF** : `isSafePublicHttpUrl` appliqué DANS le vérificateur avant tout fetch ; une URL
  privée/non http → `mort`, jamais de requête. Garde « best-effort » (pas de protection
  DNS-rebinding — connu, hérité).
- **Fetch borné** : `AbortSignal.timeout` ; le corps n'est jamais lu (le GET par plage
  n'aspire pas un gros fichier).
- **Upload** : validation par contenu (`sharp`), cap 5 Mio, formats fermés ; MIME navigateur
  ignoré. `getStudioConfig()` null → refus propre (pas de crash).
- **Édition** : patch partiel validé ; `tcOut > tcIn` imposé ; le reset de `linkStatus` ne
  se déclenche que sur un changement d'url réel.
- Toutes les actions débutent par `requireUser()` + `requirePermission(role, "video",
  "manage")`.

## Tests

- **Purs** : `timecode` (`parseTimecode`, `insertSpanSeconds` — cas ms, hors format,
  out≤in) ; `verifyUrl` via `fetchImpl` injecté (200→ok, 403→interdit, 404/500→mort,
  exception→mort, URL privée→mort sans fetch) ; génération de clé d'upload.
- **DB** : `updateBeatInsertCore` étendu (changement d'url reset le statut ; édition
  crédit/tc ne le reset pas ; champ absent inchangé vs null) ; `setInsertLinkStatusCore` ;
  `uploadInsertMediaCore` avec `putObject`/`validateImageAsset` injectés ou un petit PNG
  réel.
- **Intégration** : `verifyProjectLinks` (concurrence + totaux) via fetch injecté.
- Nouveaux tests purs inscrits dans `PURE_FILES` (`scripts/test-fast.ts`).

## Contraintes héritées

- `lib/video/timecode.ts` et `lib/video/link-check.ts` restent purs (fetch injectable) ;
  les cœurs DB regroupent l'accès `@/db` (modèle `persist.ts`, sans `"use server"`).
- Ordre de verrou `script_variants → script_beats → beat_inserts` pour toute transaction
  touchant les inserts.
- Durées **stockées** ; `insertSpanSeconds` est indicatif, il ne remplace pas
  `displayDurationSec` (saisi/importé).
- Copie UI en français ; shadcn/ui + Tailwind v4 ; réutiliser le validateur studio et
  `putObject`/`isSafePublicHttpUrl` existants (ne pas réécrire).

Voir [[video-module-roadmap]] et [[execution-mode-subagent-driven]]. Amont :
`2026-08-21-video-conducteur-montage-design.md` (SP2, lecteur de `linkStatus`).
