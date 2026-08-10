"use client";

import { useEffect, useState } from "react";
import { DEFAULT_PREFS, parsePrefs, serializePrefs, type EditorPrefs } from "@/lib/studio/editor-prefs";

// hooks/use-editor-prefs.ts — Tâche 1 (U1, spec §3) : pont navigateur pour lib/studio/editor-prefs.ts
// (lui-même PUR). Lit une fois au montage (le rendu serveur/initial reste DEFAULT_PREFS pour éviter
// tout écart d'hydratation), puis écrit à chaque changement sous la clé `studio.editor-prefs`.
const STORAGE_KEY = "studio.editor-prefs";

export type SetEditorPrefs = (update: EditorPrefs | ((prev: EditorPrefs) => EditorPrefs)) => void;

export function useEditorPrefs(): [EditorPrefs, SetEditorPrefs] {
  const [prefs, setPrefsState] = useState<EditorPrefs>(DEFAULT_PREFS);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setPrefsState(parsePrefs(window.localStorage.getItem(STORAGE_KEY)));
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
