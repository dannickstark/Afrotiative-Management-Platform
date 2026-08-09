# V2 — Studio (éditeur visuel)

**Date :** 2026-08-09
**Programme :** « Studio visuel & diffusion multicanale » (`2026-08-09-afrotiative-studio-diffusion-roadmap.md`)
**Sous-projet :** V2 — dépend de V1 (livré, fusionnable)
**Statut :** validé

## Objectif

Donner une interface à V1. Un administrateur ou un éditeur crée un gabarit, y place des calques,
lie des emplacements à des jetons, téléverse ses logos et ses polices, prévisualise le rendu réel,
puis publie. Sans cette couche, V1 n'est utilisable qu'en écrivant du JSON à la main.

V2 ferme aussi les deux lacunes que V1 a documentées comme siennes : `wp_categories.color` n'a
aucun chemin d'écriture, et les contextes à saisie manuelle (`quote_card`, `newsletter_header`,
`recap_card`) n'ont pas de fournisseur de valeurs.

## Hors portée

- Toute diffusion vers un réseau social (D1 et suivants).
- L'onglet *Aperçu final* dans la page article (V3).
- La répétition de contenu (les N lignes d'une carte de récap restent `recap.item1..3`, comme en V1).
- Le redimensionnement multi-format d'un gabarit : un gabarit reste **un** format, décision V1.

---

## §1 Surfaces

| Route | Rôle | Contenu |
|---|---|---|
| `/studio` | admin, éditeur | Liste des gabarits groupés par contexte, avec portée (canal / catégorie), état (brouillon / publié / modifications non publiées), format. Créer, dupliquer, archiver. |
| `/studio/[id]` | admin, éditeur | L'éditeur : canevas, panneau de calques, panneau de propriétés, aperçu réel, publication. |
| `/studio/assets` | admin, éditeur | Bibliothèque : images et polices, téléversement, suppression. |
| `/studio/generer` | admin, éditeur | Génération ponctuelle pour les contextes à saisie manuelle (citation, bandeau, récap). |
| `/settings/taxonomy` *(existant)* | admin, éditeur | **+ couleur par catégorie** — ferme la lacune V1. |

Entrées de navigation : une section **Studio** dans `components/shell/nav-items.ts`, avec
*Gabarits*, *Bibliothèque* et *Génération*, visible pour `admin` et `editor`.

**RBAC.** Nouvelle ressource `template`, actions `read` / `manage` / `publish`. Éditeur et admin
obtiennent les trois ; le journaliste n'a rien et ne voit pas la section. La matrice vit dans
`lib/rbac.ts` comme le reste.

> **Contrainte de sécurité non négociable.** Tout export d'un module `"use server"` est une Server
> Action appelable **sans authentification propre** — le commentaire en tête de
> `lib/actions/taxonomy-actions.ts` documente déjà ce piège et la façon de l'éviter. Chaque action
> de V2 commence donc par `requireUser()` + `requirePermission()`, et aucun helper d'écriture brut
> n'est exporté depuis un module `"use server"`.

## §2 Éditeur — modèle d'interaction

**Le canevas est du DOM, pas un `<canvas>`.** Chaque calque est une `div` positionnée en absolu,
stylée par la **même** fonction que le rendu final : `textStyleFor` (`lib/studio/element.ts`) est
déjà partagée entre le moteur et la sonde d'auto-ajustement, et l'éditeur devient le troisième
consommateur. Un `<canvas>` imposerait une seconde implémentation du dessin, donc une seconde
source de dérive — exactement le défaut que la revue de V1 a fait corriger.

Le canevas est rendu à l'échelle : `transform: scale(k)` sur un conteneur aux dimensions réelles du
gabarit, `k` calculé pour tenir dans la zone disponible. Toutes les coordonnées manipulées restent
en **pixels du gabarit** ; l'échelle n'existe que pour l'affichage et la conversion des événements
souris.

**Interactions :** sélection au clic, déplacement au glisser, redimensionnement par huit poignées,
rotation par une poignée dédiée, `Suppr` pour supprimer, flèches pour déplacer d'un pixel
(`Maj+flèches` pour dix). Un calque `locked` ne répond ni au clic ni au glisser.

**Fidélité assumée.** Le DOM approxime ; Satori a son propre moteur de mise en page. L'éditeur
n'essaie donc pas de simuler le rendu final — il affiche un **aperçu réel** produit par le moteur
V1 (§4), rafraîchi en différé. Le canevas sert au placement, l'aperçu sert à la vérité.

## §3 État et persistance

L'état de la scène vit dans un `useReducer` côté client. Chaque action (déplacer, éditer une
propriété, réordonner) produit une nouvelle scène validée par `parseScene` avant d'entrer dans
l'état — une scène invalide n'est jamais stockée, même transitoirement.

