import type { TemplateContext } from "@/lib/studio/tokens";

// lib/studio/preview-contexts.ts — la liste des contextes de gabarit qui proposent un sélecteur
// d'article dans l'aperçu (spec §4/§5). PUR : aucun accès React/DOM ici, aucune importation de
// composant — même discipline que lib/studio/studio-mode.ts.
//
// Vivait dans components/studio/preview-pane.tsx (Tâche 10) jusqu'à la refonte « planche/
// inspection » (chantier D, Tâche 6) : ce composant a été supprimé — son dernier consommateur
// restant, components/studio/render-mode.tsx, ne compose plus <PreviewPane> depuis la Tâche 3
// (hooks/use-preview.ts) et les Tâches 4-5 (components/studio/render/proof-sheet.tsx et
// format-focus.tsx). La constante, elle, reste nécessaire : render-mode.tsx en a toujours besoin
// pour piloter son propre sélecteur d'article, et la sortir dans un module PUR évite de la recopier
// — une copie dupliquée pourrait diverger silencieusement du sélecteur réel (ex. si un contexte
// manuel gagnait un jour un article associé sans que la copie ne soit mise à jour).
export const ARTICLE_SELECTABLE_CONTEXTS: TemplateContext[] = ["article_image", "social_post"];
