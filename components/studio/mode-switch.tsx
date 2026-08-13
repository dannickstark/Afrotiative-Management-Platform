"use client";

import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { isModeToggleShortcut, toggleMode, type StudioMode } from "@/lib/studio/studio-mode";

// components/studio/mode-switch.tsx — Tâche 5 (U1, spec §5) : le contrôle segmenté flottant,
// centré au-dessus du canevas, présent dans les DEUX états (« Montage ⇄ Rendu réel »). Le raccourci
// clavier « R » est un écouteur DOCUMENT (window), comme editor-shell.tsx:COLLAPSE_PANEL_KEY (⌘/,
// Tâche 1) — mais toute la DÉCISION (faut-il basculer ?) vit dans isModeToggleShortcut,
// lib/studio/studio-mode.ts, une fonction PURE testée séparément (tests/studio-mode.test.ts) : ce
// composant ne fait que traduire l'événement RÉEL du navigateur en le littéral qu'elle attend.
export interface ModeSwitchProps {
  mode: StudioMode;
  onChange: (mode: StudioMode) => void;
  className?: string;
}

export function ModeSwitch({ mode, onChange, className }: ModeSwitchProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const shortcutEvent = {
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        target: target ? { tagName: target.tagName, isContentEditable: target.isContentEditable } : null,
      };
      if (!isModeToggleShortcut(shortcutEvent)) return;
      e.preventDefault();
      onChange(toggleMode(mode));
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode, onChange]);

  // Correctif revue finale (Minor) : `role="tablist"`/`role="tab"` promettait une sémantique de tabs
  // (tabpanel associé via `aria-controls`, flèches gauche/droite pour naviguer, `aria-selected`) que
  // ce contrôle ne tient PAS — il ne pilote aucun `tabpanel` (Montage/Rendu réel sont deux ARBRES DE
  // COMPOSANTS entièrement différents rendus par editor-shell.tsx, jamais deux panneaux d'un même
  // conteneur `role="tabpanel"`), et n'a jamais eu de gestion des flèches clavier. Un lecteur d'écran
  // annonçant « onglet » pour un contrôle qui n'en est pas un est PIRE que deux boutons ordinaires.
  //
  // CORRECTIF U3 Tâche 5 — `role="radiogroup"` avait remplacé une promesse ARIA non tenue par une
  // AUTRE : les enfants portent `aria-pressed`, c'est-à-dire le motif du bouton-bascule, pas
  // `role="radio"` + `aria-checked`. Le lecteur d'écran annonçait « groupe de boutons radio » puis
  // trouvait des boutons : aucun des deux contrats n'était honoré (défaut antérieur à U2, reporté par
  // sa revue finale, tranché ici).
  //
  // Le rôle retenu est `role="group"` + `aria-label` — les enfants RESTENT des bascules — et non la
  // conversion en vrai `radiogroup`, pour trois raisons :
  //   1. `radiogroup` oblige un tabindex MOBILE (un seul point d'arrêt) et des flèches qui déplacent
  //      la sélection. Réclamer le rôle sans ce comportement serait le même défaut sous un autre
  //      habit ; l'implémenter serait du code clavier neuf pour un gain nul sur DEUX options — Tab
  //      atteint déjà l'autre bouton en une frappe, et le raccourci « R » (isModeToggleShortcut,
  //      lib/studio/studio-mode.ts) bascule déjà sans quitter le canevas.
  //   2. Pour un radio, flèche = sélection : un simple survol clavier du groupe ferait basculer tout
  //      l'éditeur (editor-shell.tsx remonte un ARBRE entier, et « Rendu réel » lance des rendus).
  //      Deux boutons-bascules n'agissent que sur activation explicite.
  //   3. C'est l'option que la feuille de route nommait la première (specs/2026-08-10-…-roadmap.md :
  //      « `role="group"` ou aucun rôle conviendrait »). `group` plutôt qu'aucun rôle : sur un `div`
  //      sans rôle, `aria-label` n'est pas restitué — le groupe perdrait son nom accessible.
  // Contrat clavier effectivement tenu, et prouvé par de VRAIS événements dans
  // tests/studio-mode-switch.test.ts : deux boutons natifs indépendamment tabulables (aucun
  // `tabindex`), activation par clic/Espace/Entrée, aucune flèche interceptée, et « R » toujours câblé.
  return (
    <div
      role="group"
      aria-label="Mode d'édition"
      data-testid="mode-switch"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full border bg-background p-0.5 shadow-sm",
        className,
      )}
    >
      <button
        type="button"
        aria-pressed={mode === "montage"}
        data-action="mode-montage"
        onClick={() => onChange("montage")}
        className={cn(
          "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
          // Chantier E Tâche 5, correctif revue : accent de marque — EXACTEMENT le même changement
          // que rail.tsx (bg-primary -> bg-accent-brand/text-accent-brand-foreground) pour que les
          // deux pastilles actives restent visuellement identiques, comme une revue antérieure les
          // avait délibérément alignées (voir le commentaire de rail.tsx).
          mode === "montage" ? "bg-accent-brand text-accent-brand-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        Montage
      </button>
      <button
        type="button"
        aria-pressed={mode === "rendu"}
        data-action="mode-rendu"
        onClick={() => onChange("rendu")}
        className={cn(
          "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
          mode === "rendu" ? "bg-accent-brand text-accent-brand-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        Rendu réel
      </button>
    </div>
  );
}
