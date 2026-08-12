import { colorFieldsOf, setColorAtPath, type Scene, type Layer } from "./scene";
import { extractTokens, type TokenId } from "./tokens";

export type TokenValues = Partial<Record<TokenId, string>>;

// Erreur typée : le message est en français et NOMME les jetons manquants, parce qu'un rédacteur
// qui voit « il manque des informations » ne peut rien en faire.
export class MissingTokensError extends Error {
  constructor(public readonly tokens: string[]) {
    super(`Valeurs manquantes pour : ${tokens.join(", ")}.`);
    this.name = "MissingTokensError";
  }
}

const TOKEN_IN_TEXT = /\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g;

function substitute(value: string, values: TokenValues): string {
  return value.replace(TOKEN_IN_TEXT, (_m, token: string) => values[token as TokenId] ?? "");
}

// U4 Tâche 2 — la dimension COULEUR n'est plus une liste recopiée à la main (fill/gradient/border/
// shadow/stroke/overlay/fg/bg, un `if` par champ optionnel) : `colorFieldsOf` (scene.ts) énumère
// CHAQUE champ-couleur du calque — y compris un arrêt de dégradé par entrée — et `setColorAtPath`
// écrit la substitution IMMUTABLEMENT à ce chemin. `usesInLayer` (tokens.ts) consulte le MÊME
// `colorFieldsOf` pour scanner ces champs : les deux fonctions ne peuvent plus diverger.
//
// `field.get()` lit toujours dans le calque D'ORIGINE (fermeture prise par `colorFieldsOf(layer)`) ;
// chaque `setColorAtPath` s'applique à l'ACCUMULATEUR, pas à l'original, pour que les champs déjà
// substitués ne soient jamais écrasés par le suivant.
function substituteColorFields(layer: Layer, values: TokenValues): Layer {
  return colorFieldsOf(layer).reduce(
    (acc, field) => setColorAtPath(acc, field.path, substitute(field.get(), values)),
    layer,
  );
}

// Renvoie une NOUVELLE scène ; l'entrée n'est jamais mutée (les scènes viennent d'un cache ou
// d'une ligne de base et peuvent être réutilisées).
//
// La substitution couvre EXACTEMENT les champs qu'extractTokens (tokens.ts) scanne, sans quoi les
// deux fonctions divergeraient : arrière-plan du canevas (traité ici, seul champ-couleur au niveau
// scène), toute couleur de calque (via `substituteColorFields`, dérivée du schéma), PLUS le
// source/overlay d'image et le contenu de texte, qui restent spécifiques à leur type — comme
// `colorFieldsOf` ne les connaît pas.
export function resolveTokens(scene: Scene, values: TokenValues): Scene {
  const missing = [...new Set(
    extractTokens(scene)
      .map((u) => u.token)
      .filter((t) => !values[t as TokenId]),
  )];
  if (missing.length > 0) throw new MissingTokensError(missing.sort());

  const layers: Layer[] = scene.layers.map((layer): Layer => {
    const colored = substituteColorFields(layer, values);
    switch (colored.type) {
      case "image": {
        const source = colored.source.kind === "slot"
          ? { kind: "url" as const, url: values[colored.source.slot as TokenId]! }
          : colored.source;
        return { ...colored, source };
      }
      case "qr":
        // qrLayer.slot n'est PAS substitué ici : seul render.ts sait transformer une URL en bitmap
        // QR, donc le slot reste un identifiant de jeton jusqu'au rendu. fg/bg, en revanche, ont
        // déjà été résolues normalement par `substituteColorFields` ci-dessus.
        return colored;
      case "text":
        return { ...colored, content: substitute(colored.content, values) };
      case "shape":
        return colored;
    }
  });

  return {
    ...scene,
    canvas: { ...scene.canvas, background: substitute(scene.canvas.background, values) },
    layers,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// U4 Tâche 3 — RÉSOLUTION D'AFFICHAGE (le défaut que le §0 du plan U4 nomme : le navigateur reçoit
// une chaîne « {{jeton}} » là où il attend une couleur CSS — texte, QR, fond de forme, fond de
// canevas — et l'ABANDONNE silencieusement, invisible à l'écran sans qu'aucune erreur n'apparaisse).
//
// `resolveTokens` ci-dessus prépare la scène pour l'EXPORT RÉEL : couleur + source d'image + contenu
// de texte, contre de VRAIES valeurs (article ou saisie). L'éditeur, lui, n'a JAMAIS de valeur réelle
// pour une image ou un texte (spec §2 — un `{{slot}}` d'image garde son espace réservé, un contenu
// texte reste sa forme technique brute) : SEULE la couleur doit s'afficher, avec un ÉCHANTILLON, pour
// que le designer voie ce qu'il compose plutôt qu'un champ qui semble avoir perdu sa valeur.
//
// Les deux fonctions ci-dessous réutilisent EXACTEMENT `substitute`/`substituteColorFields` — les
// MÊMES fonctions que `resolveTokens` applique déjà à la dimension couleur — pour qu'une seconde
// implémentation ne puisse jamais diverger de la première : c'est ce qui rend l'accord éditeur/export
// STRUCTUREL plutôt qu'accidentel (tests/studio-layer-view.test.ts, « §0 »).
//
// PURE, comme `resolveTokens` : ni `layer` ni `value` ne sont mutés (setColorAtPath clone à chaque
// niveau traversé). Contrairement à `resolveTokens`, un jeton sans valeur d'échantillon ne LÈVE PAS
// MissingTokensError — ceci est un affichage de MEILLEUR EFFORT (un designer qui n'a pas encore
// choisi de couleur de catégorie ne doit pas voir le canevas planter), pas une préparation stricte.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Le fond du canevas (`scene.canvas.background`), résolu pour l'affichage — components/studio/canvas.tsx. */
export function resolveDisplayColor(value: string, values: TokenValues): string {
  return substitute(value, values);
}

/** UN calque, avec SEULEMENT ses champs-couleur (colorFieldsOf, Task 2) résolus pour l'affichage —
 *  components/studio/layer-view.tsx. La source d'une image et le contenu d'un texte ne sont JAMAIS
 *  touchés : `colorFieldsOf` ne les énumère pas, donc `substituteColorFields` ne peut pas les voir. */
export function resolveLayerColorsForDisplay(layer: Layer, values: TokenValues): Layer {
  return substituteColorFields(layer, values);
}
