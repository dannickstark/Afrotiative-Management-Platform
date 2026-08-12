"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_TEMPLATES_VIEW, parseTemplatesView, serializeTemplatesView, type TemplatesView,
} from "@/lib/studio/templates-view-pref";

// hooks/use-templates-view.ts — Chantier A, Tâche 5 (spec §4) : pont navigateur pour
// lib/studio/templates-view-pref.ts (lui-même PUR), même recette que hooks/use-editor-prefs.ts.
// Lit une fois au montage (le rendu serveur/initial reste DEFAULT_TEMPLATES_VIEW pour éviter tout
// écart d'hydratation), puis écrit à chaque changement sous sa propre clé — DISTINCTE de
// "studio.editor-prefs" : cette préférence appartient à la liste /studio (coque admin), pas à
// l'éditeur d'un gabarit précis, les deux n'ont donc aucune raison de partager une entrée.
const STORAGE_KEY = "studio.templates-view";

export function useTemplatesView(): [TemplatesView, (next: TemplatesView) => void] {
  const [view, setViewState] = useState<TemplatesView>(DEFAULT_TEMPLATES_VIEW);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setViewState(parseTemplatesView(window.localStorage.getItem(STORAGE_KEY)));
    // Lecture UNIQUEMENT au montage — même remarque que use-editor-prefs.ts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Même garde-fou que use-editor-prefs.ts (correctif revue finale — Minor) : ne PAS écrire au
  // tout premier rendu (DEFAULT_TEMPLATES_VIEW), seulement une fois l'effet de chargement ci-dessus
  // a eu la chance de poser la valeur réellement persistée — sinon un navigateur qui avait choisi
  // "table" verrait ce montage réécraser silencieusement sa préférence avec "grid" avant même de
  // l'avoir relue.
  const isFirstWrite = useRef(true);
  useEffect(() => {
    if (isFirstWrite.current) {
      isFirstWrite.current = false;
      return;
    }
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, serializeTemplatesView(view));
  }, [view]);

  const setView = useCallback((next: TemplatesView) => setViewState(next), []);

  return [view, setView];
}
