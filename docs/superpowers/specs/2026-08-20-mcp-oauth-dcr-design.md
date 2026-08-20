# OAuth 2.1 + DCR pour le serveur MCP (sous-projet 1 ter) — design

Débloque **claude.ai web** comme client du serveur MCP existant. SP1 bis a livré le
serveur MCP authentifié par jeton d'API personnel (Claude Desktop/Code). SP1 ter ajoute
la porte OAuth exigée par claude.ai web : **même serveur, mêmes outils, seule la porte
change**. Le contrat consommé par le dispatch — l'acteur `McpActor` — reste identique.

## Objectif et périmètre

- **But** : un utilisateur connecté peut relier son compte MAIMP à claude.ai web via OAuth
  2.1 (PKCE) avec enregistrement dynamique de client (DCR, RFC 7591), sans coller de jeton
  à la main.
- **Hors périmètre** : aucun nouvel outil MCP ; aucune modification du dispatch, de
  `refusPourPortee`, du registre d'outils, ni des cœurs SP1 (`lib/video/*`). Le chemin
  jeton personnel (Claude Desktop/Code) reste inchangé et coexiste.

## Décisions verrouillées (ne pas rouvrir)

1. **Portée choisie au consentement** — l'écran de consentement présente les deux axes
   (`canWrite`, `canReadArticles`) en cases à cocher, défaut écriture-oui / articles-non.
   Reflète le modèle de portées de SP1 bis.
