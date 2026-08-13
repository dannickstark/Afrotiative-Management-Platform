// lib/studio/clipboard.ts — Chantier B, Tâche 2 : le presse-papiers EN SESSION de l'éditeur
// (copier/coller/dupliquer). Un module FEUILLE au même sens que keymap.ts et align.ts avant lui :
// aucune I/O, aucun DOM, aucun React — uniquement des transformations pures sur des `Layer[]` et un
// état MODULE-level (le presse-papiers lui-même). Depuis la Tâche 5, il porte UN import de VALEUR
// (`nextGroupId`, lib/studio/groups.ts) : `groups.ts` est lui-même une feuille du même genre (aucun
// DOM/React, voir son en-tête), et réutiliser SA source d'id de groupe plutôt que d'en écrire une
// seconde ici est exactement la même discipline que l'ID-GEN ci-dessous applique déjà aux ids de
// calque — un seul générateur, jamais deux schémas qui pourraient diverger.
//
// CE N'EST PAS le presse-papiers du système d'exploitation, ni localStorage : c'est une variable au
// niveau du module, qui vit pour la durée du PROCESSUS (donc de la session onglet). C'est le brief
// qui le demande ainsi (« MODULE-level in-memory store, a deep clone/snapshot ») — copier dans un
// gabarit et coller dans un AUTRE (un « template » différent monté dans le même onglet) doit
// fonctionner, ce qu'un état React local à un composant ne permettrait pas : le clipboard doit
// survivre au démontage/remontage de l'éditeur pour un changement de gabarit.
//
// ID-GEN : réutilise EXACTEMENT `crypto.randomUUID()`, le même générateur que `createLayer()`
// (editor-state.ts) — voir le commentaire de `cloneLayersWithNewIds` plus bas. Aucun second schéma
// d'id (pas de nanoid, pas de compteur) : un id de calque est un UUID partout dans l'éditeur, sans
// exception pour les clones.
import type { Layer } from "./scene";
import { nextGroupId } from "./groups";

/** Un décalage de cadre, en pixels gabarit — voir `cloneLayersWithNewIds`. */
export interface CloneOffset {
  dx: number;
  dy: number;
}

// Le décalage fixe utilisé par coller/dupliquer (brief, « Ambiguity resolutions ») : assez petit
// pour rester visuellement proche de la source, assez grand pour être visible sans être confondu
// avec le calque d'origine. Exporté et RÉUTILISÉ par tout appelant (hooks/use-editor-keymap.ts) —
// une seule valeur à garder d'accord, jamais deux littéraux `{ dx: 16, dy: 16 }` qui pourraient
// diverger silencieusement.
export const PASTE_OFFSET: CloneOffset = { dx: 16, dy: 16 };

/**
 * Clone `layers` : chaque clone reçoit un id NEUF (via `crypto.randomUUID()` — le MÊME générateur
 * que `createLayer()`, jamais un second schéma), et son cadre est décalé de `offset`. Toute autre
 * propriété du calque source est recopiée telle quelle.
 *
 * `groupId` (chantier B, Tâche 5, spec §3 verbatim : « Un calque groupé collé reçoit un groupId
 * neuf partagé (le groupe est dupliqué, pas fusionné) ») — REMAPPÉ, jamais recopié tel quel. Sans
 * ce remappage, coller/dupliquer un groupe `[a,b]` (groupId `g1`) produirait quatre calques
 * partageant TOUS le même `g1` : cliquer n'importe lequel des quatre sélectionnerait les quatre, et
 * dégrouper le CLONE dégrouperait la SOURCE au passage — une fusion, pas une duplication. `remap`
 * associe donc CHAQUE `groupId` DISTINCT rencontré dans le lot à UN SEUL `nextGroupId()` frais,
 * appliqué à TOUS les calques qui le partageaient (le clone d'un groupe RESTE un groupe, entre SES
 * clones) — et un calque source SANS `groupId` clone SANS `groupId`, tout aussi fidèlement. Deux
 * groupes sources DIFFÉRENTS dans le même lot (ex. coller deux sélections multi-groupes d'un coup)
 * reçoivent chacun leur PROPRE `groupId` neuf, jamais fusionnés entre eux.
 *
 * Ne mute JAMAIS `layers` : chaque clone est un objet neuf, avec un `frame` neuf.
 */
export function cloneLayersWithNewIds(layers: readonly Layer[], offset: CloneOffset): Layer[] {
  const remap = new Map<string, string>();
  return layers.map((layer) => {
    // `{ ...layer, id, frame }` SANS poser `groupId` explicitement : un calque source SANS ce champ
    // clone donc SANS lui non plus (la clé reste ABSENTE, jamais `groupId: undefined`) — le même
    // souci d'exactitude que `withGroupId` (editor-state.ts) applique déjà au dégroupement, pour la
    // même raison (un champ optionnel absent doit RESTER absent, pas devenir présent-et-undefined).
    const cloned: Layer = {
      ...layer,
      id: crypto.randomUUID(),
      frame: { ...layer.frame, x: layer.frame.x + offset.dx, y: layer.frame.y + offset.dy },
    };
    if (!layer.groupId) return cloned;
    if (!remap.has(layer.groupId)) remap.set(layer.groupId, nextGroupId());
    return { ...cloned, groupId: remap.get(layer.groupId)! };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Le presse-papiers lui-même — un état MODULE-level, PAS exporté directement (jamais de mutation en
// place depuis l'extérieur) : les trois fonctions ci-dessous sont la SEULE surface.
let clipboard: Layer[] = [];

/**
 * Écrase le contenu du presse-papiers par un INSTANTANÉ de `layers` — une copie défensive à
 * l'ÉCRITURE (structuredClone), pour que muter `layers` (ou un de ses éléments) APRÈS l'appel ne
 * puisse pas empoisonner le presse-papiers a posteriori. C'est cette copie, pas les objets
 * d'origine, que `readClipboard()` renverra ensuite.
 *
 * Copier une sélection VIDE range un presse-papiers VIDE — pas une erreur : c'est `readClipboard()`
 * qui reste la source de vérité pour « y a-t-il quelque chose à coller ».
 */
export function copyToClipboard(layers: readonly Layer[]): void {
  clipboard = structuredClone(layers) as Layer[];
}

/**
 * Renvoie un INSTANTANÉ du contenu courant du presse-papiers — jamais les objets internes par
 * référence : muter le tableau ou un calque du résultat ne touche pas le presse-papiers, et
 * inversement une copie ultérieure ne peut pas changer un tableau déjà renvoyé par un appel
 * précédent. Tableau vide si rien n'a encore été copié (ou après `clearClipboard()`).
 */
export function readClipboard(): Layer[] {
  return structuredClone(clipboard) as Layer[];
}

/** Vide le presse-papiers. Utilisé par les tests pour s'isoler les uns des autres (le presse-papiers
 * est un singleton de module, partagé par tout le processus `bun test`) ; aucun appelant applicatif
 * n'a de raison de l'invoquer aujourd'hui. */
export function clearClipboard(): void {
  clipboard = [];
}
