"use client"

import * as React from "react"
import { editorLayoutMode, type EditorLayoutMode } from "@/lib/studio/layout-mode"

// hooks/use-editor-layout.ts — Chantier A Tâche 4 (spec §2/§9) : pont navigateur pour
// lib/studio/layout-mode.ts (lui-même PUR). MÊME découpage que hooks/use-editor-prefs.ts /
// lib/studio/editor-prefs.ts : la RÈGLE vit dans un module sans DOM, ce hook ne fait que la
// réévaluer quand la largeur d'écran change.
//
// Réutilise le patron de hooks/use-mobile.ts#useIsMobile — `matchMedia` sert de SOURCE
// D'ÉVÉNEMENT (un `change` ne se déclenche qu'en franchissant une frontière, jamais à chaque pixel
// de redimensionnement), la VALEUR elle-même vient toujours de `window.innerWidth` au moment où cet
// événement se déclenche. `useIsMobile` n'a qu'UNE frontière (768) ; `editorLayoutMode` en a TROIS
// (768/1024/1280) — une requête `matchMedia` par frontière, chacune ré-exécutant le MÊME calcul pur.
const BREAKPOINTS = [768, 1024, 1280] as const

// SSR-safe (même garantie que `useIsMobile` : `!!isMobile` retombe sur `false` avant le premier
// effet) — `"full"` est le comportement HISTORIQUE d'avant cette tâche (trois colonnes fixes,
// jamais de tiroir), donc un rendu serveur/un premier rendu client avant hydratation affiche
// exactement ce qu'il affichait avant l'existence de ce hook, sans le moindre écart d'hydratation
// pour du contenu qui ne dépend pas déjà de `window`.
const SSR_DEFAULT: EditorLayoutMode = "full"

export function useEditorLayout(): EditorLayoutMode {
  const [mode, setMode] = React.useState<EditorLayoutMode | undefined>(undefined)

  React.useEffect(() => {
    const onChange = () => setMode(editorLayoutMode(window.innerWidth))
    onChange();

    // Défensif — jsdom (les tests DOM du dépôt, tests/dom-harness.ts) n'implémente PAS
    // `window.matchMedia` : un environnement qui en est dépourvu retombe sur UNE lecture au montage
    // (ci-dessus), sans jamais suivre les redimensionnements ultérieurs — jamais une exception qui
    // ferait échouer le montage. Un vrai navigateur a toujours `matchMedia` ; ce garde ne change donc
    // rien au comportement réel, il protège seulement les environnements de test qui en manquent.
    if (typeof window.matchMedia !== "function") return;
    const queries = BREAKPOINTS.map((bp) => window.matchMedia(`(min-width: ${bp}px)`))
    queries.forEach((mql) => mql.addEventListener("change", onChange))
    return () => queries.forEach((mql) => mql.removeEventListener("change", onChange))
  }, [])

  return mode ?? SSR_DEFAULT
}
