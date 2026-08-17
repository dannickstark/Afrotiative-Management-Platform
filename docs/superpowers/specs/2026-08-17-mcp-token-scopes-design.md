# Design — Portées des jetons MCP

Date: 2026-08-17
Status: approved-for-planning (pending user spec review)
Branch: `feat/mcp-token-scopes`, empilée sur `feat/video-mcp-category` (PR #40), elle-même empilée
sur `feat/video-categories-instructions` (PR #39). Elle annote `list_video_categories`, l'outil que
la #40 introduit, d'où l'empilement. **Ordre de fusion : chaque PR empilée avant sa base** — celle-ci
d'abord (dans `feat/video-mcp-category`), puis #40 (dans `feat/video-categories-instructions`), puis
#39 (dans `main`). Fusionner une base avant son enfant laisserait le travail de l'enfant dans un
cul-de-sac.

Aujourd'hui, un jeton d'API MCP donne **tout** ce que son propriétaire peut faire. `registerTools`
(`lib/mcp/tools.ts:65`) ne vérifie une permission que pour les outils d'écriture ; les outils de
lecture ne passent aucun contrôle. Et comme les trois rôles portent `video: ["read", "manage"]`,
ajouter `requirePermission(role, "video", "read")` sur les lectures ne changerait strictement rien :
le jeton hérite du rôle, et tous les rôles ont ce droit.

Le besoin réel n'est donc pas un durcissement de la matrice de rôles, mais une **portée propre au
jeton** : pouvoir remettre à quelqu'un — ou à un agent — un jeton qui lit sans écrire, ou qui touche
au module vidéo sans lire toute la rédaction.

## Décisions verrouillées avec l'utilisateur

1. **Portée par jeton**, pas durcissement par rôle. Le rôle reste le plancher (il continue de garder
   les écritures) ; la portée du jeton devient le plafond. Un appel doit passer les deux.
2. **Deux axes booléens**, décidés à la création :
   - `canWrite` — sans lui, le jeton n'appelle que les outils `kind: "lecture"` du registre.
   - `canReadArticles` — sans lui, `list_articles` et `get_article` sont refusés ; le jeton ne voit
     que le domaine vidéo.
   Deux cases plutôt qu'un seul niveau : « lecture seule » ne répond pas à « ce jeton ne doit pas
   lire la rédaction », et un axe par outil chargerait l'écran de création pour un besoin qui ne
   s'est pas manifesté.
3. **Rétro-compatible** : les jetons déjà émis valent `canWrite = true, canReadArticles = true`,
   c'est-à-dire exactement ce qu'ils peuvent aujourd'hui. Aucun agent en cours ne casse.
4. **La portée n'est pas modifiable après émission.** Pour la changer, on révoque et on recrée. Une
   portée éditable donnerait l'illusion qu'un jeton distribué peut être repris en main — il ne peut
   pas : il est déjà dans la nature.
5. **La portée limite le jeton, pas la personne.** Le propriétaire d'un jeton en lecture seule
   conserve tous ses droits dans l'interface web. C'est l'intention, pas un oubli.
6. Un refus de portée remonte un **message français explicite**, pas un 403 nu : l'agent doit
   comprendre qu'il lui manque une portée, pas croire que l'outil est cassé.

---

## 1. Données

Deux colonnes sur `api_tokens` :

| Colonne | Type | Défaut | Note |
|---|---|---|---|
| `can_write` | boolean notNull | `true` | Le défaut EST la rétro-compatibilité : la migration n'a aucune donnée à réécrire, les lignes existantes prennent la valeur qui décrit leur pouvoir actuel. |
| `can_read_articles` | boolean notNull | `true` | Idem. |

Deux booléens plutôt qu'un `jsonb scopes` : la portée a deux axes fixes et connus, et deux colonnes
se lisent dans un `select`, se filtrent en SQL et se typent sans cast.

## 2. Le domaine d'un outil

`ToolSpec` (`lib/mcp/registry.ts`) gagne un champ **obligatoire** :

```ts
export type ToolDomain = "video" | "article";
export type ToolSpec = {
  name: string;
  kind: ToolKind;          // existant : "lecture" | "ecriture"
  domain: ToolDomain;      // nouveau
  description: string;
  inputSchema: z.ZodRawShape;
};
```

Obligatoire et non optionnel : un outil ajouté sans domaine ne compile pas. C'est le même
raisonnement que le registre lui-même — un pouvoir accordé en silence est le défaut que cette
structure existe pour rendre impossible.

Répartition : `list_articles` et `get_article` sont `"article"` ; tout le reste est `"video"`.

## 3. Application

`McpActor` (`lib/mcp/auth.ts`) transporte la portée à côté du rôle :

```ts
export type McpScope = { canWrite: boolean; canReadArticles: boolean };
export type McpActor = { userId: string; role: Role; tokenId: string; scope: McpScope };
```

`registerTools` vérifie, dans cet ordre, avant tout appel :

1. **Le rôle** — `requirePermission(actor.role, "video", "manage")` pour les écritures. Inchangé.
2. **La portée** — refus si `spec.kind === "ecriture"` et `!scope.canWrite` ; refus si
   `spec.domain === "article"` et `!scope.canReadArticles`.

Le rôle d'abord : la portée d'un jeton ne doit jamais pouvoir accorder ce que le rôle refuse. Les
deux contrôles vivent dans **une seule fonction pure**, `refusPourPortee(spec, scope): string | null`,
testable sans base ni serveur — c'est là que se lit la règle, plutôt que dispersée dans le corps de
`registerTools`.

Messages de refus :
- écriture sans `canWrite` → « Ce jeton est en lecture seule. Créez un jeton avec l'écriture pour
  cette action. »
- outil `article` sans `canReadArticles` → « Ce jeton n'a pas accès aux articles. »

Ils partent par le même chemin que les autres erreurs d'outil (une `Error` levée, que le SDK MCP
transforme en résultat `isError: true` portant le texte), donc l'agent les lit.

## 4. Écran des réglages MCP

**Création** (`components/settings/mcp/token-list.tsx`) : deux interrupteurs sous le champ du nom,
**cochés par défaut** — le comportement d'aujourd'hui reste le geste par défaut, la restriction est
un choix délibéré. Un libellé dit ce que chacun retire, pas ce qu'il accorde : c'est la privation
qui surprend, six mois plus tard, quand un agent échoue.

**Liste** : chaque ligne affiche sa portée. Un jeton dont on ne voit pas la portée est un jeton
qu'on ne peut pas auditer. Deux `Badge` — « Lecture seule » et « Sans articles » — affichés
seulement quand la portée est restreinte : un jeton complet n'a rien à signaler, et décorer les
lignes ordinaires noierait les lignes intéressantes.

Aucune modification de portée après création (décision 4) : pas de bouton d'édition.

## 5. Fichiers touchés

| Fichier | Nature |
|---|---|
| `db/schema.ts` + migration | `api_tokens.can_write`, `api_tokens.can_read_articles` |
| `lib/mcp/registry.ts` | `ToolDomain`, champ `domain` obligatoire sur les 11 outils |
| `lib/mcp/scope.ts` | *nouveau* — `refusPourPortee`, fonction pure |
| `lib/mcp/auth.ts` | `McpScope`, la portée chargée dans `McpActor` |
| `lib/mcp/tools.ts` | Application dans `registerTools` |
| `lib/queries/mcp.ts` | `createApiTokenCore` accepte la portée ; `TokenRow` et `listTokensCore` la remontent |
| `lib/actions/mcp-actions.ts` | `createApiToken` accepte et valide la portée |
| `lib/validation.ts` | La portée dans le schéma de création de jeton |
| `components/settings/mcp/token-list.tsx` | Interrupteurs à la création, badges dans la liste |
| `components/settings/mcp/tool-catalog.tsx` | Afficher le domaine à côté du genre de chaque outil |

## 6. Tests

**Purs** (`refusPourPortee` est une fonction pure — c'est tout l'intérêt de l'avoir extraite) :
- portée complète : aucun refus, quel que soit l'outil ;
- `canWrite: false` : refuse tous les outils `kind: "ecriture"` du registre et n'en refuse aucun de
  `kind: "lecture"` — assertion écrite en itérant `TOOL_REGISTRY`, pas sur une liste de noms
  recopiée qui cesserait silencieusement de tout couvrir au prochain outil ajouté ;
- `canReadArticles: false` : refuse `list_articles` et `get_article`, et EUX SEULS ;
- portée vide (`false, false`) : les deux refus s'appliquent, et le message est celui de l'axe le
  plus spécifique — pas deux messages concaténés ;
- **test de couverture du registre** : itérer `TOOL_REGISTRY` et vérifier que chaque outil porte un
  `domain` connu. Sans lui, un futur outil pourrait recevoir `"video"` par distraction et échapper
  à l'axe articles.

**Base :**
- un jeton créé avec `canWrite: false` est persisté ainsi, et `listTokensCore` le remonte ;
- un jeton créé sans portée explicite est complet (rétro-compatibilité par défaut) ;
- `authenticateMcp` charge la portée dans l'acteur.

**Bout en bout** (harnais MCP existant, `tests/mcp-harness.ts`) :
- un jeton en lecture seule reçoit `isError: true` et le message français sur `create_video_project` ;
- le même jeton lit `list_video_projects` sans encombre ;
- un jeton sans accès aux articles est refusé sur `get_article` et passe sur `get_script`.

## 7. Hors périmètre

- Une portée par outil, ou par projet.
- Modifier la portée d'un jeton existant.
- Une date d'expiration de jeton.
- Un rôle « lecture seule » dans la matrice RBAC — les portées répondent au besoin ; ajouter un rôle
  toucherait tout le produit, pas seulement MCP.
- Limiter ce qu'un porteur de jeton peut faire dans l'interface web (décision 5).
