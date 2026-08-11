"use client";

import { useEffect, useState } from "react";
import { DEFAULT_PREFS, parsePrefs, serializePrefs, type EditorPrefs } from "@/lib/studio/editor-prefs";

// hooks/use-editor-prefs.ts — Tâche 1 (U1, spec §3) : pont navigateur pour lib/studio/editor-prefs.ts
// (lui-même PUR). Lit une fois au montage (le rendu serveur/initial reste DEFAULT_PREFS pour éviter
// tout écart d'hydratation), puis écrit à chaque changement sous la clé `studio.editor-prefs`.
const STORAGE_KEY = "studio.editor-prefs";

export type SetEditorPrefs = (update: EditorPrefs | ((prev: EditorPrefs) => EditorPrefs)) => void;

// `defaultSafeAreas` (Tâche 7, U1 spec §7) : n'intervient QUE quand ce navigateur n'a ENCORE JAMAIS
// enregistré la moindre préférence (`localStorage.getItem(STORAGE_KEY) === null`) — le cas du tout
// premier gabarit jamais ouvert ici. DEFAULT_PREFS.safeAreas reste un booléen générique fixe (`true`,
// verrouillé par tests/studio-editor-prefs.test.ts) : il ne connaît rien du FORMAT en cours, alors
// que spec §7 demande un défaut différent par format (« on » pour story/portrait, « off » pour les
// formats lien — voir components/studio/canvas-chrome.tsx#safeAreaDefaultFor, qui dérive ce choix de
// l'orientation réelle du format plutôt que de coder une paire en dur). Dès qu'UNE préférence existe
// déjà — même posée par un premier gabarit d'un format différent — elle est reprise TELLE QUELLE :
// ce paramètre ne fait donc que combler le trou du tout premier lancement, jamais une réévaluation à
// chaque nouveau gabarit ouvert (« state remembered per user », spec §7 — pas par gabarit).
export function useEditorPrefs(defaultSafeAreas?: boolean): [EditorPrefs, SetEditorPrefs] {
  const [prefs, setPrefsState] = useState<EditorPrefs>(
    defaultSafeAreas === undefined ? DEFAULT_PREFS : { ...DEFAULT_PREFS, safeAreas: defaultSafeAreas },
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null && defaultSafeAreas !== undefined) {
      setPrefsState({ ...DEFAULT_PREFS, safeAreas: defaultSafeAreas });
      return;
    }
    setPrefsState(parsePrefs(raw));
    // Lecture UNIQUEMENT au montage — volontairement `[]`, voir le commentaire du module.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setPrefs: SetEditorPrefs = (update) => {
    setPrefsState((prev) => {
      const next = typeof update === "function" ? (update as (p: EditorPrefs) => EditorPrefs)(prev) : update;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, serializePrefs(next));
      }
      return next;
    });
  };

  return [prefs, setPrefs];
}