**Enregistrement automatique du brouillon**, en différé (1,5 s après la dernière modification),
vers `render_templates.scene`. C'est la copie de travail ; le résolveur ne la lit jamais (V1 §2).
Un indicateur d'état (« Enregistré », « Enregistrement… », « Échec ») accompagne chaque cycle.

**Publication.** `publishTemplate(id)` valide la scène pour son contexte via `validateScene`, refuse
si la liste d'erreurs n'est pas vide (messages français affichés tels quels), sinon insère un
instantané dans `render_template_versions` avec `version = max(version) + 1` et pose
`publishedVersion`. L'opération est transactionnelle — V1 a appris cette leçon sur son semeur.

**Historique.** La liste des versions est consultable ; « Restaurer » copie l'instantané d'une
version dans `scene` (le brouillon), sans republier. Republier reste un geste explicite.

**« Modifications non publiées »** se dérive en comparant `scene` à l'instantané de
`publishedVersion` — pas de colonne `status`, décision V1 §2.

## §4 Aperçu réel

Une Server Action `previewTemplate({ templateId, values })` appelle `renderScene` sur la scène
**brouillon** et renvoie une **data URI**, sans rien écrire.

Ce choix est délibéré : router l'aperçu par `renderForArticle` polluerait la table `renders` et le
bucket R2 avec des états intermédiaires, et le cache par `inputHash` servirait ensuite un brouillon
comme s'il s'agissait d'un rendu publié. L'aperçu ne passe donc **ni par le cache, ni par le
stockage**.

**Valeurs d'aperçu.** Trois sources, dans l'ordre :
1. un article réel choisi dans un sélecteur (contextes `article_image` / `social_post`) ;
2. les valeurs saisies dans le formulaire (contextes à saisie manuelle) ;
3. à défaut, un **jeu d'échantillons** français intégré (`SAMPLE_VALUES`) — titre long, catégorie,
   image de démonstration — pour qu'un gabarit neuf soit prévisualisable immédiatement.

Déclenchement : en différé (800 ms) après stabilisation de la scène, plus un bouton *Actualiser*.
Un aperçu en échec affiche le message français du moteur, pas une image cassée.

## §5 Bibliothèque d'assets

`render_assets` existe depuis V1 et n'est lue par personne. V2 l'alimente et branche le chargeur.

**Téléversement** par Server Action recevant un `FormData`. Contrôles, dans cet ordre :

| Contrôle | Images | Polices |
|---|---|---|
| Taille max | 5 Mo | 2 Mo |
| Types acceptés | `image/png`, `image/jpeg`, `image/webp`, `image/svg+xml` | `font/ttf`, `font/otf`, `application/x-font-ttf`, `application/vnd.ms-opentype` |
| Validation réelle | `sharp().metadata()` doit réussir et donner des dimensions | **octets magiques** `00 01 00 00`, `true`, `ttcf` ou `OTTO` |
| Extension refusée | — | **WOFF2** — Satori ne sait pas le lire (V1 §Contraintes) |

Le type MIME déclaré par le navigateur n'est jamais cru sur parole : c'est la validation réelle qui
tranche. Une police WOFF2 est refusée avec un message français explicite plutôt qu'acceptée puis
cassée au rendu.

**Chargeur.** `DbAssetLoader implements AssetLoader` (`lib/studio/asset-loader.ts`) lit
`render_assets`, télécharge depuis R2 et met en cache en mémoire par `assetId`. Il remplace
`NullAssetLoader` dans `renderForArticle` et dans l'aperçu. C'est ce branchement qui rend
atteignable le chemin `assets.imageUrl()` que la revue de V1 a signalé comme laissant fuir une
erreur brute : **V2 doit le corriger en même temps** (message français, `RenderError`).