2. **Qui autorise** — tout utilisateur connecté et non banni peut autoriser une connexion.
   La capacité réelle reste bornée par le rôle (les outils d'écriture appellent toujours
   `requirePermission(video, manage)` au dispatch : un journaliste peut autoriser une
   connexion mais ses outils d'écriture sont refusés). La portée est un plafond, le rôle
   un plancher — exactement le modèle SP1 bis.
3. **Surface de gestion** — un panneau « Connexions OAuth » dans Réglages → MCP liste les
   connexions et permet de les révoquer, à côté de la liste des jetons personnels.
4. **Approche** — plugins `oidcProvider` + `mcp` de **better-auth 1.6.25** (déjà la
   librairie d'auth du projet), pas d'AS OAuth écrit à la main.

## Architecture

Les plugins `oidcProvider` + `mcp` se montent sur le handler catch-all existant
`app/api/auth/[...all]/route.ts` (`toNextJsHandler(auth)`). Ils fournissent, conformes aux
standards : DCR, `/authorize`, `/token`, vérification PKCE, jetons d'accès et de
rafraîchissement, et les métadonnées du serveur d'autorisation.

Nous ajoutons seulement trois pièces minces :

1. Deux routes de métadonnées `.well-known`.
2. Une page de consentement maison.
3. Une branche OAuth dans la **porte MCP unique** (`authenticateMcp`).

### La porte unique

`authenticateMcp` (`lib/mcp/auth.ts`) reste le seul point d'authentification et aiguille
selon la forme du jeton :

- Jeton commençant par le namespace `afro_vid_` → chemin jeton personnel existant
  (inchangé).
- Sinon → jeton d'accès OAuth : vérifié via better-auth → résout `userId` + `clientId` +
  rôle + portée stockée → construit **le même `McpActor`** `{ userId, role, tokenId,
  scope: { canWrite, canReadArticles } }`.

Le dispatch, les outils et `refusPourPortee` sont intouchés. Seule la porte gagne un
second schéma.

## Modèle de portée (rendu robuste)

Le point d'endpoint de consentement du plugin (`/oauth2/consent`) ne prend que
`{ accept: boolean, consent_code? }` : c'est **tout ou rien** sur les portées demandées ;
le plugin ne peut pas accorder un sous-ensemble. Nous ne faisons donc **pas** transiter nos
deux axes par les chaînes de portée OAuth.

- L'OAuth authentifie **qui** (utilisateur + client).
- Nos deux booléens vivent dans une table maison écrite par la page de consentement.

Flux au consentement :

1. La page rend les deux cases (Écriture / Lire les articles), défaut écriture-on /
   articles-off.
2. Sur « Autoriser » : upsert `mcp_oauth_scope(userId, clientId, canWrite,
   canReadArticles)`, puis appel de l'acceptation better-auth (`accept: true`).
3. La porte MCP lit cette ligne et construit `McpActor.scope` à partir d'elle ; le rôle
   la borne ensuite au dispatch.

Défaut si aucune ligne : conservateur (écriture-oui / articles-non).

## Flux de données (claude.ai web se connecte)

1. claude.ai appelle `/api/mcp` sans jeton → `401` + en-tête `WWW-Authenticate` pointant
   vers `/.well-known/oauth-protected-resource`.
2. Il lit les métadonnées de ressource protégée → trouve le serveur d'autorisation → lit
   `/.well-known/oauth-authorization-server`.
3. DCR : il s'enregistre dynamiquement comme client (`allowDynamicClientRegistration:
   true`).
4. `/authorize` avec PKCE → si non connecté, redirection vers `/login` existant puis
   retour → page de consentement `/oauth/authorize` → l'utilisateur choisit les axes et
   approuve.
5. Échange `/token` → jeton d'accès + jeton de rafraîchissement.
6. Appels `/api/mcp` avec le jeton d'accès → la porte construit `McpActor` → les outils
   s'exécutent bornés par la portée.

## Modèle de données

- **Géré par le plugin** (migration générée) : `oauthApplication` (clients enregistrés),
  `oauthAccessToken`, `oauthConsent`.
- **Nouvelle table maison `mcp_oauth_scope`** : unique sur `(userId, clientId)`,
  `canWrite bool`, `canReadArticles bool`, `createdAt`, `lastUsedAt`. Source de vérité de
  la portée par connexion ; alimente la liste de révocation.

## Routes ajoutées

- `app/.well-known/oauth-authorization-server/route.ts` → `oAuthDiscoveryMetadata(auth)`
- `app/.well-known/oauth-protected-resource/route.ts` → `oAuthProtectedResourceMetadata(auth)`
- `app/(app)/oauth/authorize/page.tsx` → page de consentement maison
- Les endpoints du plugin (`/authorize`, `/token`, DCR, `/oauth2/consent`) transitent par
  `app/api/auth/[...all]` existant.

## Interface de consentement

`app/(app)/oauth/authorize/page.tsx` lit les paramètres `client_id` / `scope` /
`consent_code`, affiche le nom du client + les deux cases à cocher françaises + boutons
Refuser / Autoriser. Accessible à tout utilisateur connecté non banni.

## Interface de révocation (Réglages → MCP)

Nouveau panneau « Connexions OAuth » à côté de la liste des jetons personnels : lignes
issues de `mcp_oauth_scope` jointes au nom du client + `lastUsedAt`, chacune avec un bouton
Révoquer qui supprime les jetons d'accès + le consentement du plugin pour ce couple
(utilisateur, client) et la ligne de portée. Même motif `ConfirmDialog` que la révocation
de jeton.

## Configuration et transverses

- `mcp({ loginPage: "/login", oidcConfig: { requirePKCE: true,
  allowDynamicClientRegistration: true, consentPage: "/oauth/authorize",
  accessTokenExpiresIn, refreshTokenExpiresIn } })`.
- Émetteur (issuer) dérivé de `BETTER_AUTH_URL`.
- Le coupe-circuit `mcpEnabled` garde toujours la route ressource (503 si coupé).
- Copie de `connection-panel.tsx` mise à jour : claude.ai web désormais supporté (on
  retire la mention « nécessite OAuth, utilisez Desktop pour l'instant ») ; son test
  existant est mis à jour en conséquence.

## Gestion des erreurs

- Jeton d'accès inconnu / expiré → `401` avec `WWW-Authenticate` pointant vers les
  métadonnées de ressource protégée (le MCP l'exige pour que claude.ai découvre le serveur
  d'autorisation).
- Utilisateur banni → session inutilisable → `401`.
- `mcpEnabled` coupé → `503` sur la route ressource.
- Aucune portée cochée → connexion valide mais fortement limitée ; les outils refusent au
  besoin.

## Tests

- **Purs** : mapping ligne de portée → `McpActor` ; logique défaut/sélection du formulaire
  de consentement ; forme des routes de métadonnées.
- **Intégration** : DCR → authorize → token → appel `/api/mcp` applique la portée choisie ;
  révocation → appel suivant `401` ; le chemin jeton personnel fonctionne toujours ;
  utilisateur banni → `401`.

## Risques à résoudre au plan (pas maintenant)

1. **Appel exact de révocation** — l'API better-auth pour révoquer les jetons d'un client
   pour un utilisateur donné : identifier l'endpoint ou la requête directe à utiliser.
2. **Résolution des routes `.well-known` sous l'App Router** — l'`AGENTS.md` du dépôt
   avertit que cette version de Next.js a des conventions non standard : lire la doc des
   route handlers dans `node_modules/next/dist/docs/` avant de coder, et vérifier qu'un
   segment `.well-known` se résout bien.
3. **Migration des tables plugin** — générer la migration des tables `oauth*` de
   better-auth via drizzle-kit (ou la CLI better-auth) et l'aligner sur le dossier
   `db/migrations/` existant (numérotation 0028+).

## Contraintes héritées (SP1 / SP1 bis)

- `McpActor` = `{ userId, role, tokenId, scope: { canWrite, canReadArticles } }` est le
  contrat consommé par le dispatch ; toute nouvelle porte doit produire exactement cela.
- Le rôle est le plancher (`requirePermission` dans `lib/mcp/tools.ts`), la portée le
  plafond (`refusPourPortee` dans `lib/mcp/scope.ts`). OAuth ne touche qu'à la porte.
- Import du client DB via `@/db` ; migrations Drizzle dans `db/migrations/` ; nouveaux
  fichiers de test purs à inscrire dans l'allowlist `PURE_FILES` de `scripts/test-fast.ts`.

Voir [[video-module-roadmap]] pour le découpage, `2026-08-16-video-script-mcp-design.md`
(SP1 bis) et `2026-08-17-mcp-token-scopes-design.md` (portées) pour l'amont.
