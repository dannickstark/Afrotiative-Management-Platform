# V3 — Aperçu dans la page article

**Date :** 2026-08-09
**Programme :** « Studio visuel & diffusion multicanale » (`2026-08-09-afrotiative-studio-diffusion-roadmap.md`)
**Sous-projet :** V3 — dépend de V1 ; indépendant de V2
**Statut :** validé

## Objectif

Deux choses, demandées ensemble par l'utilisateur :

1. Dans `/article/[id]`, séparer **l'image originale** (source, crédit, lien) de **l'aperçu final** —
   ce que l'image deviendra une fois passée par le gabarit du site.
2. Faire en sorte que l'image réellement publiée sur WordPress soit **l'image générée**, produite au
   moment du clic sur « Approuver & publier », et non l'image brute.

C'est le point que l'utilisateur a formulé explicitement : *« les images ne sont pas générées
pendant le pipeline normal ; elles le sont au moment où on approuve et publie »*.

## Hors portée

- Les aperçus **par réseau social** : ils vivront dans le panneau Diffusion (D1). Décision prise au
  brainstorming ; cet écran ne montre que le rendu du **site**.
- Toute modification du studio (V2).

---

## §1 Onglets dans le panneau image

`components/article/image-panel.tsx` gagne deux onglets (`components/ui/tabs.tsx` existe déjà).

**Onglet « Image originale »** — strictement l'existant : vignette, crédit obligatoire, lien source,
bouton *Changer l'image*. Aucun changement de comportement.

**Onglet « Aperçu final »** — le rendu du gabarit `article_image` résolu pour la catégorie de
l'article. Quatre états, tous explicites :

| État | Affichage |
|---|---|
| Rendu disponible | l'image, plus la mention du gabarit utilisé |
| Aucun gabarit résolu | « Aucun gabarit configuré — l'image originale sera publiée telle quelle. » |
| Informations manquantes | le message français du moteur, qui **nomme** ce qui manque (image, catégorie…) |
| Stockage non configuré | « Stockage R2 non configuré. » |

L'aperçu est **calculé à la demande**, au premier affichage de l'onglet — jamais au chargement de la
page. Le rendu coûte plusieurs secondes et la grande majorité des consultations d'article ne
l'ouvriront pas.

Le cache par `inputHash` de V1 fait que rouvrir l'onglet, ou l'ouvrir après la publication, ne
relance aucun rendu : la même entrée renvoie la même ligne `renders`.

## §2 Génération au moment de publier

`approveAndPublish` (`lib/actions/article-actions.ts`) et le cron `publishDueArticles` publient
aujourd'hui l'image brute : `uploadFeaturedImage` télécharge `articles.featuredImageUrl` et la
pousse dans la médiathèque WordPress.

**Changement :** avant de construire la charge utile WordPress, `buildPublishPayload`
(`lib/wp/publish.ts`) demande à V1 le rendu du contexte `article_image`. Trois issues :

1. **Un rendu est produit** → c'est **son** URL qui est téléversée dans la médiathèque WordPress.
2. **Aucun gabarit n'est résolu** (`{ ok: true, url: null }`) → comportement actuel inchangé,
   l'image brute est publiée. Ce n'est pas une erreur.
3. **Le rendu échoue** (`{ ok: false, message }`) → la publication **échoue** avec ce message
   français, et l'article reste `approved`, donc réessayable.

Le point 3 est un durcissement délibéré et il mérite d'être dit clairement : aujourd'hui
`uploadFeaturedImage` est *fail-soft* — une image injoignable laisse passer la publication sans
image à la une. Avec un gabarit configuré, l'image générée **est** l'illustration de l'article ;
publier sans elle produirait un article visiblement cassé sur le site public. Un échec clair et
réessayable vaut mieux. Le fail-soft du téléversement WordPress lui-même reste inchangé.

`articles.featuredImageUrl` n'est **jamais** réécrit : il reste la trace de l'image d'origine, avec
son crédit et son lien source. C'est ce que l'onglet « Image originale » montre, et c'est ce dont le
gabarit repart à chaque rendu.

## §3 Dette V1 assignée à V3

Deux points que la revue de branche de V1 a explicitement renvoyés ici, parce que V3 est le premier
consommateur applicatif du moteur :

- **`next.config.ts`** n'inclut ni `sharp`, ni `@resvg/resvg-js`, ni `satori` dans
  `serverExternalPackages`. Aucun code applicatif n'importait `lib/studio` jusqu'ici ; V3 l'importe
  depuis une Server Action, et ces paquets embarquent des binaires natifs `.node` que le
  regroupement Turbopack ne sait pas traiter. Le fichier documente déjà le même problème pour
  `jsdom` / `css-tree` — même remède, même raison.
- **Un article sans image à la une ou sans catégorie** fait échouer le rendu (échec dur, conforme au
  spec V1 §6). L'interface doit le dire intelligiblement : le message du moteur nomme déjà les
  jetons manquants ; l'onglet les présente comme une liste d'informations à compléter, pas comme une
  erreur technique.

## §4 Erreurs

| Cas | Comportement |
|---|---|
| Aperçu demandé, stockage non configuré | message français dans l'onglet, aucun appel au moteur |
| Aperçu demandé, informations manquantes | liste des manques, avec un lien vers le champ concerné quand c'est possible |
| Publication, rendu en échec | la publication échoue, l'article reste `approved`, message affiché |
| Publication, aucun gabarit | publication normale de l'image brute |

## §5 Tests

| Cible | Ce qui est vérifié |
|---|---|
| Onglet aperçu | ne déclenche **aucun** rendu tant qu'il n'est pas ouvert |
| `buildPublishPayload` | avec gabarit → l'URL téléversée est celle du **rendu** ; sans gabarit → l'image brute ; rendu en échec → la publication échoue et l'article reste `approved` |
| Barrière de revue | inchangée — `publishDueArticles` ne sélectionne toujours que `status='approved'` |
| `featuredImageUrl` | jamais réécrit par une publication |
| Cache | deux publications successives ne produisent qu'un seul rendu |
| Article incomplet | message nommant les informations manquantes, pas une trace technique |

Les suites de publication existantes (`tests/wp-publish.test.ts`, `tests/publish-due.test.ts`)
doivent rester vertes : le comportement sans gabarit est inchangé, et c'est précisément ce
qu'elles couvrent.