**Suppression.** Un asset référencé par au moins un gabarit **non archivé** ne peut pas être
supprimé ; le message nomme les gabarits concernés. Le fichier R2 est supprimé après la ligne.

## §6 Couleur de catégorie

`/settings/taxonomy` gagne une colonne **Couleur** : pastille + sélecteur hexadécimal, enregistrée
par une action `setCategoryColor(id, color)` gardée par `taxonomy:manage`. Validation : `#RRGGBB`
strict, ou vide pour revenir au défaut.

C'est le chaînon manquant de la promesse centrale du programme — un gabarit par canal, la couleur
venant de la taxonomie. Sans lui, tout rendu sort avec `DEFAULT_CATEGORY_COLOR`.

## §7 Contextes à saisie manuelle

`/studio/generer` : on choisit un contexte (`quote_card`, `newsletter_header`, `recap_card`), le
formulaire se construit à partir de `CONTEXT_TOKENS[context]` — un champ par jeton, typé selon
`TOKEN_KINDS` (texte, couleur, URL d'image, avec sélecteur d'asset pour les images).

Le rendu passe par une action `renderManual({ context, channel, categoryId, values })` qui, elle,
**écrit** : elle produit une image durable (stockage R2 + ligne `renders` avec
`subjectType: "manual"`, `subjectId: null`), puisque l'utilisateur veut récupérer un fichier. Le
résultat s'affiche avec un lien de téléchargement.

C'est ce qui rend enfin utiles les jetons `quote.*`, `edition.*` et `recap.*` déclarés en V1.

## §8 Erreurs

Style de la maison, hérité de V1 : les actions renvoient `{ ok: false, message }` en français plutôt
que de lever, et l'interface affiche le message tel quel via `sonner`.

| Cas | Comportement |
|---|---|
| R2 non configuré | Le studio s'affiche en lecture seule avec une bannière explicite ; téléversement et aperçu désactivés |
| Scène invalide à la publication | Refus, liste des erreurs de `validateScene` affichée champ par champ |
| Aperçu en échec | Message français dans la zone d'aperçu, la scène n'est pas altérée |
| Police introuvable au rendu | Repli intégré, badge « rendu dégradé » sur l'aperçu |
| Conflit de portée à la création | Message nommant le gabarit existant qui occupe déjà `(contexte, canal, catégorie)` |

## §9 Tests

`bun test`, sans réseau. Les suites qui écrivent en base nettoient derrière elles et **suppriment
défensivement leurs portées avant d'insérer** — le motif imposé par V1 via `tests/studio-fixtures.ts`.

| Cible | Ce qui est vérifié |
|---|---|
| Réducteur de scène | chaque action produit une scène valide ; annuler/rétablir ; aucune mutation |
| Conversion coordonnées | un glisser à l'échelle `k` déplace du bon nombre de pixels **du gabarit** |
| Actions gabarit | RBAC refusé pour un journaliste sur chacune ; conflit de portée ; publication refusée sur scène invalide ; version incrémentée ; instantané immuable |
| Restauration de version | copie dans le brouillon **sans** toucher `publishedVersion` |
| Téléversement | WOFF2 refusé ; MIME menteur refusé par la validation réelle ; dépassement de taille refusé |
| Suppression d'asset | refusée quand un gabarit non archivé le référence |
| `DbAssetLoader` | police et image résolues ; asset absent → `null` (et non une exception) |
| Couleur de catégorie | `#RRGGBB` accepté, `rouge` refusé, vide efface |
| `renderManual` | écrit bien une ligne `renders` `subjectType: "manual"` |
| Aperçu | n'écrit **ni** ligne `renders` **ni** objet R2 |

## §10 Découpage

V2 est volumineux. Il se livre en quatre lots, chacun utilisable :

1. **Fondations** — RBAC `template`, requêtes, actions CRUD, `/studio` (liste), couleur de catégorie.
2. **Éditeur** — canevas, calques, propriétés, liaison de jetons, aperçu réel.
3. **Bibliothèque** — téléversement images/polices, `DbAssetLoader`, sélecteurs, correction de la
   fuite `assets.imageUrl()`.
4. **Saisie manuelle** — `/studio/generer`, `renderManual`, documentation.
