"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PREFS, openModelesIfEmpty, parsePrefs, serializePrefs, type EditorPrefs } from "@/lib/studio/editor-prefs";

// hooks/use-editor-prefs.ts — Tâche 1 (U1, spec §3) : pont navigateur pour lib/studio/editor-prefs.ts
// (lui-même PUR). Lit une fois au montage (le rendu serveur/initial reste DEFAULT_PREFS pour éviter
// tout écart d'hydratation), puis écrit à chaque changement sous la clé `studio.editor-prefs`.
const STORAGE_KEY = "studio.editor-prefs";

export type SetEditorPrefs = (update: EditorPrefs | ((prev: EditorPrefs) => EditorPrefs)) => void;

export interface UseEditorPrefsOptions {
  // `defaultSafeAreas` (Tâche 7, U1 spec §7) : n'intervient QUE quand ce navigateur n'a ENCORE
  // JAMAIS enregistré la moindre préférence (`localStorage.getItem(STORAGE_KEY) === null`) — le cas
  // du tout premier gabarit jamais ouvert ici. DEFAULT_PREFS.safeAreas reste un booléen générique
  // fixe (`true`, verrouillé par tests/studio-editor-prefs.test.ts) : il ne connaît rien du FORMAT en
  // cours, alors que spec §7 demande un défaut différent par format (« on » pour story/portrait,
  // « off » pour les formats lien — voir components/studio/canvas-chrome.tsx#safeAreaDefaultFor, qui
  // dérive ce choix de l'orientation réelle du format plutôt que de coder une paire en dur). Dès
  // qu'UNE préférence existe déjà — même posée par un premier gabarit d'un format différent — elle
  // est reprise TELLE QUELLE : ce paramètre ne fait donc que combler le trou du tout premier
  // lancement, jamais une réévaluation à chaque nouveau gabarit ouvert (« state remembered per user »,
  // spec §7 — pas par gabarit).
  defaultSafeAreas?: boolean;
  // `hasLayers` (correctif revue finale, amendement de spec §3) : à la différence de
  // `defaultSafeAreas`, RÉÉVALUÉ à CHAQUE gabarit ouvert — ce hook est ré-instancié à chaque
  // navigation vers un gabarit différent (composant parent démonté/remonté par le routeur), donc ce
  // paramètre reflète bien LE gabarit courant, jamais un état figé au premier lancement du
  // navigateur. Voir lib/studio/editor-prefs.ts#openModelesIfEmpty pour la règle PURE appliquée
  // ci-dessous : par défaut `true` (aucun appelant historique de ce hook ne passait ce paramètre) —
  // un appelant qui l'omet ne voit donc jamais Modèles s'ouvrir de force, comportement inchangé.
  hasLayers?: boolean;
}

export function useEditorPrefs(options: UseEditorPrefsOptions = {}): [EditorPrefs, SetEditorPrefs] {
  const { defaultSafeAreas, hasLayers = true } = options;
  const [prefs, setPrefsState] = useState<EditorPrefs>(
    defaultSafeAreas === undefined ? DEFAULT_PREFS : { ...DEFAULT_PREFS, safeAreas: defaultSafeAreas },
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const base = raw === null && defaultSafeAreas !== undefined
      ? { ...DEFAULT_PREFS, safeAreas: defaultSafeAreas }
      : parsePrefs(raw);
    setPrefsState(openModelesIfEmpty(base, hasLayers));
    // Lecture UNIQUEMENT au montage — volontairement `[]`, voir le commentaire du module.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Correctif revue finale — Minor : `setPrefs` écrivait AUPARAVANT dans `localStorage` DEPUIS
  // L'INTÉRIEUR de l'updater passé à `setPrefsState`. Un updater doit rester PUR (React peut
  // l'invoquer deux fois en Strict Mode, ou l'appeler puis jeter le rendu qui en résultait) : cette
  // écriture pouvait donc se produire deux fois, ou survivre à un rendu abandonné. L'écriture vit
  // désormais dans un effet dédié, déclenché par le changement RÉEL de `prefs` — jamais par
  // l'exécution de l'updater lui-même. `isFirstWrite` saute la toute première exécution de CET effet
  // (celle du rendu initial, valeurs par défaut) : sans ce garde, le tout premier montage écrirait
  // aussitôt DEFAULT_PREFS dans localStorage, avant même que l'effet de chargement ci-dessus ait eu
  // la chance de lire/corriger la valeur réellement persistée — cet effet se redéclenche ensuite
  // normalement dès que l'effet de chargement pose l'état chargé, et écrit alors pour de vrai.
  const isFirstWrite = useRef(true);
  useEffect(() => {
    if (isFirstWrite.current) {
      isFirstWrite.current = false;
      return;
    }
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, serializePrefs(prefs));
  }, [prefs]);

  // `useCallback` (correctif revue finale — Minor) : les deux écouteurs `keydown` de
  // editor-shell.tsx (⌘/ et, via mode-switch.tsx, « R ») dépendent de `setPrefs` — une nouvelle
  // référence à CHAQUE rendu de EditorShellInner faisait retirer puis reposer ces écouteurs
  // `window.addEventListener` à chaque frappe/interaction, pas seulement au montage.
  const setPrefs = useCallback<SetEditorPrefs>((update) => {
    setPrefsState((prev) => (typeof update === "function" ? (update as (p: EditorPrefs) => EditorPrefs)(prev) : update));
  }, []);

  return [prefs, setPrefs];
}
